// AI controller: a deterministic, fair state machine.
//   assemble -> patrol -> engage -> (retreat when low) -> search -> cautious
// Perception is limited (FOV + LOS + range + hearing). The AI never fires at
// what it cannot see, and the projectile's continuous-collision raycast
// enforces wall occlusion, so it cannot shoot through walls. Bullets are
// ballistic (CONFIG.bulletSpeed), so the AI leads moving targets by their
// velocity × estimated flight time. Accuracy is limited by an aim-inaccuracy
// cone (kept as the difficulty knob); reaction is gated by a delay. At the
// shared 1-shot-per-second cadence there is no burst concept: an AI with a
// target in sight simply fires one round whenever its cooldown has elapsed
// ("fire when it's time").
//
// AI-01 — strategic personalities (doctrine). Each unit is assigned one of
// two doctrines by the match seed (per-team draw, both sides get both):
//   * 'rusher'  — pushes the mid / shortest path, holds the fight, and only
//     retreats when very low on HP (later than everyone else).
//   * 'flanker' — picks waypoints far from its teammates' centroid (the outer
//     east/west lanes, not the mid), fires ONE round then peels off to cover
//     for a short disengage window ('flank' state) before re-engaging, and
//     refuses to join a firefight its teammates are already in.
// After CONFIG.ai.doctrine.stalemateTime, flankers drop the doctrine and
// fight as rushers so a dragging game still terminates.

import type { Unit, Vec3, AIState, MapData, Solid, Doctrine } from '../types';
import { CONFIG } from '../constants';
import { RNG, hashSeed } from '../rng';
import { losClear, lineOfFireClear } from '../map/geometry';
import { stepUnit } from '../map/movement';
import { findPath, findNearestNode, type NavGraph } from '../map/navmesh';
import { eyeOf, type FireResult } from '../combat/hitscan';
import { perturbDirection } from '../combat/weapon';
import { perceive } from './aiPerception';

export interface MatchContext {
  map: MapData;
  solids: Solid[];
  graph: NavGraph;
  units: Unit[];
  now: number;
  dt: number;
  seed: number;
  /**
   * The ONLY way an AI unit fires. Provided by Match so that AI shots travel
   * the exact same path as player shots (fireWeapon + the Match event bus):
   * tracers, muzzle flash, sparks, gun audio, hit/kill events and the kill
   * feed all work identically for AI and player shooters.
   */
  fire: (shooter: Unit, aim: Vec3) => FireResult;
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/**
 * AI-01: strategic personality. Assigned per TEAM from a team-level seeded
 * draw (Fisher–Yates over the team's 4 member slots): exactly two members
 * become flankers and two rushers on EACH side, and WHICH members are which
 * is a pure function of the match seed — never hard-coded to unit ids. Both
 * the human's team and the enemy team get both doctrines.
 */
export function doctrineFor(unit: Unit, seed: number): Doctrine {
  const teamSalt = unit.team === 'blue' ? 2846 : 3119;
  const rng = new RNG(hashSeed(seed, 70000 + teamSalt));
  const order = [0, 1, 2, 3];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const slot = ((unit.id % 4) + 4) % 4;
  return order.indexOf(slot) < 2 ? 'flanker' : 'rusher';
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
    strafeDir: 0,
    strafeUntil: 0,
    doctrine: doctrineFor(unit, seed),
    flankUntil: 0,
    retreatSince: 0,
    stuckSince: 0,
    stuckX: 0,
    stuckZ: 0,
    slideSign: 0,
    slideUntil: 0,
    clearSince: 0,
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

/** Number of living teammates (excluding `unit`) within `radius` of a point. */
function alliesNear(units: readonly Unit[], unit: Unit, x: number, z: number, radius: number): number {
  let c = 0;
  for (const u of units) {
    if (!u.alive || u.team !== unit.team || u.id === unit.id) continue;
    if (Math.hypot(u.pos.x - x, u.pos.z - z) <= radius) c++;
  }
  return c;
}

/** AI-01: rushers disengage later — their retreat threshold is lower HP. */
function retreatHpFor(b: AIState): number {
  return b.doctrine === 'rusher' ? CONFIG.ai.doctrine.rusherRetreatHp : CONFIG.ai.retreatHp;
}

/** Enter 'retreat' with a fresh timestamp (dwell guard) and cover re-pick. */
function enterRetreat(b: AIState, now: number): void {
  b.state = 'retreat';
  b.retreatSince = now;
  b.pathIndex = b.path.length; // force a fresh cover pick
}

function goPatrol(b: AIState): void {
  b.state = 'patrol';
  b.pathIndex = b.path.length; // force a fresh waypoint
}

function setPath(unit: Unit, b: AIState, graph: NavGraph, dest: number, solids: readonly Solid[]): void {
  if (dest < 0) {
    b.path = [];
    b.pathIndex = 0;
    return;
  }
  const cur = nearestReachableNode(graph, solids, unit.pos.x, unit.pos.z, unit.pos.y);
  const p = findPath(graph, cur, dest);
  if (p && p.length > 1) {
    b.path = p;
    // When the unit stands off the nav graph, do NOT skip the start node:
    // walking straight to path[1] from the unit's real position would cut
    // through whatever wall put it off-graph in the first place. Walk to the
    // start node (whose sight line we verified) before following the route.
    const cn = graph.byId.get(cur);
    const dCur = cn ? Math.hypot(cn.x - unit.pos.x, cn.z - unit.pos.z) : 0;
    b.pathIndex = dCur < 1.2 ? 1 : 0;
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

/**
 * Pick the next waypoint node.
 *  - 'advance': centre + shortest path first (the classic mid push).
 *  - 'wander':  something near-ish.
 *  - 'flank' (AI-01): prefer nodes FAR from the living teammates' centroid —
 *    the outer lanes (east/west wings, enemy half) — instead of the mid.
 */
export function pickPatrolNode(
  b: AIState,
  graph: NavGraph,
  unit: Unit,
  mode: 'advance' | 'wander' | 'flank',
  allies: readonly Unit[]
): number {
  let cx = 0;
  let cz = 0;
  let cnt = 0;
  for (const a of allies) {
    if (!a.alive || a.id === unit.id) continue;
    cx += a.pos.x;
    cz += a.pos.z;
    cnt++;
  }
  const hasAlly = cnt > 0;
  let best = -1;
  let bestScore = Infinity;
  for (const n of graph.nodes) {
    if (Math.abs(n.y) > 0.15) continue;
    const dMe = Math.hypot(n.x - unit.pos.x, n.z - unit.pos.z);
    if (dMe < 4) continue;
    const dCenter = Math.hypot(n.x, n.z);
    const dAlly = hasAlly ? Math.hypot(n.x - cx / cnt, n.z - cz / cnt) : 0;
    const score =
      mode === 'advance'
        ? dCenter + dMe * 0.25 + b.rng() * 8
        : mode === 'flank'
          ? dMe * 0.25 + dCenter * 0.5 - dAlly * 1.5 + b.rng() * 8
          : dMe + b.rng() * 12;
    if (score < bestScore) {
      bestScore = score;
      best = n.id;
    }
  }
  return best;
}

/**
 * Nearest node that is ALSO reachable by a straight walk from (x, z) (clear
 * sight at torso height). Units standing off the nav graph (mid-corridor,
 * jammed against a wall) would otherwise get a path whose first segment cuts
 * through the wall they are pressed against. Falls back to the plain nearest
 * node when nothing is directly walkable.
 */
function nearestReachableNode(
  graph: NavGraph,
  solids: readonly Solid[],
  x: number,
  z: number,
  y: number,
): number {
  let anyBest = -1;
  let anyScore = Infinity;
  let reachBest = -1;
  let reachScore = Infinity;
  for (const n of graph.nodes) {
    const xz = Math.hypot(n.x - x, n.z - z);
    const score = xz + 24 * Math.abs(n.y - y);
    if (score < anyScore) {
      anyScore = score;
      anyBest = n.id;
    }
    if (score < reachScore && losClear(solids, x, z, y + 1.0, n.x, n.z, n.y + 1.0, 1.0, undefined, { throughGlass: false })) {
      reachScore = score;
      reachBest = n.id;
    }
  }
  return reachBest >= 0 ? reachBest : anyBest;
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
    if (b.pathIndex >= b.path.length) setPath(unit, b, graph, cover, solids);
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

/**
 * Ballistic line of fire: eyes → target torso, with glass COUNTED as blocking
 * (MAP-02). Sight lines (canSee) pass through glass; this one does not, so
 * an AI that can SEE a target through glass will hold its fire until it has
 * an unobstructed shot line instead of emptying rounds into the pane.
 */
function hasLineOfFire(solids: readonly Solid[], shooter: Unit, target: Unit): boolean {
  const eye = eyeOf(shooter);
  return lineOfFireClear(
    solids,
    eye.x, eye.y, eye.z,
    target.pos.x, target.pos.y + 0.9, target.pos.z
  );
}

/**
 * MAP-02: the target is visible but a glass wall blocks the shot — route to a
 * nav node that has a clean ballistic line on the target (glass counts),
 * i.e. "get to a position where I can actually hit". Falls back to the
 * normal engage motion if no such node exists.
 */
function clearShotMove(unit: Unit, b: AIState, target: Unit, solids: readonly Solid[], graph: NavGraph, now: number): { vx: number; vz: number } {
  let best = -1;
  let bestScore = Infinity;
  for (const n of graph.nodes) {
    if (Math.abs(n.y) > 0.15) continue;
    const dMe = Math.hypot(n.x - unit.pos.x, n.z - unit.pos.z);
    if (dMe < 3) continue;
    if (!lineOfFireClear(solids, n.x, n.y + CONFIG.eyeHeight, n.z, target.pos.x, target.pos.y + 0.9, target.pos.z)) continue;
    const dTarget = Math.hypot(target.pos.x - n.x, target.pos.z - n.z);
    const score = dMe + dTarget * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = n.id;
    }
  }
  if (best >= 0) {
    if (b.pathIndex >= b.path.length || b.path[b.path.length - 1] !== best) {
      setPath(unit, b, graph, best, solids);
    }
    return followPath(unit, b, graph);
  }
  return engageMove(unit, b, target, now);
}

function doShoot(unit: Unit, ctx: MatchContext, now: number, target: Unit): void {
  const b = unit.ai!;
  // MAP-02: pre-fire ballistic check. canSee() intentionally passes through
  // glass, but bullets do not — if the eye→torso segment is blocked (e.g. by
  // a glass wall) hold fire and let the controller reposition, instead of
  // firing one round per second into glass forever.
  if (!hasLineOfFire(ctx.solids, unit, target)) return;
  // One shot per second, same cadence as the player: fire a single round the
  // moment the cooldown elapses while a target is still in sight. There is no
  // burst — at 1 rps a "burst" would just be a sustained 1/s fire.
  if (now - unit.lastShotAt < CONFIG.ai.fireInterval) return;
  const eye = eyeOf(unit);
  // First-order lead: aim at (target position + target velocity × estimated
  // flight time). Bullets fly at CONFIG.bulletSpeed, so at 30 m the bullet is
  // airborne 0.5 s — aiming at the target's CURRENT position would miss any
  // strafing target. One refinement pass keeps the distance honest at range.
  let leadX = target.pos.x;
  let leadZ = target.pos.z;
  for (let i = 0; i < 2; i++) {
    const d = Math.hypot(leadX - eye.x, leadZ - eye.z);
    const tf = d / CONFIG.bulletSpeed;
    leadX = target.pos.x + target.vel.x * tf;
    leadZ = target.pos.z + target.vel.z * tf;
  }
  const dx = leadX - eye.x;
  const dy = target.pos.y + 0.9 - eye.y;
  const dz = leadZ - eye.z;
  const base = norm({ x: dx, y: dy, z: dz });
  const dist = Math.hypot(leadX - eye.x, leadZ - eye.z);
  const speed = Math.hypot(unit.vel.x, unit.vel.z);
  const cone =
    CONFIG.ai.inaccuracyBase +
    dist * CONFIG.ai.inaccuracyDist +
    (speed > 1 ? CONFIG.ai.moveInaccuracy : 0);
  const az = b.rng() * Math.PI * 2;
  const aim = perturbDirection(base, cone, az);
  ctx.fire(unit, aim);
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
  // Target hysteresis: keep the current target while it is still visible.
  // Picking "nearest visible" fresh every tick makes a unit in a pile
  // flip-flop between two near-equal distances, and every flip resets the
  // reaction delay — the unit never finishes a shot cycle.
  let targetUnit: Unit | null = null;
  if (b.targetId >= 0) {
    const prev = findUnit(units, b.targetId);
    if (prev && prev.alive && prev.team !== unit.team && perc.visible.some((v) => v.id === prev.id)) {
      targetUnit = prev;
    }
  }
  if (!targetUnit) {
    const t2 = nearest(perc.visible, unit);
    targetUnit = t2 ? findUnit(units, t2.id) : null;
  }
  const seen = targetUnit != null;
  const lowHp = unit.hp <= retreatHpFor(b);
  const lostTime = now - b.lastSeenAt;
  // AI-01: flankers stop flanking once the stalemate window is over — after
  // stalemateTime everyone fights as a rusher so a dragging game still ends.
  const isFlanker = b.doctrine === 'flanker' && now < CONFIG.ai.doctrine.stalemateTime;
  // AI-01 final escalation: after hardPushTime EVERY unit patrols a pure
  // centre-push (no wander / no flank) so late-match survivors converge and
  // the game terminates instead of two teams circling their own halves.
  const hardPush = now >= CONFIG.ai.doctrine.hardPushTime;
    let mayEngage = seen;
  if (seen && isFlanker && targetUnit) {
    const clump = alliesNear(units, unit, targetUnit.pos.x, targetUnit.pos.z, CONFIG.ai.doctrine.clumpRadius);
    if (clump >= CONFIG.ai.doctrine.clumpAllies) mayEngage = false;
  }

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

  if (now >= CONFIG.ai.doctrine.warTime) {
    // AI-01 terminal escalation: dumb "walk at the target, shoot when the
    // round will actually connect, cower at most 6s while bleeding" — any
    // two survivors that face each other then trade until one dies. We only
    // get here after the game has dragged past two minutes, so a clumsy
    // shoving match beats a stalemate where nobody dies.
    const e = targetUnit;
    const clear = e ? hasLineOfFire(solids, unit, e) : false;
    const lowHpWar = unit.hp <= 20;
    if (lowHpWar && clear && b.state !== 'retreat') b.retreatSince = now;
    const fleeing = lowHpWar && clear && now - b.retreatSince < 6;
    if (e && fleeing) {
      b.state = 'retreat';
      const m2 = retreatMove(unit, b, e, solids, graph);
      vx = m2.vx;
      vz = m2.vz;
    } else if (e) {
      b.state = 'engage';
      let m3: { vx: number; vz: number };
      if (clear) {
        b.clearSince = 0;
        m3 = engageMove(unit, b, e, now);
      } else if (b.clearSince > 0 && now - b.clearSince > 4) {
        // The lane-hunt is over: when the target never offers a fireable line
        // (e.g. pinned behind/against glass), orbiting forever is a stalemate —
        // walk straight into it. Getting point-blank IS the fix.
        m3 = engageMove(unit, b, e, now);
      } else {
        if (b.clearSince <= 0) b.clearSince = now;
        m3 = clearShotMove(unit, b, e, solids, graph, now);
      }
      vx = m3.vx;
      vz = m3.vz;
      aimTarget = e;
      wantShoot = true;
    } else {
      b.state = 'patrol';
      // No visible enemy: stop guessing and path to the nearest enemy's
      // ACTUAL position (both sides do this, so they physically converge
      // and end up facing each other instead of orbiting the map).
      let foe: Unit | null = null;
      let fd = Infinity;
      for (const u of units) {
        if (!u.alive || u.team === unit.team) continue;
        const d = Math.hypot(u.pos.x - unit.pos.x, u.pos.z - unit.pos.z);
        if (d < fd) {
          fd = d;
          foe = u;
        }
      }
      if (foe) {
        const dest = findNearestNode(graph, foe.pos.x, foe.pos.z, foe.pos.y);
        if (b.pathIndex >= b.path.length || b.path[b.path.length - 1] !== dest) {
          setPath(unit, b, graph, dest, solids);
        }
      } else if (b.pathIndex >= b.path.length) {
        setPath(unit, b, graph, pickPatrolNode(b, graph, unit, 'advance', units), solids);
      }
      const m4 = followPath(unit, b, graph);
      vx = m4.vx;
      vz = m4.vz;
      if (vx === 0 && vz === 0 && foe) {
        // Empty or consumed path (or the unit is off-graph and A* has no
        // route): never camp on a waypoint. Walk straight at the enemy's
        // actual position — the shared stall/slide tail below breaks any
        // wall contact the result makes, so this cannot livelock either.
        const dx = foe.pos.x - unit.pos.x;
        const dz = foe.pos.z - unit.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        vx = (dx / d) * CONFIG.aiSpeed;
        vz = (dz / d) * CONFIG.aiSpeed;
      }
    }
  } else {
    switch (b.state) {
    case 'assemble': {
      if (mayEngage) {
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
      if (b.pathIndex >= b.path.length) setPath(unit, b, graph, pickPatrolNode(b, graph, unit, hardPush ? 'advance' : isFlanker ? 'flank' : 'advance', units), ctx.solids);
      const m = followPath(unit, b, graph);
      vx = m.vx;
      vz = m.vz;
      if (b.pathIndex >= b.path.length) goPatrol(b);
      break;
    }
    case 'patrol': {
      if (mayEngage) {
        b.state = 'engage';
        break;
      }
      // Livelock fix (MAP-02 second-order effect): the old `lowHp -> retreat`
      // here ping-ponged against retreat's exits (retreat -> patrol ->
      // retreat, every tick) and FROZE low-HP units in place forever —
      // retreat only moved toward the nearest cover node, which immediately
      // became the "new nearest" again once the forced re-pick happened.
      // A hurt unit with no visible threat keeps moving: wounded units roam
      // nearby instead of pushing the centre; if they SPOT a threat they
      // engage -> immediately retreat, which now always has an exit.
      if (!hasLivingAllies(units, unit)) {
        b.state = 'cautious';
        break;
      }
      if (perc.heard.length > 0) {
        b.state = 'alert';
        b.stateUntil = now + CONFIG.ai.alertTime;
        break;
      }
      const mode: 'advance' | 'wander' | 'flank' =
        hardPush ? 'advance' : isFlanker ? 'flank' : lowHp ? 'wander' : b.rng() < 0.6 ? 'advance' : 'wander';
      if (b.pathIndex >= b.path.length) setPath(unit, b, graph, pickPatrolNode(b, graph, unit, mode, units), ctx.solids);
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
      if (mayEngage) {
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
          setPath(unit, b, graph, findNearestNode(graph, h.pos.x, h.pos.z, h.pos.y), ctx.solids);
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
        enterRetreat(b, now);
        break;
      }
      if (isFlanker) {
        const clump = alliesNear(units, unit, targetUnit!.pos.x, targetUnit!.pos.z, CONFIG.ai.doctrine.clumpRadius);
        if (clump >= CONFIG.ai.doctrine.clumpAllies) {
          // A brawl started while we closed in — peel off and keep flanking.
          goPatrol(b);
          break;
        }
      }
      aimTarget = targetUnit;
      // MAP-02: firing is gated on a real ballistic line of fire, not just on
      // sight. Seen through glass but not hittable? Move to a clear position.
      const clearShot = hasLineOfFire(solids, unit, targetUnit!);
      const reacted = now >= b.reactUntil;
      if (isFlanker) {
        // AI-01 one-shot doctrine: once the reaction delay is over a flanker
        // either fires immediately or peels off — it never loiters in the
        // firefight waiting out its cooldown. (While the shot line is still
        // blocked it repositions via clearShotMove and fires once it's clean.)
        const coolReady = now - unit.lastShotAt >= CONFIG.ai.fireInterval;
        if (reacted && !coolReady) {
          goPatrol(b);
          break;
        }
        if (reacted && coolReady && clearShot) wantShoot = true;
      } else if (reacted && clearShot) {
        wantShoot = true;
      }
      const m = clearShot ? engageMove(unit, b, targetUnit!, now) : clearShotMove(unit, b, targetUnit!, solids, graph, now);
      vx = m.vx;
      vz = m.vz;
      break;
    }
    case 'flank': {
      // AI-01: the post-shot disengage window. No firing here — the round
      // was already spent. Move to cover near the fight (or straight away
      // from the threat if nothing hides), then re-position and re-engage.
      const m = retreatMove(unit, b, targetUnit, solids, graph);
      vx = m.vx;
      vz = m.vz;
      if (now >= b.flankUntil) {
        if (lowHp) enterRetreat(b, now);
        else goPatrol(b);
      }
      break;
    }
    case 'retreat': {
      // Livelock fix: retreat previously had exactly two exits
      // (!seen + lost -> patrol, seen + !lowHp -> engage), so `seen &&
      // lowHp` was a stable state with NO exit — glass keeps `seen` true
      // forever while the pre-fire ballistic check correctly holds the
      // (unhittable) shot. Now: an unhittable visible threat triggers a
      // re-position move (clearShotMove), and a hard dwell cap force-bails
      // out of any camp-hold, so no retreat can freeze the match.
      const lof = seen ? hasLineOfFire(solids, unit, targetUnit!) : false;
      if (seen && lof && now >= b.reactUntil) {
        aimTarget = targetUnit;
        wantShoot = true;
      }
      if (seen && !lowHp && mayEngage) {
        b.state = 'engage';
        break;
      }
      if (!seen && lostTime > CONFIG.ai.searchTime) {
        goPatrol(b);
        break;
      }
      if (now - b.retreatSince > CONFIG.ai.retreatDwell) {
        // Stuck camp-holding (e.g. hiding from a threat it can neither hit
        // nor outrank): force a re-position instead of holding forever.
        goPatrol(b);
        break;
      }
      if (seen && lowHp && !lof) {
        // "Safe but doing nothing": visible through glass, cannot hit back.
        // Route to a node with a clean ballistic line instead of freezing.
        const m = clearShotMove(unit, b, targetUnit!, solids, graph, now);
        vx = m.vx;
        vz = m.vz;
      } else {
        const m = retreatMove(unit, b, targetUnit, solids, graph);
        vx = m.vx;
        vz = m.vz;
      }
      break;
    }
    case 'search': {
      if (seen && mayEngage) {
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
      if (mayEngage) {
        b.state = 'engage';
        break;
      }
      if (lowHp) {
        enterRetreat(b, now);
        break;
      }
      if (b.pathIndex >= b.path.length) setPath(unit, b, graph, pickPatrolNode(b, graph, unit, 'advance', units), ctx.solids);
      const m = followPath(unit, b, graph);
      vx = m.vx * 0.7;
      vz = m.vz * 0.7;
      break;
    }
    case 'dead':
      break;
  }
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

  // ---- generic anti-stall ----
  // If this unit made < 0.5m of progress for 2.5s while it is supposed to be
  // acting, it is jammed (off-graph path start, wall corner, overlapping
  // pile). While the jam episode lasts, steer tangentially around the
  // obstacle (alternating sides) and drop the current plan so a fresh
  // reachable waypoint is picked. No combat rule is touched.
  if (b.stuckSince <= 0) {
    b.stuckSince = now;
    b.stuckX = unit.pos.x;
    b.stuckZ = unit.pos.z;
  } else {
    const moved = Math.hypot(unit.pos.x - b.stuckX, unit.pos.z - b.stuckZ);
    if (moved >= 0.5) {
      b.stuckSince = now;
      b.stuckX = unit.pos.x;
      b.stuckZ = unit.pos.z;
    } else if (now - b.stuckSince > 2.5) {
      const slideOut = now >= b.slideUntil;
      if (slideOut) {
        b.slideSign = b.slideSign === 0 ? (b.rng() < 0.5 ? 1 : -1) : ((-b.slideSign) as 1 | -1);
        b.slideUntil = now + 1.6;
      }
      // Corridor escape: prefer routing toward a node that is ACTUALLY
      // walkable from where the unit is jammed (open-flank side corridors
      // have no backbone node inside them, so the normal advance/wander
      // scoring always re-picks nodes across the blocking block). Otherwise
      // just drop the plan and let the current state re-pick.
      const stuckX = unit.pos.x;
      const stuckZ = unit.pos.z;
      let escape = -1;
      let escapeD = 0;
      for (const n of graph.nodes) {
        if (Math.abs(n.y - unit.pos.y) > 0.15) continue;
        const d = Math.hypot(n.x - stuckX, n.z - stuckZ);
        if (d < 4 || d > 15) continue;
        if (!losClear(solids, stuckX, stuckZ, unit.pos.y + 1.0, n.x, n.z, n.y + 1.0, 1.0, undefined, { throughGlass: false })) continue;
        if (d > escapeD) {
          escapeD = d;
          escape = n.id;
        }
      }
      if (escape >= 0 && b.state !== 'engage' && b.state !== 'flank') {
        b.state = 'patrol';
        setPath(unit, b, graph, escape, solids);
      } else if (b.state === 'engage' || b.state === 'flank') {
        // A unit actively on a visible target is FIGHTING, not stalled —
        // never yank it out of the fight over movement progress (the handler
        // re-fires every tick of a jam episode, so a corner-jammed shooter
        // would ping-pong engage -> patrol forever and never kill). The
        // tangential slide below still breaks the wall contact in place.
      } else {
        b.path = [];
        b.pathIndex = 0;
      }
    }
  }
  if (b.slideUntil > now && (vx !== 0 || vz !== 0)) {
    const a = b.slideSign * 1.31; // ~75°: mostly tangential
    const c = Math.cos(a);
    const s = Math.sin(a);
    const rx = vx * c - vz * s;
    const rz = vx * s + vz * c;
    vx = rx;
    vz = rz;
  }

  // ---- shoot ----
  const shotsBefore = unit.shotIndex;
  if (wantShoot && aimTarget) doShoot(unit, ctx, now, aimTarget);
  // AI-01 one-shot doctrine: the moment the round actually leaves the
  // barrel, the flanker breaks contact — short cover-hold, then re-position
  // around the outside and re-engage once the window is over.
  if (unit.shotIndex > shotsBefore && isFlanker && b.state === 'engage') {
    b.state = 'flank';
    b.flankUntil = now + CONFIG.ai.doctrine.disengageTime;
    b.pathIndex = b.path.length; // force a fresh cover pick
  }
}
