// Regression tests: AI shots must travel the SAME unified path as player
// shots — Match.fireFrom -> fireWeapon + Match.emitShot — so the event bus
// (shot/hit/kill) and the kill feed see every AI bullet exactly like a
// player's. Before the fix, aiController.ts called fireWeapon directly and
// 7 of the 8 shooters were audio/visual silent: no tracers, no muzzle flash,
// no sparks, no gun audio, no hit/kill events, and degraded kill-feed entries
// (headshot hard-coded false, killer '???').
//
// The scenarios pin a 1v1 at fixed range with a fixed seed, so the outcome
// (including which part the killing shot hits) is fully deterministic — the
// same guarantees the rest of this suite relies on.

import { describe, it, expect } from 'vitest';
import { Match, type MatchEvent } from '@/game/match';
import type { MapData, Unit } from '@/game/types';

const DT = 1 / 60;

// A clean open arena (only outer walls) so we control the shot distance
// precisely without interior occlusion surprises.
function openMap(): MapData {
  return {
    name: 'open',
    bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
    solids: [
      { id: 0, x: 0, z: -31, sx: 64, sz: 2, bottom: 0, top: 6, kind: 'boundary' },
      { id: 1, x: 0, z: 31, sx: 64, sz: 2, bottom: 0, top: 6, kind: 'boundary' },
      { id: 2, x: -31, z: 0, sx: 2, sz: 64, bottom: 0, top: 6, kind: 'boundary' },
      { id: 3, x: 31, z: 0, sx: 2, sz: 64, bottom: 0, top: 6, kind: 'boundary' },
    ],
    spawns: {
      blue: [{ x: -3, z: 24, yaw: Math.PI }, { x: 3, z: 24, yaw: Math.PI }, { x: -3, z: 27, yaw: Math.PI }, { x: 3, z: 27, yaw: Math.PI }],
      red: [{ x: -3, z: -24, yaw: 0 }, { x: 3, z: -24, yaw: 0 }, { x: -3, z: -27, yaw: 0 }, { x: 3, z: -27, yaw: 0 }],
    },
    navNodes: [
      { id: 0, x: 0, z: 0 }, { id: 1, x: 0, z: 10 }, { id: 2, x: 0, z: -10 },
      { id: 3, x: -10, z: 0 }, { id: 4, x: 10, z: 0 }, { id: 5, x: 0, z: 20 },
      { id: 6, x: 0, z: -20 }, { id: 7, x: -10, z: 10 }, { id: 8, x: 10, z: 10 },
      { id: 9, x: -10, z: -10 }, { id: 10, x: 10, z: -10 },
    ].map((n) => ({ ...n, y: 0 })),
  };
}

interface Pinned1v1 {
  match: Match;
  ai: Unit; // blue AI (id 1, "Kestrel") — the shooter under test
  foe: Unit; // red (id 4, "Raxx") — the victim
  events: MatchEvent[];
  run: (maxTicks: number) => void;
}

/**
 * Pin a blue AI and a red unit 28 m apart in the open, facing each other.
 * Everyone else is removed from the fight (dead units never fire) and the
 * victim's brain is dropped (test setup, not a logic change) so there is no
 * return fire and the scenario's outcome is a pure function of the seed.
 */
function pinned1v1(seed: number): Pinned1v1 {
  const m = new Match(seed, openMap());
  const ai = m.units[1];
  const foe = m.units[4];
  for (const idx of [2, 3, 5, 6, 7]) {
    m.units[idx].alive = false;
    m.units[idx].hp = 0;
  }
  foe.ai = null;
  const events: MatchEvent[] = [];
  m.onEvent = (e) => events.push(e);
  const run = (maxTicks: number): void => {
    for (let i = 0; i < maxTicks && foe.alive; i++) {
      ai.pos = { x: 0, y: 0, z: 28 };
      ai.hp = 100;
      ai.alive = true;
      foe.pos = { x: 0, y: 0, z: 0 };
      m.tick(DT);
    }
  };
  return { match: m, ai, foe, events, run };
}

type ShotEvent = Extract<MatchEvent, { type: 'shot' }>;
type KillEvent = Extract<MatchEvent, { type: 'kill' }>;

describe('AI fire goes through the unified Match event path', () => {
  it('emits a shot event carrying the AI shooter id for every AI bullet', () => {
    const { ai, events, run } = pinned1v1(8);
    run(900);

    const aiShots = events.filter((e): e is ShotEvent => e.type === 'shot' && e.shooterId === ai.id);
    expect(aiShots.length, 'the AI should have fired').toBeGreaterThan(0);
    for (const e of aiShots) {
      expect(e.res.fired).toBe(true);
      expect(e.res.aim, 'the shot must carry its actual direction').not.toBeNull();
      expect(e.res.resolution, 'the shot must carry its resolution').not.toBeNull();
    }
    // One bus event per bullet consumed — nothing silent, nothing doubled.
    expect(ai.shotIndex, 'every AI shot must appear on the bus').toBe(aiShots.length);
  });

  it('kill feed records the real hit part on an AI kill (headshot is not hard-coded)', () => {
    // --- Seed 8: the killing blow is a HEADSHOT. ---
    const head = pinned1v1(8);
    head.run(900);
    expect(head.foe.alive, 'the AI must actually kill the pinned victim').toBe(false);

    const killShot = head.events.find((e): e is ShotEvent => e.type === 'shot' && e.res.killed);
    expect(killShot, 'the killing shot must be on the event bus').toBeDefined();
    expect(killShot!.shooterId).toBe(1);
    expect(killShot!.res.targetId).toBe(4);
    expect(killShot!.res.part).toBe('head');

    const killEv = head.events.find((e): e is KillEvent => e.type === 'kill' && e.killerId === 1);
    expect(killEv, 'a kill event must fire for the AI kill').toBeDefined();
    expect(killEv!.victimId).toBe(4);
    expect(killEv!.item.killer).toBe('Kestrel');
    expect(killEv!.item.victim).toBe('Raxx');
    expect(killEv!.item.headshot, 'a headshot kill must record headshot: true').toBe(true);
    expect(killEv!.item.headshot).toBe(killShot!.res.part === 'head');

    // The feed itself, as consumed by the HUD.
    const feedItem = head.match.killfeed.find((k) => k.killer === 'Kestrel');
    expect(feedItem, 'the kill feed must contain the AI kill').toBeDefined();
    expect(feedItem!.headshot).toBe(true);

    // Hit events (hitmarker source) also fire for AI hits now.
    expect(
      head.events.some((e) => e.type === 'hit' && e.victimId === 4 && e.part === 'head'),
      'an AI head hit must emit a head hit event'
    ).toBe(true);

    // --- Seed 33: the killing blow is a BODY shot -> headshot must be false. ---
    const body = pinned1v1(33);
    body.run(1800);
    expect(body.foe.alive, 'the AI must actually kill the pinned victim').toBe(false);
    const bodyKillShot = body.events.find((e): e is ShotEvent => e.type === 'shot' && e.res.killed);
    expect(bodyKillShot, 'the killing shot must be on the event bus').toBeDefined();
    expect(bodyKillShot!.res.part).toBe('body');
    const bodyItem = body.match.killfeed.find((k) => k.victim === 'Raxx');
    expect(bodyItem, 'the kill feed must contain the AI kill').toBeDefined();
    expect(bodyItem!.headshot, 'a body kill must record headshot: false').toBe(false);
    expect(bodyItem!.headshot).toBe(bodyKillShot!.res.part === 'head');
  });
});
