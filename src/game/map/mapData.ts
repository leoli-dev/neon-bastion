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
// "cover" and "wall" differ only by height — both block fire at eye level.
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

  // ---- Central raised platform (the elevation feature) ----
  s(8, 0, 0, 16, 16, 0, 1.2, 'platform', 'central-platform'),
  // Ramps up to the platform (smooth slope, climbable from ground level).
  // West ramp: low end x=-14 (y=0) -> high end x=-8 (y=1.2, meets platform).
  s(9, -11, 0, 6, 10, 0, 1.2, 'ramp', 'west-ramp', { rampAxis: 'x', rampHighPositive: true }),
  // East ramp: low end x=14 (y=0) -> high end x=8 (y=1.2, meets platform).
  s(10, 11, 0, 6, 10, 0, 1.2, 'ramp', 'east-ramp', { rampAxis: 'x', rampHighPositive: false }),

  // ---- Side wings (two flanking corridors) ----
  s(11, 16, 0, 2, 34, 0, 3, 'wall', 'east-wing-wall'),
  s(12, -16, 0, 2, 34, 0, 3, 'wall', 'west-wing-wall'),

  // ---- Cover: east wing ----
  s(13, 22, -8, 4, 4, 0, 2.5, 'cover', 'east-c1'),
  s(14, 23, 0, 3, 5, 0, 3, 'cover', 'east-c2'),
  s(15, 22, 8, 4, 4, 0, 2.5, 'cover', 'east-c3'),
  // ---- Cover: west wing ----
  s(16, -22, -8, 4, 4, 0, 2.5, 'cover', 'west-c1'),
  s(17, -23, 0, 3, 5, 0, 3, 'cover', 'west-c2'),
  s(18, -22, 8, 4, 4, 0, 2.5, 'cover', 'west-c3'),
  // ---- Cover: central approach (flanks the platform) ----
  s(19, -13, 11, 4, 4, 0, 2.5, 'cover', 'cover-sw'),
  s(20, 13, 11, 4, 4, 0, 2.5, 'cover', 'cover-se'),
  s(21, -13, -11, 4, 4, 0, 2.5, 'cover', 'cover-nw'),
  s(22, 13, -11, 4, 4, 0, 2.5, 'cover', 'cover-ne'),
  s(23, 0, 13, 3, 3, 0, 3, 'cover', 'cover-s-col'),
  s(24, 0, -13, 3, 3, 0, 3, 'cover', 'cover-n-col'),

  // ---- Flanking mazes (south-west & south-east baffles with clear lanes) ----
  s(25, -8, 17, 2, 6, 0, 3, 'wall', 'maze-sw-a'),
  s(26, -14, 14, 5, 2, 0, 3, 'wall', 'maze-sw-b'),
  s(27, 8, 17, 2, 6, 0, 3, 'wall', 'maze-se-a'),
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
  // Central platform top (y = 1.2)
  n(24, -6, 0, 1.2),
  n(25, 6, 0, 1.2),
  n(26, 0, 0, 1.2),
  n(27, 0, -5, 1.2),
  n(28, 0, 5, 1.2),
];

export const NEON_BASTION: MapData = {
  name: 'Neon Bastion',
  bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
  solids,
  spawns: { blue: blueSpawns, red: redSpawns },
  navNodes,
};

/** Count of solids that count as usable cover (boxes / columns / walls for cover). */
export function coverCount(): number {
  return solids.filter((x) => x.kind === 'cover' || x.kind === 'wall').length;
}

/** A few convenience lookups used by tests and the map builder. */
export function findSolid(id: number): Solid | undefined {
  return solids.find((x) => x.id === id);
}

export const NEON_BASTION_CENTRAL_NODE = 26; // platform top centre
export const NEON_BASTION_SOUTH_NODE = 10; // main push node
export const NEON_BASTION_NORTH_NODE = 11;
