// AUD-01: footstep trigger logic, kept PURE (no WebAudio, no DOM) so the
// "accumulated walking distance -> how many footsteps" cadence is unit-testable
// in node. The Audio object only turns a returned trigger into a sound; all the
// distance-accumulation / grounded / landing state lives here.

export type FootstepKind = 'step' | 'land';

export interface FootstepTrigger {
  kind: FootstepKind;
  /** Base loudness 0..1 (ambient, always well below a gunshot). Audio adds a
   *  little per-call jitter on top so consecutive steps never repeat exactly. */
  intensity: number;
}

export const FOOTSTEP = {
  // Horizontal travel (units) between steps. Sprinting shortens the stride so
  // the cadence speeds up with speed, exactly as requested.
  stepLengthWalk: 1.75,
  stepLengthSprint: 1.5,
  // Base loudness per trigger. Footsteps are AMBIENT sound, never a cue —
  // Audio caps the actual gain far below a gunshot.
  intensityWalk: 0.5,
  intensitySprint: 0.8,
  intensityLand: 0.85, // a touch heavier when the feet come back down
} as const;

/**
 * Distance-driven footstep cadence for ONE unit (the local player). Feed it the
 * horizontal distance moved + grounded/sprint state once per logic tick; it
 * returns a trigger at most once per tick.
 */
export class FootstepTracker {
  /** Total triggers fired since the last reset() — surfaced on test hooks. */
  count = 0;
  private acc = 0;
  private grounded = false;
  private primed = false;

  reset(): void {
    this.acc = 0;
    this.grounded = false;
    this.primed = false;
    this.count = 0;
  }

  /**
   * Advance one tick.
   * @param movedXZ  horizontal distance travelled this tick (>= 0)
   * @param grounded is the unit on the ground this tick
   * @param sprinting is the unit sprinting this tick
   */
  tick(movedXZ: number, grounded: boolean, sprinting: boolean): FootstepTrigger | null {
    const wasGrounded = this.grounded;
    const first = !this.primed;
    this.primed = true;
    this.grounded = grounded;

    // Landing: airborne -> grounded transition. Suppressed on the very first
    // tick, because the player spawns ON the ground and that initial state must
    // not be read as a fresh landing.
    if (grounded && !wasGrounded && !first) {
      this.acc = 0;
      this.count += 1;
      return { kind: 'land', intensity: FOOTSTEP.intensityLand };
    }

    // Airborne: no footsteps, and drop the accumulator so landing doesn't
    // immediately replay a burst of "steps" that built up mid-air.
    if (!grounded) {
      this.acc = 0;
      return null;
    }

    this.acc += movedXZ;
    const stepLen = sprinting ? FOOTSTEP.stepLengthSprint : FOOTSTEP.stepLengthWalk;
    if (this.acc >= stepLen) {
      this.acc -= stepLen;
      this.count += 1;
      return { kind: 'step', intensity: sprinting ? FOOTSTEP.intensitySprint : FOOTSTEP.intensityWalk };
    }
    return null;
  }
}
