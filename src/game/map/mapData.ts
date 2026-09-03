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
// ============================================================================

import type { MapData, Solid, SpawnPoint, NavNodeSpec } from '../types';

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

const solids: Solid[] = [
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

  // ---- Side wings (two flanking corridors) ----
  s(11, 16, 0, 2, 34, 0, 3, 'wall', 'east-wing-wall'),
  s(12, -16, 0, 2, 34, 0, 3, 'wall', 'west-wing-wall'),

  // ---- Walls: east wing (all unified to top=3.0, MAP-03) ----
  s(13, 22, -8, 4, 4, 0, 3, 'wall', 'east-c1'),
  s(14, 23, 0, 3, 5, 0, 3, 'wall', 'east-c2'),
  s(15, 22, 8, 4, 4, 0, 3, 'wall', 'east-c3'),
  // ---- Walls: west wing ----
  s(16, -22, -8, 4, 4, 0, 3, 'wall', 'west-c1'),
  s(17, -23, 0, 3, 5, 0, 3, 'wall', 'west-c2'),
  s(18, -22, 8, 4, 4, 0, 3, 'wall', 'west-c3'),
  // ---- Walls: central approach ----
  s(19, -13, 11, 4, 4, 0, 3, 'wall', 'cover-sw'),
  s(20, 13, 11, 4, 4, 0, 3, 'wall', 'cover-se'),
  s(21, -13, -11, 4, 4, 0, 3, 'wall', 'cover-nw'),
  s(22, 13, -11, 4, 4, 0, 3, 'wall', 'cover-ne'),
  s(23, 0, 13, 3, 3, 0, 3, 'wall', 'cover-s-col'),
  s(24, 0, -13, 3, 3, 0, 3, 'wall', 'cover-n-col'),

  // ---- Flanking mazes (south-west & south-east baffles with clear lanes) ----
  // MAP-01: manual material overrides for verification only — one hedge and
  // one glass wall among the four maze walls. (Randomized in task 4.)
  s(25, -8, 17, 2, 6, 0, 3, 'wall', 'maze-sw-a', { material: 'hedge' }),
  s(26, -14, 14, 5, 2, 0, 3, 'wall', 'maze-sw-b'),
  s(27, 8, 17, 2, 6, 0, 3, 'wall', 'maze-se-a', { material: 'glass' }),
  s(28, 14, 14, 5, 2, 0, 3, 'wall', 'maze-se-b'),
];

const blueSpawns: SpawnPoint[] = [
  { x: -3, z: 27, yaw: Math.PI }, // facing north (toward red)
  { x: 3, z: 27, yaw: Math.PI },
  { x: -3, z: 24, yaw: Math.PI },
  { x: 3, z: 24, yaw: Math.PI },
];

const redSpawns: SpawnPoint[] = [
  { x: -3, z: -27, yaw: 0 }, // facing south (toward blue)
  { x: 3, z: -27, yaw: 0 },
  { x: -3, z: -24, yaw: 0 },
  { x: 3, z: -24, yaw: 0 },
];

const navNodes: NavNodeSpec[] = [
  // Ground level (y = 0)
  n(0, 0, 26), // blue exit (centre)
  n(1, -12, 19), // blue SW
  n(2, 12, 19), // blue SE
  n(3, -12, 16), // SW pocket (west of the SW maze)
  n(4, 12, 16), // SE pocket (east of the SE maze)
  n(5, 0, 17), // south-centre lane
  n(6, -9, 9), // SW of platform
  n(7, 9, 9), // SE of platform
  n(8, -9, -9), // NW of platform
  n(9, 9, -9), // NE of platform
  n(10, 0, 9), // south of platform (main push)
  n(11, 0, -9), // north of platform
  n(12, -14, 0), // far-west open (ramp base)
  n(13, 14, 0), // far-east open (ramp base)
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
  // Central ground node (the arena is fully flat, MAP-03)
  n(29, 0, 0), // arena centre (ground)
];

export const NEON_BASTION: MapData = {
  name: 'Neon Bastion',
  bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
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
