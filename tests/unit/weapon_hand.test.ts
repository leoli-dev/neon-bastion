// ART-15 (Task 11): the weapon is GRIPPED, not carried at the chest. The
// hand position is a pure function of (gait phase, aim blend); the weapon
// pivot sits at the hand (minus the grip offset), so the grip under the
// hand, the muzzle flash and the barrel tip all stay coherent at every
// walk phase.

import { describe, it, expect } from 'vitest';
import {
  rightHandLocal,
  leftHandLocal,
  weaponPivotLocal,
  WEAPON_GRIP_LOCAL,
  WEAPON_GRIP_DROP,
  WEAPON_REST_PITCH,
  WEAPON_PIVOT_Y,
  weaponAimRot,
  RIGHT_ARM,
} from '../../src/render/weapon';
import type { Vec3 } from '../../src/game/types';

const TOL = 0.12; // metres: hand/grip coincidence budget

/** Rotate a pivot-frame vector by the weapon's Euler ('YXZ') rotation:
 *  R = Ry(yaw) * Rx(pitch) — the same convention as the renderer. */
function weaponLocalToWorldInPivot(yaw: number, pitch: number, v: Vec3): Vec3 {
  const c = Math.cos(pitch), s = Math.sin(pitch);
  const y = v.y * c - v.z * s;
  const z = v.y * s + v.z * c;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return { x: v.x * cy + z * sy, y, z: -v.x * sy + z * cy };
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** The grip point of the weapon mesh for a pivot at `pivot` in pose
 *  (yaw, pitch). */
function gripPoint(pivot: Vec3, yaw: number, pitch: number): Vec3 {
  const g = weaponLocalToWorldInPivot(yaw, pitch, WEAPON_GRIP_LOCAL);
  return { x: pivot.x + g.x, y: pivot.y + g.y, z: pivot.z + g.z };
}

const PHASES = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

describe('ART-15: the weapon is held in the right hand', () => {
  for (const phase of PHASES) {
    const label = `gait phase ${(phase / Math.PI).toFixed(2)}π`;
    it(`${label}, idle carry: the grip sits in the right hand`, () => {
      const hand = rightHandLocal(phase, 0);
      const pivot = weaponPivotLocal(phase, 0);
      const grip = gripPoint(pivot, 0, WEAPON_REST_PITCH); // rest pose: muzzle down
      expect(dist(grip, hand)).toBeLessThan(TOL);
      // The carry grip hangs at hand level — not up at the eye line.
      expect(Math.abs(hand.y - (pivot.y + WEAPON_GRIP_DROP.y))).toBeLessThan(0.02);
    });

    it(`${label}, aiming: the grip still sits in the raised hand`, () => {
      const hand = rightHandLocal(phase, 1);
      const pivot = weaponPivotLocal(phase, 1);
      // A flat two-handed shot (the pitch weaponAimRot would give).
      const pose = weaponAimRot(0, { x: 0, y: 0, z: 1 }, 0);
      const grip = gripPoint(pivot, pose.yaw, pose.pitch);
      expect(dist(grip, hand)).toBeLessThan(TOL);
    });
  }

  it('idle -> aiming raises the gun AND the hand together', () => {
    for (const phase of [0, Math.PI, (3 * Math.PI) / 2]) {
      const handDY = rightHandLocal(phase, 1).y - rightHandLocal(phase, 0).y;
      const pivotDY = weaponPivotLocal(phase, 1).y - weaponPivotLocal(phase, 0).y;
      // The hand clearly raises…
      expect(handDY).toBeGreaterThan(0.2);
      // …and the gun pivot follows it (within a few cm — it rides the hand).
      expect(pivotDY).toBeGreaterThan(0.15);
      expect(Math.abs(pivotDY - handDY)).toBeLessThan(0.05);
    }
  });

  it('aiming: the left hand crosses to the front of the weapon, in front of the body', () => {
    const pivot = weaponPivotLocal(0, 1);
    const lh = leftHandLocal(0, 1);
    // Near the weapon body (grip end) …
    expect(dist(lh, pivot)).toBeLessThan(0.45);
    // …in front of the shoulders and at a plausible hold height.
    expect(lh.z).toBeGreaterThan(RIGHT_ARM.shoulder.z);
    expect(lh.y).toBeGreaterThan(0.75);
    expect(lh.y).toBeLessThan(1.45);
  });

  it('negative control: the legacy chest anchor is FAR from the hand', () => {
    // If the pivot were still the old torso anchor (0, WEAPON_PIVOT_Y, 0),
    // the grip would hang 0.3 m+ away from the hand at every phase — this
    // is exactly the defect the Task-11 unit test must catch.
    const chest: Vec3 = { x: 0, y: WEAPON_PIVOT_Y, z: 0 };
    for (const phase of PHASES) {
      const hand = rightHandLocal(phase, 0);
      const grip = gripPoint(chest, 0, WEAPON_REST_PITCH);
      expect(dist(grip, hand)).toBeGreaterThan(0.3);
    }
  });

  it('grip drop: the rest-orientation grip offset keeps the grip in the hand', () => {
    // The pivot is offset from the hand by the grip rotated into the REST
    // (muzzle-down) orientation — so at rest pitch the grip lands in the
    // hand exactly.
    const hand = rightHandLocal(0.7, 0);
    const pivot = weaponPivotLocal(0.7, 0);
    const grip = gripPoint(pivot, 0, WEAPON_REST_PITCH);
    expect(dist(grip, hand)).toBeLessThan(1e-9);
    // Sanity: the drop offset is the grip rotated about X by the rest pitch.
    expect(WEAPON_GRIP_DROP.y).toBeCloseTo(WEAPON_GRIP_LOCAL.y * Math.cos(WEAPON_REST_PITCH) - WEAPON_GRIP_LOCAL.z * Math.sin(WEAPON_REST_PITCH), 12);
  });
});
