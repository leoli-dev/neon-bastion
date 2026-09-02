// Core shared types for the Neon Bastion game logic.
// These types are used by the pure logic modules (no DOM / no three.js).

export type Vec2 = { x: number; z: number };
export type Vec3 = { x: number; y: number; z: number };

export type Team = 'blue' | 'red';

export const TEAMS: Team[] = ['blue', 'red'];

export function otherTeam(t: Team): Team {
  return t === 'blue' ? 'red' : 'blue';
}

export function teamColor(t: Team): string {
  return t === 'blue' ? '#2f8fff' : '#ff3b3b';
}

/** A single axis-aligned solid in the map (wall / cover / platform / ramp / boundary). */
export interface Solid {
  id: number;
  /** Center on the XZ plane. */
  x: number;
  z: number;
  /** Full extents on XZ. */
  sx: number;
  sz: number;
  /** Vertical range (world Y). */
  bottom: number;
  top: number;
  kind: 'boundary' | 'wall' | 'cover' | 'platform' | 'ramp' | 'spawn';
  /** Ramp axis + which X/Z end is the high end (only for kind === 'ramp'). */
  rampAxis?: 'x' | 'z';
  rampHighPositive?: boolean;
  label?: string;
}

export interface SpawnPoint {
  x: number;
  z: number;
  /** Facing direction in radians (world yaw). 0 = facing -Z. */
  yaw: number;
}

export interface TeamSpawns {
  blue: SpawnPoint[];
  red: SpawnPoint[];
}

/** Raw nav node placement. Links are derived at build time from distance + line-of-sight. */
export interface NavNodeSpec {
  id: number;
  x: number;
  z: number;
  /** Surface height this node sits on (0 = ground, 1.2 = platform top). */
  y: number;
}

/** A NavNode with resolved links. */
export interface NavNode extends NavNodeSpec {
  links: number[];
}

export interface MapData {
  name: string;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  solids: Solid[];
  spawns: TeamSpawns;
  navNodes: NavNodeSpec[];
}

/** Result of a map raycast: the first solid intersected (if any within maxDist). */
export interface MapRayHit {
  solidId: number;
  point: Vec3;
  distance: number;
  normal: Vec3;
}

/** A unit hitbox ray result (head or body). */
export type HitPart = 'head' | 'body';

export interface UnitRayHit {
  unitId: number;
  part: HitPart;
  point: Vec3;
  distance: number;
}

/** Final resolved shot: either a damaged enemy, or a wall hit, or a miss. */
export interface ShotResolution {
  kind: 'unit' | 'wall' | 'miss';
  unitId?: number;
  part?: HitPart;
  point: Vec3;
  distance: number;
  wallSolidId?: number;
}

/** Live state of a single character (player or AI). */
export interface Unit {
  id: number;
  name: string;
  team: Team;
  isPlayer: boolean;
  pos: Vec3; // feet position (y = feet height)
  vel: { x: number; z: number }; // horizontal velocity (world)
  vy: number; // vertical velocity
  grounded: boolean;
  yaw: number; // facing
  pitch: number; // camera pitch (for player view)
  hp: number;
  armor: number;
  alive: boolean;
  // Weapon
  lastShotAt: number;
  shotIndex: number;
  heat: number; // 0..1 accumulated recoil/spread heat
  // Combat feedback bookkeeping
  lastHitBy: number; // unit id of last attacker, or -1
  flashUntil: number; // logic time until which this unit renders as "hit-flashed"
  deathAt: number; // logic time of death, or -1
  // Scoring
  kills: number;
  hitScore: number; // points from valid hits only
  totalScore: number; // hitScore + kill bonus
  // AI
  ai: AIState | null;
}

export type AIStateName =
  | 'assemble'
  | 'patrol'
  | 'alert'
  | 'engage'
  | 'retreat'
  | 'search'
  | 'cautious'
  | 'dead';

export interface AIState {
  state: AIStateName;
  stateUntil: number;
  path: number[]; // nav node indices to follow
  pathIndex: number;
  targetId: number; // -1 if none
  lastSeenPos: { x: number; z: number } | null;
  lastSeenAt: number;
  reactUntil: number; // do not fire before this time (reaction delay)
  strafeDir: number; // -1, 0, 1
  strafeUntil: number;
  // Deterministic per-unit RNG (seeded from match seed + unit id).
  rng: () => number;
}

/** Match-level result / summary for the scoreboard and result screen. */
export interface UnitScore {
  id: number;
  name: string;
  team: Team;
  isPlayer: boolean;
  alive: boolean;
  kills: number;
  hitScore: number; // points from valid hits (not the kill bonus)
  totalScore: number; // hitScore + kill bonus
  hp: number;
}

export interface MatchSummary {
  winner: Team | null; // null while in progress
  elapsed: number; // logic seconds
  blueAlive: number;
  redAlive: number;
  blueScore: number;
  redScore: number;
  playerKills: number;
  playerHits: number;
  playerScore: number;
}
