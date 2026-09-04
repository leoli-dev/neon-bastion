// ART-10: the weapon muzzle math must keep the muzzle flash and the barrel
// tip on the same point. The canonical invariant: at zero recoil the barrel
// tip EXACTLY reproduces the legacy muzzle-flash formula
//   eye + aim * MUZZLE_OFFSET - (0, MUZZLE_DROP, 0)
// for any aim direction (horizontal, steep pitch, any yaw) — so switching the
// flash source to the weapon geometry can never move it.

import { describe, it, expect } from 'vitest';
import { CONFIG } from '../../src/game/constants';
import {
  MUZZLE_OFFSET,
  MUZZLE_DROP,
  WEAPON_PIVOT_Y,
  WEAPON_RECOIL_PITCH,
  WEAPON_RECOIL_TRAVEL,
  WEAPON_REST_PITCH,
  weaponMuzzleWorld,
  weaponAimRot,
} from '../../src/render/weapon';

const EPS = 1e-9;

function aim(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
}

function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('ART-10 weapon muzzle math', () => {
  it('pivot height + muzzle drop equals the eye height (the alignment anchor)', () => {
    // The weapon pivot sits this far below the eye; the flash formula drops
    // the muzzle this far below the eye. They must be the same point.
    expect(Math.abs(WEAPON_PIVOT_Y + MUZZLE_DROP - CONFIG.eyeHeight)).toBeLessThan(EPS);
  });

  it('un-recoiled barrel tip reproduces the legacy muzzle formula for any aim', () => {
    const pos = { x: 3.2, y: 0.4, z: -7.5 };
    const uYaw = 1.0;
    // The LEGACY chest pivot: with it, the new signature must reproduce the
    // old formula exactly (ART-15 kept the math, only the runtime pivot
    // moved — now it follows the right hand).
    const legacyPivot = { x: 0, y: WEAPON_PIVOT_Y, z: 0 };
    const dirs = [
      aim(uYaw, 0),        // straight ahead, no pitch
      aim(0.2, 0.3),       // other yaw, pitched up
      aim(-2.1, -0.45),    // other yaw, steep down
      aim(2.9, 0.1),       // near-behind the facing
      aim(0, 0.7),         // steep elevation
    ];
    for (const a of dirs) {
      const tip = weaponMuzzleWorld(pos, uYaw, legacyPivot, a, 0);
      const eyeY = pos.y + CONFIG.eyeHeight;
      expect(Math.abs(tip.x - (pos.x + a.x * MUZZLE_OFFSET))).toBeLessThan(EPS);
      expect(Math.abs(tip.y - (eyeY - MUZZLE_DROP + a.y * MUZZLE_OFFSET))).toBeLessThan(EPS);
      expect(Math.abs(tip.z - (pos.z + a.z * MUZZLE_OFFSET))).toBeLessThan(EPS);
    }
  });

  it('recoil pulls the tip back and up, by a small bounded amount', () => {
    const pos = { x: 0, y: 0, z: 0 };
    const a = aim(0.4, 0.1);
    const pivot = { x: 0, y: WEAPON_PIVOT_Y, z: 0 };
    const t0 = weaponMuzzleWorld(pos, 0.4, pivot, a, 0);
    // Full recoil: the pivot is pulled back along the unit's local -Z…
    const recoilPivot = { x: 0, y: WEAPON_PIVOT_Y, z: -WEAPON_RECOIL_TRAVEL };
    const t1 = weaponMuzzleWorld(pos, 0.4, recoilPivot, a, 1);
    // Bounded: a full recoil kick moves the muzzle less than ~0.1 m.
    expect(dist(t0, t1)).toBeLessThan(0.1);
    // Direction: net pulled BACK along the aim (the travel wins over the
    // pitch-up arc) and raised in world Y.
    const dx = t0.x - t1.x, dy = t0.y - t1.y, dz = t0.z - t1.z;
    expect(a.x * dx + a.y * dy + a.z * dz).toBeGreaterThan(WEAPON_RECOIL_TRAVEL * 0.5);
    expect(t1.y - t0.y).toBeGreaterThan(0);
  });

  it('an off-centre pivot shifts the tip rigidly (hand-follow coherence)', () => {
    // ART-15: whatever local point the pivot sits at (the right hand), the
    // tip must be pivotWorld + dir*MUZZLE_OFFSET — the same rigid rule the
    // 3D mesh uses, so the flash can never drift from the barrel tip.
    const pos = { x: 1, y: 0, z: 2 };
    const uYaw = 0.9;
    const pivotLocal = { x: -0.25, y: 0.98, z: 0.52 };
    const a = aim(0.4, 0.1);
    const tip = weaponMuzzleWorld(pos, uYaw, pivotLocal, a, 0);
    const cp = Math.cos(-Math.asin(a.y));
    const su = Math.sin(uYaw), cu = Math.cos(uYaw);
    const px = pos.x + pivotLocal.x * cu + pivotLocal.z * su;
    const py = pos.y + pivotLocal.y;
    const pz = pos.z - pivotLocal.x * su + pivotLocal.z * cu;
    const dx = Math.sin(0.4) * cp, dy = a.y, dz = Math.cos(0.4) * cp;
    expect(Math.abs(tip.x - (px + dx * MUZZLE_OFFSET))).toBeLessThan(EPS);
    expect(Math.abs(tip.y - (py + dy * MUZZLE_OFFSET))).toBeLessThan(EPS);
    expect(Math.abs(tip.z - (pz + dz * MUZZLE_OFFSET))).toBeLessThan(EPS);
  });

  it('aim rotation: raised pose points at the aim, rest pose droops below it', () => {
    // Firing straight ahead of a yaw-0 unit: zero yaw offset, pitch only the
    // (negative) recoil kick at full recoil.
    const r0 = weaponAimRot(0, aim(0, 0), 0);
    expect(Math.abs(r0.yaw)).toBeLessThan(EPS);
    expect(Math.abs(r0.pitch)).toBeLessThan(EPS);
    const r1 = weaponAimRot(0, aim(0, 0), 1);
    expect(Math.abs(r1.pitch - (-WEAPON_RECOIL_PITCH))).toBeLessThan(EPS);

    // Firing away from the unit's facing: the local yaw offset cancels the
    // unit yaw, the pitch matches the shot elevation.
    const r2 = weaponAimRot(0.5, aim(0.5, 0.2), 0);
    expect(Math.abs(r2.yaw)).toBeLessThan(1e-6);
    expect(Math.abs(r2.pitch - (-0.2))).toBeLessThan(1e-6);

    // Third-person readability: the raised pitch (≈ shot elevation) is
    // clearly ABOVE the relaxed muzzle-down rest pitch (positive x = down).
    expect(WEAPON_REST_PITCH).toBeGreaterThan(0.3);
    expect(r2.pitch).toBeLessThan(WEAPON_REST_PITCH - 0.3);
  });
});
