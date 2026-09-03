// UX-12: minimap vision cone + shared team view.
//  - geomVisible() is the team/alive-agnostic geometry (distance + FOV + LOS):
//    straight ahead visible, ±44° visible, ±46° invisible (minimap cone is
//    90° total), out of range invisible, hedge blocks, glass does NOT block.
//  - The AI keeps its own, WIDER perception cone (CONFIG.ai.fovHalfDeg = 50°
//    half = 100° total): a target at 47° is still `canSee`-able by the AI but
//    outside the minimap's ±45° display arc. Two knobs, not merged.
//  - sharedViewCanSee(): enemy visible to the player OR any LIVING teammate
//    -> "should display"; visible to nobody -> "not displayed".

import { describe, it, expect } from 'vitest';
import { createUnit } from '@/game/units/units';
import {
  geomVisible,
  sharedViewCanSee,
  canSee,
  MINIMAP_VISIBILITY,
} from '@/game/ai/aiPerception';
import { CONFIG } from '@/game/constants';
import type { Solid, Unit } from '@/game/types';

const DEG = Math.PI / 180;

const GLASS_WALL: Solid = {
  id: 100, x: 0, z: 5, sx: 4, sz: 1, bottom: 0, top: 6, kind: 'wall', material: 'glass',
};
const HEDGE_WALL: Solid = { ...GLASS_WALL, id: 101, material: 'hedge' };

/** Observer at the origin facing +Z (yaw 0); target at `deg` off-axis at `dist`. */
function observerAndTarget(deg: number, dist: number): { o: Unit; t: Unit } {
  const a = deg * DEG;
  const o = createUnit(0, 'Vega', 'blue', true, 0, 0, 0);
  const t = createUnit(1, 'Raxx', 'red', false, dist * Math.sin(a), dist * Math.cos(a), 0);
  return { o, t };
}

describe('UX-12: geomVisible() — geometric sight (no team/alive preconditions)', () => {
  it('straight ahead is visible', () => {
    const { o, t } = observerAndTarget(0, 10);
    expect(geomVisible([], o, t, MINIMAP_VISIBILITY)).toBe(true);
  });

  it('±44° off-axis is visible (inside the 90° display cone)', () => {
    const right = observerAndTarget(44, 10);
    const left = observerAndTarget(-44, 10);
    expect(geomVisible([], right.o, right.t, MINIMAP_VISIBILITY)).toBe(true);
    expect(geomVisible([], left.o, left.t, MINIMAP_VISIBILITY)).toBe(true);
  });

  it('±46° off-axis is invisible (outside the 90° display cone)', () => {
    const right = observerAndTarget(46, 10);
    const left = observerAndTarget(-46, 10);
    expect(geomVisible([], right.o, right.t, MINIMAP_VISIBILITY)).toBe(false);
    expect(geomVisible([], left.o, left.t, MINIMAP_VISIBILITY)).toBe(false);
  });

  it('out of range is invisible (range knob, not the FOV)', () => {
    const near = observerAndTarget(0, CONFIG.minimap.visionDist - 1);
    const far = observerAndTarget(0, CONFIG.minimap.visionDist + 1);
    expect(geomVisible([], near.o, near.t, MINIMAP_VISIBILITY)).toBe(true);
    expect(geomVisible([], far.o, far.t, MINIMAP_VISIBILITY)).toBe(false);
  });

  it('an opaque hedge wall blocks sight', () => {
    const { o, t } = observerAndTarget(0, 10); // the hedge sits at z=5 on the axis
    expect(geomVisible([HEDGE_WALL], o, t, MINIMAP_VISIBILITY)).toBe(false);
  });

  it('a glass wall does NOT block sight (MAP-02 sight-line rule)', () => {
    const { o, t } = observerAndTarget(0, 10); // the glass sits at z=5 on the axis
    expect(geomVisible([GLASS_WALL], o, t, MINIMAP_VISIBILITY)).toBe(true);
  });
});

describe('UX-12: AI perception cone and minimap display cone stay separate', () => {
  it('CONFIG knobs are distinct and canSee() uses the WIDER AI cone', () => {
    expect(CONFIG.ai.fovHalfDeg).toBe(50); // AI perception: 100° total
    expect(CONFIG.minimap.fovHalfDeg).toBe(45); // minimap display: 90° total
    // 47° off-axis: the AI (100° cone) still acquires it…
    const { o, t } = observerAndTarget(47, 10);
    expect(canSee([], o, t), 'AI must still see a target at 47°').toBe(true);
    // …but it is outside the minimap's ±45° display arc.
    expect(geomVisible([], o, t, MINIMAP_VISIBILITY), 'minimap cone must not widen').toBe(false);
  });

  it('canSee() still refuses same-team and dead targets', () => {
    const ally = createUnit(2, 'Juno', 'blue', false, 5, 5, 0);
    const dead = createUnit(3, 'Raxx', 'red', false, 0, 5, 0);
    dead.alive = false;
    const p = createUnit(0, 'Vega', 'blue', true, 0, 0, 0);
    expect(canSee([], p, ally)).toBe(false);
    expect(canSee([], p, dead)).toBe(false);
  });
});

describe('UX-12: sharedViewCanSee() — enemy shared view for the minimap', () => {
  function setup() {
    // Player at origin facing +Z; the enemy is BEHIND the player (z < 0),
    // so the player's own ±45° cone never contains it.
    const player = createUnit(0, 'Vega', 'blue', true, 0, 0, 0);
    const enemy = createUnit(4, 'Raxx', 'red', false, 0, -30, Math.PI);
    // Teammate 10 m to the east of the enemy, facing straight at it.
    const teammate = createUnit(1, 'Kestrel', 'blue', false, 10, -15, Math.atan2(-10, -15));
    return { player, enemy, teammate };
  }

  it('displays when the enemy is out of the player cone but inside a LIVING teammate cone', () => {
    const { player, enemy, teammate } = setup();
    // Sanity: the player truly cannot see it…
    expect(geomVisible([], player, enemy, MINIMAP_VISIBILITY)).toBe(false);
    // …but the teammate has clean geometric sight (18 m, straight ahead).
    expect(geomVisible([], teammate, enemy, MINIMAP_VISIBILITY)).toBe(true);
    expect(sharedViewCanSee([], [player, teammate], 'blue', enemy)).toBe(true);
  });

  it('does not display when nobody can see it (teammate faces away)', () => {
    const { player, enemy, teammate } = setup();
    teammate.yaw = 0; // facing +Z now: the enemy is behind it as well
    expect(sharedViewCanSee([], [player, teammate], 'blue', enemy)).toBe(false);
  });

  it('a dead teammate contributes no view', () => {
    const { player, enemy, teammate } = setup();
    teammate.alive = false;
    expect(sharedViewCanSee([], [player, teammate], 'blue', enemy)).toBe(false);
  });

  it('a dead enemy is never displayed', () => {
    const { player, enemy, teammate } = setup();
    enemy.alive = false;
    expect(sharedViewCanSee([], [player, teammate], 'blue', enemy)).toBe(false);
  });

  it('walls block the shared view too (hedge yes, glass no)', () => {
    const { player, enemy, teammate } = setup();
    const hedge: Solid = { id: 90, x: 5, z: -22.5, sx: 1, sz: 6, bottom: 0, top: 6, kind: 'wall', material: 'hedge' };
    const glass: Solid = { ...hedge, id: 91, material: 'glass' };
    expect(sharedViewCanSee([hedge], [player, teammate], 'blue', enemy)).toBe(false);
    expect(sharedViewCanSee([glass], [player, teammate], 'blue', enemy)).toBe(true);
  });
});
