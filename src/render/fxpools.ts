// FX-05: pure object-pool bookkeeping shared by the renderer's impact FX
// pools (wall sparks and unit-hit blood). Deliberately THREE-free and
// side-effect free so the capacity/lifetime logic is unit-testable in node.
// Slots are dumb carriers that the renderer owns; the pool only manages
// round-robin acquisition (stealing the oldest slot when saturated) and the
// shared lifetime accounting (countdown, one-shot expiry, alive counts).

export interface FxLife {
  /** Seconds remaining on the current effect; <= 0 means the slot is free. */
  life: number;
  /** Lifetime the slot was (re)used with (opacity fade normalizes by this). */
  max: number;
}

export class FxPool<T extends FxLife> {
  readonly slots: T[];
  private cursor = 0;

  constructor(slots: T[]) {
    this.slots = slots;
  }

  /** Pool capacity. Fixed for the pool's lifetime — effects can never
   *  allocate more than this, no matter how many impacts land in a frame. */
  get capacity(): number {
    return this.slots.length;
  }

  /** How many slots currently carry a live effect. */
  countAlive(): number {
    let n = 0;
    for (const s of this.slots) if (s.life > 0) n++;
    return n;
  }

  /**
   * Take the next slot for a new effect. Round-robin: when the pool is
   * saturated the oldest slot is recycled (its old effect is cut short),
   * so an impact burst can never exceed the pool's capacity.
   */
  acquire(): T {
    const s = this.slots[this.cursor % this.slots.length];
    this.cursor = (this.cursor + 1) % this.slots.length;
    return s;
  }

  /**
   * Advance every live slot by `dt` seconds and retire the expired ones:
   * their life drops to <= 0 (the slot returns to the pool) and `onExpire`
   * fires EXACTLY ONCE per effect so the owner can hide its mesh. Dead
   * slots are untouched (no spurious expiry callbacks). Returns the number
   * of slots still alive after the step.
   */
  step(dt: number, onExpire?: (slot: T) => void): number {
    let alive = 0;
    for (const s of this.slots) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        onExpire?.(s);
      } else {
        alive++;
      }
    }
    return alive;
  }
}
