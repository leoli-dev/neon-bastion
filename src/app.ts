// App: wires the Match (logic), Renderer (Three.js), HUD (DOM), and Audio
// together; owns the fixed-tick game loop, keyboard/mouse input, and pointer
// lock / pause lifecycle. Exposes the pieces the test hooks need.

import * as THREE from 'three';
import { Match } from './game/match';
import type { MatchEvent } from './game/match';
import type { Vec3 } from './game/types';
import { CONFIG } from './game/constants';
import { Renderer } from './render/renderer';
import { HUD } from './render/hud';
import { Audio } from './game/audio';
import { FootstepTracker } from './game/footstep';
import { eyeOf, type FireResult } from './game/combat/hitscan';
import { groundHeight, losClear, pointInSolidXZ } from './game/map/geometry';
import { MUZZLE_OFFSET, MUZZLE_DROP } from './render/weapon';
import { createTestHooks } from './testHooks';

const TICK = 1 / 60;
const DEFAULT_SEED = 20260212;

// FX-01: tracers/flash start at the MUZZLE, not the shooter's eye. A line
// starting at the FPV camera origin projects to a single screen-centre point
// and can never be seen by its own shooter; offsetting it forward (and slightly
// below eye level, like a held rifle) makes the player's own fire visible.
// ART-10: the offsets now live in render/weapon.ts (shared with the weapon
// geometry, whose barrel tip is built to sit EXACTLY at this point); the
// formula below is only the fallback for a shooter without rendered visuals.

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Screen-space bearing of a world point relative to the player's facing:
 * 0 = straight ahead, positive = to the player's right (clockwise on screen).
 * Pure (no DOM/camera state) so it is unit-testable in node.
 */
export function damageBearing(playerYaw: number, from: { x: number; z: number }, to: { x: number; z: number }): number | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return null;
  // forward = (sin yaw, cos yaw); screen-right = (-cos yaw, sin yaw) (the
  // same handedness the strafe fix established — A/D use it too).
  const fx = Math.sin(playerYaw);
  const fz = Math.cos(playerYaw);
  const rx = -Math.cos(playerYaw);
  const rz = Math.sin(playerYaw);
  return Math.atan2((rx * dx + rz * dz) / len, (fx * dx + fz * dz) / len);
}

export class App {
  match: Match;
  renderer: Renderer;
  hud: HUD;
  audio: Audio;
  seed: number;
  /** AUD-01: drives the player's distance-based footstep cadence. */
  private footstep: FootstepTracker;
  /** Player XZ position at the last footstep sample (for delta distance). */
  private lastStepPos = { x: 0, z: 0 };

  private appEl: HTMLElement;
  private webglCanvas: HTMLCanvasElement;
  private started = false;
  private paused = false;
  private directorMode = false;
  private debugVisible = true;
  private hadLock = false;
  private acc = 0;
  private lastTs = -1;
  private raf = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private minimapCanvas: HTMLCanvasElement;

  constructor() {
    this.appEl = document.getElementById('app')!;
    this.webglCanvas = document.getElementById('webgl-canvas') as HTMLCanvasElement;

    this.minimapCanvas = document.createElement('canvas');
    this.minimapCanvas.width = 150;
    this.minimapCanvas.height = 150;
    this.minimapCanvas.className = 'nb-minimap';
    Object.assign(this.minimapCanvas.style, {
      position: 'fixed',
      top: '16px',
      left: '22px',
      width: '150px',
      height: '150px',
      borderRadius: '8px',
      border: '1px solid rgba(90,140,220,.3)',
      zIndex: '10',
      pointerEvents: 'none',
    });
    this.appEl.appendChild(this.minimapCanvas);

    this.seed = DEFAULT_SEED;
    this.match = new Match(this.seed);
    // MAP-04: the renderer MUST draw the exact map the Match simulates
    // (generateMap(seed) is random per seed), or collisions and pixels
    // would disagree.
    this.renderer = new Renderer(this.webglCanvas, this.minimapCanvas, this.match.map);
    this.renderer.buildUnits(this.match.units);
    this.hud = new HUD(this.appEl);
    this.audio = new Audio();
    this.footstep = new FootstepTracker();
    this.lastStepPos = { x: this.match.player.pos.x, z: this.match.player.pos.z };

    // Reduced-motion: drop tracers / auto-orbiting cameras and decorative CSS.
    this.applyReducedMotion();
    if (typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      mq.addEventListener?.('change', () => this.applyReducedMotion());
    }

    this.match.onEvent = (e) => this.onEvent(e);
    this.hud.onPlayAgain = () => this.playAgain();

    this.bindInput();
    window.addEventListener('resize', () => this.renderer.resize());

    this.hud.showScreen('start');
    this.lastTs = -1;
    this.raf = requestAnimationFrame(this.loop);
  }

  // ---- lifecycle ---------------------------------------------------------

  start(): void {
    this.started = true;
    this.paused = false;
    this.audio.init();
    // AUD-02: deploy (or resume from the pause screen) starts the BGM.
    this.audio.bgmEnsurePlaying();
    this.hud.showScreen('none');
    this.requestLock();
  }

  /** MAP-04: rebuild the match (new seed -> new generated map + graph +
   *  units) and the renderer's static arena from the same map. */
  private rebuildMatch(): void {
    this.match = new Match(this.seed);
    this.renderer.setMap(this.match.map);
    this.match.onEvent = (e) => this.onEvent(e);
    this.resetFootstep();
  }

  /** Pin the seed and regenerate everything from it (used by the E2E seed
   *  hook before the match starts). Leaves HUD/start-screen state alone. */
  setSeed(seed: number): void {
    this.seed = seed;
    this.rebuildMatch();
  }

  playAgain(seed?: number): void {
    const s = seed ?? ((this.seed + 1) | 0);
    this.seed = s;
    this.rebuildMatch(); // new seed -> new map (MAP-04)
    this.hud.clearKillfeed();
    this.hud.flashMessage('DEPLOYING', '#9fc4ff');
    this.started = true;
    this.paused = false;
    // AUD-02: fresh loop from the top for the new match.
    this.audio.bgmStop();
    this.audio.bgmEnsurePlaying();
    this.hud.showScreen('none');
    this.requestLock();
  }

  private pause(): void {
    this.paused = true;
    this.audio.bgmPause(); // AUD-02
    this.hud.showScreen('pause');
  }

  private applyReducedMotion(): void {
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.renderer.setReducedMotion(reduced);
    this.hud.setReducedMotion(reduced);
  }

  /** Director mode (F2): hide all match chrome but a minimal win/lose line for
   *   clean recording. Normal play is untouched; toggling off restores the HUD. */
  toggleDirector(): void {
    this.directorMode = !this.directorMode;
    this.hud.setDirector(this.directorMode);
  }

  toggleDebug(): void {
    this.debugVisible = !this.debugVisible;
    this.hud.setDebugVisible(this.debugVisible);
  }

  private requestLock(): void {
    try {
      const p = this.webglCanvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* pointer lock unavailable (e.g. headless) — game still runs */
    }
  }

  // ---- input -------------------------------------------------------------

  private applyKey(key: string, down: boolean): void {
    const pi = this.match.playerInput;
    switch (key) {
      case 'KeyW':
      case 'ArrowUp':
        pi.forward = down;
        break;
      case 'KeyS':
      case 'ArrowDown':
        pi.back = down;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        pi.left = down;
        break;
      case 'KeyD':
      case 'ArrowRight':
        pi.right = down;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        pi.sprint = down;
        break;
      case 'Space':
        pi.jump = down;
        break;
      case 'KeyQ':
        if (down && !this.match.player.alive) this.match.setSpectateIndex(-1);
        break;
      case 'KeyE':
        if (down && !this.match.player.alive) this.match.setSpectateIndex(1);
        break;
      case 'F2':
        if (down) this.toggleDirector();
        break;
      case 'F3':
      case 'Backquote':
        if (down) this.toggleDebug();
        break;
      case 'KeyM':
        // AUD-02: toggle the background-music mute (SFX stay on).
        if (down) this.audio.toggleBgmMute();
        break;
    }
  }

  private bindInput(): void {
    window.addEventListener('keydown', (e) => {
      if (!this.started) return;
      this.applyKey(e.code, true);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.applyKey(e.code, false));

    this.hud.onOverlayClick = (kind) => {
      if (kind === 'start') this.start();
      else if (kind === 'pause') this.start();
    };

    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.webglCanvas) this.match.applyLook(e.movementX, e.movementY);
    });
    // Semi-auto (edge-triggered): mousedown only RAISES the held-trigger flag;
    // the Match fires a single shot on the rising edge and stays latched while
    // the flag is true, so holding the button never auto-fires. Releasing
    // (mouseup) drops the flag so the next fresh press fires again.
    this.webglCanvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.started && !this.paused) {
        if (this.match.player.alive) this.match.playerInput.fire = true;
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.match.playerInput.fire = false;
    });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.webglCanvas;
      if (locked) {
        this.hadLock = true;
        if (this.started) {
          this.paused = false;
          this.audio.bgmEnsurePlaying(); // AUD-02: resume BGM on re-lock
        }
      } else if (this.hadLock && this.started && this.match.state === 'running') {
        this.pause();
      }
    });
    document.addEventListener('pointerlockerror', () => {
      /* ignore */
    });
  }

  // ---- events ------------------------------------------------------------

  private onEvent(e: MatchEvent): void {
    const p = this.match.player;
    if (e.type === 'shot') {
      // Fire TIME: the trigger went. Muzzle flash, gun audio and recoil now;
      // the bullet itself is drawn from its live position every frame
      // (renderer bullet trails), and all hit feedback waits for the
      // 'impact' event when the projectile ARRIVES.
      const shooter = this.match.units.find((u) => u.id === e.shooterId);
      if (!shooter) return;
      const dir = e.res.aim ?? { x: Math.sin(shooter.yaw), y: 0, z: Math.cos(shooter.yaw) };
      // ART-10: raise the shooter's hand weapon FIRST (snap to the shot's aim
      // dir + full recoil) so the muzzle flash can spawn at the actual barrel
      // tip — the renderer records that point from the shared muzzle math,
      // replacing the old separately-computed formula (same constants, one
      // source of truth, so the flash can never float outside the gun).
      this.renderer.triggerShot(shooter, dir, this.match.now);
      const tip = this.renderer.muzzleAtShot(shooter.id);
      const muzzle = tip
        ? new THREE.Vector3(tip.x, tip.y, tip.z)
        : (() => {
            // Fallback only: the legacy eye + dir*MUZZLE_OFFSET - DROP formula.
            const from = eyeOf(shooter);
            return new THREE.Vector3(
              from.x + dir.x * MUZZLE_OFFSET,
              from.y - MUZZLE_DROP + dir.y * MUZZLE_OFFSET,
              from.z + dir.z * MUZZLE_OFFSET
            );
          })();
      this.renderer.spawnMuzzleFlash(muzzle);
      const eye = eyeOf(p);
      const d = muzzle.distanceTo(new THREE.Vector3(eye.x, eye.y, eye.z));
      this.audio.shot(clamp(1 - d / 45, 0.05, 1));
      if (e.shooterId === 0) {
        // Firing recoil: each shot kicks the view up by CONFIG.shotKick;
        // the renderer eases it back once the trigger is released.
        this.renderer.addRecoil(CONFIG.shotKick);
      }
    } else if (e.type === 'impact') {
      // ARRIVAL: the bullet landed. Sparks, hitmarker and damage numbers are
      // all consequences of the hit, so they fire here — not at fire time.
      const res = e.res.resolution;
      if (!res) return;
      const toV = new THREE.Vector3(res.point.x, res.point.y, res.point.z);
      if (res.kind === 'unit') {
        // FX-05: unit hits bleed — dark-red droplets continue the bullet's
        // own direction (the shot's spread direction, `e.res.aim`), falling
        // under gravity. Wall hits instead get light warm additive sparks.
        const dir = e.res.aim ?? { x: Math.sin(p.yaw), y: 0, z: Math.cos(p.yaw) };
        this.renderer.spawnBlood(toV, new THREE.Vector3(dir.x, dir.y, dir.z), e.res.part === 'head' ? 'head' : 'body');
      } else if (res.kind === 'wall') {
        this.renderer.spawnWallSparks(toV);
      }
      if (e.shooterId === 0 && res.kind === 'unit') {
        this.audio.hit(e.res.part === 'head');
        // Player feedback: hitmarker + floating damage number at the impact.
        this.hud.onPlayerHit(e.res.part === 'head', res.point, e.res.damage);
      }
    } else if (e.type === 'hit') {
      // The player took a hit: vignette + damage-direction arc + pain sfx +
      // camera kick. (victimId 0 = the local player.)
      if (e.victimId === 0 && this.match.player.alive) this.onPlayerHit(e.part);
    } else if (e.type === 'kill') {
      this.hud.addKill(e.item);
      if (e.killerId === 0) {
        this.audio.kill();
        this.hud.onKill();
        this.hud.flashMessage('ENEMY DOWN', '#ffd24a');
      }
      if (e.victimId === 0) this.hud.flashMessage('YOU WERE ELIMINATED', '#ff5a7a');
    } else if (e.type === 'end') {
      this.onEnd(e.winner);
    }
  }

  private onEnd(winner: 'blue' | 'red'): void {
    this.audio.bgmStop(); // AUD-02: fade the loop out so the stinger is clear
    this.audio.end(winner === 'blue');
    this.hud.showResults(winner, this.match.snapshot());
    if (document.pointerLockElement === this.webglCanvas) document.exitPointerLock();
  }

  /** The local player was hit (the 'hit' event with victimId 0). */
  private onPlayerHit(part: 'head' | 'body'): void {
    const p = this.match.player;
    const cause = p.lastHitBy >= 0 ? this.match.units.find((u) => u.id === p.lastHitBy) : undefined;
    const bearing = cause ? damageBearing(p.yaw, p.pos, cause.pos) : null;
    // Pain sfx (distinct from the hitmarker sound the player makes on hits).
    this.audio.hurt(part === 'head');
    // Damage-direction arc around the crosshair + red vignette.
    this.hud.onPlayerDamage(bearing, part === 'head');
    // Camera kick: snap up by CONFIG.hitKick and away from the attacker;
    // the renderer decays it back to zero in ~150 ms (no-op if reduced-motion).
    const yawOff =
      bearing == null
        ? 0
        : -clamp(bearing, -Math.PI / 2, Math.PI / 2) * CONFIG.hitKick * 0.5;
    this.renderer.applyHitKick(yawOff, CONFIG.hitKick);
  }

  // ---- loop --------------------------------------------------------------

  private loop = (ts: number): void => {
    if (this.lastTs < 0) this.lastTs = ts;
    let dtReal = (ts - this.lastTs) / 1000;
    this.lastTs = ts;
    if (dtReal > 0.1) dtReal = 0.1;
    if (dtReal < 0) dtReal = 0;

    if (this.started && !this.paused && this.match.state === 'running') {
      this.acc += dtReal;
      let steps = 0;
      while (this.acc >= TICK && steps < 5) {
        this.match.tick(TICK);
        this.acc -= TICK;
        steps++;
        this.stepFootstep();
      }
      if (steps >= 5) this.acc = 0;
    }

    this.renderer.update(this.match, dtReal);
    this.hud.update(this.match);
    this.hud.setStats(this.renderer.getStats());
    // Project floating damage numbers through the (just-updated) camera.
    this.hud.tickVisual((p) => this.renderer.screenFromWorld(p));

    // Smoothed FPS readout (updated ~2Hz to avoid DOM churn).
    this.fpsFrames++;
    this.fpsTime += dtReal;
    if (this.fpsTime >= 0.5) {
      this.hud.setFps(Math.round(this.fpsFrames / this.fpsTime));
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }

    this.raf = requestAnimationFrame(this.loop);
  };

  /** Deterministic test path: fire a player shot and advance the simulation
   *  (bounded) until the projectile settles, then return the SETTLED result —
   *  so callers can read resolution/damage/score from one synchronous call
   *  even though bullets now have real flight time. */
  shootImmediate(dir?: Vec3): FireResult | null {
    const res = this.match.firePlayerShot(dir);
    if (!res || res.bulletId == null) return res;
    const b = this.match.bullets.get(res.bulletId);
    if (!b) return res;
    let i = 0;
    while (!b.result && i < 600 && this.match.state === 'running') {
      this.match.tick(TICK);
      i++;
    }
    return b.result ?? res;
  }

  // ---- test hooks --------------------------------------------------------

  setInputKey(key: string, down: boolean): void {
    this.applyKey(key, down);
  }

  teleport(unitId: number, x: number, z: number): void {
    const u = this.match.units.find((uu) => uu.id === unitId);
    if (!u) return;
    const y = groundHeight(this.match.solids, x, z);
    u.pos.x = x;
    u.pos.z = z;
    u.pos.y = Math.min(y, 1.2);
    u.vel.x = 0;
    u.vel.z = 0;
    u.vy = 0;
    u.grounded = true;
    if (unitId === 0) this.resetFootstep();
  }

  fastForward(seconds: number): void {
    if (this.match.state !== 'running') return;
    const n = Math.floor(seconds / TICK);
    for (let i = 0; i < n; i++) {
      this.match.tick(TICK);
      this.stepFootstep();
    }
  }

  /** AUD-01: total player footstep triggers fired since the last reset. */
  footstepCount(): number {
    return this.footstep.count;
  }

  /** AUD-01: re-sync the footstep tracker's baseline position (e.g. after a
   *  spawn / reseed / teleport) so a jump in position isn't read as walking. */
  private resetFootstep(): void {
    const p = this.match.player;
    this.lastStepPos = { x: p.pos.x, z: p.pos.z };
    this.footstep.reset();
  }

  /** AUD-01: sample the player's horizontal movement for this tick and fire a
   *  footstep sound when the distance-based cadence trips. Player-only, and
   *  gated on being grounded (airborne is silent; a landing is a heavier thump
   *  handled inside the tracker). */
  private stepFootstep(): void {
    const p = this.match.player;
    if (!p.alive) return;
    const movedXZ = Math.hypot(p.pos.x - this.lastStepPos.x, p.pos.z - this.lastStepPos.z);
    this.lastStepPos.x = p.pos.x;
    this.lastStepPos.z = p.pos.z;
    const trig = this.footstep.tick(movedXZ, p.grounded, this.match.playerInput.sprint);
    if (trig) this.audio.footstep(trig.intensity);
  }

  /** ART-06 E2E hook: find a spot straight ahead of the player that is (a) not
   *  inside a solid, (b) in the player's view band (see
   *  Renderer.pointInViewBand — the same band the red-pixel assertions
   *  sample) and (c) has a clear sight line from the player's eye (glass
   *  transparent, exactly like the AI's vision). Returns null if no spot
   *  qualifies on this seed. */
  findCenterViewSpot(): { x: number; z: number } | null {
    const p = this.match.player;
    const eye = eyeOf(p);
    // Step from 2 m to 16 m ahead of the player along their facing.
    for (let d = 2; d <= 16; d += 1) {
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
      const x = p.pos.x + fx * d;
      const z = p.pos.z + fz * d;
      if (this.match.solids.some((s) => pointInSolidXZ(s, x, z))) continue;
      const chestY = Math.min(groundHeight(this.match.solids, x, z), 1.2) + 1.0;
      if (!losClear(this.match.solids, eye.x, eye.z, eye.y, x, z, chestY, 1.0)) continue;
      if (this.renderer.pointInViewBand(x, chestY, z)) return { x, z };
    }
    return null;
  }

  forceSpectate(): void {
    const p = this.match.player;
    p.alive = false;
    p.hp = 0;
    if (this.match.state === 'running') this.match.tick(TICK);
  }

  /** ART-10: the shooter's weapon pose at the match clock (E2E probe). */
  weaponProbe(unitId: number): ReturnType<Renderer['weaponProbe']> {
    return this.renderer.weaponProbe(unitId, this.match.now);
  }

  /** Force the HUD (throttled leaderboard) to repaint now — deterministic E2E. */
  repaintHud(): void {
    this.hud.repaint(this.match);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.hud.dispose();
  }
}

export function createApp(): App | null {
  // FE-20: probe for WebGL before building the 3D app. If it's missing (or
  // forced off via ?nogl=1 for testing), render a 2D fallback that still shows a
  // live, understandable battle status + controls + a clear "no 3D" message —
  // never a white screen or an uncaught error.
  const forcedOff = typeof location !== 'undefined' && /[?&]nogl=1/.test(location.search);
  if (forcedOff || !probeWebGL()) {
    const match = createNoGLFallback(document.getElementById('app')!);
    (window as unknown as Record<string, unknown>).__teamArenaTest = {
      version: 'nogl',
      ready: true,
      fallback: true,
      state: () => ({
        state: match.state,
        winner: match.winner,
        blueAlive: match.units.filter((u) => u.team === 'blue' && u.alive).length,
        redAlive: match.units.filter((u) => u.team === 'red' && u.alive).length,
      }),
    };
    return null;
  }
  const app = new App();
  (window as unknown as Record<string, unknown>).__teamArenaTest = createTestHooks(app);
  return app;
}

function probeWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch {
    return false;
  }
}

/**
 * No-WebGL fallback: the real Match runs headlessly and is drawn as a live 2D
 * top-down battle status, alongside controls and a clear "3D unavailable" note.
 * This keeps the page useful and legible on devices that can't render 3D.
 */
function createNoGLFallback(container: HTMLElement): Match {
  container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'nb-fallback';
  root.style.cssText =
    'position:fixed;inset:0;background:#05070b;color:#e6eefb;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px;font-family:system-ui,sans-serif;text-align:center;z-index:30;overflow:auto;';
  const title = document.createElement('h1');
  title.textContent = 'NEON BASTION';
  title.style.cssText = 'margin:0;font-size:40px;letter-spacing:.16em;color:#e8f4ff;font-weight:800;';
  const msg = document.createElement('div');
  msg.textContent = '3D 渲染不可用 — 此浏览器或设备不支持 WebGL，无法完整运行 Neon Bastion。';
  msg.style.cssText = 'font-size:16px;max-width:560px;opacity:.92;line-height:1.5;';
  const sub = document.createElement('div');
  sub.textContent = 'Neon Bastion requires WebGL to render the 3D arena. Below is a live 2D battle status so the match remains legible.';
  sub.style.cssText = 'font-size:13px;max-width:560px;opacity:.6;letter-spacing:.03em;';
  const canvas = document.createElement('canvas');
  canvas.width = 220;
  canvas.height = 220;
  canvas.className = 'nb-fb-map';
  canvas.style.cssText = 'background:#0a0d12;border:1px solid rgba(90,140,220,.3);border-radius:8px;';
  const score = document.createElement('div');
  score.className = 'nb-fb-score';
  score.style.cssText = 'font-family:ui-monospace,monospace;font-size:15px;letter-spacing:.08em;min-height:22px;';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:20px;align-items:center;';
  wrap.appendChild(canvas);
  wrap.appendChild(score);
  const controls = document.createElement('div');
  controls.style.cssText = 'display:grid;grid-template-columns:auto auto;gap:6px 22px;font-size:14px;opacity:.82;text-align:left;letter-spacing:.03em;';
  controls.innerHTML =
    '<b>Move</b><span>W A S D</span><b>Aim</b><span>Mouse</span><b>Shoot</b><span>Left click</span><b>Spectate</b><span>Q / E</span><b>Pause</b><span>Esc</span>';
  root.append(title, msg, sub, wrap, controls);
  container.appendChild(root);

  const match = new Match(20260212);
  const ctx = canvas.getContext('2d');
  const draw = (): void => {
    const S = canvas.width;
    const b = match.map.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    const scale = (S * 0.92) / span;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const px = (x: number): number => (x - cx) * scale + S / 2;
    const pz = (z: number): number => (z - cz) * scale + S / 2;
    if (ctx) {
      ctx.fillStyle = '#0a0d12';
      ctx.fillRect(0, 0, S, S);
      ctx.strokeStyle = '#2a3a5a';
      for (const s of match.map.solids) {
        ctx.strokeRect(px(s.x - s.sx / 2) + 0.5, pz(s.z - s.sz / 2) + 0.5, Math.max(1.5, s.sx * scale) - 1, Math.max(1.5, s.sz * scale) - 1);
      }
      for (const u of match.units) {
        ctx.beginPath();
        ctx.arc(px(u.pos.x), pz(u.pos.z), 3, 0, Math.PI * 2);
        ctx.fillStyle = u.team === 'blue' ? (u.alive ? '#18e0ff' : 'rgba(24,224,255,.35)') : u.alive ? '#ff3d63' : 'rgba(255,61,99,.35)';
        ctx.fill();
      }
    }
    const bs = match.units.filter((u) => u.team === 'blue').reduce((a, u) => a + u.totalScore, 0);
    const rs = match.units.filter((u) => u.team === 'red').reduce((a, u) => a + u.totalScore, 0);
    const ba = match.units.filter((u) => u.team === 'blue' && u.alive).length;
    const ra = match.units.filter((u) => u.team === 'red' && u.alive).length;
    score.innerHTML = match.state === 'ended'
      ? `<span style="color:${match.winner === 'blue' ? '#18e0ff' : '#ff3d63'}">${match.winner === 'blue' ? 'BLUE' : 'RED'} WINS</span>`
      : `<span style="color:#18e0ff">BLUE ${bs}·${ba}</span> <span style="opacity:.4">VS</span> <span style="color:#ff3d63">RED ${rs}·${ra}</span>`;
  };

  const TICK = 1 / 60;
  let acc = 0;
  let last = performance.now();
  const loop = (ts: number): void => {
    const dt = Math.min(0.1, (ts - last) / 1000);
    last = ts;
    acc += dt;
    let n = 0;
    while (acc >= TICK && n < 5) {
      match.tick(TICK);
      acc -= TICK;
      n++;
    }
    draw();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return match;
}
