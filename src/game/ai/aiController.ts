// AI controller: a deterministic, fair state machine.
//   assemble -> patrol -> engage -> (retreat when low) -> search -> cautious
// Perception is limited (FOV + LOS + range + hearing). The AI never fires at
// what it cannot see, and hitscan enforces wall occlusion, so it cannot shoot
// through walls. Accuracy is limited by an aim-inaccuracy cone; reaction is
// gated by a delay; fire is bursty with reload gaps.

import type { Unit, Vec3, AIState, MapData, Solid } from '../types';
import { CONFIG } from '../constants';
import { RNG, hashSeed } from '../rng';
import { losClear } from '../map/geometry';
import { stepUnit } from '../map/movement';
import { findPath, findNearestNode, type NavGraph } from '../map/navmesh';
import { eyeOf, fireWeapon } from '../combat/hitscan';
import { perturbDirection, startReload } from '../combat/weapon';
import { perceive } from './aiPerception';

export interface MatchContext {
  map: MapData;
  solids: Solid[];
  graph: NavGraph;
  units: Unit[];
  now: number;
  dt: number;
  seed: number;
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

export function createBrain(unit: Unit, seed: number): AIState {
  const rng = new RNG(hashSeed(seed, 70000 + unit.id * 131));
  return {
    state: 'assemble',
    stateUntil: 0,
    path: [],
    pathIndex: 0,
    targetId: -1,
    lastSeenPos: null,
    lastSeenAt: -1000,
    reactUntil: 0,
    burstLeft: 0,
    nextBurstAt: 0,
    strafeDir: 0,
    strafeUntil: 0,
    rng: () => rng.next(),
  };
}

function findUnit(units: readonly Unit[], id: number): Unit | null {
  if (id < 0) return null;
  return units.find((u) => u.id === id) ?? null;
}

function nearest(list: readonly Unit[], from: Unit): Unit | null {
  let best: Unit | null = null;
  let bd = Infinity;
  for (const u of list) {
    if (!u.alive) continue;
    const d = Math.hypot(u.pos.x - from.pos.x, u.pos.z - from.pos.z);
    if (d < bd) {
      bd = d;
      best = u;
    }
  }
  return best;
}

/** Does this unit still have at least one living teammate (excluding itself)? */
function hasLivingAllies(units: readonly Unit[], unit: Unit): boolean {
  return units.some((u) => u.team === unit.team && u.alive && u.id !== unit.id);
}

function goPatrol(b: AIState): void {
  b.state = 'patrol';
  b.pathIndex = b.path.length; // force a fresh waypoint
}

function setPath(unit: Unit, b: AIState, graph: NavGraph, dest: number): void {
  if (dest < 0) {
    b.path = [];
    b.pathIndex = 0;
    return;
  }
  const cur = findNearestNode(graph, unit.pos.x, unit.pos.z, unit.pos.y);
  const p = findPath(graph, cur, dest);
  if (p && p.length > 1) {
    b.path = p;
    b.pathIndex = 1;
  } else {
    b.path = [dest];
    b.pathIndex = 0;
  }
}

function followPath(unit: Unit, b: AIState, graph: NavGraph): { vx: number; vz: number } {
  let guard = 0;
  while (guard++ < 12) {
    if (b.pathIndex >= b.path.length) return { vx: 0, vz: 0 };
    const node = graph.byId.get(b.path[b.pathIndex]);
    if (!node) {
      b.pathIndex++;
      continue;
    }
    const dx = node.x - unit.pos.x;
    const dz = node.z - unit.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.8) {
      b.pathIndex++;
      continue;
    }
    return { vx: (dx / d) * CONFIG.aiSpeed, vz: (dz / d) * CONFIG.aiSpeed };
  }
  return { vx: 0, vz: 0 };
}

function pickPatrolNode(b: AIState, graph: NavGraph, unit: Unit, mode: 'advance' | 'wander'): number {
  let best = -1;
  let bestScore = Infinity;
  for (const n of graph.nodes) {
    if (Math.abs(n.y) > 0.15) continue;
    const dMe = Math.hypot(n.x - unit.pos.x, n.z - unit.pos.z);
    if (dMe < 4) continue;
    const dCenter = Math.hypot(n.x, n.z);
    const score =
      mode === 'advance'
        ? dCenter + dMe * 0.25 + b.rng() * 8
        : dMe + b.rng() * 12;
    if (score < bestScore) {
      bestScore = score;
      best = n.id;
    }
  }
  return best;
}

function engageMove(unit: Unit, b: AIState, target: Unit, now: number): { vx: number; vz: number } {
  const dx = target.pos.x - unit.pos.x;
  const dz = target.pos.z - unit.pos.z;
  const d = Math.hypot(dx, dz) || 1;
  let forward = 0;
  if (d > 15) forward = 1;
  else if (d < 6) forward = -0.6;
  if (now > b.strafeUntil || b.strafeDir === 0) {
    b.strafeDir = b.rng() < 0.5 ? -1 : 1;
    b.strafeUntil = now + 0.8 + b.rng() * 1.0;
  }
  const fx = dx / d;
  const fz = dz / d;
  const rx = -fz;
  const rz = fx;
  const s = CONFIG.aiStrafeSpeed;
  return {
    vx: fx * forward * CONFIG.aiSpeed * 0.5 + rx * b.strafeDir * s,
    vz: fz * forward * CONFIG.aiSpeed * 0.5 + rz * b.strafeDir * s,
  };
}

function retreatMove(unit: Unit, b: AIState, threat: Unit | null, solids: readonly Solid[], graph: NavGraph): { vx: number; vz: number } {
  let cover = -1;
  let bestScore = Infinity;
  for (const n of graph.nodes) {
    if (Math.abs(n.y) > 0.15) continue;
    const dMe = Math.hypot(n.x - unit.pos.x, n.z - unit.pos.z);
    if (dMe < 2) continue;
    const hidden = threat ? !losClear(solids, threat.pos.x, threat.pos.z, threat.pos.y + 1.6, n.x, n.z, n.y + 1.0, 1.0) : true;
    if (!hidden) continue;
    if (dMe < bestScore) {
      bestScore = dMe;
      cover = n.id;
    }
  }
  if (cover >= 0) {
    if (b.pathIndex >= b.path.length) setPath(unit, b, graph, cover);
    return followPath(unit, b, graph);
  }
  if (threat) {
    const ax = unit.pos.x - threat.pos.x;
    const az = unit.pos.z - threat.pos.z;
    const d = Math.hypot(ax, az) || 1;
    return { vx: (ax / d) * CONFIG.aiSpeed, vz: (az / d) * CONFIG.aiSpeed };
  }
  return { vx: 0, vz: 0 };
}

function doShoot(unit: Unit, ctx: MatchContext, now: number, target: Unit): void {
  const b = unit.ai!;
  if (unit.mag <= 0) {
    startReload(unit, now);
    return;
  }
  if (unit.reloading) return;
  if (b.burstLeft <= 0) {
    if (now < b.nextBurstAt) return;
    b.burstLeft = CONFIG.ai.burstMin + Math.floor(b.rng() * (CONFIG.ai.burstMax - CONFIG.ai.burstMin + 1));
  }
  if (now - unit.lastShotAt < CONFIG.ai.fireInterval) return;
  const eye = eyeOf(unit);
  const dx = target.pos.x - eye.x;
  const dy = target.pos.y + 0.9 - eye.y;
  const dz = target.pos.z - eye.z;
  const base = norm({ x: dx, y: dy, z: dz });
  const dist = Math.hypot(dx, dz);
  const speed = Math.hypot(unit.vel.x, unit.vel.z);
  const cone =
    CONFIG.ai.inaccuracyBase +
    dist * CONFIG.ai.inaccuracyDist +
    (speed > 1 ? CONFIG.ai.moveInaccuracy : 0);
  const az = b.rng() * Math.PI * 2;
  const aim = perturbDirection(base, cone, az);
  fireWeapon({ units: ctx.units, solids: ctx.solids, shooter: unit, aim, now, seed: ctx.seed });
  b.burstLeft--;
  if (b.burstLeft <= 0) b.nextBurstAt = now + 0.5 + b.rng() * 0.6;
}

/** Advance one AI unit by one logic tick. */
export function aiThink(unit: Unit, ctx: MatchContext): void {
  const b = unit.ai!;
  const { map, graph, units, now, dt } = ctx;
  const solids = ctx.solids;

  if (!unit.alive) {
    b.state = 'dead';
    stepUnit(unit, 0, 0, false, map, dt);
    return;
  }

  const perc = perceive(solids, unit, units);
  const target = nearest(perc.visible, unit);
  const targetUnit = target ? findUnit(units, target.id) : null;
  const seen = targetUnit != null;
  const lowHp = unit.hp <= CONFIG.ai.retreatHp;
  const lostTime = now - b.lastSeenAt;

  if (targetUnit) {
    if (b.targetId !== targetUnit.id) {
      b.targetId = targetUnit.id;
      b.reactUntil = now + CONFIG.ai.reactTime + b.rng() * 0.12;
    }
    b.lastSeenPos = { x: targetUnit.pos.x, z: targetUnit.pos.z };
    b.lastSeenAt = now;
  }

  let vx = 0;
  let vz = 0;
  let wantShoot = false;
  let aimTarget: Unit | null = null;

  switch (b.state) {
    case 'assemble': {
      if (seen) {
        b.state = 'engage';
        break;
      }
      if (!hasLivingAllies(units, unit)) {
        b.state = 'cautious';
        break;
      }
      if (perc.heard.length > 0) {
        b.state = 'alert';
        b.stateUntil = now + CONFIG.ai.alertTime;
        break;
      }
      if (b.pathIndex >= b.path.length) setPath(unit, b, graph, pickPatrolNode(b, graph, unit, 'advance'));
      const m = followPath(unit, b, graph);
      vx = m.vx;
      vz = m.vz;
      if (b.pathIndex >= b.path.length) goPatrol(b);
      break;
    }
    case 'patrol': {
      if (seen) {
        b.state = 'engage';
        break;
      }
      if (lowHp) {
        b.state = 'retreat';
        break;
      }
      if (!hasLivingAllies(units, unit)) {
        b.state = 'cautious';
        break;
      }
      if (perc.heard.length > 0) {
        b.state = 'alert';
        b.stateUntil = now + CONFIG.ai.alertTime;
        break;
      }
      if (b.pathIndex >= b.path.length) setPath(unit, b, graph, pickPatrolNode(b, graph, unit, b.rng() < 0.6 ? 'advance' : 'wander'));
      const m = followPath(unit, b, graph);
      vx = m.vx;
      vz = m.vz;
      break;
    }
    case 'alert': {
      // Heard gunfire / sensed a threat but has not acquired a target: route
      // toward the sound via the navmesh (so we go AROUND cover such as the
      // central platform, instead of walking straight into it and getting
      // stuck), then keep looking. Not a shoot state.
      if (seen) {
        b.state = 'engage';
        break;
      }
      if (!hasLivingAllies(units, unit)) {
        b.state = 'cautious';
        break;
      }
      const h = nearest(perc.heard, unit);
      if (h && now < b.stateUntil) {
        if (b.pathIndex >= b.path.length) {
          setPath(unit, b, graph, findNearestNode(graph, h.pos.x, h.pos.z, h.pos.y));
        }
        const m = followPath(unit, b, graph);
        vx = m.vx * 0.85;
        vz = m.vz * 0.85;
        if (b.pathIndex >= b.path.length) goPatrol(b);
      } else {
        goPatrol(b);
      }
      break;
    }
    case 'engage': {
      if (!seen) {
        b.state = 'search';
        break;
      }
      if (lowHp) {
        b.state = 'retreat';
        break;
      }
      aimTarget = targetUnit;
      if (now >= b.reactUntil) wantShoot = true;
      const m = engageMove(unit, b, targetUnit!, now);
      vx = m.vx;
      vz = m.vz;
      break;
    }
    case 'retreat': {
      const m = retreatMove(unit, b, targetUnit, solids, graph);
      vx = m.vx;
      vz = m.vz;
      if (seen && now >= b.reactUntil) {
        aimTarget = targetUnit;
        wantShoot = true;
      }
      if (!seen && lostTime > CONFIG.ai.searchTime) goPatrol(b);
      else if (seen && !lowHp) b.state = 'engage';
      break;
    }
    case 'search': {
      if (seen) {
        b.state = 'engage';
        break;
      }
      if (lostTime > CONFIG.ai.searchTime) {
        goPatrol(b);
        break;
      }
      if (b.lastSeenPos) {
        const lx = b.lastSeenPos.x - unit.pos.x;
        const lz = b.lastSeenPos.z - unit.pos.z;
        const d = Math.hypot(lx, lz);
        if (d > 1) {
          vx = (lx / d) * CONFIG.aiSpeed;
          vz = (lz / d) * CONFIG.aiSpeed;
        }
      }
      break;
    }
    case 'cautious': {
      // Last one on the team: push forward cautiously toward the centre /
      // nearest threat, but never rush into the open.
      if (seen) {
        b.state = 'engage';
        break;
      }
      if (lowHp) {
        b.state = 'retreat';
        break;
      }
      if (b.pathIndex >= b.path.length) setPath(unit, b, graph, pickPatrolNode(b, graph, unit, 'advance'));
      const m = followPath(unit, b, graph);
      vx = m.vx * 0.7;
      vz = m.vz * 0.7;
      break;
    }
    case 'dead':
      break;
  }

  // ---- facing / aim (also lets the AI turn to bring threats into its FOV) ----
  if (aimTarget) {
    const eye = eyeOf(unit);
    const dx = aimTarget.pos.x - eye.x;
    const dy = aimTarget.pos.y + 0.9 - eye.y;
    const dz = aimTarget.pos.z - eye.z;
    unit.yaw = Math.atan2(dx, dz);
    unit.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  } else {
    const focus = nearest(perc.heard, unit);
    const focusPos = focus ? { x: focus.pos.x, z: focus.pos.z } : b.lastSeenPos;
    if (focusPos) {
      const fx = focusPos.x - unit.pos.x;
      const fz = focusPos.z - unit.pos.z;
      if (Math.hypot(fx, fz) > 0.5) unit.yaw = Math.atan2(fx, fz);
    } else if (vx !== 0 || vz !== 0) {
      unit.yaw = Math.atan2(vx, vz);
    }
  }

  // ---- move ----
  stepUnit(unit, vx, vz, false, map, dt);

  // ---- shoot ----
  if (wantShoot && aimTarget) doShoot(unit, ctx, now, aimTarget);
}
