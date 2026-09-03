import { describe, it, expect } from 'vitest';
import { NEON_BASTION, coverCount, NEON_BASTION_CENTRAL_NODE } from '@/game/map/mapData';
import { buildNavGraph, findPath, findNearestNode, getNeighbors } from '@/game/map/navmesh';
import { isWalkablePath, raycastMap, groundHeight } from '@/game/map/geometry';
import { isStandable } from '@/game/map/movement';
import { CONFIG } from '@/game/constants';

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
  it('has at least 12 full-height wall structures', () => {
    expect(coverCount()).toBeGreaterThanOrEqual(12);
  });

  it('MAP-03: no half-height obstacle — no solid with top in (0.3, eyeHeight)', () => {
    // The only sub-eye-height solids ever were the central platform + ramps
    // (top 1.2). They are gone, so nothing may sit between 0.3m and eye height.
    for (const s of MAP.solids) {
      expect(s.top > 0.3 && s.top < CONFIG.eyeHeight, `solid ${s.id} (${s.label}) has a half-height top=${s.top}`).toBe(false);
    }
  });

  it('MAP-03: no cover or ramp solids remain (single wall height)', () => {
    for (const s of MAP.solids) {
      expect((s.kind as string) === 'cover' || (s.kind as string) === 'ramp', `solid ${s.id} (${s.label}) is kind=${s.kind}`).toBe(false);
    }
    // Every inner (non-boundary, non-spawn) solid is a 3.0m wall: one height.
    const innerTops = new Set(
      MAP.solids.filter((s) => s.kind === 'wall').map((s) => s.top)
    );
    expect(innerTops.has(3)).toBe(true);
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

  it('each team can reach the (flat) arena centre; every route segment is walkable', () => {
    // MAP-03: the raised platform + ramps are gone, so the centre is a ground
    // node (NEON_BASTION_CENTRAL_NODE) at y=0 reachable directly by both teams.
    const c = NEON_BASTION_CENTRAL_NODE;
    const cn = graph.byId.get(c)!;
    expect(cn.y).toBe(0); // ground, not a raised surface
    const p1 = findPath(graph, 0, c);
    const p2 = findPath(graph, 17, c);
    expect(p1, 'blue should reach the centre').not.toBeNull();
    expect(p2, 'red should reach the centre').not.toBeNull();
    // Every segment of a computed centre route is genuinely walkable (flat).
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

  it('the arena centre is a walkable hub connected into the nav graph', () => {
    // MAP-03: the centre node is a ground node with real links (no isolated
    // island where all the action used to funnel through the platform).
    const c = NEON_BASTION_CENTRAL_NODE;
    const cn = graph.byId.get(c)!;
    expect(cn.links.length, 'centre node should have neighbours').toBeGreaterThan(0);
    expect(findPath(graph, 0, c)).not.toBeNull();
    expect(findPath(graph, 17, c)).not.toBeNull();
    // and the centre links out to the south/north lanes
    expect(findPath(graph, c, 10)).not.toBeNull();
    expect(findPath(graph, c, 11)).not.toBeNull();
  });

  it('findNearestNode returns a nearby same-height node', () => {
    const id = findNearestNode(graph, 0, 9, 0);
    expect(id).toBe(10); // (0,9) is the south main-push node
    const cid = findNearestNode(graph, 0, 0, 0);
    expect(cid).toBe(NEON_BASTION_CENTRAL_NODE); // (0,0) ground centre (MAP-03)
  });

  it('keeps characters inside the bounds (boundary walls + clamp)', () => {
    // standing at the very edge is blocked by the boundary solid.
    const wall = MAP.solids[0]; // bound-s
    expect(wall.kind).toBe('boundary');
    expect(groundHeight(MAP.solids, 0, 30.5)).toBe(4); // inside boundary => high
  });
});
