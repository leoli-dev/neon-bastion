// Shot hit-resolution: resolve the first thing a bullet hits (wall or enemy),
// then apply damage + scoring. This is where "no hits through walls" and "one
// bullet = at most one score" are enforced.
//
// The resolution logic is shared by two entry points so the invariants
// (wall priority, head/body hitboxes, friendly fire OFF, one score per shot)
// hold identically in both:
//   * resolveShot / fireWeapon — the classic immediate (hitscan) path, still
//     the default when fireWeapon is called WITHOUT a BulletSystem;
//   * applyImpact — used by BulletSystem.step at the moment a ballistic
//     bullet ARRIVES, deferring damage/scoring from "fire time" to "arrival".

import type { Solid, Unit, Vec3, ShotResolution, HitPart } from '../types';
import type { BulletSystem } from './bullet';
import { CONFIG } from '../constants';
import { raycastMap, raycastAABB, raycastSphere } from '../map/geometry';
import { bodyAABB, headCenter, HEAD_RADIUS } from '../units/units';
import { registerShot, fireDirectionFor } from './weapon';

export const FLASH_TIME = 0.12; // seconds a target flashes when hit

/**
 * Resolve what a single bullet hits, from a given origin. Wall-priority: a
 * target only takes damage if it is closer than any wall. Returns a single
 * nearest result (never two). `shooter` is used for identity (never hits
 * itself) and team (friendly fire is OFF) only — not for position, which is
 * `origin`. That is what lets a flying bullet re-resolve from wherever it is
 * right now, even if the shooter has since moved or died.
 */
export function resolveShotFrom(
  units: readonly Unit[],
  solids: readonly Solid[],
  shooter: Unit,
  origin: Vec3,
  dir: Vec3,
  maxDist = 200
): ShotResolution {
  const wall = raycastMap(solids, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist);
  const wallDist = wall ? wall.distance : Infinity;

  let bestUnit: Unit | null = null;
  let bestPart: HitPart = 'body';
  let bestDist = Infinity;
  let bestPoint: Vec3 = { x: 0, y: 0, z: 0 };

  for (const u of units) {
    if (!u.alive || u.id === shooter.id) continue;
    if (u.team === shooter.team) continue; // friendly fire is OFF
    const box = bodyAABB(u);
    // Reuse the slab math against a synthetic solid built from the body box.
    const synthetic: Solid = {
      id: -1,
      x: (box.minX + box.maxX) / 2,
      z: (box.minZ + box.maxZ) / 2,
      sx: box.maxX - box.minX,
      sz: box.maxZ - box.minZ,
      bottom: box.minY,
      top: box.maxY,
      kind: 'cover',
    };
    const bHit = raycastAABB(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, synthetic);
    const hc = headCenter(u);
    const headT = raycastSphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, hc.x, hc.y, hc.z, HEAD_RADIUS);

    let candT = Infinity;
    let candPart: HitPart = 'body';
    if (bHit && bHit.t >= 0) {
      candT = bHit.t;
      candPart = 'body';
    }
    if (headT != null && headT < candT) {
      candT = headT;
      candPart = 'head';
    }
    if (candT < Infinity && candT < bestDist && candT < wallDist) {
      bestDist = candT;
      bestUnit = u;
      bestPart = candPart;
      bestPoint = { x: origin.x + dir.x * candT, y: origin.y + dir.y * candT, z: origin.z + dir.z * candT };
    }
  }

  if (bestUnit) {
    return { kind: 'unit', unitId: bestUnit.id, part: bestPart, point: bestPoint, distance: bestDist };
  }
  if (wall) {
    return { kind: 'wall', point: wall.point, distance: wall.distance, wallSolidId: wall.solidId };
  }
  return { kind: 'miss', point: { x: origin.x + dir.x * maxDist, y: origin.y + dir.y * maxDist, z: origin.z + dir.z * maxDist }, distance: maxDist };
}

/** Resolve from the shooter's eye — the classic hitscan entry point. */
export function resolveShot(
  units: readonly Unit[],
  solids: readonly Solid[],
  shooter: Unit,
  dir: Vec3,
  maxDist = 200
): ShotResolution {
  return resolveShotFrom(units, solids, shooter, eyeOf(shooter), dir, maxDist);
}

/** Eye position (world) of a shooter. */
export function eyeOf(u: Unit): Vec3 {
  return { x: u.pos.x, y: u.pos.y + CONFIG.eyeHeight, z: u.pos.z };
}

export interface ImpactResult {
  damage: number;
  targetId: number | null;
  part: HitPart | null;
  killed: boolean;
  points: number; // points earned by the shooter by this bullet
}

/**
 * Settle the impact of ONE bullet: apply damage (head vs body), flash the
 * target, credit the hit, and — on a killing blow — the kill bonus. One
 * bullet scores at most once. The shooter may already be DEAD when a flying
 * bullet arrives; the hit still settles (simpler to implement and intuitive:
 * the bullet left your gun, the bullet landed).
 */
export function applyImpact(
  units: readonly Unit[],
  shooter: Unit,
  resolution: ShotResolution,
  now: number
): ImpactResult {
  let damage = 0;
  let targetId: number | null = null;
  let part: HitPart | null = null;
  let killed = false;
  let points = 0;

  if (resolution.kind === 'unit' && resolution.unitId != null) {
    const target = units.find((u) => u.id === resolution.unitId);
    if (target) {
      damage = resolution.part === 'head' ? CONFIG.damageHead : CONFIG.damageBody;
      target.hp = Math.max(0, target.hp - damage);
      target.lastHitBy = shooter.id;
      target.flashUntil = now + FLASH_TIME;
      targetId = target.id;
      part = resolution.part ?? null;
      // Valid hit -> +1
      shooter.hitScore += 1;
      shooter.totalScore += 1;
      points += 1;
      if (target.hp <= 0 && target.alive) {
        target.alive = false;
        target.deathAt = now;
        target.hp = 0;
        // Killing blow -> +3 extra
        shooter.kills += 1;
        shooter.totalScore += 3;
        points += 3;
        killed = true;
      }
    }
  }
  return { damage, targetId, part, killed, points };
}

export interface FireResult {
  fired: boolean;
  shotIndex: number | null;
  aim: Vec3 | null; // the actual (spread) shot direction
  resolution: ShotResolution | null; // null while the bullet is still in flight
  damage: number;
  targetId: number | null;
  part: HitPart | null;
  killed: boolean;
  points: number; // points earned by the shooter on this shot
  /** Id of the in-flight bullet in the match's BulletSystem (null on the
   *  immediate hitscan path). */
  bulletId: number | null;
}

/**
 * Full fire pipeline: check the fire-rate cooldown, apply spread, then either
 * spawn a ballistic bullet (when `bullets` is provided — resolution is
 * deferred to arrival by BulletSystem.step) or resolve the shot immediately
 * (classic hitscan). Each call = one bullet = at most one score. Friendly
 * fire is off (same-team targets are ignored).
 */
export function fireWeapon(opts: {
  units: readonly Unit[];
  solids: readonly Solid[];
  shooter: Unit;
  aim: Vec3;
  now: number;
  seed: number;
  maxDist?: number;
  /** When given, the shot spawns a bullet in this system and damage/scoring
   *  are deferred to the moment it arrives. Omit for immediate hitscan. */
  bullets?: BulletSystem;
}): FireResult {
  const { units, solids, shooter, aim, now, seed } = opts;
  const shotIndex = registerShot(shooter, now);
  if (shotIndex == null) {
    return {
      fired: false, shotIndex: null, aim: null, resolution: null,
      damage: 0, targetId: null, part: null, killed: false, points: 0,
      bulletId: null,
    };
  }
  const speed = Math.hypot(shooter.vel.x, shooter.vel.z);
  const dir = fireDirectionFor(aim, seed, shotIndex, shooter.heat, speed);

  if (opts.bullets) {
    const bulletId = opts.bullets.spawn({
      shooterId: shooter.id,
      shotIndex,
      origin: eyeOf(shooter),
      dir,
      maxDist: opts.maxDist ?? 200,
    });
    return {
      fired: true, shotIndex, aim: dir, resolution: null,
      damage: 0, targetId: null, part: null, killed: false, points: 0,
      bulletId,
    };
  }

  const resolution = resolveShot(units, solids, shooter, dir, opts.maxDist ?? 200);
  const imp = applyImpact(units, shooter, resolution, now);
  return {
    fired: true, shotIndex, aim: dir, resolution,
    damage: imp.damage, targetId: imp.targetId, part: imp.part,
    killed: imp.killed, points: imp.points, bulletId: null,
  };
}
