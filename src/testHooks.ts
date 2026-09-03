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
  /** ART-12: the hedge foliage texture's source canvases (unrepeated):
   *  `base` is the final grain+foliage texture, `foliage` is the wrap-
   *  sensitive layer alone — the seam probe checks its repeat wrap, the
   *  same probe shape as the ART-07 sand seam test. */
  hedgeTextureCanvases: () => { base: HTMLCanvasElement; foliage: HTMLCanvasElement };
  /** ART-08: per-unit LOCAL-space bounding boxes of the visible humanoid
   *  parts (ground ring excluded — a floor marker, not the character; weapon
   *  also excluded — an explicit ART-10 exception: the held prop is NOT part
   *  of the hitbox, so the hitbox-hug assertion measures the character) —
   *  used to assert the visuals hug the hitbox (≤ 0.84 wide/deep, y 0..1.87). */
  unitVisualBounds: () => { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }[];
  /** ART-10: the unit's hand weapon at the match clock. `firing` = inside the
   *  shot-cooldown window after the last trigger (raised pose); `rot` is the
   *  weapon pivot's LOCAL rotation (rest: x ≈ +0.38 muzzle-down; raised:
   *  x ≈ shot pitch − recoil kick); `muzzleAtShot` = recorded barrel-tip world
   *  position; `flash` = world position of the most recent muzzle flash. */
  weaponState: (unitId: number) => {
    hasWeapon: boolean;
    firing: boolean;
    recoil: number;
    aim: { x: number; y: number; z: number } | null;
    rot: { x: number; y: number };
    muzzleAtShot: { x: number; y: number; z: number } | null;
    flash: { x: number; y: number; z: number } | null;
  };
  /** ART-11: show/hide the first-person view model (A/B pixel probes of the
   *  bottom-right quadrant vs the same frame without the gun). */
  viewModelVisible: (v: boolean) => void;
  /** ART-11: repaint one frame NOW (main scene + view-model overlay) at the
   *  current camera/state — deterministic pixel probes (no rAF race). */
  renderFrame: () => void;
  /** ART-11: snap the view model to its full fire-kick pose (what a player
   *  shot does) so a following renderFrame shows the recoil displacement. */
  kickViewModel: () => void;
  /** ART-11: deterministically advance the view-model animation by `seconds`
   *  (optionally forcing a `moveSpeed` so the walk sway is exercised without
   *  moving the sim) and repaint one frame. */
  stepViewModel: (seconds: number, moveSpeed?: number) => void;
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
    hedgeTextureCanvases: () => app.renderer.getHedgeTextureCanvases(),
    unitVisualBounds: () => app.renderer.unitVisualBounds(),
    weaponState: (unitId) => app.weaponProbe(unitId),
    viewModelVisible: (v) => app.renderer.setViewModelVisible(v),
    renderFrame: () => app.renderer.renderFrame(),
    kickViewModel: () => app.renderer.triggerViewModelShot(),
    stepViewModel: (seconds, moveSpeed) => app.renderer.stepViewModel(app.match, seconds, moveSpeed),
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
