// Navigation graph + A* pathfinding, derived from the map data.
// Links are only created between nodes that are (a) within maxLink distance and
// (b) connected by a *walkable* line (isWalkablePath), so no path can cross a
// wall or fly over an unclimbable edge.

import type { MapData, NavNode, Vec3 } from '../types';
import { isWalkablePath, groundHeight } from './geometry';
import { isStandable } from './movement';

const MAX_LINK = 16;

export interface NavGraph {
  nodes: NavNode[];
  byId: Map<number, NavNode>;
}

export function buildNavGraph(map: MapData): NavGraph {
  const nodes: NavNode[] = map.navNodes.map((spec) => ({ ...spec, links: [] }));
  const byId = new Map<number, NavNode>(nodes.map((n) => [n.id, n]));

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d > MAX_LINK || d < 1e-6) continue;
      // Both nodes must be standable at their own height.
      const standA = isStandable(map.solids, a.x, a.z, 0.4, a.y, 0.6);
      const standB = isStandable(map.solids, b.x, b.z, 0.4, b.y, 0.6);
      if (!standA || !standB) continue;
      // The connecting line must be walkable (no walls / unclimbable edges).
      if (!isWalkablePath(map.solids, a.x, a.z, b.x, b.z, 0.6)) continue;
      a.links.push(b.id);
      b.links.push(a.id);
    }
  }
  return { nodes, byId };
}

export function getNeighbors(graph: NavGraph, id: number): NavNode[] {
  const node = graph.byId.get(id);
  if (!node) return [];
  const out: NavNode[] = [];
  for (const l of node.links) {
    const n = graph.byId.get(l);
    if (n) out.push(n);
  }
  return out;
}

/** Nearest node by XZ distance, biased toward matching the character's height. */
export function findNearestNode(graph: NavGraph, x: number, z: number, charY: number): number {
  let best = -1;
  let bestScore = Infinity;
  for (const n of graph.nodes) {
    const xz = Math.hypot(n.x - x, n.z - z);
    const score = xz + 24 * Math.abs(n.y - charY);
    if (score < bestScore) {
      bestScore = score;
      best = n.id;
    }
  }
  return best;
}

/**
 * A* from startId to goalId. Returns the inclusive list of node ids, or null if
 * unreachable. `avoid` (optional) is a set of node ids the path must not pass
 * through (used to prove that multiple distinct routes exist).
 */
export function findPath(
  graph: NavGraph,
  startId: number,
  goalId: number,
  avoid?: Set<number>
): number[] | null {
  if (startId < 0 || goalId < 0) return null;
  if (avoid && avoid.has(startId) && startId !== goalId) return null;
  if (startId === goalId) return [startId];
  const open: number[] = [startId];
  const cameFrom = new Map<number, number>();
  const gScore = new Map<number, number>();
  const fScore = new Map<number, number>();
  const closed = new Set<number>();
  gScore.set(startId, 0);
  fScore.set(startId, 0);
  const goalNode = graph.byId.get(goalId);

  while (open.length) {
    // pick lowest f
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      if ((fScore.get(open[i]) ?? Infinity) < (fScore.get(open[i - 1]) ?? Infinity)) bi = i;
    }
    const cur = open.splice(bi, 1)[0];
    if (cur === goalId) {
      const path = [cur];
      let c = cur;
      while (cameFrom.has(c)) {
        c = cameFrom.get(c)!;
        path.push(c);
      }
      path.reverse();
      return path;
    }
    closed.add(cur);
    for (const nb of getNeighbors(graph, cur)) {
      if (avoid && avoid.has(nb.id) && nb.id !== goalId) continue;
      if (closed.has(nb.id)) continue;
      const curNode = graph.byId.get(cur)!;
      const step = Math.hypot(nb.x - curNode.x, nb.z - curNode.z) + Math.abs(nb.y - curNode.y) * 2;
      const tentative = (gScore.get(cur) ?? Infinity) + step;
      if (tentative < (gScore.get(nb.id) ?? Infinity)) {
        cameFrom.set(nb.id, cur);
        gScore.set(nb.id, tentative);
        const h = goalNode ? Math.hypot(nb.x - goalNode.x, nb.z - goalNode.z) + Math.abs(nb.y - goalNode.y) * 2 : 0;
        fScore.set(nb.id, tentative + h);
        if (!open.includes(nb.id)) open.push(nb.id);
      }
    }
  }
  return null;
}

/** Convert a node-id path into a list of world waypoints (feet height). */
export function pathToPoints(graph: NavGraph, path: number[]): Vec3[] {
  const pts: Vec3[] = [];
  for (const id of path) {
    const n = graph.byId.get(id);
    if (n) pts.push({ x: n.x, y: n.y, z: n.z });
  }
  return pts;
}

/** Convenience used by tests: is there a path between two nodes? */
export function isReachable(graph: NavGraph, a: number, b: number): boolean {
  return findPath(graph, a, b) != null;
}

/** Ground height helper re-export for callers. */
export { groundHeight };
