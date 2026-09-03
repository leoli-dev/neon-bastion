// AUD-01: footstep cadence logic (pure, no WebAudio/DOM).
// Verifies the distance-driven trigger math: how many steps a given amount of
// accumulated walking produces, that sprinting steps more often, that being
// airborne never triggers, and that a landing fires a heavier thump.

import { describe, it, expect } from 'vitest';
import { FootstepTracker, FOOTSTEP } from '../../src/game/footstep';

function feed(t: FootstepTracker, total: number, per: number, grounded = true, sprinting = false): number {
  // Feed `total` units of horizontal travel in `per`-unit increments and
  // count the triggers produced.
  const n = Math.round(total / per);
  let fired = 0;
  for (let i = 0; i < n; i++) if (t.tick(per, grounded, sprinting)) fired++;
  return fired;
}

describe('FootstepTracker', () => {
  it('fires one step per stride-length of accumulated distance', () => {
    const t = new FootstepTracker();
    // 2.5 units walked at the walk stride (1.75) -> exactly 1 step.
    const fired = feed(t, 2.5, 0.25);
    expect(fired).toBe(Math.floor(2.5 / FOOTSTEP.stepLengthWalk));
    expect(fired).toBe(1);
    expect(t.count).toBe(1);
  });

  it('keeps triggering as distance keeps accumulating across strides', () => {
    const t = new FootstepTracker();
    // 7.0 units at the walk stride -> floor(7 / 1.75) = 4 steps.
    const fired = feed(t, 7.0, 0.25);
    expect(fired).toBe(Math.floor(7.0 / FOOTSTEP.stepLengthWalk));
    expect(fired).toBe(4);
  });

  it('does not step until the stride length is actually reached', () => {
    const t = new FootstepTracker();
    const fired = feed(t, FOOTSTEP.stepLengthWalk - 0.2, 0.1);
    expect(fired).toBe(0);
    expect(t.count).toBe(0);
  });

  it('sprints with a shorter stride, so the same distance produces more steps', () => {
    const walk = new FootstepTracker();
    const sprint = new FootstepTracker();
    const dist = 8.0;
    expect(FOOTSTEP.stepLengthSprint).toBeLessThan(FOOTSTEP.stepLengthWalk);
    const walkFired = feed(walk, dist, 0.25, true, false);
    const sprintFired = feed(sprint, dist, 0.25, true, true);
    expect(sprintFired).toBe(Math.floor(dist / FOOTSTEP.stepLengthSprint));
    expect(walkFired).toBe(Math.floor(dist / FOOTSTEP.stepLengthWalk));
    expect(sprintFired).toBeGreaterThan(walkFired);
  });

  it('never triggers while airborne, even across large horizontal moves', () => {
    const t = new FootstepTracker();
    t.tick(0.5, true, false); // establish the grounded baseline (prime)
    // Jump: several airborne ticks with substantial horizontal travel.
    for (let i = 0; i < 10; i++) {
      expect(t.tick(0.9, false, false), 'airborne tick must not fire').toBeNull();
    }
    expect(t.count).toBe(0);
  });

  it('fires a slightly heavier trigger once when the player lands', () => {
    const t = new FootstepTracker();
    t.tick(0.5, true, false); // grounded baseline
    t.tick(0.4, false, false); // airborne
    const trig = t.tick(0.1, true, false); // land
    expect(trig).not.toBeNull();
    expect(trig!.kind).toBe('land');
    expect(trig!.intensity).toBe(FOOTSTEP.intensityLand);
    // Only the landing fired, not a spurious step burst.
    expect(t.count).toBe(1);
  });

  it('does not read the initial grounded spawn as a landing', () => {
    const t = new FootstepTracker();
    // The player spawns ON the ground: the first grounded tick must not land.
    expect(t.tick(0.2, true, false)).toBeNull();
    expect(t.count).toBe(0);
  });

  it('resets the accumulator and counter', () => {
    const t = new FootstepTracker();
    feed(t, 7.0, 0.25);
    expect(t.count).toBeGreaterThan(0);
    t.reset();
    expect(t.count).toBe(0);
    // After reset, a fresh partial stride again needs a full stride to fire.
    expect(feed(t, FOOTSTEP.stepLengthWalk - 0.2, 0.1)).toBe(0);
  });
});
