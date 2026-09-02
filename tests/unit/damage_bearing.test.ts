// Damage-direction bearing (the angle used to place the "who hit me" arc
// around the crosshair). Pure geometry: no DOM, no camera, no match state.
//
// Convention: 0 = attacker straight ahead, positive = attacker to the
// player's RIGHT (clockwise on screen), magnitude capped at ±π (behind).

import { describe, it, expect } from 'vitest';
import { damageBearing } from '../../src/app';

const EPS = 1e-9;

describe('damageBearing', () => {
  it('returns 0 for an attacker straight ahead', () => {
    // yaw 0 => forward is +Z
    expect(damageBearing(0, { x: 0, z: 0 }, { x: 0, z: 10 })).toBeCloseTo(0, 12);
    // yaw π => forward is -Z
    expect(damageBearing(Math.PI, { x: 0, z: 0 }, { x: 0, z: -10 })).toBeCloseTo(0, 9);
  });

  it('returns +π/2 for an attacker to the player\'s right', () => {
    // yaw 0: screen-right is (-cos 0, sin 0) = (-X)
    expect(damageBearing(0, { x: 0, z: 0 }, { x: -10, z: 0 })).toBeCloseTo(Math.PI / 2, 9);
    // yaw π: screen-right is (+X) — matches the D-strafe fix (CTRL-01)
    expect(damageBearing(Math.PI, { x: 0, z: 0 }, { x: 10, z: 0 })).toBeCloseTo(Math.PI / 2, 9);
  });

  it('returns -π/2 for an attacker to the player\'s left', () => {
    expect(damageBearing(0, { x: 0, z: 0 }, { x: 10, z: 0 })).toBeCloseTo(-Math.PI / 2, 9);
    expect(damageBearing(Math.PI, { x: 0, z: 0 }, { x: -10, z: 0 })).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('returns ±π for an attacker directly behind', () => {
    // yaw 0 => behind is -Z
    const b = damageBearing(0, { x: 0, z: 0 }, { x: 0, z: -10 })!;
    expect(Math.abs(b)).toBeCloseTo(Math.PI, 9);
  });

  it('is independent of distance (normalises the direction)', () => {
    const near = damageBearing(0, { x: 2, z: 3 }, { x: 2, z: 4 })!;
    const far = damageBearing(0, { x: 2, z: 3 }, { x: 2, z: 40 })!;
    expect(near).toBeCloseTo(far, 12);
  });

  it('handles a rotated frame consistently (yaw = π/4)', () => {
    // yaw π/4 => forward (sin, cos) = (√2/2, √2/2); right = (-cos, sin) = (-√2/2, √2/2)
    const f = Math.SQRT1_2;
    const ahead = damageBearing(Math.PI / 4, { x: 0, z: 0 }, { x: f * 10, z: f * 10 });
    expect(ahead).toBeCloseTo(0, 9);
    const right = damageBearing(Math.PI / 4, { x: 0, z: 0 }, { x: -f * 10, z: f * 10 });
    expect(right).toBeCloseTo(Math.PI / 2, 9);
  });

  it('returns null when the attacker is on top of the player (no direction)', () => {
    expect(damageBearing(0, { x: 5, z: 5 }, { x: 5, z: 5 })).toBeNull();
    expect(damageBearing(0, { x: 5, z: 5 }, { x: 5 + 1e-6, z: 5 })).toBeNull();
  });

  it('keeps the result within (-π, π]', () => {
    for (let i = 0; i < 64; i++) {
      const yaw = (i / 64) * Math.PI * 2;
      const b = damageBearing(yaw, { x: 1.3, z: -2.1 }, { x: -4, z: 7 })!;
      expect(b).toBeGreaterThan(-Math.PI - EPS);
      expect(b).toBeLessThanOrEqual(Math.PI + EPS);
    }
  });
});
