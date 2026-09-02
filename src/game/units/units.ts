// Unit factory and hitbox accessors.
// A unit's damage model: a body AABB (feet .. feet+bodyHeight) and a head sphere
// (center at feet+headCenterY, radius headRadius). Headshots do more damage.

import type { Team, Unit, Vec3 } from '../types';
import { CONFIG } from '../constants';

export interface BodyBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** Body AABB for a unit (approximates the torso/legs as a box). */
export function bodyAABB(u: Unit): BodyBox {
  const hw = CONFIG.bodyHalfW;
  return {
    minX: u.pos.x - hw,
    maxX: u.pos.x + hw,
    minY: u.pos.y,
    maxY: u.pos.y + CONFIG.bodyHeight,
    minZ: u.pos.z - hw,
    maxZ: u.pos.z + hw,
  };
}

/** Head sphere centre (world Y) and radius. */
export function headCenter(u: Unit): Vec3 {
  return { x: u.pos.x, y: u.pos.y + CONFIG.headCenterY, z: u.pos.z };
}

export const HEAD_RADIUS = CONFIG.headRadius;

const BLUE_NAMES = ['Vega', 'Kestrel', 'Onyx', 'Juno'];
const RED_NAMES = ['Raxx', 'Vulture', 'Dredge', 'Hex'];

export function createUnit(
  id: number,
  name: string,
  team: Team,
  isPlayer: boolean,
  x: number,
  z: number,
  yaw: number
): Unit {
  return {
    id,
    name,
    team,
    isPlayer,
    pos: { x, y: 0, z },
    vel: { x: 0, z: 0 },
    vy: 0,
    grounded: true,
    yaw,
    pitch: 0,
    hp: CONFIG.hpMax,
    armor: 0,
    alive: true,
    mag: CONFIG.magSize,
    reserve: CONFIG.reserveAmmo,
    reloading: false,
    reloadEndsAt: 0,
    lastShotAt: -100,
    shotIndex: 0,
    heat: 0,
    lastHitBy: -1,
    flashUntil: 0,
    deathAt: -1,
    kills: 0,
    hitScore: 0,
    totalScore: 0,
    ai: null,
  };
}

export function blueName(i: number): string {
  return BLUE_NAMES[i % BLUE_NAMES.length];
}
export function redName(i: number): string {
  return RED_NAMES[i % RED_NAMES.length];
}
