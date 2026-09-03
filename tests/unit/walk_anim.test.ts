// ART-09: walk-cycle tests.
//  (1) the phase-advance function is PURE: accumulated horizontal
//      displacement in -> gait phase + joint angles out (no time term),
//      so zero displacement keeps the phase and more displacement advances
//      it faster;
//  (2) `Unit` and `AIState` carry NO animation-related fields — the walk
//      phase lives only in the Renderer, so the deterministic sim (and the
//      seed 1..40 termination regression) is not polluted by the animation.

import { describe, it, expect } from 'vitest';
import { WALK, gaitPhase, gaitJointAngles, gaitPose } from '../../src/render/walkAnim';
import { Match } from '@/game/match';
import { createUnit } from '@/game/units/units';

// (1) — pure phase / joint-angle mapping -----------------------------------

describe('walk gait (pure math)', () => {
  it('zero displacement -> zero phase and a standing (all-zero) pose', () => {
    expect(gaitPhase(0, WALK.strideWalk)).toBe(0);
    const pose = gaitPose(0, WALK.strideWalk);
    expect(pose.phase).toBe(0);
    expect(pose.leftLeg).toBe(0);
    expect(pose.rightLeg).toBe(0);
    expect(pose.leftArm).toBe(0);
    expect(pose.rightArm).toBe(0);
  });

  it('phase is monotonic in accumulated displacement (more distance -> larger phase)', () => {
    const s = WALK.strideWalk;
    expect(gaitPhase(5, s)).toBeGreaterThan(gaitPhase(2.5, s));
    expect(gaitPhase(2.5, s)).toBeGreaterThan(gaitPhase(1, s));
    expect(gaitPhase(1, s)).toBeGreaterThan(0);
  });

  it('the phase advances linearly with displacement (no hidden time term)', () => {
    const s = WALK.strideWalk;
    // Doubling the accumulated distance doubles the phase.
    expect(gaitPhase(4, s)).toBeCloseTo(2 * gaitPhase(2, s), 12);
    expect(gaitPhase(7, s)).toBeCloseTo(7 * (Math.PI / s), 12);
  });

  it('a shorter (sprint) stride advances the phase faster for the same distance', () => {
    const d = 6;
    expect(WALK.strideSprint).toBeLessThan(WALK.strideWalk);
    const walkPhase = gaitPose(d, WALK.strideWalk).phase;
    const sprintPhase = gaitPose(d, WALK.strideSprint).phase;
    expect(sprintPhase).toBeGreaterThan(walkPhase);
  });

  it('one full gait cycle spans two strides (2*PI) and is periodic in the joints', () => {
    const s = WALK.strideWalk;
    const fullCycleDist = 2 * s; // two strides
    expect(gaitPhase(fullCycleDist, s)).toBeCloseTo(Math.PI * 2, 12);
    // Joint angles are periodic: a full cycle returns to the starting pose.
    const a0 = gaitJointAngles(gaitPhase(0, s));
    const a1 = gaitJointAngles(gaitPhase(fullCycleDist, s));
    expect(a1.leftLeg).toBeCloseTo(a0.leftLeg, 12);
    expect(a1.rightLeg).toBeCloseTo(a0.rightLeg, 12);
    expect(a1.leftArm).toBeCloseTo(a0.leftArm, 12);
    expect(a1.rightArm).toBeCloseTo(a0.rightArm, 12);
  });

  it('legs and same-side arms swing opposite (natural counter-swing)', () => {
    // Sample a phase where the sine is neither 0 nor at a peak.
    const a = gaitJointAngles(gaitPhase(1, WALK.strideWalk));
    expect(a.leftLeg).toBeCloseTo(-a.rightLeg, 12);
    expect(a.leftArm).toBeCloseTo(-a.rightArm, 12);
    // The left arm leads the RIGHT leg (counter-swing): same sign.
    expect(Math.sign(a.leftArm)).toBe(Math.sign(a.rightLeg));
    expect(Math.sign(a.leftLeg)).toBe(Math.sign(a.rightArm));
  });
});

// (2) — no animation state leaks into the deterministic sim ----------------

const ANIM_KEY_RE = /(phase|swing|stride|walk|gait|limb|anim|joint|legAngle|armAngle)/i;

function expectNoAnimKeys(obj: unknown, label: string): void {
  const keys = Object.keys(obj as Record<string, unknown>);
  const offenders = keys.filter((k) => ANIM_KEY_RE.test(k));
  expect(offenders, `${label} must not carry animation fields, found: ${offenders.join(', ')}`)
    .toHaveLength(0);
}

describe('animation stays out of the deterministic sim state', () => {
  it('createUnit has no animation-related fields', () => {
    const u = createUnit(0, 'Vega', 'blue', true, 0, 0, 0);
    expectNoAnimKeys(u, 'Unit');
  });

  it('a live sim Unit and its AIState have no animation-related fields', () => {
    const m = new Match(20240517);
    for (let i = 0; i < 60; i++) m.tick(1 / 60); // let the AI populate state
    let sawAI = false;
    for (const u of m.units) {
      expectNoAnimKeys(u, `Unit id ${u.id}`);
      if (u.ai) {
        sawAI = true;
        expectNoAnimKeys(u.ai, `AIState id ${u.id}`);
      }
    }
    expect(sawAI, 'expected at least one AI-driven unit to assert its AIState').toBe(true);
  });
});
