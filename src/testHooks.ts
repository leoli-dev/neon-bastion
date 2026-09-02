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
  teleport: (unitId: number, x: number, z: number) => void;
  fastForward: (seconds: number) => void;
  forceSpectate: () => void;
  repaintHud: () => void;
}

export function createTestHooks(app: App): TeamArenaTestHooks {
  return {
    version: '1.0.0',
    ready: true,
    state: () => app.match.snapshot(),
    seed: (s?: number) => {
      if (s !== undefined) app.seed = s;
      return app.seed;
    },
    start: () => app.start(),
    playAgain: () => app.playAgain(),
    restart: (s?: number) => app.playAgain(s),
    mouseTurn: (dx, dy) => app.match.applyLook(dx, dy),
    input: (key, down) => app.setInputKey(key, down),
    shoot: (dir?: Partial<Vec3>) => app.match.firePlayerShot(dir ? { x: dir.x ?? 0, y: dir.y ?? 0, z: dir.z ?? 0 } : undefined),
    applyDamage: (victimId, amount, causeId = -1) => app.match.applyDamage(victimId, amount, causeId),
    simulateHitOnPlayer: (causeId, part = 'body') => {
      const p = app.match.player;
      p.lastHitBy = causeId;
      app.match.onEvent?.({ type: 'hit', victimId: 0, part });
    },
    cameraKicks: () => app.renderer.getCameraKicks(),
    teleport: (unitId, x, z) => app.teleport(unitId, x, z),
    fastForward: (seconds) => app.fastForward(seconds),
    forceSpectate: () => app.forceSpectate(),
    repaintHud: () => app.repaintHud(),
  };
}
