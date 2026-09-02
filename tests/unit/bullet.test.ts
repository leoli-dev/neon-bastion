// Ballistic projectile system (task 5): bullets fly at CONFIG.bulletSpeed and
// their hit settles at ARRIVAL, with continuous (segment) collision so they
// can never tunnel through walls. The hit-resolution logic itself is the
// shared hitscan path (resolveShotFrom + applyImpact), so the classic
// invariant tests in hitscan.test.ts still hold; these tests cover the
// flight-time / tunneling / dead-shooter behaviour that only a projectile
// system has.

import { describe, it, expect } from 'vitest';
import { Match } from '@/game/match';
import type { MatchEvent } from '@/game/match';
import { BulletSystem } from '@/game/combat/bullet';
import { createUnit } from '@/game/units/units';
import { CONFIG } from '@/game/constants';
import type { MapData, Solid, Unit } from '@/game/types';

const DT = 1 / 60;

const EYE_Y = 1.62;

/** A clean open arena (only outer walls) — no interior occlusion surprises. */
function openMap(): MapData {
  return {
    name: 'open',
    bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
    solids: [
      { id: 0, x: 0, z: -31, sx: 64, sz: 2, bottom: 0, top: 6, kind: 'boundary' },
      { id: 1, x: 0, z: 31, sx: 64, sz: 2, bottom: 0, top: 6, kind: 'boundary' },
      { id: 2, x: -31, z: 0, sx: 2, sz: 64, bottom: 0, top: 6, kind: 'boundary' },
      { id: 3, x: 31, z: 0, sx: 2, sz: 64, bottom: 0, top: 6, kind: 'boundary' },
    ],
    spawns: {
      blue: [{ x: -3, z: 24, yaw: Math.PI }, { x: 3, z: 24, yaw: Math.PI }, { x: -3, z: 27, yaw: Math.PI }, { x: 3, z: 27, yaw: Math.PI }],
      red: [{ x: -3, z: -24, yaw: 0 }, { x: 3, z: -24, yaw: 0 }, { x: -3, z: -27, yaw: 0 }, { x: 3, z: -27, yaw: 0 }],
    },
    navNodes: [
      { id: 0, x: 0, z: 0 }, { id: 1, x: 0, z: 10 }, { id: 2, x: 0, z: -10 },
      { id: 3, x: -10, z: 0 }, { id: 4, x: 10, z: 0 }, { id: 5, x: 0, z: 20 },
      { id: 6, x: 0, z: -20 }, { id: 7, x: -10, z: 10 }, { id: 8, x: 10, z: 10 },
      { id: 9, x: -10, z: -10 }, { id: 10, x: 10, z: -10 },
    ].map((n) => ({ ...n, y: 0 })),
  };
}

/** Fly a bullet through open air for `range` units at tick `dt`; return the
 *  flight time (seconds of simulated time until it settled). */
function flightTime(range: number, dt: number): number {
  const shooter = createUnit(0, 'S', 'blue', true, 0, 0, 0);
  const sys = new BulletSystem();
  const id = sys.spawn({
    shooterId: 0, shotIndex: 1,
    origin: { x: 0, y: EYE_Y, z: 0 },
    dir: { x: 0, y: 0, z: 1 },
    maxDist: range,
  })!;
  const b = sys.get(id)!;
  let t = 0;
  for (let i = 0; i < 60 * 120 && b.active; i++) {
    sys.step(dt, t, [shooter], []);
    t += dt;
  }
  return t;
}

describe('bullet: flight time', () => {
  it('flight time is proportional to distance (t = d / bulletSpeed)', () => {
    const t100 = flightTime(100, DT);
    const t200 = flightTime(200, DT);
    // ~1.667 s at 60 u/s (within one tick of quantization).
    expect(t100).toBeCloseTo(100 / CONFIG.bulletSpeed, 1);
    expect(
      t200 / t100,
      'doubling the distance must double the flight time'
    ).toBeCloseTo(2, 1);
  });
});

// A wall at z=5 (front face at z=4.5), 4 wide (x -2..2), 1 thick, 3 m tall —
// an enemy sits 5 units behind it.
const wall: Solid = { id: 99, x: 0, z: 5, sx: 4, sz: 1, bottom: 0, top: 3, kind: 'wall' };

function flyAtWall(dt: number): { b: NonNullable<ReturnType<BulletSystem['get']>>; enemy: Unit } {
  const shooter = createUnit(0, 'S', 'blue', true, 0, 0, 0);
  const enemy = createUnit(1, 'E', 'red', false, 0, 10, 0);
  const sys = new BulletSystem();
  const id = sys.spawn({
    shooterId: 0, shotIndex: 1,
    origin: { x: 0, y: EYE_Y, z: 0 },
    dir: { x: 0, y: 0, z: 1 },
    maxDist: 20,
  })!;
  let t = 0;
  for (let i = 0; i < 600; i++) {
    sys.step(dt, t, [shooter, enemy], [wall]);
    t += dt;
    if (!sys.get(id)!.active) break;
  }
  return { b: sys.get(id)!, enemy };
}

describe('bullet: no tunneling (continuous collision)', () => {
  it('a huge step (30 units vs a 1-unit wall) still lands on the wall face', () => {
    // One 0.5 s step moves the bullet 30 units — far more than the wall's
    // thickness, so a discrete "is the point inside a wall" check would jump
    // OVER the wall and hit the enemy behind it.
    const { b, enemy } = flyAtWall(0.5);
    expect(b.active).toBe(false);
    expect(b.result!.resolution!.kind).toBe('wall');
    expect(b.result!.resolution!.point.z, 'impact on the front face').toBeCloseTo(4.5, 5);
    expect(enemy.hp, 'nothing may pass through the wall').toBe(100);
  });

  it('the same holds at the real 60 Hz tick', () => {
    const { b, enemy } = flyAtWall(DT);
    expect(b.active).toBe(false);
    expect(b.result!.resolution!.kind).toBe('wall');
    expect(enemy.hp).toBe(100);
  });
});

describe('bullet: shooter death during flight', () => {
  it('a bullet fired by a unit that dies mid-flight still settles, scores and kills', () => {
    const m = new Match(17, openMap());
    const shooter = m.units[0]; // the player
    const foe = m.units[4];
    // Everyone out of the fight except shooter, foe and one parked ally.
    for (const idx of [2, 3, 5, 6, 7]) {
      m.units[idx].alive = false;
      m.units[idx].hp = 0;
    }
    m.units[1].pos = { x: -26, y: 0, z: 26 }; // keep blue alive w/o interference
    m.units[1].vel = { x: 0, z: 0 };
    foe.ai = null; // no return fire
    foe.pos = { x: 0, y: 0, z: 10 }; // 10 units away -> ~0.17 s of flight
    foe.vel = { x: 0, z: 0 };
    foe.hp = 15; // a single bullet is a killing blow
    shooter.pos = { x: 0, y: 0, z: 20 };

    const events: MatchEvent[] = [];
    m.onEvent = (e) => events.push(e);

    const r = m.firePlayerShot({ x: 0, y: 0, z: -1 });
    expect(r, 'the shot must register').not.toBeNull();
    expect(r!.fired).toBe(true);
    expect(r!.bulletId, 'the shot must spawn an in-flight bullet').not.toBeNull();
    expect(r!.resolution, 'no resolution while the bullet is in flight').toBeNull();

    // The shooter dies while the bullet is still airborne.
    shooter.alive = false;
    shooter.hp = 0;
    shooter.deathAt = m.now;

    for (let i = 0; i < 24; i++) m.tick(DT);

    expect(foe.alive, 'the in-flight bullet must still kill on arrival').toBe(false);
    expect(foe.hp).toBe(0);
    expect(shooter.hitScore, 'the hit is credited to the (now-dead) shooter').toBe(1);
    expect(shooter.kills, 'the kill is credited to the (now-dead) shooter').toBe(1);

    const impact = events.find((e): e is Extract<MatchEvent, { type: 'impact' }> =>
      e.type === 'impact' && e.shooterId === shooter.id
    );
    expect(impact, 'the impact event must fire at arrival').toBeDefined();
    expect(impact!.res.targetId).toBe(foe.id);
    expect(impact!.res.killed).toBe(true);

    const hit = events.find((e) => e.type === 'hit' && e.victimId === foe.id);
    expect(hit, 'a hit event must fire at arrival').toBeDefined();
    const kill = events.find((e) => e.type === 'kill' && e.killerId === shooter.id && e.victimId === foe.id);
    expect(kill, 'a kill event must fire at arrival').toBeDefined();
  });
});
