// MAP-04: finite random layouts + fully random wall materials.
// Everything must be a PURE FUNCTION of the match seed: same seed => same
// map (determinism the whole test suite builds on), different seeds =>
// different layouts, per-seed random hedge/glass on every wall.

import { describe, it, expect } from 'vitest';
import {
  generateMap,
  NEON_BASTION,
  MAP_LAYOUTS,
  assembleLayout,
  layoutSpawnsConnected,
} from '@/game/map/mapData';
import { buildNavGraph, findNearestNode, isReachable } from '@/game/map/navmesh';
import { Match } from '@/game/match';

/** Blue-spawn -> red-spawn reachability for a fully assembled map. */
function blueToRedReachable(map: ReturnType<typeof assembleLayout>): boolean {
  const graph = buildNavGraph(map);
  const from = findNearestNode(graph, map.spawns.blue[0].x, map.spawns.blue[0].z, 0);
  const to = findNearestNode(graph, map.spawns.red[0].x, map.spawns.red[0].z, 0);
  return from >= 0 && to >= 0 && isReachable(graph, from, to);
}

describe('generateMap (MAP-04): determinism', () => {
  it('same seed twice => deep-equal maps', () => {
    for (const seed of [2, 7, 42, 99, 20260212, 123456789]) {
      expect(generateMap(seed), `seed ${seed}`).toEqual(generateMap(seed));
    }
  });

  it('different seeds produce different layouts', () => {
    const names = new Set<string>();
    for (let seed = 0; seed < 16; seed++) names.add(generateMap(seed).name);
    expect(names.size, `got: ${[...names].join(', ')}`).toBeGreaterThan(1);
  });

  it('the Match constructor defaults to generateMap(seed)', () => {
    const m = new Match(42);
    expect(m.map).toEqual(generateMap(42));
    // explicit maps are still honoured (unit tests / fixed scenarios)
    const fixed = new Match(42, NEON_BASTION);
    expect(fixed.map).toBe(NEON_BASTION);
  });
});

describe('generateMap (MAP-04): the four layouts', () => {
  it('there are exactly four hand-authored layouts', () => {
    expect(MAP_LAYOUTS).toHaveLength(4);
  });

  it('every layout passes the blue -> red spawn connectivity check', () => {
    MAP_LAYOUTS.forEach((layout, i) => {
      expect(layoutSpawnsConnected(layout), `layout ${i} (${layout.name})`).toBe(true);
      // and on the fully assembled map (nav graph incl. standability)
      expect(blueToRedReachable(assembleLayout(layout)), `layout ${i} (${layout.name})`).toBe(true);
    });
  });

  it('boundary walls, spawn walls and spawns are shared by all four layouts', () => {
    const shared = (m: ReturnType<typeof assembleLayout>) =>
      JSON.stringify({
        boundary: m.solids.filter((s) => s.kind !== 'wall'),
        spawns: m.spawns,
        bounds: m.bounds,
      });
    const first = shared(assembleLayout(MAP_LAYOUTS[0]));
    for (const layout of MAP_LAYOUTS) {
      expect(shared(assembleLayout(layout)), layout.name).toBe(first);
    }
  });

  it('generateMap output is always connected (blue -> red)', () => {
    for (const seed of [2, 7, 42, 99, 20260212]) {
      expect(blueToRedReachable(generateMap(seed)), `seed ${seed}`).toBe(true);
    }
  });
});

describe('generateMap (MAP-04): random wall materials', () => {
  it('both hedge and glass appear across a range of seeds', () => {
    const seen = new Set<string>();
    let walls = 0;
    for (let seed = 1; seed <= 8; seed++) {
      for (const s of generateMap(seed).solids) {
        if (s.kind === 'wall') {
          walls++;
          seen.add(s.material ?? 'solid');
        }
      }
    }
    expect(walls).toBeGreaterThan(0);
    expect(seen.has('hedge'), `materials seen: ${[...seen].join(', ')}`).toBe(true);
    expect(seen.has('glass'), `materials seen: ${[...seen].join(', ')}`).toBe(true);
  });

  it('every inner wall is hedge or glass; boundary & spawn walls stay solid', () => {
    for (const seed of [3, 42, 777, 20260212]) {
      for (const s of generateMap(seed).solids) {
        if (s.kind === 'wall') {
          expect(['hedge', 'glass'], `seed ${seed} wall ${s.id} (${s.label}) material=${s.material}`).toContain(s.material);
        } else {
          expect(s.material, `seed ${seed} ${s.kind} ${s.id} must stay solid`).toBeUndefined();
        }
      }
    }
  });
});

describe('generateMap (MAP-04): NEON_BASTION is untouched', () => {
  it('NEON_BASTION is still exported with its fixed MAP-01 material overrides', () => {
    expect(NEON_BASTION.name).toBe('Neon Bastion');
    const sw = NEON_BASTION.solids.find((s) => s.id === 25);
    const se = NEON_BASTION.solids.find((s) => s.id === 27);
    expect(sw?.material).toBe('hedge');
    expect(se?.material).toBe('glass');
  });
});
