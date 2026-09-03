// ============================================================================
// Neon Bastion — map data (single source of truth)
// ----------------------------------------------------------------------------
// All geometry the game relies on is defined HERE, not in render code:
//   * solids  -> collision, raycast (occlusion), ground height, minimap
//   * spawns  -> blue / red spawn points
//   * navNodes -> navigation graph (links derived at build time from distance
//                 + line-of-sight so paths can never cross a wall)
//
// Coordinate system:
//   * X = east(+)/west(-),  Z = north(-)/south(+). Blue spawns south (+Z),
//     red spawns north (-Z). Y = up. 1 unit = 1 metre.
//
// Solid model (unified): every solid is an axis-aligned box with a bottom and
// top. The SAME list drives:
//   * horizontal collision  (a character cannot step up more than maxStep)
//   * ground height         (a box top / ramp surface is the floor beneath you)
//   * bullet occlusion      (a ray that hits a box stops there)
//   * minimap rendering
// "cover" and "wall" used to differ only by height — both blocked fire at eye
// level. MAP-03 removed the distinction: the arena is fully flat and every
// inner solid is a 3.0m `wall` (one single wall height).
//
// MAP-04 — finite random layouts + fully random wall materials:
//   * Four hand-authored layouts (MAP_LAYOUTS). Every generated map is a PURE
//     FUNCTION of the match seed: which layout is picked AND every wall's
//     material (`hedge` / `glass`) come from one seeded RNG (src/game/rng.ts).
//     Same seed => same map, always. For the player it is "a random map each
//     game"; for the tests it is fully reproducible.
//   * Boundary walls, spawn walls and spawn coordinates are SHARED by all
//     four layouts (keeps the map symmetric and both spawn rooms intact).
//   * The layouts differ in their inner walls + nav nodes, but keep a common
//     spine (side wings, wing clusters, the (±13,±11) cover blocks, the
//     (0,±13) centre columns) so passage density and firing distances stay
//     similar — the AI needs no per-layout tuning.
//   * After a layout is picked, a connectivity check (blue spawn -> red spawn
//     over the nav graph) runs once; if it fails the NEXT layout is used.
//     generateMap never silently produces an unreachable map.
//   * Boundary (`kind === 'boundary'`) and spawn (`kind === 'spawn'`) solids
//     keep the plain `solid` material; only `kind === 'wall'` solids are
//     rolled for a material.
//   * NEON_BASTION is kept (unit tests + fixed scenarios): the classic
//     layout with MAP-01's two manual material overrides — a deterministic
//     fixed map.
// ============================================================================

import type {
  MapData,
  Solid,
  SolidMaterial,
  SpawnPoint,
  NavNodeSpec,
  TeamSpawns,
} from '../types';
import { RNG, hashSeed } from '../rng';
import { buildNavGraph, findNearestNode, isReachable } from './navmesh';

function s(
  id: number,
  x: number,
  z: number,
  sx: number,
  sz: number,
  bottom: number,
  top: number,
  kind: Solid['kind'],
  label: string,
  extra: Partial<Solid> = {}
): Solid {
  return { id, x, z, sx, sz, bottom, top, kind, label, ...extra };
}

function n(id: number, x: number, z: number, y = 0): NavNodeSpec {
  return { id, x, z, y };
}

// ---- Shared by ALL four layouts (MAP-04) ----------------------------------

const SHARED_BOUNDS = { minX: -30, maxX: 30, minZ: -30, maxZ: 30 };

// Boundary + spawn-room walls. Fixed for every layout so the arena stays
// symmetric and both spawn rooms always exist (id 0-3 boundary, 4-7 spawn).
const SHARED_SOLIDS: Solid[] = [
  // ---- Boundary (keeps everyone inside; 4m high, cannot be stepped onto) ----
  s(0, 0, 31, 64, 2, 0, 4, 'boundary', 'bound-s'),
  s(1, 0, -31, 64, 2, 0, 4, 'boundary', 'bound-n'),
  s(2, -31, 0, 2, 64, 0, 4, 'boundary', 'bound-w'),
  s(3, 31, 0, 2, 64, 0, 4, 'boundary', 'bound-e'),
  // ---- Spawn rooms (open toward the arena at the centre) ----
  s(4, -9, 27, 2, 10, 0, 3, 'spawn', 'blue-spawn-l'),
  s(5, 9, 27, 2, 10, 0, 3, 'spawn', 'blue-spawn-r'),
  s(6, -9, -27, 2, 10, 0, 3, 'spawn', 'red-spawn-l'),
  s(7, 9, -27, 2, 10, 0, 3, 'spawn', 'red-spawn-r'),
];

const SHARED_SPAWNS: TeamSpawns = {
  blue: [
    { x: -3, z: 27, yaw: Math.PI }, // facing north (toward red)
    { x: 3, z: 27, yaw: Math.PI },
    { x: -3, z: 24, yaw: Math.PI },
    { x: 3, z: 24, yaw: Math.PI },
  ],
  red: [
    { x: -3, z: -27, yaw: 0 }, // facing south (toward blue)
    { x: 3, z: -27, yaw: 0 },
    { x: -3, z: -24, yaw: 0 },
    { x: 3, z: -24, yaw: 0 },
  ],
};

// ---- Shared spine (inner walls common to all four layouts) -----------------
// The wings, wing clusters, cover blocks and centre columns. Keeping this
// spine fixed means passage density and firing distances stay similar across
// layouts (no per-layout AI tuning), and the well-known lanes the test suite
// relies on ((0,±13) centre columns, the (±3, 24) spawn lanes) always exist.

const WINGS = [
  s(11, 16, 0, 2, 34, 0, 3, 'wall', 'east-wing-wall'),
  s(12, -16, 0, 2, 34, 0, 3, 'wall', 'west-wing-wall'),
];

const WING_CLUSTERS = [
  // East wing
  s(13, 22, -8, 4, 4, 0, 3, 'wall', 'east-c1'),
  s(14, 23, 0, 3, 5, 0, 3, 'wall', 'east-c2'),
  s(15, 22, 8, 4, 4, 0, 3, 'wall', 'east-c3'),
  // West wing
  s(16, -22, -8, 4, 4, 0, 3, 'wall', 'west-c1'),
  s(17, -23, 0, 3, 5, 0, 3, 'wall', 'west-c2'),
  s(18, -22, 8, 4, 4, 0, 3, 'wall', 'west-c3'),
];

const COVER_AND_COLUMNS = [
  // Corner cover blocks
  s(19, -13, 11, 4, 4, 0, 3, 'wall', 'cover-sw'),
  s(20, 13, 11, 4, 4, 0, 3, 'wall', 'cover-se'),
  s(21, -13, -11, 4, 4, 0, 3, 'wall', 'cover-nw'),
  s(22, 13, -11, 4, 4, 0, 3, 'wall', 'cover-ne'),
  // Centre approach columns
  s(23, 0, 13, 3, 3, 0, 3, 'wall', 'cover-s-col'),
  s(24, 0, -13, 3, 3, 0, 3, 'wall', 'cover-n-col'),
];

// South maze baffles (classic flanking mazes with clear lanes) and their
// north-side mirror — the two maze "flavours" the layouts mix.
const MAZE_SOUTH = [
  s(25, -8, 17, 2, 6, 0, 3, 'wall', 'maze-sw-a'),
  s(26, -14, 14, 5, 2, 0, 3, 'wall', 'maze-sw-b'),
  s(27, 8, 17, 2, 6, 0, 3, 'wall', 'maze-se-a'),
  s(28, 14, 14, 5, 2, 0, 3, 'wall', 'maze-se-b'),
];

const MAZE_NORTH = [
  s(25, -8, -17, 2, 6, 0, 3, 'wall', 'maze-nw-a'),
  s(26, -14, -14, 5, 2, 0, 3, 'wall', 'maze-nw-b'),
  s(27, 8, -17, 2, 6, 0, 3, 'wall', 'maze-ne-a'),
  s(28, 14, -14, 5, 2, 0, 3, 'wall', 'maze-ne-b'),
];

const MID_PILLARS = [
  s(25, 7, 0, 3, 3, 0, 3, 'wall', 'mid-e'),
  s(26, -7, 0, 3, 3, 0, 3, 'wall', 'mid-w'),
];

// Nav node backbone shared by all layouts (spawn exits, main lanes, wings,
// centre). Layouts add a few pocket nodes around their maze/wall features.
const NAV_BACKBONE: NavNodeSpec[] = [
  n(0, 0, 26), // blue exit (centre)
  n(1, -12, 19), // blue SW
  n(2, 12, 19), // blue SE
  n(5, 0, 17), // south-centre lane
  n(6, -9, 9), // SW of centre
  n(7, 9, 9), // SE of centre
  n(8, -9, -9), // NW of centre
  n(9, 9, -9), // NE of centre
  n(10, 0, 9), // south of centre (main push)
  n(11, 0, -9), // north of centre
  n(12, -14, 0), // far-west open
  n(13, 14, 0), // far-east open
  n(14, -12, -20), // red SW
  n(15, 12, -20), // red SE
  n(16, 0, -17), // north-centre lane
  n(17, 0, -26), // red exit (centre)
  // Wings (clear corridors on the outer edge, flanking the inner walls)
  n(18, 26, 16), // east wing S
  n(19, 26, 0), // east wing M
  n(20, 26, -16), // east wing N
  n(21, -26, 16), // west wing S
  n(22, -26, 0), // west wing M
  n(23, -26, -16), // west wing N
  n(29, 0, 0), // arena centre (ground)
];

const SOUTHEAST_POCKETS = [n(3, -12, 16), n(4, 12, 16)]; // SW/SE pockets by the south maze
const NORTHWEST_POCKETS = [n(30, -12, -16), n(31, 12, -16)]; // mirror for the north maze

// ---- The four hand-authored layouts (MAP-04) -------------------------------

export interface MapLayoutSpec {
  name: string;
  /** Inner walls (`kind === 'wall'`); materials are assigned per seed. */
  walls: Solid[];
  navNodes: NavNodeSpec[];
}

export const MAP_LAYOUTS: readonly MapLayoutSpec[] = [
  {
    name: 'Classic',
    walls: [...WINGS, ...WING_CLUSTERS, ...COVER_AND_COLUMNS, ...MAZE_SOUTH],
    navNodes: [...NAV_BACKBONE, ...SOUTHEAST_POCKETS],
  },
  {
    name: 'North Gate',
    walls: [...WINGS, ...WING_CLUSTERS, ...COVER_AND_COLUMNS, ...MAZE_NORTH],
    navNodes: [...NAV_BACKBONE, ...NORTHWEST_POCKETS],
  },
  {
    name: 'Open Flanks',
    walls: [...WINGS, ...WING_CLUSTERS, ...COVER_AND_COLUMNS, ...MID_PILLARS],
    navNodes: [...NAV_BACKBONE],
  },
  {
    name: 'Twin Mazes',
    walls: [...WINGS, ...COVER_AND_COLUMNS, ...MAZE_SOUTH, ...MAZE_NORTH],
    navNodes: [...NAV_BACKBONE, ...SOUTHEAST_POCKETS, ...NORTHWEST_POCKETS],
  },
];

// ---- Assembly / generation ---------------------------------------------------

/** Assemble a layout into a MapData (no random materials — plain `solid`). */
export function assembleLayout(layout: MapLayoutSpec): MapData {
  return {
    name: `Neon Bastion — ${layout.name}`,
    bounds: { ...SHARED_BOUNDS },
    solids: [...SHARED_SOLIDS, ...layout.walls.map((w) => ({ ...w }))],
    spawns: {
      blue: SHARED_SPAWNS.blue.map((p) => ({ ...p })),
      red: SHARED_SPAWNS.red.map((p) => ({ ...p })),
    },
    navNodes: layout.navNodes.map((nd) => ({ ...nd })),
  };
}

/** Blue-spawn -> red-spawn connectivity over the layout's nav graph. */
export function layoutSpawnsConnected(layout: MapLayoutSpec): boolean {
  const map = assembleLayout(layout);
  const graph = buildNavGraph(map);
  const b = map.spawns.blue[0];
  const r = map.spawns.red[0];
  const from = findNearestNode(graph, b.x, b.z, 0);
  const to = findNearestNode(graph, r.x, r.z, 0);
  return from >= 0 && to >= 0 && isReachable(graph, from, to);
}

/**
 * MAP-04: the generated map is a pure function of the match seed.
 *   1. Pick one of the four hand-authored layouts by seed (RNG draw #1).
 *   2. Run the connectivity check (blue spawn -> red spawn); if the picked
 *      layout is unreachable, fall through to the NEXT layout (deterministic
 *      walk — never silent, never a different map for the same seed).
 *   3. Give every `kind === 'wall'` solid an independent `hedge`/`glass`
 *      material from the SAME seeded RNG. Boundary and spawn walls stay
 *      `solid`.
 */
export function generateMap(seed: number): MapData {
  const rng = new RNG(hashSeed(0x4d4150, seed)); // 'MAP-' as a salt
  const first = rng.int(0, MAP_LAYOUTS.length - 1);
  let layout = MAP_LAYOUTS[0];
  for (let k = 0; k < MAP_LAYOUTS.length; k++) {
    const candidate = MAP_LAYOUTS[(first + k) % MAP_LAYOUTS.length];
    if (layoutSpawnsConnected(candidate)) {
      layout = candidate;
      break;
    }
  }
  const solids: Solid[] = [
    ...SHARED_SOLIDS,
    ...layout.walls.map((w) => {
      if (w.kind !== 'wall') return { ...w };
      const material: SolidMaterial = rng.chance(0.5) ? 'hedge' : 'glass';
      return { ...w, material };
    }),
  ];
  return {
    name: `Neon Bastion — ${layout.name}`,
    bounds: { ...SHARED_BOUNDS },
    solids,
    spawns: {
      blue: SHARED_SPAWNS.blue.map((p) => ({ ...p })),
      red: SHARED_SPAWNS.red.map((p) => ({ ...p })),
    },
    navNodes: layout.navNodes.map((nd) => ({ ...nd })),
  };
}

// ---- Fixed map (unit tests + fixed scenarios) -------------------------------

// The classic layout with MAP-01's two manual material overrides (one hedge,
// one glass among the four south maze walls). Deterministic and unchanged —
// the tests and fixed scenarios that reference solid ids 25/27 rely on it.
const classicWalls = MAP_LAYOUTS[0].walls.map((w) => {
  if (w.id === 25 && w.label === 'maze-sw-a') return { ...w, material: 'hedge' as const };
  if (w.id === 27 && w.label === 'maze-se-a') return { ...w, material: 'glass' as const };
  return { ...w };
});

const solids: Solid[] = [...SHARED_SOLIDS, ...classicWalls];

const blueSpawns: SpawnPoint[] = SHARED_SPAWNS.blue;
const redSpawns: SpawnPoint[] = SHARED_SPAWNS.red;
const navNodes: NavNodeSpec[] = MAP_LAYOUTS[0].navNodes;

export const NEON_BASTION: MapData = {
  name: 'Neon Bastion',
  bounds: { ...SHARED_BOUNDS },
  solids,
  spawns: { blue: blueSpawns, red: redSpawns },
  navNodes,
};

/**
 * Count of solids that stand as full walls (single height, MAP-03).
 * "Cover" no longer exists as a distinct kind — every inner solid is a wall,
 * so the count is simply the number of `wall` solids.
 */
export function coverCount(): number {
  return solids.filter((x) => x.kind === 'wall').length;
}

/** A few convenience lookups used by tests and the map builder. */
export function findSolid(id: number): Solid | undefined {
  return solids.find((x) => x.id === id);
}

export const NEON_BASTION_CENTRAL_NODE = 29; // arena centre (ground)
export const NEON_BASTION_SOUTH_NODE = 10; // main push node
export const NEON_BASTION_NORTH_NODE = 11;
