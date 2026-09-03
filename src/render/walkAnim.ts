// ART-09: walk-cycle math, kept PURE (no three.js, no DOM, no sim state) so
// the "accumulated horizontal displacement -> gait phase -> joint angles"
// mapping is directly unit-testable in node.
//
// The phase is driven by CUMULATIVE horizontal distance, never by the clock:
// walk faster and the phase advances faster (a shorter stride per unit of
// distance), exactly the same "accumulated displacement" idea AUD-01's
// footstep cadence uses (src/game/footstep.ts). Nothing here may ever be
// written back into `Unit` or `AIState` — it lives only in the Renderer —
// otherwise the AI unit tests and the seed 1..40 termination regression
// would start drifting (the animation would pollute the deterministic sim).

/** Tunable gait constants (presentation only — never read by the sim). */
export const WALK = {
  /** Horizontal distance (units) per stride. Sprinting uses a SHORTER stride
   *  so the same distance advances the phase faster -> a quicker cadence,
   *  matching the footstep tracker. */
  strideWalk: 1.75,
  strideSprint: 1.5,
  /** Peak hip swing (radians). Pinned so the feet never leave the 0.84
   *  body-AABB depth the ART-08 hitbox-hug test enforces (foot reach at
   *  0.34 rad is ~0.41 m, inside the 0.42 half-depth). */
  legAmpWalk: 0.30,
  legAmpSprint: 0.34,
  /** Peak shoulder swing (radians) — arms swing opposite the same-side leg. */
  armAmpWalk: 0.34,
  armAmpSprint: 0.4,
  /** Airborne (jump): the legs gather up into this fixed tuck (radians) and
   *  the arms ease back; recovering on landing is automatic because the
   *  gait phase keeps running and the swing gate re-engages on the ground. */
  airTuck: 0.28,
  airArmTuck: 0.22,
  /** prefers-reduced-motion: shrink the swing amplitude (NOT zero it — a
   *  walk cycle is readability information, not decoration). */
  reducedAmpScale: 0.35,
} as const;

/** Unit-amplitude joint angles for one gait phase (each in the -1..1 band;
 *  the renderer scales them by the per-limb amplitude). Left leg and left
 *  arm swing opposite, so the left arm leads the RIGHT leg (natural gait). */
export interface JointAngles {
  leftLeg: number;
  rightLeg: number;
  leftArm: number;
  rightArm: number;
}

/** A full gait pose: the phase plus the unit-amplitude joint angles. */
export interface GaitPose extends JointAngles {
  phase: number;
}

/**
 * Pure: accumulated horizontal displacement -> gait phase (radians).
 *
 * Each stride advances the phase by PI, so a full gait cycle (both legs back
 * to rest) spans two strides = 2*PI. Zero displacement -> phase 0; more
 * displacement -> a proportionally larger phase (monotonic, no time term).
 */
export function gaitPhase(accumDist: number, stride: number): number {
  if (!Number.isFinite(accumDist) || !Number.isFinite(stride) || stride <= 0) return 0;
  return (accumDist / stride) * Math.PI;
}

/** Pure: gait phase -> unit-amplitude joint angles. A positive phase sine
 *  drives the left leg forward and the right arm forward together. */
export function gaitJointAngles(phase: number): JointAngles {
  const s = Math.sin(phase);
  return {
    leftLeg: s + 0,
    rightLeg: -s + 0,
    leftArm: -s + 0,
    rightArm: s + 0,
  };
}

/** Pure convenience: accumulated displacement -> full pose. This is THE
 *  function the unit tests assert on (displacement in, phase/angles out). */
export function gaitPose(accumDist: number, stride: number): GaitPose {
  const phase = gaitPhase(accumDist, stride);
  const a = gaitJointAngles(phase);
  return { phase, leftLeg: a.leftLeg, rightLeg: a.rightLeg, leftArm: a.leftArm, rightArm: a.rightArm };
}
