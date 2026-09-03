// AI perception: fair, limited senses.
//  - Vision: within `visionDist`, inside the 100° FOV cone, and with line of
//    sight from the eye to the target's torso (no seeing through walls).
//  - Hearing: within `soundDist`, no FOV (sound is omnidirectional). The AI
//    uses hearing to orient / search, but can only target what it can SEE.

import type { Unit, Solid, Team } from '../types';
import { CONFIG } from '../constants';
import { losClear } from '../map/geometry';
import { eyeOf } from '../combat/hitscan';

function norm2(x: number, z: number) {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}

export function fovHalf(): number {
  return (CONFIG.ai.fovHalfDeg * Math.PI) / 180; // half-angle (100° cone)
}

/**
 * Geometric visibility options: pure distance + FOV + line-of-sight, with NO
 * team or alive preconditions — those are the caller's decision. The AI
 * passes its perception cone (CONFIG.ai); the minimap passes its display
 * cone (CONFIG.minimap, UX-12). The two are different knobs on purpose.
 */
export interface VisibilityOptions {
  maxDist: number;
  fovHalf: number; // radians
}

/** UX-12 minimap display cone: ±45° (90° total), its own radius. */
export const MINIMAP_VISIBILITY: VisibilityOptions = {
  maxDist: CONFIG.minimap.visionDist,
  fovHalf: (CONFIG.minimap.fovHalfDeg * Math.PI) / 180,
};

/**
 * Geometric visibility only: `target` within `maxDist`, inside the ±`fovHalf`
 * arc centred on the observer's facing, and with a clear sight line (eye ->
 * target torso; sight passes THROUGH glass per MAP-02). No team/alive
 * preconditions — shared by canSee() (AI) and the minimap (UX-12).
 */
export function geomVisible(
  solids: readonly Solid[],
  observer: Unit,
  target: Unit,
  o: VisibilityOptions
): boolean {
  const dx = target.pos.x - observer.pos.x;
  const dz = target.pos.z - observer.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist > o.maxDist) return false;
  if (dist < 1e-4) return true; // touching
  // FOV
  const fx = Math.sin(observer.yaw);
  const fz = Math.cos(observer.yaw);
  const t = norm2(dx, dz);
  const dot = Math.max(-1, Math.min(1, fx * t.x + fz * t.z));
  if (Math.acos(dot) > o.fovHalf) return false;
  // Line of sight: eye -> target torso
  const eye = eyeOf(observer);
  const torsoY = target.pos.y + 0.9;
  return losClear(solids, eye.x, eye.z, eye.y, target.pos.x, target.pos.z, torsoY, 1.0);
}

/** Can the observer visually acquire the target? (distance + FOV + LOS) */
export function canSee(solids: readonly Solid[], observer: Unit, target: Unit): boolean {
  if (target.team === observer.team) return false;
  if (!target.alive) return false;
  // AI perception cone (CONFIG.ai) — NOT the minimap display cone.
  return geomVisible(solids, observer, target, {
    maxDist: CONFIG.ai.visionDist,
    fovHalf: fovHalf(),
  });
}

/**
 * UX-12: may `target` be shown on the minimap of a player on `viewerTeam`?
 * An enemy appears only while the player THEMSELVES or any LIVING teammate
 * of `viewerTeam` has geometric sight of it (minimap display cone). Dead
 * enemies are never shown (nothing to track).
 */
export function sharedViewCanSee(
  solids: readonly Solid[],
  units: readonly Unit[],
  viewerTeam: Team,
  target: Unit
): boolean {
  if (!target.alive || target.team === viewerTeam) return false;
  for (const u of units) {
    if (u.team !== viewerTeam || !u.alive) continue;
    if (geomVisible(solids, u, target, MINIMAP_VISIBILITY)) return true;
  }
  return false;
}

/** Can the observer hear the target? (distance only) */
export function isHeard(observer: Unit, target: Unit): boolean {
  if (!target.alive || target.team === observer.team) return false;
  const d = Math.hypot(target.pos.x - observer.pos.x, target.pos.z - observer.pos.z);
  return d <= CONFIG.ai.soundDist;
}

export interface Perception {
  visible: Unit[]; // in FOV + LOS + range (can target)
  heard: Unit[]; // in hearing range (awareness / search)
}

export function perceive(solids: readonly Solid[], observer: Unit, units: readonly Unit[]): Perception {
  const visible: Unit[] = [];
  const heard: Unit[] = [];
  for (const u of units) {
    if (u.id === observer.id) continue;
    if (isHeard(observer, u)) heard.push(u);
    if (canSee(solids, observer, u)) visible.push(u);
  }
  return { visible, heard };
}
