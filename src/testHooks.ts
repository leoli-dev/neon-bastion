// Test hooks exposed on `window.__teamArenaTest`. Lets E2E and manual
// inspection read state, pin the RNG seed, teleport, simulate shots, force a
// spectator, fast-forward the fixed-tick loop, and restart — all without any
// network or backend.

import type { App } from './app';
import type { Vec3 } from './game/types';
import * as THREE from 'three';

export interface TeamArenaTestHooks {
  version: string;
  ready: boolean;
  state: () => unknown;
  seed: (s?: number) => number;
  start: () => void;
  playAgain: () => void;
  restart: (s?: number) => void;
  mouseTurn: (dx: number, dy: number) => void;
  input: (key: string, down: boolean) => void;
  shoot: (dir?: Partial<Vec3>) => unknown;
  applyDamage: (victimId: number, amount: number, causeId?: number) => void;
  /** Construct a 'hit' event for the local player (no HP change — pure
   *  feedback path): sets lastHitBy, then fires the event through the same
   *  bus the real fire pipeline uses. */
  simulateHitOnPlayer: (causeId: number, part?: 'head' | 'body') => void;
  /** Current camera kick / recoil offsets (radians). `recoil` is the eased
   *  pitch offset currently applied to the view; `recoilCharge` is the
   *  synchronous per-shot accumulation (set the moment a shot fires). */
  cameraKicks: () => { kickYaw: number; kickPitch: number; recoil: number; recoilCharge: number };
  /** ART-05: advance the sky's cloud drift by `seconds` real seconds and
   *  repaint once (no-op drift under reduced motion). Lets E2E measure cloud
   *  motion deterministically despite throttled headless rAF. */
  fastForwardSky: (seconds: number) => void;
  teleport: (unitId: number, x: number, z: number) => void;
  fastForward: (seconds: number) => void;
  /** AUD-01: how many player footstep triggers have fired since the last
   *  spawn/reseed (grows only while grounded and moving). */
  footstepCount: () => number;
  /** AUD-02: BGM mute state (toggled with `M`; SFX are never affected). */
  bgmMuted: () => boolean;
  /** AUD-02: true while the BGM scheduler is running. */
  bgmPlaying: () => boolean;
  /** ART-06: a sight-clear spot on the player's facing that lands in the
   *  central screen band (null if none exists on this seed). */
  findCenterViewSpot: () => { x: number; z: number } | null;
  /** ART-07: the sand texture's source canvases (unrepeated): `base` is the
   *  final grain+mottling texture, `mottle` is the mottling layer alone —
   *  the seam probe checks the repeat wrap on the mottling layer. */
  sandTextureCanvases: () => { base: HTMLCanvasElement; mottle: HTMLCanvasElement };
  /** ART-08: per-unit LOCAL-space bounding boxes of the visible humanoid
   *  parts (ground ring excluded) — used to assert the visuals hug the
   *  hitbox (≤ 0.84 wide/deep, y 0..1.87). */
  unitVisualBounds: () => { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }[];
  /** FX-04: with one in-flight bullet flying straight AT the probe camera
   *  (~5.6 units away, 2.5 units off-axis so the trail is seen obliquely),
   *  how many warm-gold (0xffe08a family) pixels does one rendered frame
   *  contain? The bullet is removed again before returning, so the match
   *  state is untouched. */
  probeTrailWarmGold: () => number;
  /** FX-05: with ONLY the given FX pool visible against a pure black
   *  backdrop, how many dark-red pixels (`darkRed`: R clearly above G and
   *  B, overall dark — blood) and bright warm pixels (`warm`: additive
   *  gold — sparks) does one rendered frame aimed at `point` contain?
   *  Scene state is restored before returning. */
  probeImpact: (point: Vec3, kind: 'blood' | 'sparks') => { darkRed: number; warm: number };
  forceSpectate: () => void;
  repaintHud: () => void;
}

export function createTestHooks(app: App): TeamArenaTestHooks {
  return {
    version: '1.0.0',
    ready: true,
    state: () => app.match.snapshot(),
    seed: (s?: number) => {
      // MAP-04: pinning the seed also REGENERATES the match map + renderer
      // arena from it (call before start for a deterministic E2E layout).
      if (s !== undefined) app.setSeed(s);
      return app.seed;
    },
    start: () => app.start(),
    playAgain: () => app.playAgain(),
    restart: (s?: number) => app.playAgain(s),
    mouseTurn: (dx, dy) => app.match.applyLook(dx, dy),
    input: (key, down) => app.setInputKey(key, down),
    // Fire AND let the projectile fly to its resolution, in one synchronous
    // call (advances the fixed-tick loop internally), so E2E reads the
    // settled resolution/damage without racing the rAF loop.
    shoot: (dir?: Partial<Vec3>) => app.shootImmediate(dir ? { x: dir.x ?? 0, y: dir.y ?? 0, z: dir.z ?? 0 } : undefined),
    applyDamage: (victimId, amount, causeId = -1) => app.match.applyDamage(victimId, amount, causeId),
    simulateHitOnPlayer: (causeId, part = 'body') => {
      const p = app.match.player;
      p.lastHitBy = causeId;
      app.match.onEvent?.({ type: 'hit', victimId: 0, part });
    },
    cameraKicks: () => app.renderer.getCameraKicks(),
    fastForwardSky: (seconds) => app.renderer.stepSky(seconds),
    teleport: (unitId, x, z) => app.teleport(unitId, x, z),
    fastForward: (seconds) => app.fastForward(seconds),
    footstepCount: () => app.footstepCount(),
    bgmMuted: () => app.audio.bgmMuted,
    bgmPlaying: () => app.audio.bgmPlaying,
    findCenterViewSpot: () => app.findCenterViewSpot(),
    sandTextureCanvases: () => app.renderer.getSandTextureCanvases(),
    unitVisualBounds: () => app.renderer.unitVisualBounds(),
    probeTrailWarmGold: () => {
      // FX-04: one in-flight bullet ~5.6 units from the probe camera pose
      // (camera at (0,4,12), view axis u = (0, 0.939693, -0.342020) = 70° up),
      // 2.5 units off-axis and aimed straight AT the camera — its trail is
      // therefore seen obliquely, like a bullet incoming from the side.
      const bx = 2.5;
      const by = 4 + 5 * 0.939693;
      const bz = 12 - 5 * 0.34202;
      const dx = -bx, dy = -5 * 0.939693, dz = 5 * 0.34202;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      app.match.bullets.spawn({
        shooterId: 0,
        shotIndex: -1,
        origin: { x: bx, y: by, z: bz },
        dir: { x: dx / len, y: dy / len, z: dz / len },
        maxDist: 20,
      });
      const n = app.renderer.probeTrailWarmGoldPixels(app.match);
      app.match.bullets.clear();
      return n;
    },
    probeImpact: (point, kind) =>
      app.renderer.probeImpactPixels(new THREE.Vector3(point.x, point.y, point.z), kind),
    forceSpectate: () => app.forceSpectate(),
    repaintHud: () => app.repaintHud(),
  };
}
