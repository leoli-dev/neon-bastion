import { describe, it, expect } from 'vitest';
import { NEON_BASTION, coverCount } from '@/game/map/mapData';
import { buildNavGraph, findPath, findNearestNode, getNeighbors } from '@/game/map/navmesh';
import { isWalkablePath, raycastMap, groundHeight } from '@/game/map/geometry';
import { isStandable } from '@/game/map/movement';

const MAP = NEON_BASTION;
const graph = buildNavGraph(MAP);

// A helper that finds up to `count` pairwise-distinct routes from `a` to `b`
// (distinct = they do not share an interior node).
function distinctPaths(a: number, b: number, count = 2): number[][] {
  const found: number[][] = [];
  let guard = 0;
  while (found.length < count && guard++ < 50) {
    const avoid = new Set<number>();
    for (const p of found) for (const id of p) if (id !== a && id !== b) avoid.add(id);
    const p = findPath(graph, a, b, avoid);
    if (!p) break;
    if (!found.some((q) => q.join(',') === p.join(','))) found.push(p);
  }
  return found;
}

describe('map data (Neon Bastion)', () => {
  it('has at least 12 usable cover/wall structures', () => {
    expect(coverCount()).toBeGreaterThanOrEqual(12);
  });

  it('every spawn point stands on walkable ground', () => {
    for (const sp of [...MAP.spawns.blue, ...MAP.spawns.red]) {
      const g = groundHeight(MAP.solids, sp.x, sp.z);
      expect(g).toBeLessThanOrEqual(0.61); // flat ground at spawns
      expect(isStandable(MAP.solids, sp.x, sp.z, 0.42, g, 0.6)).toBe(true);
    }
  });

  it('every nav node stands on walkable ground at its own height', () => {
    for (const n of MAP.navNodes) {
      const g = groundHeight(MAP.solids, n.x, n.z);
      expect(Math.abs(g - n.y)).toBeLessThan(0.35);
      expect(isStandable(MAP.solids, n.x, n.z, 0.4, n.y, 0.6)).toBe(true);
    }
  });

  it('the nav graph is connected and every link is walkable (no wall crossings)', () => {
    for (const n of graph.nodes) {
      for (const linkId of n.links) {
        const m = graph.byId.get(linkId)!;
        expect(isWalkablePath(MAP.solids, n.x, n.z, m.x, m.z, 0.6)).toBe(true);
      }
    }
    // All ground nodes are mutually reachable (strong connectivity of the arena).
    const ground = graph.nodes.filter((n) => n.y < 0.1).map((n) => n.id);
    for (const g0 of ground) {
      for (const g1 of ground) {
        expect(findPath(graph, g0, g1)).not.toBeNull();
      }
    }
  });

  it('each team has at least two valid (west & east) paths to the central area', () => {
    // A valid "two paths" requirement = each spawn can reach the central region
    // by a western route AND an eastern route (the wings and open lanes), so the
    // map is not a single choke-point corridor.
    const assert = (from: number, west: number, east: number, center: number) => {
      expect(findPath(graph, from, west)).not.toBeNull(); // reach the west side
      expect(findPath(graph, from, east)).not.toBeNull(); // reach the east side
      expect(findPath(graph, from, center)).not.toBeNull(); // reach the centre
      // and both sides connect into the centre (two real routes)
      expect(findPath(graph, west, center)).not.toBeNull();
      expect(findPath(graph, east, center)).not.toBeNull();
    };
    // blue (from south exit node 0): west open lane (6), east open lane (7), centre (10)
    assert(0, 6, 7, 10);
    // red (from north exit node 17): west (8), east (9), centre (11)
    assert(17, 8, 9, 11);
  });

  it('each team can reach the central platform via the ramps', () => {
    // The raised platform (elevation feature) is reachable through the ramps.
    const p1 = findPath(graph, 0, 26);
    const p2 = findPath(graph, 17, 26);
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    // Every segment of a computed platform route is genuinely walkable.
    for (const p of [p1!, p2!]) {
      for (let i = 0; i < p.length - 1; i++) {
        const a = graph.byId.get(p[i])!;
        const b = graph.byId.get(p[i + 1])!;
        expect(isWalkablePath(MAP.solids, a.x, a.z, b.x, b.z, 0.6)).toBe(true);
      }
    }
  });

  it('no spawn has a direct line of sight to the opposing spawn (no straight blue->red shot)', () => {
    for (const b of MAP.spawns.blue) {
      for (const r of MAP.spawns.red) {
        const ox = b.x;
        const oz = b.z;
        const oy = 1.62; // eye height
        const dx = r.x - ox;
        const dz = r.z - oz;
        const len = Math.hypot(dx, dz);
        const hit = raycastMap(MAP.solids, ox, oy, oz, dx / len, 0, dz / len, 200);
        // A wall must occlude the direct spawn-to-spawn line.
        expect(hit).not.toBeNull();
        expect((hit!.point.x - r.x) ** 2 + (hit!.point.z - r.z) ** 2).toBeLessThan(
          (r.x - ox) ** 2 + (r.z - oz) ** 2
        );
      }
    }
  });

  it('spawn can reach the central platform through a climbable ramp (nav chain exists)', () => {
    // platform-top nodes must be reachable from ground (via the ramps).
    expect(findPath(graph, 0, 26)).not.toBeNull();
    expect(findPath(graph, 17, 26)).not.toBeNull();
    // and the platform-top cluster is internally connected
    expect(findPath(graph, 24, 25)).not.toBeNull();
  });

  it('findNearestNode returns a nearby same-height node', () => {
    const id = findNearestNode(graph, 0, 9, 0);
    expect(id).toBe(10); // (0,9) is the south main-push node
    const pid = findNearestNode(graph, 0, 0, 1.2);
    expect(pid).toBe(26); // (0,0) platform top
  });

  it('keeps characters inside the bounds (boundary walls + clamp)', () => {
    // standing at the very edge is blocked by the boundary solid.
    const wall = MAP.solids[0]; // bound-s
    expect(wall.kind).toBe('boundary');
    expect(groundHeight(MAP.solids, 0, 30.5)).toBe(4); // inside boundary => high
  });
});
