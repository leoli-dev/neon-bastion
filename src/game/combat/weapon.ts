// Automatic rifle: fire-rate throttle, recoil "heat",
// and deterministic spread. There are no magazines, reserve ammo or reloads —
// the 1-shot/second fire interval is the ONLY thing limiting firing.
//
// Spread is fully deterministic: given the same master seed, shot index, heat
// and horizontal speed, the exact bullet direction is reproducible (via
// shotRandom). That makes "same seed + same shot index => same spread" testable.

import type { Unit, Vec3 } from '../types';
import { CONFIG } from '../constants';
import { shotRandom } from '../rng';

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Spread cone (radians) for a shot given recoil heat and horizontal speed. */
export function computeSpreadCone(heat: number, speed: number): number {
  return CONFIG.spreadBase + heat * CONFIG.spreadHeatScale + speed * CONFIG.spreadMoveScale;
}

/**
 * Perturb an aim direction by `cone` radians at `azimuth` (world).
 * Builds a right/up basis from the aim so the spread is consistent regardless
 * of the look direction.
 */
export function perturbDirection(aim: Vec3, cone: number, azimuth: number): Vec3 {
  const a = norm(aim);
  const worldUp = { x: 0, y: 1, z: 0 };
  let right = cross(a, worldUp);
  if (Math.hypot(right.x, right.y, right.z) < 1e-4) right = { x: 1, y: 0, z: 0 };
  right = norm(right);
  const up = norm(cross(right, a));
  const dx = a.x + Math.cos(azimuth) * cone * right.x + Math.sin(azimuth) * cone * up.x;
  const dy = a.y + Math.cos(azimuth) * cone * right.y + Math.sin(azimuth) * cone * up.y;
  const dz = a.z + Math.cos(azimuth) * cone * right.z + Math.sin(azimuth) * cone * up.z;
  return norm({ x: dx, y: dy, z: dz });
}

/**
 * Deterministic bullet direction for a shot.
 * `seed` + `shotIndex` select the azimuth; `heat` and `speed` set the cone.
 */
export function fireDirectionFor(
  aim: Vec3,
  seed: number,
  shotIndex: number,
  heat: number,
  speed: number
): Vec3 {
  const cone = computeSpreadCone(heat, speed);
  const azimuth = shotRandom(seed, shotIndex) * Math.PI * 2;
  return perturbDirection(aim, cone, azimuth);
}

// --- Weapon state transitions (operate on a Unit) -------------------------

export function canFire(u: Unit, now: number): boolean {
  return u.alive && now - u.lastShotAt >= CONFIG.fireInterval;
}

/**
 * If the unit can fire, record the shot. Returns the shot index used (for
 * deterministic spread), or null if it could not fire (dead or cooldown).
 */
export function registerShot(u: Unit, now: number): number | null {
  if (!canFire(u, now)) return null;
  u.lastShotAt = now;
  u.shotIndex += 1;
  u.heat = Math.min(CONFIG.spreadHeatMax, u.heat + CONFIG.spreadHeatPerShot);
  return u.shotIndex;
}

/** Recover recoil heat when the trigger is released (called every tick). */
export function recoverHeat(u: Unit, dt: number, firing: boolean): void {
  if (!u.alive) return;
  if (firing) return;
  u.heat = Math.max(0, u.heat - CONFIG.spreadHeatRecovery * dt);
}
