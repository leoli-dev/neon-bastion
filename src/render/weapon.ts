// ART-10: the reusable low-poly hand weapon + the shared muzzle math.
//
// Everything visible (body / barrel / grip) is cold-metal toned — deliberately
// NOT team-coloured, so the weapon never steals the team-identity palette.
// `makeWeaponMesh()` is the single constructor for the weapon geometry: the
// third-person unit visuals (renderer.buildUnits) use it, and the first-person
// view model (a later task) must reuse it too.
//
// Muzzle alignment: the muzzle flash has always been computed as
//   eye + dir * MUZZLE_OFFSET - (0, MUZZLE_DROP, 0)
// with eye = feet + (0, CONFIG.eyeHeight, 0). This module anchors the weapon's
// rotation PIVOT at feet + (0, WEAPON_PIVOT_Y, 0), where
//   WEAPON_PIVOT_Y + MUZZLE_DROP === CONFIG.eyeHeight (1.50 + 0.12 = 1.62),
// and puts the barrel tip exactly MUZZLE_OFFSET ahead of that pivot along the
// weapon's own +Z axis. Because the pivot sits on the muzzle line of the
// formula, `weaponMuzzleWorld(..., 0)` with the legacy chest pivot
// ({x: 0, y: WEAPON_PIVOT_Y, z: 0}) reproduces the legacy formula to machine
// precision for ANY aim direction (including steep pitch) — the flash spawns
// at the actual barrel tip instead of a second, independent calculation.
//
// ART-15 (Task 11): the runtime pivot no longer sits at the chest — it
// FOLLOWS the right hand (rightHandLocal / weaponPivotLocal, pure functions
// of gait phase + aim blend), and weaponMuzzleWorld takes the pivot position
// EXPLICITLY so the flash stays coherent with the moving hand.

import * as THREE from 'three';
import type { Vec3 } from '../game/types';
import { WALK } from './walkAnim';

/** Metres along the shot direction from the shooter's eye to the muzzle.
 *  Shared FX offset (previously a private app.ts constant). */
export const MUZZLE_OFFSET = 0.55;
/** Metres the muzzle sits below eye level in the muzzle-flash formula. */
export const MUZZLE_DROP = 0.12;
/** LEGACY chest anchor, height above the feet: CONFIG.eyeHeight (1.62) -
 *  MUZZLE_DROP (0.12) = 1.50. Kept for the muzzle-formula identity tests;
 *  the runtime pivot follows the right hand instead (see ART-15 below). */
export const WEAPON_PIVOT_Y = 1.5;
/** Relaxed (not firing) pose: muzzle droops ~22° below the horizon. */
export const WEAPON_REST_PITCH = 0.38;
/** Post-shot recoil: the barrel snaps UP by this many radians (decays). */
export const WEAPON_RECOIL_PITCH = 0.14;
/** Post-shot recoil: the weapon is pulled back this far (decays). */
export const WEAPON_RECOIL_TRAVEL = 0.05;
/** How long the raised/aim pose holds after a trigger (stays inside the
 *  CONFIG.fireInterval = 1.0 s shot cooldown window, then relaxes). */
export const WEAPON_FIRING_WINDOW = 0.9;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap an angle difference into [-PI, PI] (stable shortest-arc lerp). */
export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export interface WeaponMesh {
  /** Weapon group in LOCAL space: +Z = the barrel axis (forward), origin at
   *  the rotation pivot (chest point). Attach it to a pivot group at
   *  (0, WEAPON_PIVOT_Y, 0) in the unit's feet frame. */
  group: THREE.Group;
  /** Zero-draw-call marker at the exact barrel tip, local
   *  (0, 0, MUZZLE_OFFSET). World-position this for the muzzle flash. */
  tip: THREE.Object3D;
}

// Shared (lazily created) geometry + cold-metal materials. Every weapon
// instance reuses them — the same sharing discipline as the unit humanoids
// (zero per-unit allocation; only 3 draw calls per unit).
interface WeaponShared {
  bodyGeo: THREE.BoxGeometry;
  barrelGeo: THREE.CylinderGeometry;
  gripGeo: THREE.BoxGeometry;
  bodyMat: THREE.MeshStandardMaterial;
  barrelMat: THREE.MeshStandardMaterial;
  gripMat: THREE.MeshStandardMaterial;
}

/* ------------------------------------------------------------------ *-
 * ART-15 (Task 11): the weapon is GRIPPED, not carried at the chest.
 * The right arm's hand end is a pure function of (gait phase, aim blend);
 * the weapon pivot sits at that hand (minus the grip offset), so the grip
 * under the hand, the muzzle flash and the barrel tip all stay coherent.
 * `aiming` is a 0..1 blend: 0 = carry (gait swing), 1 = raised two-hand
 * hold. The renderer's arm meshes use exactly these joint numbers (its
 * `armL` mesh is the unit's RIGHT arm — mirrored at x = -0.325).
 * -*/
/** Right arm joint: shoulder anchor (unit-local, feet at origin, +Z forward),
 *  base turn, and the 0.52 m box length the renderer hangs from the shoulder. */
export const RIGHT_ARM = { shoulder: { x: -0.325, y: 1.31, z: 0.14 } as Vec3, yaw: -0.35, length: 0.52 } as const;
/** Left arm joint (same numbers mirrored). */
export const LEFT_ARM = { shoulder: { x: 0.325, y: 1.31, z: 0.14 } as Vec3, yaw: 0.35, length: 0.52 } as const;
/** Two-hand hold pose (applied while the firing window is open). */
export const AIM = {
  /** Right arm swings forward so the hand lands on the grip. */
  rightArmSwing: -1.1,
  /** Right arm turns slightly across the body so the gun sits centred. */
  rightArmYaw: 0.2,
  /** Left arm crosses forward toward the handguard. */
  leftArmSwing: -1.2,
  leftArmYaw: -0.75,
} as const;

/** Pure: the HAND end of an arm whose shoulder sits at `shoulder`, turned by
 *  `yaw` and swung forward by `swing` (rotation.x, the same convention as
 *  the renderer's walk swing). Unit: metres, unit-local. */
export function armHandLocal(shoulder: Vec3, yaw: number, swing: number, length: number): Vec3 {
  const hy = -length * Math.cos(swing);
  const hz = -length * Math.sin(swing);
  return {
    x: shoulder.x + hz * Math.sin(yaw),
    y: shoulder.y + hy,
    z: shoulder.z + hz * Math.cos(yaw),
  };
}

/** Pure: RIGHT hand position (unit-local) at gait `phase` with aim blend
 *  `aiming`. The carry swing matches the renderer's right-side arm mesh
 *  EXACTLY (that mesh is the one labelled `armL` at x -0.325, driven by
 *  `gaitJointAngles().leftArm = -sin(phase)`). */
export function rightHandLocal(phase: number, aiming: number): Vec3 {
  const swing = -Math.sin(phase) * WALK.armAmpWalk * (1 - aiming) + AIM.rightArmSwing * aiming;
  const yaw = RIGHT_ARM.yaw * (1 - aiming) + AIM.rightArmYaw * aiming;
  return armHandLocal(RIGHT_ARM.shoulder, yaw, swing, RIGHT_ARM.length);
}

/** Pure: LEFT hand position (unit-local) — the support hand (the arm mesh
 *  labelled `armR` at x +0.325, driven by `gaitJointAngles().rightArm`). */
export function leftHandLocal(phase: number, aiming: number): Vec3 {
  const swing = Math.sin(phase) * WALK.armAmpWalk * (1 - aiming) + AIM.leftArmSwing * aiming;
  const yaw = LEFT_ARM.yaw * (1 - aiming) + AIM.leftArmYaw * aiming;
  return armHandLocal(LEFT_ARM.shoulder, yaw, swing, LEFT_ARM.length);
}

/** Local grip point of the weapon mesh (makeWeaponMesh) in the pivot frame. */
export const WEAPON_GRIP_LOCAL: Vec3 = { x: 0.01, y: -0.115, z: -0.03 };

/** The grip offset rotated into the REST (muzzle-down) pose: the pivot is
 *  placed relative to the hand through THIS offset, so the grip sits in the
 *  hand at rest and drifts by only a few cm while the gun pitches up. */
const _grc = Math.cos(WEAPON_REST_PITCH), _grs = Math.sin(WEAPON_REST_PITCH);
export const WEAPON_GRIP_DROP: Vec3 = {
  x: WEAPON_GRIP_LOCAL.x,
  y: WEAPON_GRIP_LOCAL.y * _grc - WEAPON_GRIP_LOCAL.z * _grs,
  z: WEAPON_GRIP_LOCAL.y * _grs + WEAPON_GRIP_LOCAL.z * _grc,
};

/** Pure: weapon PIVOT position (unit-local) that puts the right hand on the
 *  grip: the hand minus the grip offset in the rest orientation (the raised
 *  pitch / recoil kick shifts the grip by only a few cm — well inside the
 *  0.12 m hand/grip test tolerance). */
export function weaponPivotLocal(phase: number, aiming: number): Vec3 {
  const hand = rightHandLocal(phase, aiming);
  return {
    x: hand.x - WEAPON_GRIP_DROP.x,
    y: hand.y - WEAPON_GRIP_DROP.y,
    z: hand.z - WEAPON_GRIP_DROP.z,
  };
}

let shared: WeaponShared | null = null;
function ensureShared(): WeaponShared {
  if (shared) return shared;
  shared = {
    // Receiver / body: a slim box along the barrel axis.
    bodyGeo: new THREE.BoxGeometry(0.07, 0.11, 0.42),
    // Barrel: a thin capped cylinder; centred at z 0.38 so its front face
    // ends exactly at z MUZZLE_OFFSET (0.55) — the muzzle.
    barrelGeo: new THREE.CylinderGeometry(0.024, 0.024, 0.34, 8, 1, false),
    // Grip: a small box angled back below the receiver.
    gripGeo: new THREE.BoxGeometry(0.055, 0.15, 0.07),
    // Cold metal tones (slightly blue-grey), matte-to-brushed: visible in the
    // daylight scene but flat enough to stay behind the team colours.
    bodyMat: new THREE.MeshStandardMaterial({ color: 0x99a6b4, metalness: 0.85, roughness: 0.35 }),
    barrelMat: new THREE.MeshStandardMaterial({ color: 0x66707d, metalness: 0.9, roughness: 0.3 }),
    gripMat: new THREE.MeshStandardMaterial({ color: 0x3a434e, metalness: 0.35, roughness: 0.65 }),
  };
  return shared;
}

/** Build one weapon instance (shared geometries + materials). Reusable for
 *  every unit AND the later first-person view model. */
export function makeWeaponMesh(): WeaponMesh {
  const s = ensureShared();
  const group = new THREE.Group();
  group.name = 'weapon';

  const body = new THREE.Mesh(s.bodyGeo, s.bodyMat);
  body.position.set(-0.015, -0.005, 0.16); // receiver, slight right-hand offset

  const barrel = new THREE.Mesh(s.barrelGeo, s.barrelMat);
  barrel.rotation.x = Math.PI / 2; // cylinder axis Y -> Z
  barrel.position.set(0, 0, 0.38); // front face at z 0.55 = the muzzle

  const grip = new THREE.Mesh(s.gripGeo, s.gripMat);
  grip.position.set(0.01, -0.115, -0.03);
  grip.rotation.x = 0.28;

  const tip = new THREE.Object3D();
  tip.name = 'muzzleTip';
  tip.position.set(0, 0, MUZZLE_OFFSET);

  group.add(body, barrel, grip, tip);
  return { group, tip };
}

/** Pivot local rotation (Euler order 'YXZ') that points the weapon at `aim`
 *  (a world aim direction) for a unit with world `unitYaw`, plus the
 *  optional recoil kick. rotation.y is relative to the unit (0 = facing),
 *  rotation.x is the pitch about the (post-yaw) horizontal axis. */
export function weaponAimRot(unitYaw: number, aim: Vec3, recoil: number): { yaw: number; pitch: number } {
  const yaw = wrapAngle(Math.atan2(aim.x, aim.z) - unitYaw);
  const pitch = -Math.asin(clamp(aim.y, -1, 1)) - WEAPON_RECOIL_PITCH * recoil;
  return { yaw, pitch };
}

/** World position of the barrel tip (muzzle-flash anchor) for a unit at
 *  `pos` facing `yaw`, with the weapon pivot at LOCAL `pivotLocal`, aiming
 *  at `aim`, with `recoil` in [0, 1]. Feeding the legacy chest pivot
 *  ({x: 0, y: WEAPON_PIVOT_Y, z: 0}) with recoil 0 is EXACTLY the legacy
 *  muzzle-flash formula: eye + aim*MUZZLE_OFFSET - (0, MUZZLE_DROP, 0).
 *  Pure math (no three.js state) so both the App (flash spawn) and the
 *  Renderer (probe / view model) share one source of truth — and the
 *  renderer feeds the SAME pivot it used for the 3D mesh, so the flash can
 *  never drift from the barrel tip on the moving hand. */
export function weaponMuzzleWorld(
  pos: Vec3,
  yaw: number,
  pivotLocal: Vec3,
  aim: Vec3,
  recoil: number,
): Vec3 {
  const ay = clamp(aim.y, -1, 1);
  const yawW = Math.atan2(aim.x, aim.z);
  const pitch = -Math.asin(ay) - WEAPON_RECOIL_PITCH * recoil; // Rx angle
  const cp = Math.cos(pitch);
  const sy = Math.sin(yawW);
  const cy = Math.cos(yawW);
  // tip direction = Ry(yawW) * Rx(pitch) * (0,0,1)
  const dx = sy * cp;
  const dy = -Math.sin(pitch);
  const dz = cy * cp;
  // pivot world position = rotY(unitYaw) applied to (pos + pivotLocal)
  const su = Math.sin(yaw);
  const cu = Math.cos(yaw);
  const px = pos.x + pivotLocal.x * cu + pivotLocal.z * su;
  const py = pos.y + pivotLocal.y;
  const pz = pos.z - pivotLocal.x * su + pivotLocal.z * cu;
  return {
    x: px + dx * MUZZLE_OFFSET,
    y: py + dy * MUZZLE_OFFSET,
    z: pz + dz * MUZZLE_OFFSET,
  };
}
