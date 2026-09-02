// Player strafe / forward direction (pure logic, no DOM).
// Regression for CTRL-01: A/D were straffing to the wrong side.
//
// Convention: forward = (sin yaw, cos yaw) in the XZ plane (yaw=0 faces +Z),
// and the FPV camera looks along that same vector. In three.js (right-handed,
// Y-up) the screen-right axis is f × up, which for this forward vector is
// (-cos yaw, sin yaw). D must move the player along that vector.

import { describe, it, expect } from 'vitest';
import { Match } from '../../src/game/match';
import { CONFIG } from '../../src/game/constants';

const STEPS = 10; // ~0.167s of logic time at the fixed tick

function placeAt(m: Match, x: number, z: number, yaw: number): void {
  const p = m.player;
  p.pos.x = x;
  p.pos.z = z;
  p.pos.y = 0;
  p.yaw = yaw;
  p.pitch = 0;
  p.vel.x = 0;
  p.vel.z = 0;
  p.vy = 0;
  p.grounded = true;
}

function drive(m: Match, input: (pi: Match['playerInput']) => void): { dx: number; dz: number } {
  input(m.playerInput);
  for (let i = 0; i < STEPS; i++) m.tick(CONFIG.tickDt);
  m.playerInput.forward = m.playerInput.back = false;
  m.playerInput.left = m.playerInput.right = false;
  m.playerInput.jump = false;
  const p = m.player;
  return { dx: p.vel.x, dz: p.vel.z };
}

describe('player movement axes (CTRL-01 regression)', () => {
  it('W moves along the facing direction (yaw=0 -> +Z)', () => {
    const m = new Match(1);
    placeAt(m, -3, 24, 0);
    const z0 = m.player.pos.z;
    drive(m, (pi) => { pi.forward = true; });
    expect(m.player.pos.z).toBeGreaterThan(z0 + 0.5);
    expect(Math.abs(m.player.pos.x - -3)).toBeLessThan(0.1);
  });

  it('D strafes to screen-right: facing +Z (yaw=0), x must DECREASE', () => {
    const m = new Match(1);
    placeAt(m, -3, 24, 0);
    const x0 = m.player.pos.x;
    drive(m, (pi) => { pi.right = true; });
    expect(m.player.pos.x, 'screen-right while facing +Z is -X').toBeLessThan(x0 - 0.5);
    expect(Math.abs(m.player.pos.z - 24)).toBeLessThan(0.1);
  });

  it('D strafes to screen-right: facing -Z (yaw=π), x must INCREASE', () => {
    const m = new Match(1);
    placeAt(m, -3, 24, Math.PI);
    const x0 = m.player.pos.x;
    drive(m, (pi) => { pi.right = true; });
    expect(m.player.pos.x, 'screen-right while facing -Z is +X').toBeGreaterThan(x0 + 0.5);
  });

  it('A is the exact mirror of D', () => {
    for (const yaw of [0, Math.PI]) {
      const mA = new Match(1);
      placeAt(mA, -3, 24, yaw);
      drive(mA, (pi) => { pi.left = true; });
      const mD = new Match(1);
      placeAt(mD, -3, 24, yaw);
      drive(mD, (pi) => { pi.right = true; });
      const dA = mA.player.pos.x - -3;
      const dD = mD.player.pos.x - -3;
      expect(dA, `A should move opposite to D at yaw=${yaw}`).toBeCloseTo(-dD, 5);
    }
  });

  it('D/A never produce forward-backward drift (pure lateral)', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const m = new Match(1);
      // open central-south area for every heading
      placeAt(m, -3, 24, yaw);
      const x0 = m.player.pos.x;
      const z0 = m.player.pos.z;
      drive(m, (pi) => { pi.right = true; });
      const dx = m.player.pos.x - x0;
      const dz = m.player.pos.z - z0;
      const dot = dx * Math.sin(yaw) + dz * Math.cos(yaw); // component along facing
      expect(Math.abs(dot), `strafe must be perpendicular to facing at yaw=${yaw}`).toBeLessThan(0.05);
      expect(Math.hypot(dx, dz), 'strafe must actually move the player').toBeGreaterThan(0.5);
    }
  });
});
