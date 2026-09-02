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
      if (e.shooterId === 0 && res.kind === 'unit') this.audio.hit(e.res.part === 'head');
    } else if (e.type === 'kill') {
      this.hud.addKill(e.item);
      if (e.killerId === 0) {
        this.audio.kill();
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

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.hud.dispose();
  }
}

export function createApp(): App {
  const app = new App();
  (window as unknown as Record<string, unknown>).__teamArenaTest = createTestHooks(app);
  return app;
}
