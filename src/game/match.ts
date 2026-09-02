// Match orchestration: owns all 8 units, the nav graph, the clock, the player
// controller, the AI tick, reloads, spectator resolution, and win/lose checks.
// A fixed logic step is `tick(dt)` (the app loop feeds it 1/60s steps).

import type { Unit, Team, MapData, Vec3, AIState } from './types';
import { CONFIG } from './constants';
import { NEON_BASTION } from './map/mapData';
import { buildNavGraph, type NavGraph } from './map/navmesh';
import { stepUnit } from './map/movement';
import { createUnit, blueName, redName } from './units/units';
import { fireWeapon, type FireResult, eyeOf } from './combat/hitscan';
import { startReload, updateReload, recoverHeat } from './combat/weapon';
import { aiThink, createBrain, type MatchContext } from './ai/aiController';
import { resolveSpectator, type SpectatorResult } from './ai/spectator';

export interface PlayerInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
  jump: boolean;
  fire: boolean;
  reload: boolean; // edge-triggered (true for one tick)
}

export type MatchEvent =
  | { type: 'shot'; shooterId: number; res: FireResult }
  | { type: 'hit'; victimId: number; part: 'head' | 'body' }
  | { type: 'kill'; killerId: number; victimId: number; item: KillFeedItem }
  | { type: 'reload'; unitId: number }
  | { type: 'end'; winner: Team };

export interface KillFeedItem {
  killer: string;
  victim: string;
  killerTeam: Team;
  victimTeam: Team;
  headshot: boolean;
  time: number;
}

export interface SpectatorView {
  mode: 'alive' | 'ally' | 'free';
  targetId: number | null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class Match {
  seed: number;
  map: MapData;
  solids: import('./types').Solid[];
  graph: NavGraph;
  units: Unit[] = [];
  now = 0;
  state: 'running' | 'ended' = 'running';
  winner: Team | null = null;
  killfeed: KillFeedItem[] = [];
  spectatorIndex = 0;
  spectate: SpectatorView = { mode: 'alive', targetId: null };
  playerInput: PlayerInput = {
    forward: false, back: false, left: false, right: false,
    sprint: false, jump: false, fire: false, reload: false,
  };
  onEvent?: (e: MatchEvent) => void;

  constructor(seed: number, map: MapData = NEON_BASTION) {
    this.seed = seed;
    this.map = map;
    this.solids = map.solids;
    this.graph = buildNavGraph(map);
    this.reset();
  }

  get player(): Unit {
    return this.units[0];
  }

  /** (Re)create all units at their spawn points and clear match state. */
  reset(seed?: number): void {
    if (seed != null) this.seed = seed;
    this.now = 0;
    this.state = 'running';
    this.winner = null;
    this.killfeed = [];
    this.spectatorIndex = 0;
    this.spectate = { mode: 'alive', targetId: null };
    this.playerInput = {
      forward: false, back: false, left: false, right: false,
      sprint: false, jump: false, fire: false, reload: false,
    };
    this.units = [];
    let id = 0;
    for (let i = 0; i < 4; i++) {
      const s = this.map.spawns.blue[i];
      const u = createUnit(id++, blueName(i), 'blue', i === 0, s.x, s.z, s.yaw);
      u.pos.y = 0;
      this.units.push(u);
    }
    for (let i = 0; i < 4; i++) {
      const s = this.map.spawns.red[i];
      const u = createUnit(id++, redName(i), 'red', false, s.x, s.z, s.yaw);
      u.pos.y = 0;
      this.units.push(u);
    }
    // Give every AI unit a deterministic brain.
    for (const u of this.units) {
      if (!u.isPlayer) u.ai = createBrain(u, this.seed);
    }
  }

  ctx(): MatchContext {
    return {
      map: this.map,
      solids: this.solids,
      graph: this.graph,
      units: this.units,
      now: this.now,
      dt: CONFIG.tickDt,
      seed: this.seed,
    };
  }

  /** Apply mouse look (same code path for real mouse and test hooks). */
  applyLook(dx: number, dy: number): void {
    const p = this.player;
    if (!p.alive) return;
    const sens = 0.0022;
    p.yaw -= dx * sens;
    p.pitch = clamp(p.pitch - dy * sens, -1.35, 1.35);
  }

  setSpectateIndex(delta: number): void {
    this.spectatorIndex += delta;
  }

  private playerAim(p: Unit): Vec3 {
    const cp = Math.cos(p.pitch);
    return { x: Math.sin(p.yaw) * cp, y: Math.sin(p.pitch), z: Math.cos(p.yaw) * cp };
  }

  private controlPlayer(dt: number): void {
    const p = this.player;
    if (!p.alive) return;
    const inp = this.playerInput;
    const speed = inp.sprint ? CONFIG.sprintSpeed : CONFIG.walkSpeed;
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    const rx = Math.cos(p.yaw);
    const rz = -Math.sin(p.yaw);
    let mx = 0;
    let mz = 0;
    if (inp.forward) { mx += fx; mz += fz; }
    if (inp.back) { mx -= fx; mz -= fz; }
    if (inp.right) { mx += rx; mz += rz; }
    if (inp.left) { mx -= rx; mz -= rz; }
    const ml = Math.hypot(mx, mz);
    let vx = 0;
    let vz = 0;
    if (ml > 1e-4) {
      vx = (mx / ml) * speed;
      vz = (mz / ml) * speed;
    }
    stepUnit(p, vx, vz, inp.jump, this.map, dt);
    if (inp.reload) {
      if (startReload(p, this.now)) this.onEvent?.({ type: 'reload', unitId: p.id });
    }
    if (inp.fire) this.firePlayerShot();
    this.playerInput.reload = false; // edge-triggered
  }

  /** Fire a single shot for the player (also used by the test hook). */
  firePlayerShot(aim?: Vec3): FireResult | null {
    const p = this.player;
    if (!p.alive) return null;
    const a = aim ?? this.playerAim(p);
    const res = fireWeapon({ units: this.units, solids: this.solids, shooter: p, aim: a, now: this.now, seed: this.seed });
    if (res.fired) this.emitShot(p, res);
    return res.fired ? res : null;
  }

  /** Test hook: apply direct damage, optionally credited to a cause unit. */
  applyDamage(victimId: number, amount: number, causeId = -1): void {
    const v = this.units.find((u) => u.id === victimId);
    if (!v || !v.alive) return;
    v.hp = Math.max(0, v.hp - amount);
    if (causeId >= 0) {
      const c = this.units.find((u) => u.id === causeId);
      if (c) {
        v.lastHitBy = causeId;
        c.hitScore += 1;
        c.totalScore += 1;
      }
    }
    v.flashUntil = this.now + 0.12;
    if (v.hp <= 0) {
      v.alive = false;
      if (causeId >= 0) {
        const c = this.units.find((u) => u.id === causeId);
        if (c) {
          c.kills += 1;
          c.totalScore += 3;
        }
        const c2 = this.units.find((u) => u.id === causeId);
        const item: KillFeedItem = {
          killer: c2?.name ?? '???',
          victim: v.name,
          killerTeam: c2?.team ?? v.team,
          victimTeam: v.team,
          headshot: false,
          time: this.now,
        };
        this.killfeed.unshift(item);
        if (this.killfeed.length > 5) this.killfeed.length = 5;
        this.onEvent?.({ type: 'kill', killerId: causeId, victimId: v.id, item });
      }
    }
    this.checkEnd();
  }

  private emitShot(shooter: Unit, res: FireResult): void {
    this.onEvent?.({ type: 'shot', shooterId: shooter.id, res });
    if (res.resolution?.kind === 'unit' && res.targetId != null) {
      this.onEvent?.({ type: 'hit', victimId: res.targetId, part: res.part ?? 'body' });
      if (res.killed) {
        const victim = this.units.find((u) => u.id === res.targetId);
        if (victim) {
          const item: KillFeedItem = {
            killer: shooter.name,
            victim: victim.name,
            killerTeam: shooter.team,
            victimTeam: victim.team,
            headshot: res.part === 'head',
            time: this.now,
          };
          this.killfeed.unshift(item);
          if (this.killfeed.length > 5) this.killfeed.length = 5;
          this.onEvent?.({ type: 'kill', killerId: shooter.id, victimId: victim.id, item });
        }
      }
    }
  }

  /** Advance the whole match by one fixed logic step. */
  tick(dt: number): void {
    if (this.state !== 'running') return;
    this.now += dt;
    this.controlPlayer(dt);
    const ctx = this.ctx();
    for (let i = 1; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.ai) aiThink(u, ctx);
    }
    for (const u of this.units) {
      updateReload(u, this.now);
      recoverHeat(u, dt, false);
    }
    this.updateSpectator();
    this.checkEnd();
  }

  private updateSpectator(): void {
    const p = this.player;
    if (p.alive) {
      this.spectate = { mode: 'alive', targetId: null };
      return;
    }
    const allies = this.units.filter((u) => u.team === p.team && u.alive && u.id !== p.id);
    const r: SpectatorResult = resolveSpectator(allies, this.spectatorIndex);
    this.spectate = { mode: r.mode as SpectatorView['mode'], targetId: r.targetId };
  }

  private checkEnd(): void {
    if (this.state !== 'running') return;
    const blueAlive = this.units.some((u) => u.team === 'blue' && u.alive);
    const redAlive = this.units.some((u) => u.team === 'red' && u.alive);
    if (!blueAlive) {
      this.state = 'ended';
      this.winner = 'red';
      this.onEvent?.({ type: 'end', winner: 'red' });
    } else if (!redAlive) {
      this.state = 'ended';
      this.winner = 'blue';
      this.onEvent?.({ type: 'end', winner: 'blue' });
    }
  }

  /** Plain snapshot for HUD / test hook. */
  snapshot() {
    return {
      now: this.now,
      state: this.state,
      winner: this.winner,
      spectate: { ...this.spectate },
      killfeed: this.killfeed.map((k) => ({ ...k })),
      units: this.units.map((u) => ({
        id: u.id,
        name: u.name,
        team: u.team,
        isPlayer: u.isPlayer,
        alive: u.alive,
        hp: Math.round(u.hp),
        pos: { x: u.pos.x, y: u.pos.y, z: u.pos.z },
        yaw: u.yaw,
        mag: u.mag,
        kills: u.kills,
        hitScore: u.hitScore,
        totalScore: u.totalScore,
        aiState: u.ai?.state ?? null,
      })),
    };
  }
}

export { eyeOf };
