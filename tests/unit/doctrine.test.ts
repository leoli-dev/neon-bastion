// Task 5 / AI-01: strategic personality. Each team gets exactly two
// flankers and two rushers, assigned from a team-level seeded draw (which
// members are which is a pure function of the seed, never hard-coded to
// unit ids). Flankers prefer peripheral patrol nodes and fire-and-peel
// (one shot, then disengage); rushers hold the fight at the shared
// 1-shot/s cadence. After the stalemate window every unit fights as a
// rusher so a dragging game still ends.

import { describe, it, expect } from 'vitest';
import { Match } from '@/game/match';
import { CONFIG } from '@/game/constants';
import { doctrineFor, createBrain, pickPatrolNode } from '@/game/ai/aiController';
import type { MapData, Unit } from '@/game/types';

const DT = 1 / 60;

// A clean open arena (only outer walls) so 1v1 pins have no occlusion.
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

describe('AI doctrine assignment', () => {
  it('gives each team exactly two flankers and two rushers', () => {
    // Note: the four slots per team include the human's slot (blue id 0) —
    // the permutation assigns doctrines to all four members; the human
    // simply has no brain to carry one.
    for (const seed of [1, 5, 16, 27, 99, 20260212]) {
      const m = new Match(seed);
      for (const team of ['blue', 'red'] as const) {
        const ds = m.units.filter((u) => u.team === team).map((u) => doctrineFor(u, seed));
        expect(ds, `seed ${seed} ${team} has four members`).toHaveLength(4);
        expect(ds.filter((d) => d === 'flanker').length, `seed ${seed} ${team} flankers`).toBe(2);
        expect(ds.filter((d) => d === 'rusher').length, `seed ${seed} ${team} rushers`).toBe(2);
        // Every AI brain carries exactly the doctrine its slot was dealt.
        for (const u of m.units) if (u.ai) expect(u.ai.doctrine, `unit ${u.id}`).toBe(doctrineFor(u, seed));
      }
    }
  });

  it('is a pure function of the seed, and the member split churns across seeds', () => {
    // Deterministic: same seed -> identical assignment.
    const a = new Match(99);
    const b = new Match(99);
    a.units.forEach((u, i) => {
      if (!u.ai) return;
      expect(u.ai.doctrine).toBe(b.units[i].ai!.doctrine);
    });
    // doctrineFor never depends on the unit object, only (team, id, seed).
    for (const u of a.units) if (u.ai) expect(u.ai.doctrine).toBe(doctrineFor(u, 99));

    // Not hard-coded to unit ids: the blue flanker pair (all four slots)
    // varies across seeds.
    const splits = new Set<string>();
    for (let s = 1; s <= 12; s++) {
      const m = new Match(s);
      splits.add(
        m.units
          .filter((u) => u.team === 'blue' && doctrineFor(u, s) === 'flanker')
          .map((u) => u.id)
          .sort((x, y) => x - y)
          .join(',')
      );
    }
    expect(splits.size).toBeGreaterThan(1);
  });
});

describe('AI doctrine behavior', () => {
  it('flankers pick more peripheral patrol nodes than rushers', () => {
    // In normal play a flanker patrols with mode 'flank' (perimeter) while a
    // rusher patrols 'advance' (center push). Sample the radial distance of
    // the chosen nodes with fresh brains and compare the means.
    const m = new Match(16);
    const graph = m.graph;
    const flanker = m.units.find((u) => u.team === 'blue' && u.ai?.doctrine === 'flanker')!;
    const rusher = m.units.find((u) => u.team === 'blue' && u.ai?.doctrine === 'rusher')!;
    const alliesOf = (u: Unit) => m.units.filter((a) => a.team === u.team && a.id !== u.id && a.alive);
    const meanRadius = (u: Unit, mode: 'flank' | 'advance'): number => {
      let sum = 0;
      for (let i = 0; i < 40; i++) {
        const b = createBrain(u, 1000 + i);
        const nid = pickPatrolNode(b, graph, u, mode, alliesOf(u));
        const n = graph.nodes.find((x) => x.id === nid)!;
        sum += Math.hypot(n.x, n.z);
      }
      return sum / 40;
    };
    const flankerR = meanRadius(flanker, 'flank');
    const rusherR = meanRadius(rusher, 'advance');
    expect(flankerR, `flanker ${flankerR.toFixed(2)} vs rusher ${rusherR.toFixed(2)}`).toBeGreaterThan(rusherR);
    // Sanity: a flanker walking 'advance' and a rusher walking 'flank' pick
    // like their MODE, proving the periphery bias comes from the doctrine's
    // patrol mode, not from unit identity.
    expect(meanRadius(rusher, 'flank')).toBeGreaterThan(meanRadius(rusher, 'advance'));
  });

  it('a flanker fires once then peels off; a rusher keeps engaging', () => {
    const run = (doctrine: 'flanker' | 'rusher', seconds: number) => {
      const m = new Match(99, openMap());
      const ai = m.units[1];
      const foe = m.units[4];
      ai.ai!.doctrine = doctrine;
      const shotTimes: number[] = [];
      const statesAfterShot: string[] = [];
      for (let i = 0; i < seconds * 60 && ai.alive && foe.alive; i++) {
        ai.pos = { x: 0, y: 0, z: 20 };
        ai.hp = 100;
        ai.alive = true;
        foe.pos = { x: 0, y: 0, z: 5 };
        foe.vel = { x: 0, z: 0 };
        foe.hp = 100;
        foe.alive = true;
        m.units[2].pos = { x: -26, y: 0, z: 26 };
        m.units[3].pos = { x: 26, y: 0, z: 26 };
        m.units[5].pos = { x: -26, y: 0, z: -26 };
        m.units[6].pos = { x: 0, y: 0, z: -26 };
        m.units[7].pos = { x: 26, y: 0, z: -26 };
        const before = ai.shotIndex;
        m.tick(DT);
        if (ai.shotIndex > before) {
          shotTimes.push(m.now);
          statesAfterShot.push(ai.ai!.state);
        }
      }
      return { shotTimes, statesAfterShot };
    };

    const fl = run('flanker', 8);
    expect(fl.shotTimes.length, 'flanker actually engaged').toBeGreaterThanOrEqual(2);
    // After each shot a flanker disengages into the 'flank' window...
    for (const s of fl.statesAfterShot) expect(s, 'flanker peels after its shot').toBe('flank');
    // ...so its shots are spaced by the peel window (>= 1.5s), not the 1s cadence.
    for (let i = 1; i < fl.shotTimes.length; i++) {
      expect(fl.shotTimes[i] - fl.shotTimes[i - 1]).toBeGreaterThanOrEqual(1.5);
    }

    const ru = run('rusher', 8);
    expect(ru.shotTimes.length, 'rusher holds the fight at ~1 shot/s').toBeGreaterThanOrEqual(6);
    for (const s of ru.statesAfterShot) expect(s, 'rusher never peels after a shot').toBe('engage');
  }, 60000);

  it('flankers stop peeling after the stalemate window (all rusher)', () => {
    const m = new Match(99, openMap());
    const ai = m.units[1];
    const foe = m.units[4];
    ai.ai!.doctrine = 'flanker';
    const stalemate = CONFIG.ai.doctrine.stalemateTime;
    const lateStates: string[] = [];
    let lateShots = 0;
    for (let i = 0; i < 66 * 60 && ai.alive && foe.alive; i++) {
      ai.pos = { x: 0, y: 0, z: 20 };
      ai.hp = 100;
      ai.alive = true;
      foe.pos = { x: 0, y: 0, z: 5 };
      foe.vel = { x: 0, z: 0 };
      foe.hp = 100;
      foe.alive = true;
      m.units[2].pos = { x: -26, y: 0, z: 26 };
      m.units[3].pos = { x: 26, y: 0, z: 26 };
      m.units[5].pos = { x: -26, y: 0, z: -26 };
      m.units[6].pos = { x: 0, y: 0, z: -26 };
      m.units[7].pos = { x: 26, y: 0, z: -26 };
      const before = ai.shotIndex;
      m.tick(DT);
      if (ai.shotIndex > before && m.now > stalemate + 1) {
        lateShots++;
        lateStates.push(ai.ai!.state);
      }
    }
    expect(lateShots, 'still fighting after the stalemate window').toBeGreaterThanOrEqual(3);
    for (const s of lateStates) expect(s, 'no more fire-and-peel after stalemateTime').toBe('engage');
  }, 120000);
});
