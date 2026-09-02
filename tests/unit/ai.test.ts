import { describe, it, expect } from 'vitest';
import { Match } from '@/game/match';
import { CONFIG } from '@/game/constants';
import type { MapData } from '@/game/types';

const DT = 1 / 60;

// A clean open arena (only outer walls) so we can control the shot distance
// precisely without interior occlusion surprises.
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

function runTicks(m: Match, n: number, prep?: (m: Match, i: number) => void): void {
  for (let i = 0; i < n; i++) {
    prep?.(m, i);
    m.tick(DT);
  }
}

describe('AI: determinism', () => {
  it('same seed + same inputs => identical AI behaviour', () => {
    const a = new Match(20240517);
    const b = new Match(20240517);
    runTicks(a, 420); // 7 seconds, no player input
    runTicks(b, 420);
    for (let i = 0; i < 8; i++) {
      expect(a.units[i].pos.x).toBeCloseTo(b.units[i].pos.x, 6);
      expect(a.units[i].pos.z).toBeCloseTo(b.units[i].pos.z, 6);
      const aiA = a.units[i].ai;
      const aiB = b.units[i].ai;
      if (aiA && aiB) {
        expect(aiA.state).toBe(aiB.state);
      }
    }
  });
});

describe('AI: bounded reaction time', () => {
  it('does not fire before the reaction delay once a target is acquired', () => {
    const m = new Match(7);
    const ai = m.units[1]; // a blue AI
    const foe = m.units[4]; // a red unit
    // Put them in an open line, facing each other.
    ai.pos = { x: 0, y: 0, z: 20 };
    ai.yaw = Math.PI; // facing -Z
    foe.pos = { x: 0, y: 0, z: 16 };
    let firedAt = -1;
    for (let i = 0; i < 900; i++) {
      m.tick(DT);
      if (ai.shotIndex > 0 && firedAt < 0) firedAt = m.now;
      if (firedAt >= 0) break;
    }
    expect(firedAt).toBeGreaterThan(0); // it eventually fired
    expect(firedAt).toBeGreaterThanOrEqual(CONFIG.ai.reactTime - 1e-6);
  });
});

describe('AI: limited hit rate', () => {
  it('hits some but not all of its shots at a live target', () => {
    const m = new Match(99, openMap());
    const ai = m.units[1];
    const foe = m.units[4];
    // Pin the shooter at 15m from a live, invulnerable target in the open; pin
    // the other six units in the corners so they do not interfere. Stop once
    // the shooter has fired 30 shots.
    // (At the shared 1-shot/second cadence 30 shots take ~30s,
    // so the budget is ~40s of ticks.)
    for (let i = 0; i < 2400 && ai.shotIndex < 30 && m.state === 'running'; i++) {
      ai.pos = { x: 0, y: 0, z: 20 };
      ai.hp = 100;
      ai.alive = true;
      foe.pos = { x: 0, y: 0, z: 5 };
      foe.vel = { x: 0, z: 0 }; // pinned target: zero velocity, else the AI's
      // ballistic lead (pos + vel × flight time) would aim past it
      foe.hp = 100;
      foe.alive = true;
      m.units[2].pos = { x: -26, y: 0, z: 26 };
      m.units[3].pos = { x: 26, y: 0, z: 26 };
      m.units[5].pos = { x: -26, y: 0, z: -26 };
      m.units[6].pos = { x: 0, y: 0, z: -26 };
      m.units[7].pos = { x: 26, y: 0, z: -26 };
      m.tick(DT);
    }
    const shots = ai.shotIndex;
    expect(shots).toBeGreaterThanOrEqual(30); // it actually engaged
    const hitRate = ai.hitScore / shots;
    expect(hitRate).toBeGreaterThan(0.1); // competent
    expect(hitRate).toBeLessThan(0.9); // not a perfect aimbot
  });
});

describe('AI: beatable', () => {
  it('a weakened AI can be killed by an opponent', () => {
    const m = new Match(5);
    const ai = m.units[1];
    const foe = m.units[4];
    // Close range, facing each other; the AI is barely alive.
    ai.pos = { x: 0, y: 0, z: 18 };
    ai.yaw = Math.PI;
    ai.hp = 8;
    foe.pos = { x: 0, y: 0, z: 15 };
    foe.yaw = 0; // facing +Z
    let died = false;
    for (let i = 0; i < 1200; i++) {
      m.tick(DT);
      if (!ai.alive) {
        died = true;
        break;
      }
    }
    expect(died).toBe(true);
    expect(ai.hp).toBe(0);
  });
});

describe('AI: alert state', () => {
  it('enters alert when it hears a threat it cannot see', () => {
    const m = new Match(11);
    const ai = m.units[1]; // a blue AI
    const foe = m.units[4]; // a red unit
    // The south approach cover column (solid 23) at (0,13) occludes the direct
    // line, so the foe is HEARD (7m < soundDist) but never SEEN. Pin both so
    // the AI can never walk around the occluder and must stay in 'alert'.
    let sawAlert = false;
    let neverSaw = true;
    for (let i = 0; i < 240; i++) {
      ai.pos = { x: 0, y: 0, z: 16.5 };
      ai.yaw = Math.PI; // facing -Z (north)
      foe.pos = { x: 0, y: 0, z: 9.5 };
      foe.hp = 100;
      foe.alive = true;
      m.tick(DT);
      if (ai.ai?.state === 'alert') sawAlert = true;
      if (ai.ai?.state === 'engage') neverSaw = false;
    }
    expect(sawAlert, 'AI should investigate the sound in an alert state').toBe(true);
    expect(neverSaw, 'AI must not engage a target it cannot see').toBe(true);
    expect(foe.hp, 'no through-wall damage from the alerted AI').toBe(100);
  });
});

describe('AI: full match terminates', () => {
  it('a seeded all-AI match reaches a terminal state (no central-platform stalemate)', () => {
    for (const seed of [20260212, 1, 99]) {
      const m = new Match(seed);
      // Remove the passive human player so the whole match is AI-driven; the
      // human unit would otherwise camp at spawn and the match could never end.
      m.player.alive = false;
      m.player.hp = 0;
      m.tick(DT);
      for (let i = 0; i < 90 * 60 && m.state === 'running'; i++) m.tick(DT);
      const snap = m.snapshot();
      expect(snap.state, `seed ${seed}: the all-AI match must end`).toBe('ended');
      expect(snap.winner, `seed ${seed}: a team must win`).not.toBeNull();
      for (const u of snap.units) {
        expect(u.hp, `seed ${seed}: ${u.name} hp`).toBeGreaterThanOrEqual(0);
        expect(u.totalScore, `seed ${seed}: ${u.name} scoring invariant`).toBe(u.hitScore + 3 * u.kills);
      }
      const loser = snap.winner === 'blue' ? 'red' : 'blue';
      expect(
        snap.units.filter((u) => u.team === loser && u.alive).length,
        `seed ${seed}: losing team fully eliminated`
      ).toBe(0);
    }
  });
});

describe('AI: fair senses', () => {
  it('does not damage an enemy it cannot see through a wall', () => {
    const m = new Match(3);
    // Use the south approach cover column (solid 23) at (0,13) as occlusion.
    // Put the AI just south of it and the enemy just north of it, same XZ line.
    const ai = m.units[1];
    const foe = m.units[4];
    ai.pos = { x: 0, y: 0, z: 16.5 };
    ai.yaw = Math.PI; // facing -Z (north)
    foe.pos = { x: 0, y: 0, z: 9.5 }; // the cover column at (0,13) is between them
    // Pin BOTH so the AI can never walk around the occluder; it must stay blind.
    runTicks(m, 600, () => {
      ai.pos = { x: 0, y: 0, z: 16.5 };
      ai.yaw = Math.PI;
      foe.pos = { x: 0, y: 0, z: 9.5 };
      foe.hp = 100;
      foe.alive = true;
    });
    // The column blocks the direct shot, so the pinned foe must stay alive.
    expect(foe.hp).toBe(100);
  });
});
