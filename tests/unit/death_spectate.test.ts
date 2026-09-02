import { describe, it, expect } from 'vitest';
import { Match } from '@/game/match';
import { resolveSpectator } from '@/game/ai/spectator';
import { createUnit } from '@/game/units/units';

const DT = 1 / 60;

function allyUnit(id: number, team: 'blue' | 'red', alive = true): ReturnType<typeof createUnit> {
  const u = createUnit(id, `U${id}`, team, false, 0, 0, 0);
  u.alive = alive;
  u.hp = alive ? 100 : 0;
  return u;
}

describe('resolveSpectator (pure)', () => {
  it('cycles through living allies in order', () => {
    const allies = [allyUnit(1, 'blue'), allyUnit(2, 'blue'), allyUnit(3, 'blue')];
    expect(resolveSpectator(allies, 0).targetId).toBe(1);
    expect(resolveSpectator(allies, 1).targetId).toBe(2);
    expect(resolveSpectator(allies, 2).targetId).toBe(3);
    // wraps around
    expect(resolveSpectator(allies, 3).targetId).toBe(1);
    expect(resolveSpectator(allies, -1).mode).toBe('ally');
  });

  it('skips dead allies', () => {
    const allies = [allyUnit(1, 'blue', false), allyUnit(2, 'blue'), allyUnit(3, 'blue', false)];
    const r = resolveSpectator(allies, 0);
    expect(r.mode).toBe('ally');
    expect(r.targetId).toBe(2); // only survivor
  });

  it('falls back to free-cam when no ally is alive', () => {
    const allies = [allyUnit(1, 'blue', false), allyUnit(2, 'blue', false)];
    const r = resolveSpectator(allies, 0);
    expect(r.mode).toBe('free');
    expect(r.targetId).toBeNull();
  });
});

describe('Match: death -> spectator flow', () => {
  it('a dead player spectates a living ally, cycling on index change', () => {
    const m = new Match(11);
    // Kill the player outright.
    m.units[0].alive = false;
    m.units[0].hp = 0;
    m.tick(DT);
    expect(m.spectate.mode).toBe('ally');
    const first = m.spectate.targetId;
    expect(first).not.toBeNull();
    expect(m.units.find((u) => u.id === first)?.team).toBe('blue');
    expect(m.units.find((u) => u.id === first)?.alive).toBe(true);

    // Advance one ally slot -> should pick a different living ally (if any).
    const blueAllies = m.units.filter((u) => u.team === 'blue' && u.alive && u.id !== 0).map((u) => u.id);
    m.setSpectateIndex(1);
    m.tick(DT);
    const second = m.spectate.targetId;
    if (blueAllies.length > 1) {
      expect(second).not.toBe(first);
    }
    expect(blueAllies).toContain(second);
  });

  it('falls back to free-cam when the whole blue team is dead (player last)', () => {
    const m = new Match(11);
    // Kill the blue AI teammates first, leaving only the player alive.
    for (const u of m.units) if (u.team === 'blue' && !u.isPlayer) { u.alive = false; u.hp = 0; }
    m.tick(DT); // player still alive -> mode 'alive'
    expect(m.spectate.mode).toBe('alive');
    // Now the player dies -> no living blue allies -> free-cam.
    m.units[0].alive = false;
    m.units[0].hp = 0;
    m.tick(DT);
    expect(m.spectate.mode).toBe('free');
    expect(m.spectate.targetId).toBeNull();
  });
});

describe('Match: end-of-match detection', () => {
  it('ends with a winner when one team is fully eliminated', () => {
    const m = new Match(21);
    for (const u of m.units) if (u.team === 'red') { u.alive = false; u.hp = 0; }
    m.tick(DT);
    expect(m.state).toBe('ended');
    expect(m.winner).toBe('blue');
    // Further ticks are no-ops once ended.
    const t = m.now;
    m.tick(DT);
    expect(m.now).toBe(t);
  });
});
