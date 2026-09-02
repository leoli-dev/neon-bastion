// Player weapon is SEMI-AUTOMATIC at the shared 1-shot/second cadence:
// `playerInput.fire` is the held-trigger level (true from mousedown to
// mouseup), and the Match fires only on its rising edge. Holding the button
// down (fire staying true every tick) must therefore produce exactly ONE
// shot; firing again requires release + a fresh press.

import { describe, it, expect } from 'vitest';
import { Match } from '@/game/match';

const DT = 1 / 60;

/** Tick `n` steps with the trigger held at `fire`, keeping the player alive. */
function tickWith(m: Match, fire: boolean, n: number): void {
  for (let i = 0; i < n; i++) {
    m.playerInput.fire = fire;
    m.player.hp = 100; // immune to AI return fire: isolate the trigger logic
    m.tick(DT);
  }
}

describe('player: semi-auto (edge-triggered fire)', () => {
  it('holding the trigger (fire=true continuously) fires exactly one round', () => {
    const m = new Match(20260212);
    // Hold the trigger for 10 seconds straight — far more than the 1/s
    // cooldown — and the full-auto behaviour would have fired ~10 rounds.
    tickWith(m, true, 600);
    expect(m.player.shotIndex, 'a held trigger must never auto-fire').toBe(1);
  });

  it('releasing and pressing again fires once more (still 1/s throttled)', () => {
    const m = new Match(20260212);
    tickWith(m, true, 1); // fresh press #1
    expect(m.player.shotIndex).toBe(1);
    tickWith(m, true, 120); // keep holding: nothing else happens
    expect(m.player.shotIndex, 'holding must not repeat shots').toBe(1);
    tickWith(m, false, 60); // release for 1s (cooldown clears)
    tickWith(m, true, 240); // fresh press #2, then held for 4s
    expect(m.player.shotIndex, 'a fresh press after release fires exactly one more').toBe(2);
  });
});
