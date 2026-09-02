// App: wires the Match (logic), Renderer (Three.js), HUD (DOM), and Audio
// together; owns the fixed-tick game loop, keyboard/mouse input, and pointer
// lock / pause lifecycle. Exposes the pieces the test hooks need.

import * as THREE from 'three';
import { Match } from './game/match';
import type { MatchEvent } from './game/match';
import { Renderer } from './render/renderer';
import { HUD } from './render/hud';
import { Audio } from './game/audio';
import { eyeOf } from './game/combat/hitscan';
import { groundHeight } from './game/map/geometry';
import { createTestHooks } from './testHooks';

const TICK = 1 / 60;
const DEFAULT_SEED = 20260212;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class App {
  match: Match;
  renderer: Renderer;
  hud: HUD;
  audio: Audio;
  seed: number;

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
    this.renderer = new Renderer(this.webglCanvas, this.minimapCanvas);
    this.renderer.buildUnits(this.match.units);
    this.hud = new HUD(this.appEl);
    this.audio = new Audio();

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
    this.hud.showScreen('none');
    this.requestLock();
  }

  playAgain(seed?: number): void {
    const s = seed ?? ((this.seed + 1) | 0);
    this.seed = s;
    this.match.reset(s);
    this.hud.clearKillfeed();
    this.hud.flashMessage('DEPLOYING', '#9fc4ff');
    this.started = true;
    this.paused = false;
    this.hud.showScreen('none');
    this.requestLock();
  }

  private pause(): void {
    this.paused = true;
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
      case 'KeyR':
        if (down) pi.reload = true;
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
    this.webglCanvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.started && !this.paused) {
        const p = this.match.player;
        if (p.alive) {
          this.match.playerInput.fire = true;
          if (p.mag === 0) this.audio.empty();
        }
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.match.playerInput.fire = false;
    });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.webglCanvas;
      if (locked) {
        this.hadLock = true;
        if (this.started) this.paused = false;
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
      const shooter = this.match.units.find((u) => u.id === e.shooterId);
      const res = e.res.resolution;
      if (!shooter || !res) return;
      const from = eyeOf(shooter);
      const fromV = new THREE.Vector3(from.x, from.y, from.z);
      const to = res.point;
      const toV = new THREE.Vector3(to.x, to.y, to.z);
      this.renderer.spawnTracer(fromV, toV);
      if (res.kind === 'unit') this.renderer.spawnHitSpark(toV, e.res.part === 'head');
      const eye = eyeOf(p);
      const d = fromV.distanceTo(new THREE.Vector3(eye.x, eye.y, eye.z));
      this.audio.shot(clamp(1 - d / 45, 0.05, 1));
      if (e.shooterId === 0 && res.kind === 'unit') {
        this.audio.hit(e.res.part === 'head');
        // Player feedback: hitmarker + floating damage number at the impact.
        this.hud.onPlayerHit(e.res.part === 'head', res.point, e.res.damage);
      }
    } else if (e.type === 'kill') {
      this.hud.addKill(e.item);
      if (e.killerId === 0) {
        this.audio.kill();
        this.hud.onKill();
        this.hud.flashMessage('ENEMY DOWN', '#ffd24a');
      }
      if (e.victimId === 0) this.hud.flashMessage('YOU WERE ELIMINATED', '#ff5a7a');
    } else if (e.type === 'reload') {
      if (e.unitId === 0) this.audio.reload();
    } else if (e.type === 'end') {
      this.onEnd(e.winner);
    }
  }

  private onEnd(winner: 'blue' | 'red'): void {
    this.audio.end(winner === 'blue');
    this.hud.showResults(winner, this.match.snapshot());
    if (document.pointerLockElement === this.webglCanvas) document.exitPointerLock();
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
  }

  fastForward(seconds: number): void {
    if (this.match.state !== 'running') return;
    const n = Math.floor(seconds / TICK);
    for (let i = 0; i < n; i++) this.match.tick(TICK);
  }

  forceSpectate(): void {
    const p = this.match.player;
    p.alive = false;
    p.hp = 0;
    if (this.match.state === 'running') this.match.tick(TICK);
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
    '<b>Move</b><span>W A S D</span><b>Aim</b><span>Mouse</span><b>Shoot</b><span>Left click</span><b>Reload</b><span>R</span><b>Spectate</b><span>Q / E</span><b>Pause</b><span>Esc</span>';
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
