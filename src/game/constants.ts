// Central tuning / configuration. Everything the balance of the game depends on
// lives here so AI accuracy, reaction delay and damage are all configurable.

export const CONFIG = {
  // --- Timing -------------------------------------------------------------
  tickRate: 60, // fixed logic ticks per second
  tickDt: 1 / 60,

  // --- Character / movement ----------------------------------------------
  unitRadius: 0.42,
  eyeHeight: 1.62,
  headCenterY: 1.6, // above feet
  headRadius: 0.27,
  bodyHalfW: 0.42, // half-extent of the body AABB on X/Z
  bodyHeight: 1.42, // body AABB height above feet
  gravity: 24,
  jumpVelocity: 8.2,
  maxStep: 0.6, // max climbable vertical difference per horizontal move
  walkSpeed: 5.4,
  sprintSpeed: 8.4,
  aiSpeed: 5.0,
  aiStrafeSpeed: 3.2,
  accel: 40, // velocity change toward target (units/s^2) for smoothness
  // Camera
  bobAmplitude: 0.05,
  bobFrequency: 9,
  hitKick: 0.06, // camera kick on being hit
  shotKick: 0.02, // camera kick per shot (recoil pitch)

  // --- Combat / weapon ----------------------------------------------------
  hpMax: 100,
  armorMax: 0,
  damageBody: 20,
  damageHead: 50,
  magSize: 30,
  reserveAmmo: 90,
  fireInterval: 0.085, // seconds between full-auto shots (~11.7 rps)
  reloadTime: 2.1,
  // spread (radians of cone)
  spreadBase: 0.0045,
  spreadHeatPerShot: 0.16, // heat added per shot
  spreadHeatMax: 1.0,
  spreadHeatRecovery: 1.6, // heat decay per second when not firing
  spreadHeatScale: 0.010, // radians added per unit of heat
  spreadMoveScale: 0.006, // radians scaled by horizontal speed
  // scoring
  scorePerHit: 1,
  scorePerKill: 3,

  // --- AI (all configurable, same rules both teams) -----------------------
  ai: {
    fovHalfDeg: 50, // half-angle of the vision cone (100° total, used directly)
    visionDist: 38, // max direct-line sight distance
    soundDist: 26, // how far gunfire is "heard"
    reactTime: 0.26, // seconds before an AI can return fire after acquiring
    fireInterval: 0.2, // seconds between AI shots (slower, more human)
    burstMin: 3,
    burstMax: 6,
    accuracy: 0.62, // base hit chance on a target in sight
    accuracyCloseBonus: 0.18, // added when target is close
    inaccuracyBase: 0.03, // base cone
    inaccuracyDist: 0.0009, // added per meter of range
    moveInaccuracy: 0.004, // added when the AI is moving
    aiMagSize: 30,
    aiReloadTime: 1.8,
    reloadWhenEmpty: true,
    retreatHp: 32, // drop to 'retreat' at or below this HP
    // behaviour timing
    decideInterval: 0.22, // how often an AI re-evaluates its state
    alertTime: 2.2, // how long an AI holds the 'alert' state investigating a sound
    searchTime: 3.0, // how long to search a last-known position
    coverTime: 1.4, // how long to hold cover
    advanceJitter: 4.0, // how far ahead of a waypoint to pick the next goal
    minFireDist: 3.0, // won't fire closer than this (point blank mercy)
    // fair-sense sanity: AI never fires through walls (enforced by hitscan)
    wanderRadius: 10,
  },

  // --- Camera / spectator -------------------------------------------------
  spectateSmooth: 6, // camera lerp factor
  freeCamHeight: 26, // top-down fallback camera height

  // --- Particles ----------------------------------------------------------
  maxParticles: 900,
  tracerLife: 0.08,
  sparkLife: 0.3,
  muzzleLife: 0.05,
};

export type Config = typeof CONFIG;
