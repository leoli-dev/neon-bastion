// Test hooks exposed on `window.__teamArenaTest`. Lets E2E and manual
// inspection read state, pin the RNG seed, teleport, simulate shots, force a
// spectator, fast-forward the fixed-tick loop, and restart — all without any
// network or backend.

import type { App } from './app';
import type { Vec3 } from './game/types';

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
    forceSpectate: () => app.forceSpectate(),
    repaintHud: () => app.repaintHud(),
  };
}
