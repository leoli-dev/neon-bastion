// MAP-02: sight lines pass through glass, ballistic lines do not.
//  - canSee() is true across a glass wall; resolveShotFrom() says 'wall'
//    (the bullet stops on the pane, the target takes no damage).
//  - A pinned AI that can see the enemy through glass must NOT fire
//    (shotIndex stays 0) — no infinite 1 rps into glass.
//  - A hedge wall, by contrast, still blocks sight (canSee false).

import { describe, it, expect } from 'vitest';
import { Match } from '@/game/match';
import { canSee } from '@/game/ai/aiPerception';
import { resolveShotFrom, applyImpact, eyeOf } from '@/game/combat/hitscan';
import { createUnit } from '@/game/units/units';
import type { MapData, Solid, Vec3 } from '@/game/types';

const DT = 1 / 60;

const GLASS_WALL: Solid = {
  id: 100,
  x: 0,
  z: 0,
  sx: 40,
  sz: 1,
  bottom: 0,
  top: 6,
  kind: 'wall',
  material: 'glass',
};

const HEDGE_WALL: Solid = { ...GLASS_WALL, id: 101, material: 'hedge' };

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

describe('MAP-02: sight through glass, bullets stopped', () => {
  it('canSee() is true across glass, but the shot resolves as a wall (no damage)', () => {
    const solids: Solid[] = [GLASS_WALL];
    const shooter = createUnit(0, 'Vega', 'blue', false, 0, 10, Math.PI); // facing -Z
    const target = createUnit(1, 'Raxx', 'red', false, 0, -10, 0);
    const units = [shooter, target];

    // The pane is 6 m tall and transparent: the AI acquires the target.
    expect(canSee(solids, shooter, target), 'sight must pass through glass').toBe(true);

    // The bullet, however, flies straight into the pane.
    const eye = eyeOf(shooter);
    const dir = norm({
      x: target.pos.x - eye.x,
      y: target.pos.y + 0.9 - eye.y,
      z: target.pos.z - eye.z,
    });
    const resolution = resolveShotFrom(units, solids, shooter, eye, dir, 200);
    expect(resolution.kind, 'the bullet must stop on the glass').toBe('wall');
    if (resolution.kind === 'wall') {
      expect(resolution.wallSolidId).toBe(GLASS_WALL.id);
    }

    // Settling the impact deals zero damage: the target does not bleed.
    const hpBefore = target.hp;
    const impact = applyImpact(units, shooter, resolution, 0);
    expect(impact.damage).toBe(0);
    expect(impact.targetId).toBeNull();
    expect(target.hp).toBe(hpBefore);
  });

  it('a hedge wall still blocks sight (canSee false)', () => {
    const solids: Solid[] = [HEDGE_WALL];
    const shooter = createUnit(0, 'Vega', 'blue', false, 0, 10, Math.PI);
    const target = createUnit(1, 'Raxx', 'red', false, 0, -10, 0);
    expect(canSee(solids, shooter, target), 'hedge must occlude the sight line').toBe(false);
  });
});

describe('MAP-02: AI holds fire across glass', () => {
  it('does not shoot an enemy it can only see through a glass wall', () => {
    // Open arena split by a full-width glass pane at z = 0.
    const map: MapData = {
      name: 'glass-arena',
      bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
      solids: [
        { id: 0, x: 0, z: -31, sx: 64, sz: 2, bottom: 0, top: 6, kind: 'boundary' },
        { id: 1, x: 0, z: 31, sx: 64, sz: 2, bottom: 0, top: 6, kind: 'boundary' },
        { id: 2, x: -31, z: 0, sx: 2, sz: 64, bottom: 0, top: 6, kind: 'boundary' },
        { id: 3, x: 31, z: 0, sx: 2, sz: 64, bottom: 0, top: 6, kind: 'boundary' },
        { id: 10, x: 0, z: 0, sx: 64, sz: 1, bottom: 0, top: 6, kind: 'wall', material: 'glass' },
      ],
      spawns: {
        blue: [{ x: -3, z: 24, yaw: Math.PI }, { x: 3, z: 24, yaw: Math.PI }, { x: -3, z: 27, yaw: Math.PI }, { x: 3, z: 27, yaw: Math.PI }],
        red: [{ x: -3, z: -24, yaw: 0 }, { x: 3, z: -24, yaw: 0 }, { x: -3, z: -27, yaw: 0 }, { x: 3, z: -27, yaw: 0 }],
      },
      navNodes: [
        { id: 0, x: 0, z: 0, y: 0 }, { id: 1, x: 0, z: 10, y: 0 }, { id: 2, x: 0, z: -10, y: 0 },
        { id: 3, x: -10, z: 0, y: 0 }, { id: 4, x: 10, z: 0, y: 0 }, { id: 5, x: 0, z: 20, y: 0 },
        { id: 6, x: 0, z: -20, y: 0 }, { id: 7, x: -10, z: 10, y: 0 }, { id: 8, x: 10, z: 10, y: 0 },
        { id: 9, x: -10, z: -10, y: 0 }, { id: 10, x: 10, z: -10, y: 0 },
      ],
    };
    const m = new Match(42, map);
    const ai = m.units[1]; // blue AI, south of the pane
    const foe = m.units[4]; // red unit, north of the pane

    let sawEngage = false;
    // 15 s at the shared 1 rps cadence — without the pre-fire ballistic check
    // this unit would have fired ~15 rounds into the pane.
    for (let i = 0; i < 15 * 60; i++) {
      ai.pos = { x: 0, y: 0, z: 15 };
      ai.yaw = Math.PI; // facing the foe straight through the glass
      ai.hp = 100;
      ai.alive = true;
      foe.pos = { x: 0, y: 0, z: -15 };
      foe.hp = 100;
      foe.alive = true;
      // Pin the other six in the corners so nothing interferes.
      m.units[2].pos = { x: -26, y: 0, z: 26 };
      m.units[3].pos = { x: 26, y: 0, z: 26 };
      m.units[5].pos = { x: -26, y: 0, z: -26 };
      m.units[6].pos = { x: 0, y: 0, z: -26 };
      m.units[7].pos = { x: 26, y: 0, z: -26 };
      m.tick(DT);
      if (ai.ai?.state === 'engage') sawEngage = true;
    }

    expect(sawEngage, 'the AI acquires the target through the glass (engage state)').toBe(true);
    expect(ai.shotIndex, 'no shots may be fired across the glass wall').toBe(0);
    expect(foe.hp, 'no through-glass damage').toBe(100);
  });
});
