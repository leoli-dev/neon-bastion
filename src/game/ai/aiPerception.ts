// AI perception: fair, limited senses.
//  - Vision: within `visionDist`, inside the 100° FOV cone, and with line of
//    sight from the eye to the target's torso (no seeing through walls).
//  - Hearing: within `soundDist`, no FOV (sound is omnidirectional). The AI
//    uses hearing to orient / search, but can only target what it can SEE.

import type { Unit, Solid } from '../types';
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

/** Can the observer visually acquire the target? (distance + FOV + LOS) */
export function canSee(solids: readonly Solid[], observer: Unit, target: Unit): boolean {
  if (!target.alive || target.team === observer.team) return false;
  const dx = target.pos.x - observer.pos.x;
  const dz = target.pos.z - observer.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist > CONFIG.ai.visionDist) return false;
  if (dist < 1e-4) return true; // touching
  // FOV
  const fx = Math.sin(observer.yaw);
  const fz = Math.cos(observer.yaw);
  const t = norm2(dx, dz);
  const dot = Math.max(-1, Math.min(1, fx * t.x + fz * t.z));
  if (Math.acos(dot) > fovHalf()) return false;
  // Line of sight: eye -> target torso
  const eye = eyeOf(observer);
  const torsoY = target.pos.y + 0.9;
  return losClear(solids, eye.x, eye.z, eye.y, target.pos.x, target.pos.z, torsoY, 1.0);
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
