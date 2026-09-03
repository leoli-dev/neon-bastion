// Pure geometry: ray/box, ray/sphere, ground height and walkability.
// Shared by collision, hitscan, navigation and AI perception so they all agree
// on the same map model. No three.js, no DOM.

import type { Solid, Vec3, MapRayHit } from '../types';

const EPS = 1e-9;

/** Is (x,z) within the horizontal footprint of the solid? */
export function pointInSolidXZ(s: Solid, x: number, z: number): boolean {
  return (
    x >= s.x - s.sx / 2 - EPS &&
    x <= s.x + s.sx / 2 + EPS &&
    z >= s.z - s.sz / 2 - EPS &&
    z <= s.z + s.sz / 2 + EPS
  );
}

/**
 * The surface height a single solid contributes at (x,z).
 * Boxes return their top; ramps interpolate between bottom and top.
 * Returns -Infinity if the point is not horizontally under the solid.
 */
export function surfaceHeight(s: Solid, x: number, z: number): number {
  if (!pointInSolidXZ(s, x, z)) return -Infinity;
  if (s.kind !== 'ramp' || !s.rampAxis) return s.top;
  const half = s.rampAxis === 'x' ? s.sx / 2 : s.sz / 2;
  const center = s.rampAxis === 'x' ? s.x : s.z;
  const p = s.rampAxis === 'x' ? x : z;
  const low = center - half;
  const high = center + half;
  // rampHighPositive true => the +end (high) is the high end.
  let t: number;
  if (s.rampHighPositive) t = (p - low) / (high - low);
  else t = (high - p) / (high - low);
  t = Math.max(0, Math.min(1, t));
  return s.bottom + (s.top - s.bottom) * t;
}

/** Ground height = the highest solid surface under (x,z), clamped to >= 0. */
export function groundHeight(solids: readonly Solid[], x: number, z: number): number {
  let h = 0;
  for (let i = 0; i < solids.length; i++) {
    const hh = surfaceHeight(solids[i], x, z);
    if (hh > h) h = hh;
  }
  return h;
}

export interface BoxHit {
  t: number;
  point: Vec3;
  normal: Vec3;
}

/**
 * Ray vs axis-aligned box (slab method). `dir` should be normalized so that
 * `t` is the distance along the ray. Returns the nearest entry, or null.
 */
export function raycastAABB(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  s: Solid
): BoxHit | null {
  const minX = s.x - s.sx / 2;
  const maxX = s.x + s.sx / 2;
  const minY = s.bottom;
  const maxY = s.top;
  const minZ = s.z - s.sz / 2;
  const maxZ = s.z + s.sz / 2;

  let tmin = -Infinity;
  let tmax = Infinity;
  let normalAxis = 0; // 0=x 1=y 2=z

  // X
  if (Math.abs(dx) < EPS) {
    if (ox < minX || ox > maxX) return null;
  } else {
    let t1 = (minX - ox) / dx;
    let t2 = (maxX - ox) / dx;
    let n = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      n = 1;
    } else n = 1;
    if (t1 > tmin) {
      tmin = t1;
      normalAxis = 0;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  // Y
  if (Math.abs(dy) < EPS) {
    if (oy < minY || oy > maxY) return null;
  } else {
    let t1 = (minY - oy) / dy;
    let t2 = (maxY - oy) / dy;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) {
      tmin = t1;
      normalAxis = 1;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  // Z
  if (Math.abs(dz) < EPS) {
    if (oz < minZ || oz > maxZ) return null;
  } else {
    let t1 = (minZ - oz) / dz;
    let t2 = (maxZ - oz) / dz;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) {
      tmin = t1;
      normalAxis = 2;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }

  // Origin inside the box => treat as an immediate hit.
  if (tmin < 0) {
    if (tmax < 0) return null;
    tmin = 0;
  }

  const point: Vec3 = { x: ox + dx * tmin, y: oy + dy * tmin, z: oz + dz * tmin };
  let normal: Vec3 = { x: 0, y: 0, z: 0 };
  if (normalAxis === 0) {
    normal.x = tmin === 0 ? (ox >= s.x ? 1 : -1) : ox < s.x ? -1 : 1;
  } else if (normalAxis === 1) {
    normal.y = oy < s.bottom ? -1 : 1;
  } else {
    normal.z = oz < s.z ? -1 : 1;
  }
  return { t: tmin, point, normal };
}

/** Ray vs sphere. Returns t (distance) of nearest intersection, or null. */
export function raycastSphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  r: number
): number | null {
  const fx = ox - cx;
  const fy = oy - cy;
  const fz = oz - cz;
  const b = fx * dx + fy * dy + fz * dz;
  const c = fx * fx + fy * fy + fz * fz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  if (t < 0) {
    // origin inside sphere
    t = 0;
  }
  return t;
}

/**
 * Nearest solid intersected by a ray (for occlusion / bullet impact).
 * Returns the hit or null if nothing within maxDist.
 */
export function raycastMap(
  solids: readonly Solid[],
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number
): MapRayHit | null {
  let best: MapRayHit | null = null;
  let bestT = maxDist;
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    const hit = raycastAABB(ox, oy, oz, dx, dy, dz, s);
    if (hit && hit.t >= 0 && hit.t < bestT) {
      bestT = hit.t;
      best = { solidId: s.id, point: hit.point, distance: hit.t, normal: hit.normal };
    }
  }
  return best;
}

/**
 * Is the straight horizontal path from A to B actually walkable?
 * Walkability = consecutive samples never require stepping up more than
 * `maxStep`. This is what lets a ramp produce a valid climb link while a
 * sudden 1.2m platform edge does NOT (so AI never "flies" over an unclimbable
 * edge). Used to build navigation links so paths never cross a wall.
 */
export function isWalkablePath(
  solids: readonly Solid[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
  maxStep: number
): boolean {
  const dist = Math.hypot(bx - ax, bz - az);
  if (dist < EPS) return true;
  const steps = Math.max(2, Math.ceil(dist / 0.5));
  let prev = groundHeight(solids, ax, az);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    const g = groundHeight(solids, x, z);
    if (g - prev > maxStep + 1e-4) return false;
    // reject stepping down into a hole that is deeper than a normal step too
    // (there are no holes in this map, but keep it symmetric for safety).
    if (prev - g > maxStep + 1.6) return false;
    prev = g;
  }
  return true;
}

/** Options for line queries (MAP-02). */
export interface LineQueryOptions {
  /**
   * Whether glass is transparent to this line. Sight lines (AI vision, cover
   * checks) default to `true` — you can SEE through glass. Ballistic lines
   * (pre-shot fire check) must pass `false` — bullets are STOPPED by glass,
   * so the AI must never fire across it. `raycastMap()` itself is left
   * unchanged and always treats glass as opaque.
   */
  throughGlass?: boolean;
}

/**
 * Horizontal line-of-sight (for AI perception / nav). Checks at `height` so a
 * 1.2m platform does not block a 1.6m sight-line, while 2.5m+ cover does.
 *
 * MAP-02: sight lines pass THROUGH glass by default (`throughGlass` true)
 * while ballistic queries (`throughGlass: false`) are blocked by it, so
 * "can see" and "can hit" are no longer the same test. The ray here is a
 * straight A→B segment (same math as `raycastMap` over a filtered solid set),
 * so both variants stay exact.
 */
export function losClear(
  solids: readonly Solid[],
  ax: number,
  az: number,
  ay: number,
  bx: number,
  bz: number,
  by: number,
  height: number,
  maxDist?: number,
  opts?: LineQueryOptions
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < EPS) return true;
  const ddx = dx / len;
  const ddy = dy / len;
  const ddz = dz / len;
  const md = maxDist ?? len;
  const throughGlass = opts?.throughGlass !== false;
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (throughGlass && s.material === 'glass') continue;
    const hit = raycastAABB(ax, ay, az, ddx, ddy, ddz, s);
    if (hit && hit.t >= 0 && hit.t < md) {
      // A solid blocks the line if it is tall enough to intersect the sight
      // line at the sampled height. raycastAABB accounts for the box extents,
      // so any hit means occlusion.
      return false;
    }
  }
  return true;
}

/**
 * Ballistic line of fire (MAP-02): the straight eye→target segment as a
 * PROJECTILE would travel it — glass blocks, everything else blocks.
 * Opposite of the sight-line default: `losClear` (see above) lets you see
 * through glass; this check must fail when a glass wall stands between the
 * eyes and the target's torso, so the AI repositions instead of firing into
 * glass. Reuses `losClear` with `throughGlass: false`.
 */
export function lineOfFireClear(
  solids: readonly Solid[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number
): boolean {
  return losClear(
    solids,
    ax, az, ay,
    bx, bz, by,
    1.0,
    undefined,
    { throughGlass: false }
  );
}
