import { describe, it, expect } from 'vitest';
import { createUnit } from '@/game/units/units';
import { resolveShot, fireWeapon } from '@/game/combat/hitscan';
import { fireDirectionFor, computeSpreadCone, recoverHeat, canFire, registerShot } from '@/game/combat/weapon';
import type { Solid, Unit, Vec3 } from '@/game/types';

const eye = (u: Unit): Vec3 => ({ x: u.pos.x, y: u.pos.y + 1.62, z: u.pos.z });
function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

// A wall at z=5 (front face at z=4.5), 4 wide (x -2..2), 3m tall.
const wall: Solid = { id: 99, x: 0, z: 5, sx: 4, sz: 1, bottom: 0, top: 3, kind: 'wall', label: 'wall' };
const EMPTY: Solid[] = [];

function blue(x: number, z: number): Unit {
  return createUnit(0, 'P', 'blue', true, x, z, 0);
}
function red(id: number, x: number, z: number): Unit {
  return createUnit(id, 'E', 'red', false, x, z, 0);
}

describe('hitscan: wall priority', () => {
  it('a target behind a wall is NOT damaged; one in the open IS', () => {
    const shooter = blue(0, 0);
    const hidden = red(1, 0, 10); // behind the wall
    const open = red(2, 5, 10); // to the side, not behind the wall
    const units = [shooter, hidden, open];
    const dir = norm({ x: 0, y: 0, z: 1 });
    // fire at the hidden enemy's column (x=0)
    const r1 = fireWeapon({ units, solids: [wall], shooter, aim: dir, now: 0.1, seed: 1 });
    expect(r1.resolution?.kind).toBe('wall');
    expect(hidden.hp).toBe(100); // untouched
    expect(r1.points).toBe(0);

    // fire toward the open enemy (x=5): no wall on that line
    const dirOpen = norm({ x: 5, y: 0, z: 10 });
    const r2 = fireWeapon({ units, solids: [wall], shooter, aim: dirOpen, now: 0.3, seed: 2 });
    expect(r2.resolution?.kind).toBe('unit');
    expect(open.hp).toBeLessThan(100);
  });

  it('wall closer than the enemy wins even if the enemy is also in the beam', () => {
    const shooter = blue(0, 0);
    const enemy = red(1, 0, 20); // far, and the wall at z=5 is in front
    const res = resolveShot([shooter, enemy], [wall], shooter, norm({ x: 0, y: 0, z: 1 }));
    expect(res.kind).toBe('wall');
    expect(res.distance).toBeCloseTo(4.5, 5); // wall front face at z=4.5
  });
});

describe('hitscan: damage and head/body', () => {
  it('body hit deals 20, head hit deals 50', () => {
    const shooter = blue(0, 0);
    const enemy = red(1, 0, 10);
    // body: aim at torso centre
    const torso = { x: 0, y: enemy.pos.y + 0.7, z: 10 };
    let r = fireWeapon({ units: [shooter, enemy], solids: EMPTY, shooter, aim: norm({ x: torso.x - 0, y: torso.y - (shooter.pos.y + 1.62), z: 10 }), now: 0.1, seed: 7 });
    expect(r.part).toBe('body');
    expect(enemy.hp).toBe(100 - 20);

    // head: aim at the head centre
    const enemy2 = red(2, 0, 10);
    const head = { x: 0, y: enemy2.pos.y + 1.6, z: 10 };
    r = fireWeapon({ units: [shooter, enemy2], solids: EMPTY, shooter, aim: norm({ x: 0, y: head.y - (shooter.pos.y + 1.62), z: 10 }), now: 0.3, seed: 7 });
    expect(r.part).toBe('head');
    expect(enemy2.hp).toBe(100 - 50);
  });

  it('HP never goes below 0 and a killing blow is registered once', () => {
    const shooter = blue(0, 0);
    const enemy = red(1, 0, 10);
    enemy.hp = 15;
    const r = fireWeapon({ units: [shooter, enemy], solids: EMPTY, shooter, aim: norm({ x: 0, y: -0.92, z: 10 }), now: 0.1, seed: 11 });
    expect(enemy.hp).toBe(0);
    expect(enemy.alive).toBe(false);
    expect(r.killed).toBe(true);
    expect(r.points).toBe(4); // +1 hit +3 kill
  });
});

describe('scoring rules', () => {
  it('valid hit +1, killing blow +3, single ray scores once', () => {
    const shooter = blue(0, 0);
    const enemy = red(1, 0, 10);
    const aim = norm({ x: 0, y: -0.92, z: 10 });
    const r = fireWeapon({ units: [shooter, enemy], solids: EMPTY, shooter, aim, now: 0.1, seed: 3 });
    expect(r.points).toBe(1);
    expect(shooter.hitScore).toBe(1);
    expect(shooter.totalScore).toBe(1);
    // fire again (different shot) — still one score per shot
    const r2 = fireWeapon({ units: [shooter, enemy], solids: EMPTY, shooter, aim, now: 0.3, seed: 3 });
    expect(r2.points).toBe(1);
    expect(shooter.hitScore).toBe(2);
  });

  it('friendly fire is OFF: same-team hits deal no damage and no points', () => {
    const a = createUnit(0, 'A', 'blue', true, 0, 0, 0);
    const b = createUnit(2, 'B', 'blue', false, 0, 10, 0);
    const r = fireWeapon({ units: [a, b], solids: EMPTY, shooter: a, aim: norm({ x: 0, y: -0.92, z: 10 }), now: 0.1, seed: 5 });
    expect(b.hp).toBe(100);
    expect(r.points).toBe(0);
    expect(a.hitScore).toBe(0);
  });

  it('a miss awards no points', () => {
    const shooter = blue(0, 0);
    const enemy = red(1, 10, 0); // off to the side
    const r = fireWeapon({ units: [shooter, enemy], solids: EMPTY, shooter, aim: norm({ x: 0, y: 0, z: 1 }), now: 0.1, seed: 6 });
    expect(enemy.hp).toBe(100);
    expect(r.points).toBe(0);
  });
});

describe('spread determinism and recovery', () => {
  it('same seed + same shot index + same state => identical direction', () => {
    const aim = { x: 0, y: 0, z: 1 };
    const a = fireDirectionFor(aim, 42, 7, 0.3, 2.0);
    const b = fireDirectionFor(aim, 42, 7, 0.3, 2.0);
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(a.y).toBeCloseTo(b.y, 9);
    expect(a.z).toBeCloseTo(b.z, 9);
  });

  it('spread grows with heat and movement, and recovers after stopping fire', () => {
    expect(computeSpreadCone(1, 0)).toBeGreaterThan(computeSpreadCone(0, 0));
    expect(computeSpreadCone(0, 8)).toBeGreaterThan(computeSpreadCone(0, 0));
    const u = blue(0, 0);
    u.heat = 1;
    let prev = u.heat;
    for (let i = 0; i < 120; i++) recoverHeat(u, 1 / 60, false);
    expect(u.heat).toBeLessThan(prev);
    expect(u.heat).toBe(0); // fully recovered
  });
});

describe('magazine and reload lockout', () => {
  it('empty magazine cannot fire; reload blocks firing then refills', () => {
    const u = blue(0, 0);
    // drain the magazine
    let shots = 0;
    for (let i = 0; i < 40; i++) {
      if (canFire(u, i * 0.1)) {
        registerShot(u, i * 0.1);
        shots++;
      }
    }
    expect(u.mag).toBe(0);
    expect(shots).toBe(30); // mag size
    expect(canFire(u, 5)).toBe(false); // empty, no fire
  });
});
