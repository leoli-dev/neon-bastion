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
// formula, `weaponMuzzleWorld(pos, yaw, aim, 0)` reproduces the legacy
// formula to machine precision for ANY aim direction (including steep
// pitch) — the flash spawns at the actual barrel tip instead of a second,
// independent calculation.

import * as THREE from 'three';
import type { Vec3 } from '../game/types';

/** Metres along the shot direction from the shooter's eye to the muzzle.
 *  Shared FX offset (previously a private app.ts constant). */
export const MUZZLE_OFFSET = 0.55;
/** Metres the muzzle sits below eye level in the muzzle-flash formula. */
export const MUZZLE_DROP = 0.12;
/** Weapon pivot height above the feet: CONFIG.eyeHeight (1.62) - MUZZLE_DROP
 *  (0.12) = 1.50. Chest level — the gun reads as "held across the chest",
 *  raised to eye level when aiming. */
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

/** World position of the barrel tip for a unit at `pos` facing `yaw`, aiming
 *  at `aim`, with `recoil` in [0, 1]. At recoil 0 this is EXACTLY the legacy
 *  muzzle-flash formula: eye + aim*MUZZLE_OFFSET - (0, MUZZLE_DROP, 0).
 *  Pure math (no three.js state) so both the App (flash spawn) and the
 *  Renderer (probe / view model) share one source of truth. */
export function weaponMuzzleWorld(pos: Vec3, yaw: number, aim: Vec3, recoil: number): Vec3 {
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
  // pivot offset = Ry(yaw) * (0, WEAPON_PIVOT_Y, -RECOIL_TRAVEL*recoil)
  const pull = -WEAPON_RECOIL_TRAVEL * recoil;
  const su = Math.sin(yaw);
  const cu = Math.cos(yaw);
  return {
    x: pos.x + pull * su + dx * MUZZLE_OFFSET,
    y: pos.y + WEAPON_PIVOT_Y + dy * MUZZLE_OFFSET,
    z: pos.z + pull * cu + dz * MUZZLE_OFFSET,
  };
}
