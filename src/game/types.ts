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

/** Visual/collision material of a solid — orthogonal to its `kind` (MAP-01).
 *  The same wall can be plain solid, opaque hedge foliage, or transparent glass. */
export type SolidMaterial = 'solid' | 'hedge' | 'glass';

/** A single axis-aligned solid in the map (wall / platform / ramp / boundary / spawn).
 *  MAP-03: "cover" is gone — the arena is flat and every inner solid is a full
 *  3.0m `wall` (single height). 'platform'/'ramp' remain in the union for the
 *  geometry helpers but no solid currently uses them. */
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
  kind: 'boundary' | 'wall' | 'platform' | 'ramp' | 'spawn';
  /** Material override (MAP-01). Unset = 'solid' (legacy appearance). */
  material?: SolidMaterial;
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
  /** Surface height this node sits on (0 = ground). */
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

/**
 * AI-01: a unit's strategic personality. 'rusher' pushes the mid / shortest
 * path and holds the fight (retreats late); 'flanker' picks nodes far from
 * its teammates' centroid (the outer lanes), fires one round then peels off
 * to cover, and refuses to join an ongoing brawl. Assigned per team from the
 * match seed — both sides carry both doctrines.
 */
export type Doctrine = 'flanker' | 'rusher';

export type AIStateName =
  | 'assemble'
  | 'patrol'
  | 'alert'
  | 'engage'
  | 'flank' // AI-01: the flanker's post-shot disengage window (cover hold)
  | 'retreat'
  | 'search'
  | 'cautious'
  | 'dead';

export interface AIState {
  state: AIStateName;
  /** AI-01: strategic personality ('flanker' / 'rusher'), seed-assigned. */
  doctrine: Doctrine;
  /** AI-01 flanker: logic time at which the current disengage window ends. */
  flankUntil: number;
  /** Logic time this unit entered 'retreat' (livelock dwell guard). */
  retreatSince: number;
  /** Generic anti-stall bookkeeping: position/time when the last real
   *  progress was made. If < 0.5m of progress for 2.5s, the current plan is
   *  dropped so a fresh (reachable) waypoint is picked. */
  stuckSince: number;
  stuckX: number;
  stuckZ: number;
  /** Corner-slide: while a jam episode is active, the desired velocity is
   *  rotated by this sign so the unit steers TANGENTIALLY around whatever
   *  corner it is pressed against instead of re-ramming it. */
  slideSign: -1 | 0 | 1;
  slideUntil: number;
  clearSince: number; // war mode: lane-hunt started at this time (0 = not hunting)
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
