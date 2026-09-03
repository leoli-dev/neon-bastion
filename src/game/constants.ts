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
  fovBase: 78, // resting field of view (degrees)
  sprintFov: 85, // FOV pushed to while sprinting (smoothly interpolated)
  bobAmplitude: 0.05,
  bobFrequency: 9,
  hitKick: 0.06, // camera kick on being hit (rad, snaps up + away from the attacker, fast return)
  shotKick: 0.02, // camera kick per shot (recoil pitch, accumulates while firing, eases back)

  // --- Combat / weapon ----------------------------------------------------
  hpMax: 100,
  armorMax: 0,
  damageBody: 20,
  damageHead: 50,
  fireInterval: 1.0, // seconds between shots — one shot per second, shared by player AND AI. The ONLY firing limit (no magazines, no reserve, no reload — nobody can "run dry").
  // Ballistic projectile: bullets FLY at this speed (units/s), so a shot takes
  // distance/bulletSpeed seconds to arrive and can be dodged at range.
  // 60 u/s => 0.17 s over 10 units, 0.5 s over 30 units: mid/long range is
  // reactive, point blank is not. Tuning band: 45–80.
  bulletSpeed: 60,
  bulletMaxAge: 4, // seconds — hard lifetime cap for pooled bullets (safety, not expected)
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
    fireInterval: 1.0, // seconds between AI shots — same 1/s cadence as the player
    accuracy: 0.62, // base hit chance on a target in sight
    accuracyCloseBonus: 0.18, // added when target is close
    inaccuracyBase: 0.03, // base cone
    inaccuracyDist: 0.0009, // added per meter of range
    moveInaccuracy: 0.004, // added when the AI is moving
    retreatHp: 32, // drop to 'retreat' at or below this HP
    // AI-01: strategic personalities (doctrine)
    doctrine: {
      // rushers hold the fight: they only retreat below this (LOWER than
      // retreatHp), i.e. they disengage later than everyone else
      rusherRetreatHp: 20,
      // flanker "one shot, then peel": seconds to hold cover in the 'flank'
      // disengage state before re-joining the push
      disengageTime: 1.6,
      // a flanker refuses to join a firefight where this many of its own
      // teammates are already within clumpRadius of the target
      clumpRadius: 12,
      clumpAllies: 2,
      // stalemate escape: after this much match time, flankers drop the
      // doctrine and fight as rushers so slow games still terminate
      stalemateTime: 60,
      // final escalation: after this much match time EVERY unit patrols a
      // pure centre-push (no wander / no flank), so late-match survivors
      // always converge and the game terminates
      hardPushTime: 90,
      // terminal escalation: after this much match time the AI state machine
      // is replaced by a dumb "walk straight at the target, shoot if you can
      // actually hit, cower only when bleeding with the shooter in front".
      // Any two survivors that end up facing each other then trade until one
      // dies, so no late-match layout can hold a permanent stalemate.
      warTime: 120,
    },
    // hard cap (seconds) on how long a unit may sit in 'retreat' before it
    // is forced to re-position. Livelock guard: seen-through-glass + low HP
    // used to be a stable state with no exit out of 'retreat' at all
    retreatDwell: 10,
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

  // --- Minimap (UX-12) — display-only knobs -------------------------------
  // Deliberately SEPARATE from the `ai` block above: `ai.fovHalfDeg` /
  // `ai.visionDist` are BALANCE knobs (what the AI actually perceives);
  // these are PRESENTATION knobs (how the vision cone is drawn on the
  // minimap and how the shared enemy view behaves). Do not merge them.
  minimap: {
    visionDist: 38, // radius (units) of the drawn vision cone
    fovHalfDeg: 45, // half-angle of the drawn cone (90° total)
    lastSeenFade: 0.7, // seconds an unseen enemy fades at its last known spot
  },

  // --- Camera / spectator -------------------------------------------------
  spectateSmooth: 6, // camera lerp factor
  freeCamHeight: 26, // top-down fallback camera height

  // --- Particles (all consumed by the renderer's effect pools) -------------
  bulletTrail: 1.1, // length (units) of the short trail drawn behind an in-flight bullet
  tracerLife: 0.18, // ~11 frames at 60fps — long enough to be perceived
  sparkLife: 0.22,
  muzzleLife: 0.05, // a flash is a flash: a few frames
};

export type Config = typeof CONFIG;
