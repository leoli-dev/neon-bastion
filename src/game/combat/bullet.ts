// Ballistic projectile system. Bullets FLY at CONFIG.bulletSpeed, so a shot
// takes distance/bulletSpeed seconds to arrive — that flight time is what
// makes mid/long-range shots dodgeable.
//
// Continuous collision: every logic tick, the *segment* the bullet travels
// this frame (length bulletSpeed × dt, bounded by the remaining range) is
// ray-cast through resolveShotFrom — the EXACT same code path as hitscan, so
// the four invariants (wall priority, head/body hitboxes, friendly fire OFF,
// one score per bullet) apply at arrival, and a fast bullet can never skip
// ("tunnel") through a wall: a discrete "is the point inside a wall" check
// would, the segment raycast cannot.
//
// Impact settlement (damage, scoring, kill) happens only when the bullet
// ARRIVES, via applyImpact — the shooter may be dead by then; the hit still
// settles (see applyImpact).
//
// Pooling follows the renderer's sparks/tracers pattern: a fixed pool of
// MAX_BULLETS slots with a hard lifetime cap (CONFIG.bulletMaxAge) so nothing
// accumulates.

import type { Solid, Unit, Vec3, ShotResolution } from '../types';
import { CONFIG } from '../constants';
import { resolveShotFrom, applyImpact, type FireResult } from './hitscan';

/** Pool cap: at most this many bullets in flight (slots recycle when full). */
export const MAX_BULLETS = 64;

export interface Bullet {
  id: number;
  active: boolean;
  shooterId: number;
  shotIndex: number;
  /** Last resolved position — always outside geometry (continuous). */
  pos: Vec3;
  /** Normalized flight direction. */
  dir: Vec3;
  /** Distance still allowed to fly before the bullet expires. */
  remaining: number;
  /** Seconds in flight (for the lifetime cap). */
  age: number;
  /** Set when the bullet settles (unit / wall / miss). */
  result: FireResult | null;
}

export interface BulletSpawn {
  shooterId: number;
  shotIndex: number;
  origin: Vec3;
  dir: Vec3;
  maxDist: number;
}

export class BulletSystem {
  readonly bullets: Bullet[] = [];
  private cursor = 0;
  private nextId = 1;

  private newBullet(): Bullet {
    return {
      id: 0, active: false, shooterId: -1, shotIndex: 0,
      pos: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 },
      remaining: 0, age: 0, result: null,
    };
  }

  /** Spawn a bullet. Returns its id, or null if it could not be spawned. */
  spawn(o: BulletSpawn): number | null {
    let b: Bullet;
    if (this.bullets.length < MAX_BULLETS) {
      b = this.newBullet();
      this.bullets.push(b);
    } else {
      // Pool exhausted: recycle a slot (oldest cursor, like the renderer's
      // effect pools). With 1 shot/s per shooter and short flight times this
      // cap is effectively unreachable.
      b = this.bullets[this.cursor++ % MAX_BULLETS];
    }
    b.id = this.nextId++;
    b.active = true;
    b.shooterId = o.shooterId;
    b.shotIndex = o.shotIndex;
    b.pos = { x: o.origin.x, y: o.origin.y, z: o.origin.z };
    b.dir = { x: o.dir.x, y: o.dir.y, z: o.dir.z };
    b.remaining = o.maxDist;
    b.age = 0;
    b.result = null;
    return b.id;
  }

  get(id: number): Bullet | null {
    return this.bullets.find((b) => b.id === id) ?? null;
  }

  get activeCount(): number {
    let n = 0;
    for (const b of this.bullets) if (b.active) n++;
    return n;
  }

  /** Release every bullet (match reset). */
  clear(): void {
    for (const b of this.bullets) b.active = false;
  }

  /**
   * Advance all active bullets by one logic step.
   *
   * Per bullet: the segment [pos, pos + dir × min(bulletSpeed·dt, remaining)]
   * is resolved with resolveShotFrom. If the first hit lies INSIDE that
   * segment, the bullet stops exactly at the hit point and settles there
   * (damage + scoring via applyImpact, and `onImpact` fires); otherwise the
   * bullet advances the full segment and keeps flying.
   */
  step(
    dt: number,
    now: number,
    units: readonly Unit[],
    solids: readonly Solid[],
    onImpact?: (b: Bullet) => void
  ): void {
    for (const b of this.bullets) {
      if (!b.active) continue;
      const stepDist = Math.min(CONFIG.bulletSpeed * dt, b.remaining);
      const shooter = units.find((u) => u.id === b.shooterId);
      if (!shooter || stepDist <= 0) {
        b.active = false; // shooter gone from the roster / nothing left to fly
        continue;
      }
      const res = resolveShotFrom(units, solids, shooter, b.pos, b.dir, stepDist);
      if (res.kind !== 'miss' && res.distance <= stepDist) {
        // The first thing on the line is within this frame's segment:
        // land exactly on it (continuous collision — no tunneling).
        b.pos = res.point;
        b.remaining = Math.max(0, b.remaining - res.distance);
        b.age += res.distance / CONFIG.bulletSpeed;
        b.active = false;
        b.result = this.settle(b, shooter, res, units, now);
        onImpact?.(b);
      } else {
        // Nothing within this frame's segment: advance exactly the segment.
        b.pos = {
          x: b.pos.x + b.dir.x * stepDist,
          y: b.pos.y + b.dir.y * stepDist,
          z: b.pos.z + b.dir.z * stepDist,
        };
        b.remaining -= stepDist;
        b.age += stepDist / CONFIG.bulletSpeed;
        if (b.remaining <= 1e-6 || b.age >= CONFIG.bulletMaxAge) {
          // Out of range (or lifetime cap): the bullet simply vanishes —
          // it hit nothing, so it scores nothing.
          b.active = false;
          b.result = this.settle(b, shooter, { kind: 'miss', point: b.pos, distance: b.age * CONFIG.bulletSpeed }, units, now);
        }
      }
    }
  }

  /** Build the FireResult that records how a bullet settled. */
  private settle(
    b: Bullet,
    shooter: Unit,
    res: ShotResolution,
    units: readonly Unit[],
    now: number
  ): FireResult {
    const imp = applyImpact(units, shooter, res, now);
    return {
      fired: true,
      shotIndex: b.shotIndex,
      aim: { x: b.dir.x, y: b.dir.y, z: b.dir.z },
      resolution: res,
      damage: imp.damage,
      targetId: imp.targetId,
      part: imp.part,
      killed: imp.killed,
      points: imp.points,
      bulletId: b.id,
    };
  }
}
