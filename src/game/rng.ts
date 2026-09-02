// Deterministic, injectable-seed RNG for all game randomness.
// No wall-clock, no Math.random, no network. A fixed seed fully determines a match.

/** mulberry32 PRNG — small, fast, deterministic, seedable. */
export class RNG {
  private s: number;

  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  get state(): number {
    return this.s;
  }

  set state(v: number) {
    this.s = v >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Pick a random element. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** true with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  clone(): RNG {
    const c = new RNG(0);
    c.s = this.s;
    return c;
  }
}

/**
 * Deterministic per-shot hash.
 * Given the same master seed and the same shot index, this ALWAYS returns the
 * same value, independent of any prior RNG calls. This is what makes burst
 * spread reproducible: "same seed + same shot index => same spread".
 */
export function shotRandom(masterSeed: number, k: number): number {
  let h = (Math.imul(masterSeed ^ 0x9e3779b9, 0x85ebca6b) ^ (k | 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Combine several ints into a 32-bit seed. */
export function hashSeed(...vals: number[]): number {
  let h = 0x811c9dc5 >>> 0;
  for (const v of vals) {
    h ^= v | 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
