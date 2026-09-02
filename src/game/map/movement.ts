// Character movement + collision.
// A character is a vertical cylinder (radius `r`) whose feet sit at pos.y.
// Collision is solved on the XZ plane against "wall" solids (any non-ramp solid
// whose top is higher than the character can step onto), plus ground-height
// following for the vertical axis (ramps / steps / platform edges).
// Pure: given (state, input, dt, map) it returns the new state. No DOM.

import type { Solid, Vec3, Unit, MapData } from '../types';
import { groundHeight } from './geometry';
import { CONFIG } from '../constants';

export interface MoveInput {
  vx: number; // desired world-space horizontal velocity (x)
  vz: number; // (z)
  jump: boolean;
}

export interface MoveResult {
  pos: Vec3;
  vel: { x: number; z: number };
  vy: number;
  grounded: boolean;
  collided: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Resolve a circle (cx,cz,r) out of every blocking solid's XZ footprint.
 * A solid blocks if it is not a ramp and its top is above the character's
 * current feet height + maxStep (i.e. a real wall, not a climbable floor).
 */
function resolveWalls(
  solids: readonly Solid[],
  cx: number,
  cz: number,
  r: number,
  feetY: number,
  maxStep: number
): { x: number; z: number; collided: boolean } {
  let x = cx;
  let z = cz;
  let collided = false;
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    for (let i = 0; i < solids.length; i++) {
      const s = solids[i];
      if (s.kind === 'ramp') continue;
      if (s.top <= feetY + maxStep + 1e-4) continue;
      const minX = s.x - s.sx / 2;
      const maxX = s.x + s.sx / 2;
      const minZ = s.z - s.sz / 2;
      const maxZ = s.z + s.sz / 2;
      const closestX = clamp(x, minX, maxX);
      const closestZ = clamp(z, minZ, maxZ);
      const dx = x - closestX;
      const dz = z - closestZ;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r) {
        collided = true;
        moved = true;
        if (d2 > 1e-12) {
          const d = Math.sqrt(d2);
          const push = r - d;
          x += (dx / d) * push;
          z += (dz / d) * push;
        } else {
          // Centre inside the box: push out along the nearest face.
          const penX = Math.min(x - minX, maxX - x);
          const penZ = Math.min(z - minZ, maxZ - z);
          if (penX < penZ) x = x - minX < maxX - x ? minX - r : maxX + r;
          else z = z - minZ < maxZ - cz ? minZ - r : maxZ + r;
        }
      }
    }
    if (!moved) break;
  }
  return { x, z, collided };
}

/**
 * Advance a character by one logic step.
 * @param pos    current feet position
 * @param vel    current horizontal velocity
 * @param vy     current vertical velocity
 * @param input  desired movement this tick
 */
export function moveCharacter(
  pos: Vec3,
  vel: { x: number; z: number },
  vy: number,
  grounded: boolean,
  input: MoveInput,
  dt: number,
  solids: readonly Solid[],
  r: number,
  maxStep: number,
  gravity: number,
  jumpVel: number,
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number }
): MoveResult {
  // ---- Vertical (jump / gravity / ground follow) ----
  let y = pos.y;
  let newVy = vy;
  if (input.jump && grounded) {
    newVy = jumpVel;
    grounded = false;
  }
  if (!grounded) {
    newVy -= gravity * dt;
    y += newVy * dt;
    const g = groundHeight(solids, pos.x, pos.z);
    if (y <= g && newVy <= 0) {
      y = g;
      newVy = 0;
      grounded = true;
    }
  }

  // ---- Horizontal with wall resolution ----
  let nx = pos.x + vel.x * dt;
  let nz = pos.z + vel.z * dt;
  const feetForWall = grounded ? y : pos.y;
  const res = resolveWalls(solids, nx, nz, r, feetForWall, maxStep);
  nx = res.x;
  nz = res.z;

  // Boundary safety (the boundary walls already block this; this is a belt
  // and braces so nothing ever leaves the arena).
  if (bounds) {
    nx = clamp(nx, bounds.minX + r, bounds.maxX - r);
    nz = clamp(nz, bounds.minZ + r, bounds.maxZ - r);
  }

  // ---- Ground follow (step up / walk off) ----
  if (grounded) {
    const g = groundHeight(solids, nx, nz);
    if (g > y) {
      // Only step up if within maxStep (a real wall already blocked the entry).
      y = g <= y + maxStep + 1e-4 ? g : y;
    } else {
      // Walking off an edge / descending a ramp.
      y = g;
    }
    if (y < 0) y = 0;
  }

  return { pos: { x: nx, y, z: nz }, vel, vy: newVy, grounded, collided: res.collided };
}

/** Convenience: is the horizontal point free of a blocking wall for a body of radius r? */
export function isStandable(
  solids: readonly Solid[],
  x: number,
  z: number,
  r: number,
  feetY: number,
  maxStep: number
): boolean {
  for (const s of solids) {
    if (s.kind === 'ramp') continue;
    if (s.top <= feetY + maxStep + 1e-4) continue;
    const minX = s.x - s.sx / 2;
    const maxX = s.x + s.sx / 2;
    const minZ = s.z - s.sz / 2;
    const maxZ = s.z + s.sz / 2;
    const cx = Math.max(minX, Math.min(x, maxX));
    const cz = Math.max(minZ, Math.min(z, maxZ));
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz < r * r) return false;
  }
  return true;
}

/**
 * Advance a Unit by one tick using a desired WORLD-space velocity (vx, vz).
 * Writes the new pos/vy/grounded/vel back onto the unit.
 */
export function stepUnit(unit: Unit, vx: number, vz: number, jump: boolean, map: MapData, dt: number): void {
  const res = moveCharacter(
    unit.pos, { x: vx, z: vz }, unit.vy, unit.grounded,
    { vx, vz, jump }, dt, map.solids,
    CONFIG.unitRadius, CONFIG.maxStep, CONFIG.gravity, CONFIG.jumpVelocity,
    { minX: map.bounds.minX, maxX: map.bounds.maxX, minZ: map.bounds.minZ, maxZ: map.bounds.maxZ }
  );
  unit.pos = res.pos;
  unit.vy = res.vy;
  unit.grounded = res.grounded;
  unit.vel = { x: vx, z: vz };
}
