// Three.js renderer for Neon Bastion. Owns the WebGL scene, the static arena
// (built from map data), the 8 unit meshes + ground team-rings, tracer/spark
// effects, the camera (FPV + spectator), and the 2D canvas minimap. The game
// logic (Match) is driven elsewhere; this class only renders whatever state the
// Match reports.
//
// Visual direction (see design review): saturation is reserved for *people*
// and *hit feedback*. The arena itself is built from lightness steps in a
// near-neutral grey so a bright cyan or magenta silhouette always reads as "a
// unit". Blue team is pushed to cyan to separate it from the cool concrete;
// red team is a hot magenta-red. Warm sodium lamps + an ACES tonemap give the
// scene layered, cinematic darkness instead of a flat grey.

import * as THREE from 'three';
import type { Match } from '../game/match';
import type { MapData, Solid, Unit, Vec3 } from '../game/types';
import { NEON_BASTION } from '../game/map/mapData';
import { CONFIG } from '../game/constants';
import { MAX_BULLETS } from '../game/combat/bullet';
import { eyeOf } from '../game/combat/hitscan';

// Team identity colours. Cyan blue vs magenta red: ~158° apart on the hue
// wheel, both fully saturated, sitting on a desaturated ~210°/8% environment.
const BLUE = { body: 0x18e0ff, head: 0xb8f6ff, emissive: 0x0a6e8c, ring: 0x18e0ff };
const RED = { body: 0xff3d63, head: 0xffc9d4, emissive: 0x8a1530, ring: 0xff3d63 };

// Arena palette: pure lightness steps, no hue. Each class is ~1.5x brighter
// than the one before it, so cover (the thing you judge in a split second) is
// the brightest architecture and the boundary recedes into the background.
const ENV = {
  background: 0x05070b,
  ground: 0x0a0d13,
  boundary: 0x0e1013,
  // ART-03: raised from 0x1a1d22 (~11% lightness, unreadable in real play).
  wall: 0x23272e,
  ramp: 0x2a2f36,
  platform: 0x333a44,
  spawn: 0x14181f,
  gridA: 0x2a3038,
  gridB: 0x171b22,
  edgeNeutral: 0x2a3a5a,
  edgePlatform: 0x3fa9ff,
};

interface UnitVisual {
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  ring: THREE.Mesh;
  team: 'blue' | 'red';
  bodyMat: THREE.MeshStandardMaterial;
  headMat: THREE.MeshStandardMaterial;
}

interface Tracer {
  line: THREE.Line;
  mat: THREE.LineBasicMaterial;
  life: number;
  max: number;
}

interface BulletTrail {
  line: THREE.Line;
  mat: THREE.LineBasicMaterial;
}

interface Muzzle {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  max: number;
}

interface Spark {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  max: number;
  vel: THREE.Vector3;
}

export class Renderer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private map: MapData;
  /** Static arena solids for the CURRENT map (rebuildable via setMap, MAP-04). */
  private arenaGroup: THREE.Group;
  private units: UnitVisual[] = [];
  private tracers: Tracer[] = [];
  private bulletTrails: BulletTrail[] = [];
  private muzzles: Muzzle[] = [];
  private sparks: Spark[] = [];
  private sparkGeo: THREE.BoxGeometry;
  private muzzleGeo: THREE.SphereGeometry;
  private minimap: CanvasRenderingContext2D;
  private minimapSize: number;
  private freeCamAngle = 0;
  private reducedMotion = false;
  private fovCurrent = CONFIG.fovBase;
  private bobPhase = 0;
  private bobAmp = 0;
  // Camera kick (on being hit) and firing recoil: offsets applied on top of
  // the player's pitch/yaw, each decaying back to zero on its own.
  private kickYaw = 0;
  private kickPitch = 0;
  private recoilCharge = 0; // accumulated by shots while the trigger is down
  private recoilShown = 0;  // the eased pitch offset actually applied to the cam

  constructor(canvas: HTMLCanvasElement, minimapCanvas: HTMLCanvasElement, map: MapData = NEON_BASTION) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // ACES filmic tonemap + sRGB output: the single biggest reason the previous
    // build read as a "flat grey dark" instead of a "layered dark".
    // ART-03: exposure raised 1.15 -> 1.5 — the palette's lightness steps alone
    // did not set a brightness floor, so real play was unreadably dark.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.5;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(ENV.background);
    // The arena is only ~64 units wide; fogging at 22m smeared the whole
    // firefight. Push it back so depth is a subtle cue, not a blur.
    this.scene.fog = new THREE.Fog(ENV.background, 38, 95);

    this.camera = new THREE.PerspectiveCamera(CONFIG.fovBase, 16 / 9, 0.1, 300);
    this.camera.position.set(0, 1.6, 27);

    this.minimap = minimapCanvas.getContext('2d')!;
    this.minimapSize = minimapCanvas.width;
    this.sparkGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
    this.muzzleGeo = new THREE.SphereGeometry(0.1, 8, 8);

    this.buildLights();
    this.arenaGroup = new THREE.Group();
    this.scene.add(this.arenaGroup);
    this.buildArena(map);
    this.buildTracerPool(40);
    this.buildBulletTrailPool(MAX_BULLETS);
    this.buildMuzzlePool(12);
    this.buildSparkPool(48);
    this.resize();
  }

  /** Honours prefers-reduced-motion: no tracers, fewer sparks, static cameras. */
  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  /** Firing recoil: each shot adds `amount` of pitch-up. The charge persists
   *  while firing and eases back to zero after the trigger is released.
   *  No-op under reduced-motion (camera movement is exactly what it targets). */
  addRecoil(amount: number): void {
    if (this.reducedMotion) return;
    this.recoilCharge = Math.min(this.recoilCharge + amount, 0.12);
  }

  /** Impact kick from being hit: an immediate pitch/yaw jolt that snaps back
   *  to zero within ~150 ms. No-op under reduced-motion. */
  applyHitKick(yawOffset: number, pitchOffset: number): void {
    if (this.reducedMotion) return;
    const k = Math.exp(-0.02 * 10); // keep the kick bounded across rapid hits
    this.kickYaw = this.kickYaw * k + yawOffset;
    this.kickPitch = this.kickPitch * k + pitchOffset;
  }

  /** Current camera kick/recoil offsets — test hooks read this to assert that
   *  the 'hit' and player-'shot' events actually moved the camera. */
  getCameraKicks(): { kickYaw: number; kickPitch: number; recoil: number; recoilCharge: number } {
    return {
      kickYaw: this.kickYaw,
      kickPitch: this.kickPitch,
      recoil: this.recoilShown,
      recoilCharge: this.recoilCharge,
    };
  }

  private buildLights(): void {
    // Cool sky + WARM ground bounce. The warm floor reflection is what makes
    // concrete read as concrete instead of blue plastic.
    this.scene.add(new THREE.HemisphereLight(0x2a3550, 0x241c14, 0.75));
    // ART-03: a guaranteed brightness floor — no purely black region anywhere
    // in the arena, even where no sodium lamp reaches.
    this.scene.add(new THREE.AmbientLight(0x3a4a6a, 0.25));
    const dir = new THREE.DirectionalLight(0xfff0dd, 0.6);
    dir.position.set(12, 24, 10);
    this.scene.add(dir);

    // Warm sodium lamps at the two maze corners, the two wing mouths and the
    // two central-approach flanks — the "clear light/dark hierarchy at the
    // maze turns" the prompt asks for. ART-03: 4 -> 6 lamps, 150 -> 220.
    const sodium: Array<[number, number]> = [
      [-10, 16],
      [10, 16],
      [23, 0],
      [-23, 0],
      [0, 8],
      [0, -8],
    ];
    for (const [x, z] of sodium) {
      const l = new THREE.PointLight(0xffb45a, 220, 26, 2);
      l.position.set(x, 5.5, z);
      this.scene.add(l);
    }

    // Team spawn glow (identity, kept but restrained under the tonemap).
    const blueLight = new THREE.PointLight(0x18e0ff, 110, 50, 2);
    blueLight.position.set(0, 8, 26);
    this.scene.add(blueLight);
    const redLight = new THREE.PointLight(0xff3d63, 110, 50, 2);
    redLight.position.set(0, 8, -26);
    this.scene.add(redLight);
  }

  /** MAP-01: material is orthogonal to `kind`. `solid` (the default) keeps
   *  the exact legacy per-kind appearance; `hedge` and `glass` override it. */
  private materialFor(s: Solid): THREE.MeshStandardMaterial {
    const mat = s.material ?? 'solid';
    if (mat === 'hedge') {
      // Opaque foliage: saturated plant green, matte (high roughness, zero
      // metalness). A deterministic per-solid perturbation (seeded from the
      // solid id) shifts hue/saturation/lightness slightly so no two hedge
      // walls read as exactly the same green.
      const c = new THREE.Color(0x3f7d3a);
      const hsl = { h: 0, s: 0, l: 0 };
      c.getHSL(hsl);
      const t = (s.id * 0.61803398875) % 1; // golden-ratio hash: stable per id
      c.setHSL(
        (hsl.h + (t - 0.5) * 0.045 + 1) % 1,
        Math.min(1, hsl.s + (t - 0.5) * 0.12),
        Math.min(1, Math.max(0, hsl.l + (t - 0.5) * 0.06)),
      );
      return new THREE.MeshStandardMaterial({ color: c, roughness: 0.95, metalness: 0 });
    }
    if (mat === 'glass') {
      // Faintly cyan-tinted, low roughness, ~22% opaque: a unit on the far
      // side must stay clearly readable through it (verified by the E2E
      // canvas-pixel assertion). No depth write so transparents behind it
      // (team rings, grid) keep blending correctly.
      return new THREE.MeshStandardMaterial({
        color: 0xa8dce8, roughness: 0.08, metalness: 0.1,
        transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide,
      });
    }
    let color = ENV.wall;
    let emissive = 0x000000;
    let emissiveIntensity = 0;
    switch (s.kind) {
      case 'boundary': color = ENV.boundary; break;
      case 'wall': color = ENV.wall; break;
      case 'ramp': color = ENV.ramp; break;
      case 'spawn': color = ENV.spawn; emissive = 0x101018; emissiveIntensity = 0.4; break;
      // The platform is the one building allowed a hue: it is the contested
      // high ground, so it earns a faint cyan glow.
      case 'platform': color = ENV.platform; emissive = 0x16324f; emissiveIntensity = 0.55; break;
    }
    return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.15, emissive, emissiveIntensity });
  }

  /** MAP-04: swap the static arena geometry for a different (seed-generated)
   *  map. The Match and the Renderer must always show the SAME map, or
   *  collisions and pixels disagree. Ground, grid and lights are shared by
   *  all layouts and stay put; only the solid boxes are rebuilt. */
  setMap(map: MapData): void {
    this.map = map;
    for (const child of [...this.arenaGroup.children]) {
      const obj = child as THREE.Mesh;
      obj.geometry?.dispose();
      const mat = obj.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
      this.arenaGroup.remove(child);
    }
    this.buildArenaSolids(map);
  }

  private buildArena(map: MapData): void {
    // Ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: ENV.ground, roughness: 1, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(64, 32, ENV.gridA, ENV.gridB);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.22;
    grid.position.y = 0.02;
    this.scene.add(grid);

    this.buildArenaSolids(map);
  }

  /** The solid boxes of one map (into arenaGroup so setMap can rebuild it). */
  private buildArenaSolids(map: MapData): void {
    // Solids
    const edgeGeoCache = new Map<string, THREE.EdgesGeometry>();
    for (const s of map.solids) {
      const h = Math.max(0.05, s.top - s.bottom);
      const geo = new THREE.BoxGeometry(s.sx, h, s.sz);
      const mesh = new THREE.Mesh(geo, this.materialFor(s));
      mesh.position.set(s.x, s.bottom + h / 2, s.z);
      this.arenaGroup.add(mesh);

      const key = `${s.sx}|${h}|${s.sz}`;
      let edges = edgeGeoCache.get(key);
      if (!edges) {
        edges = new THREE.EdgesGeometry(geo);
        edgeGeoCache.set(key, edges);
      }
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: s.kind === 'platform' ? ENV.edgePlatform : ENV.edgeNeutral, transparent: true, opacity: s.kind === 'platform' ? 0.55 : 0.35 })
      );
      line.position.copy(mesh.position);
      this.arenaGroup.add(line);
    }
  }

  /** Create the 8 unit visuals (blue 0-3, red 4-7) + ground team rings. */
  buildUnits(units: Unit[]): void {
    const ringGeo = new THREE.RingGeometry(0.34, 0.5, 28);
    for (const u of units) {
      const palette = u.team === 'blue' ? BLUE : RED;
      const bodyMat = new THREE.MeshStandardMaterial({
        color: palette.body, emissive: palette.emissive, emissiveIntensity: 0.7, roughness: 0.5, metalness: 0.2
      });
      const headMat = new THREE.MeshStandardMaterial({
        color: palette.head, emissive: palette.emissive, emissiveIntensity: 0.45, roughness: 0.4, metalness: 0.2
      });
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 0.8), bodyMat);
      body.position.y = 0.5;
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.4, 0.44), headMat);
      head.position.y = 1.28;
      const group = new THREE.Group();
      group.add(body);
      group.add(head);
      this.scene.add(group);

      // Ground team-colour ring: an additive flat circle that stays visible
      // when a low-poly body is partially occluded by cover — the "non-UI"
      // team cue the prompt asks for.
      const ringMat = new THREE.MeshBasicMaterial({
        color: palette.ring, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      this.scene.add(ring);

      this.units.push({ group, body, head, ring, team: u.team, bodyMat, headMat });
    }
  }

  private buildTracerPool(n: number): void {
    for (let i = 0; i < n; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.visible = false;
      this.scene.add(line);
      this.tracers.push({ line, mat, life: 0, max: CONFIG.tracerLife });
    }
  }

  /** One trail slot per pooled bullet (see combat/bullet.ts). Unlike the old
   *  fire-time tracer (muzzle -> impact, drawn as one full line at the moment
   *  of firing), the trail is re-positioned EVERY FRAME on the bullet's
   *  CURRENT position — a short streak that follows the projectile, so the
   *  player can see a bullet coming AT them from a specific direction. */
  private buildBulletTrailPool(n: number): void {
    for (let i = 0; i < n; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.visible = false;
      this.scene.add(line);
      this.bulletTrails.push({ line, mat });
    }
  }

  private buildMuzzlePool(n: number): void {
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.Mesh(this.muzzleGeo, mat);
      mesh.visible = false;
      mesh.scale.setScalar(0.001);
      this.scene.add(mesh);
      this.muzzles.push({ mesh, mat, life: 0, max: CONFIG.muzzleLife });
    }
  }

  private buildSparkPool(n: number): void {
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending });
      const mesh = new THREE.Mesh(this.sparkGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.sparks.push({ mesh, mat, life: 0, max: CONFIG.sparkLife, vel: new THREE.Vector3() });
    }
  }

  private tracerCursor = 0;
  spawnTracer(from: THREE.Vector3, to: THREE.Vector3): void {
    if (this.reducedMotion) return;
    const t = this.tracers[this.tracerCursor++ % this.tracers.length];
    const attr = t.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(0, from.x, from.y, from.z);
    attr.setXYZ(1, to.x, to.y, to.z);
    attr.needsUpdate = true;
    // FX-01: 0.09s (~5 frames) sat at the edge of perception; CONFIG.tracerLife
    // (0.18s, ~11 frames) is the single source of truth.
    t.life = t.max = CONFIG.tracerLife;
    t.mat.color.setHex(0xffe08a);
    t.line.visible = true;
  }

  private muzzleCursor = 0;
  /** FX-01: the muzzle flash — a short additive gold sphere at the muzzle. */
  spawnMuzzleFlash(at: THREE.Vector3): void {
    if (this.reducedMotion) return;
    const m = this.muzzles[this.muzzleCursor++ % this.muzzles.length];
    m.mesh.position.copy(at);
    m.life = m.max = CONFIG.muzzleLife;
    m.mesh.scale.setScalar(0.6);
    m.mat.color.setHex(0xffd24a);
    m.mesh.visible = true;
  }

  private sparkCursor = 0;
  /** FX-01: impact sparks for unit hits AND wall hits (walls used to get none). */
  spawnHitSpark(point: THREE.Vector3, kind: 'head' | 'body' | 'wall'): void {
    if (kind === 'wall') {
      // cool, neutral shards — distinct from the warm unit-hit feedback
      const n = 4 * (this.reducedMotion ? 0.5 : 1);
      for (let i = 0; i < n; i++) {
        const s = this.sparks[this.sparkCursor++ % this.sparks.length];
        s.mesh.position.copy(point);
        s.mat.color.setHex(0x9fb4d8);
        s.life = s.max = CONFIG.sparkLife;
        s.vel.set((Math.random() - 0.5) * 5, Math.random() * 4, (Math.random() - 0.5) * 5);
        s.mesh.visible = true;
      }
      return;
    }
    const n = (kind === 'head' ? 5 : 3) * (this.reducedMotion ? 0.5 : 1);
    for (let i = 0; i < n; i++) {
      const s = this.sparks[this.sparkCursor++ % this.sparks.length];
      s.mesh.position.copy(point);
      s.mat.color.setHex(kind === 'head' ? 0xffd24a : 0xff5a5a);
      s.life = s.max = this.reducedMotion ? CONFIG.sparkLife * 0.5 : CONFIG.sparkLife;
      s.vel.set((Math.random() - 0.5) * 6, Math.random() * 5, (Math.random() - 0.5) * 6);
      s.mesh.visible = true;
    }
  }

  /** Advance rendering state by one frame and draw. */
  update(match: Match, dt: number): void {
    const now = match.now;
    // Units
    for (let i = 0; i < match.units.length && i < this.units.length; i++) {
      const u = match.units[i];
      const v = this.units[i];
      v.group.position.set(u.pos.x, u.pos.y, u.pos.z);
      v.group.rotation.y = u.yaw;
      const dead = !u.alive;
      // A corpse lies down and dims; a live unit stands and keeps its ground ring.
      if (dead) {
        v.group.rotation.z = Math.PI / 2;
        v.group.position.y = u.pos.y + 0.3;
        v.bodyMat.emissiveIntensity = 0.05;
        v.headMat.emissiveIntensity = 0.05;
        v.ring.visible = false;
      } else {
        v.group.rotation.z = 0;
        const flashing = u.flashUntil > now;
        v.bodyMat.emissiveIntensity = flashing ? 1.9 : 0.7;
        v.headMat.emissiveIntensity = flashing ? 1.6 : 0.45;
        v.ring.visible = true;
        v.ring.position.set(u.pos.x, u.pos.y + 0.06, u.pos.z);
        // Ring sits at the feet even on the platform (u.pos.y already carries height).
      }
      // The player's own body is hidden while in first person (but its ring shows).
      const isPlayer = u.isPlayer;
      const fpv = match.spectate.mode === 'alive';
      v.group.visible = !isPlayer || !fpv;
      if (isPlayer) v.ring.visible = !fpv && !dead;
    }

    this.updateCamera(match, dt);

    // Bullet trails: one short streak per in-flight bullet, tracking its live
    // position each frame (the bullet itself is stepped by the Match).
    const trailLen = CONFIG.bulletTrail;
    for (let i = 0; i < this.bulletTrails.length; i++) {
      const t = this.bulletTrails[i];
      const b = match.bullets.bullets[i];
      if (b && b.active) {
        const attr = t.line.geometry.getAttribute('position') as THREE.BufferAttribute;
        attr.setXYZ(0, b.pos.x - b.dir.x * trailLen, b.pos.y - b.dir.y * trailLen, b.pos.z - b.dir.z * trailLen);
        attr.setXYZ(1, b.pos.x, b.pos.y, b.pos.z);
        attr.needsUpdate = true;
        t.mat.opacity = 0.9;
        t.line.visible = true;
      } else {
        t.mat.opacity = 0;
        t.line.visible = false;
      }
    }

    // Tracers
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.line.visible = false;
        t.mat.opacity = 0;
      } else {
        t.mat.opacity = t.life / t.max;
      }
    }
    // Muzzle flashes: expand + fade over their short life.
    for (const m of this.muzzles) {
      if (m.life <= 0) continue;
      m.life -= dt;
      if (m.life <= 0) {
        m.mesh.visible = false;
        m.mat.opacity = 0;
      } else {
        const k = m.life / m.max; // 1 -> 0
        m.mat.opacity = k;
        m.mesh.scale.setScalar(0.6 + (1 - k) * 1.4);
      }
    }
    // Sparks
    for (const s of this.sparks) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.mesh.visible = false;
        s.mat.opacity = 0;
      } else {
        s.mesh.position.addScaledVector(s.vel, dt);
        s.vel.y -= 12 * dt;
        s.mat.opacity = s.life / s.max;
      }
    }

    this.drawMinimap(match);
    this.renderer.render(this.scene, this.camera);
  }

  /** Number of live effects — feeds the debug panel's "active particles". */
  getStats(): { activeParticles: number; activeTracers: number } {
    let parts = 0;
    let tracers = 0;
    for (const s of this.sparks) if (s.life > 0) parts++;
    for (const m of this.muzzles) if (m.life > 0) parts++;
    for (const t of this.tracers) if (t.life > 0) tracers++;
    return { activeParticles: parts + tracers, activeTracers: tracers };
  }

  /** Project a world point to CSS pixels (for floating damage numbers). */
  screenFromWorld(p: Vec3): { x: number; y: number; behind: boolean } {
    const v = new THREE.Vector3(p.x, p.y, p.z);
    v.project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
      behind: v.z > 1,
    };
  }

  private updateCamera(match: Match, dt: number): void {
    // Kick/recoil decay always runs (even while spectating) so a stale offset
    // can never survive into a respawn or a chase cam.
    if (!match.playerInput.fire) this.recoilCharge *= Math.exp(-dt * 6); // half-life ~115 ms
    this.recoilShown += (this.recoilCharge - this.recoilShown) * Math.min(1, dt * 16);
    const kickDecay = Math.exp(-dt * 10); // half-life ~70 ms: a fast snap-back
    this.kickYaw *= kickDecay;
    this.kickPitch *= kickDecay;

    const p = match.player;
    const mode = match.spectate.mode;
    if (mode === 'alive' && p.alive) {
      const eye = eyeOf(p);
      // Effective view angles = the player's own aim + recoil pitch-up +
      // impact kick (the kick is applied here, not to p.yaw/p.pitch, so the
      // simulation state is never contaminated by a camera effect).
      const yaw = p.yaw + this.kickYaw;
      const pitch = Math.min(1.35, Math.max(-1.35, p.pitch + this.recoilShown + this.kickPitch));
      const cp = Math.cos(pitch);
      const fx = Math.sin(yaw) * cp;
      const fy = Math.sin(pitch);
      const fz = Math.cos(yaw) * cp;

      // Sprint feedback: smooth FOV push (78° -> 85°) + a subtle head bob so
      // the 1.56× speed is *felt*, not just in the sim. Disabled under
      // reduced-motion (both are camera motion).
      const sprinting = !this.reducedMotion && match.playerInput.sprint && p.grounded;
      const fovTarget = sprinting ? CONFIG.sprintFov : CONFIG.fovBase;
      this.fovCurrent += (fovTarget - this.fovCurrent) * Math.min(1, dt * 6);
      if (Math.abs(this.camera.fov - this.fovCurrent) > 0.01) {
        this.camera.fov = this.fovCurrent;
        this.camera.updateProjectionMatrix();
      }
      this.bobAmp += ((sprinting ? CONFIG.bobAmplitude : 0) - this.bobAmp) * Math.min(1, dt * 8);
      if (this.bobAmp > 1e-4) this.bobPhase += dt * CONFIG.bobFrequency;
      const bobY = Math.sin(this.bobPhase) * this.bobAmp;
      const bobF = Math.cos(this.bobPhase * 2) * this.bobAmp * 0.6;

      const ox = eye.x + fx * bobF;
      const oy = eye.y + bobY;
      const oz = eye.z + fz * bobF;
      this.camera.position.set(ox, oy, oz);
      this.camera.lookAt(ox + fx, oy + fy, oz + fz);
    } else {
      const targetId = match.spectate.targetId;
      let focus: THREE.Vector3 | null = null;
      if (mode === 'ally' && targetId != null) {
        const t = match.units.find((u) => u.id === targetId);
        if (t && t.alive) focus = new THREE.Vector3(t.pos.x, t.pos.y + 1.4, t.pos.z);
      }
      if (focus) {
        // Chase cam: offset behind/above the ally along a slowly drifting angle
        // (frozen under reduced-motion so the camera does not orbit).
        if (!this.reducedMotion) this.freeCamAngle += dt * 0.25;
        const r = 6;
        const cx = focus.x + Math.sin(this.freeCamAngle) * r;
        const cz = focus.z + Math.cos(this.freeCamAngle) * r;
        this.camera.position.lerp(new THREE.Vector3(cx, focus.y + 3.2, cz), 0.15);
        this.camera.lookAt(focus);
      } else {
        // Free cam: high orbit over the arena centre (static under reduced-motion).
        if (!this.reducedMotion) this.freeCamAngle += dt * 0.12;
        const r = 26;
        const cx = Math.sin(this.freeCamAngle) * r;
        const cz = Math.cos(this.freeCamAngle) * r;
        this.camera.position.lerp(new THREE.Vector3(cx, 24, cz), 0.05);
        this.camera.lookAt(0, 0, 0);
      }
    }
  }

  // ------------------------------------------------------------------ minimap
  // Rendered as a "bastion blueprint": near-black field, thin structural lines,
  // two spawn wedges, live units as filled dots and the fallen as hollow rings.
  private drawMinimap(match: Match): void {
    const ctx = this.minimap;
    const S = this.minimapSize;
    const b = this.map.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    const scale = (S * 0.92) / span;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const px = (x: number) => (x - cx) * scale + S / 2;
    const pz = (z: number) => (z - cz) * scale + S / 2;

    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#0a0d12';
    ctx.fillRect(0, 0, S, S);

    // Spawn wedges (12% team colour) — blue south, red north.
    ctx.fillStyle = 'rgba(24,224,255,0.14)';
    ctx.fillRect(px(-12), pz(20), 24 * scale, (b.maxZ - 20) * scale);
    ctx.fillStyle = 'rgba(255,61,99,0.14)';
    ctx.fillRect(px(-12), pz(b.minZ), 24 * scale, (20 - b.minZ) * scale);

    // Structural lines (1px) instead of filled blocks: the "blueprint" read.
    ctx.strokeStyle = '#2a3a5a';
    ctx.lineWidth = 1;
    for (const s of this.map.solids) {
      const x = px(s.x - s.sx / 2);
      const y = pz(s.z - s.sz / 2);
      const w = Math.max(1.5, s.sx * scale);
      const h = Math.max(1.5, s.sz * scale);
      if (s.kind === 'platform') {
        ctx.fillStyle = 'rgba(63,169,255,0.16)';
        ctx.fillRect(x, y, w, h);
      }
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }

    // Units: alive = filled dot, dead = hollow ring. Player gets a white ring.
    for (const u of match.units) {
      const x = px(u.pos.x);
      const y = pz(u.pos.z);
      const col = u.team === 'blue' ? '#18e0ff' : '#ff3d63';
      ctx.beginPath();
      ctx.arc(x, y, u.isPlayer ? 4 : 3, 0, Math.PI * 2);
      if (u.alive) {
        ctx.fillStyle = col;
        ctx.fill();
      } else {
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (u.isPlayer && u.alive) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
