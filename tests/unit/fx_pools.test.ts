// FX-05: the blood and spark effect pools share their bookkeeping with the
// pure FxPool (src/render/fxpools.ts). These tests pin the pool semantics the
// renderer relies on — fixed capacity (an impact burst can never allocate
// past it), round-robin stealing of the oldest slot when saturated, lifetime
// countdown with exactly-once expiry, and immediate reclamation of retired
// slots — plus the independent CONFIG budgets of the two FX families.

import { describe, expect, it } from 'vitest';
import { FxPool } from '../../src/render/fxpools';
import { CONFIG } from '../../src/game/constants';

interface Slot {
  life: number;
  max: number;
}

const makeSlots = (n: number): Slot[] =>
  Array.from({ length: n }, () => ({ life: 0, max: 0 }));

describe('FxPool (FX-05 shared blood/spark pool logic)', () => {
  it('capacity is fixed and acquisitions wrap, stealing the oldest slot', () => {
    const slots = makeSlots(4);
    const pool = new FxPool(slots);
    expect(pool.capacity).toBe(4);

    // Fill the pool.
    for (let i = 0; i < 4; i++) {
      const s = pool.acquire();
      s.life = s.max = 1;
    }
    expect(pool.countAlive()).toBe(4);

    // Saturated: the next slot taken is slot 0 (round robin), and the pool
    // does NOT grow.
    const stolen = pool.acquire();
    expect(stolen).toBe(slots[0]);
    expect(pool.capacity).toBe(4);

    // Wraps around again on the third cycle.
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    expect([a, b, c]).toEqual([slots[2], slots[3], slots[0]]);
  });

  it('step() retires expired slots exactly once and they become recyclable', () => {
    const slots = makeSlots(2);
    const pool = new FxPool(slots);
    let expirations = 0;
    const mark = (s: Slot, life: number) => {
      s.life = s.max = life;
    };

    mark(pool.acquire(), CONFIG.sparkLife); // a spark-like slot
    mark(pool.acquire(), CONFIG.bloodLife); // a blood-like slot

    // One step: the shorter-lived spark (0.22 s) expires, the blood slot
    // (0.55 s) survives this step (0.3 < 0.55).
    const after1 = pool.step(0.3, () => expirations++);
    expect(after1, 'the blood slot must still be alive').toBe(1);
    expect(expirations, 'the spark must expire exactly once').toBe(1);
    expect(slots[0].life).toBeLessThanOrEqual(0);
    expect(slots[1].life).toBeGreaterThan(0);

    // A big step retires the blood slot too — still only ONE expiry each.
    const after2 = pool.step(10, () => expirations++);
    expect(after2).toBe(0);
    expect(expirations, 'each effect expires exactly once, never twice').toBe(2);
    expect(slots.every((s) => s.life <= 0)).toBe(true);

    // Dead slots stay dead: stepping again must not fire more expiries.
    expect(pool.step(0.5, () => expirations++)).toBe(0);
    expect(expirations).toBe(2);

    // Expired slots are instantly recyclable for new effects.
    const recycled = pool.acquire();
    recycled.life = recycled.max = CONFIG.bloodLife;
    expect(pool.countAlive()).toBe(1);
  });

  it('an unbounded impact burst can never exceed the pool capacity', () => {
    const slots = makeSlots(8);
    const pool = new FxPool(slots);
    // 100 impacts into an 8-slot pool: memory and live count stay capped.
    for (let i = 0; i < 100; i++) pool.acquire().life = 1;
    expect(pool.countAlive()).toBeLessThanOrEqual(slots.length);
    expect(pool.countAlive()).toBe(8);
    expect(pool.capacity).toBe(8);
  });

  it('acquire on an empty-but-valid pool never hands out the same slot twice before wrapping', () => {
    const slots = makeSlots(3);
    const pool = new FxPool(slots);
    expect(pool.acquire()).toBe(slots[0]);
    expect(pool.acquire()).toBe(slots[1]);
    expect(pool.acquire()).toBe(slots[2]);
    expect(pool.acquire(), 'wrap-around reuses slot 0').toBe(slots[0]);
  });
});

describe('FX-05 CONFIG: blood and sparks are independent, correctly-sized budgets', () => {
  it('the two pools have their own capacities (no shared pool)', () => {
    expect(CONFIG.sparkPoolSize).toBeGreaterThan(0);
    expect(CONFIG.bloodPoolSize).toBeGreaterThan(0);
  });

  it('sparks are light + fast-fading; blood is heavier + slower', () => {
    // Spark motion budget: outward burst, short life, weaker gravity.
    expect(CONFIG.sparkCount).toBeGreaterThan(0);
    expect(CONFIG.sparkSpeed).toBeGreaterThan(0);
    expect(CONFIG.sparkUpSpeed).toBeGreaterThan(0);
    expect(CONFIG.sparkLife).toBeGreaterThan(0);
    // Blood must outlive a spark and fall under a stronger gravity —
    // that is the "heavier, lingers, drops" read the task demands.
    expect(CONFIG.bloodLife).toBeGreaterThan(CONFIG.sparkLife);
    expect(CONFIG.bloodGravity).toBeGreaterThan(CONFIG.sparkGravity);
    expect(CONFIG.bloodSpeed).toBeGreaterThan(0);
    expect(CONFIG.bloodSpread).toBeGreaterThan(0);
  });

  it('headshots bleed more and bigger than body hits', () => {
    expect(CONFIG.bloodCountHead).toBeGreaterThan(CONFIG.bloodCountBody);
    expect(CONFIG.bloodHeadSizeMult).toBeGreaterThan(1);
    expect(CONFIG.bloodSize).toBeGreaterThan(0);
  });
});
