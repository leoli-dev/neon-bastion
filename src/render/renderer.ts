// Three.js renderer for Neon Bastion. Owns the WebGL scene, the static arena
// (built from map data), the 8 unit meshes, tracer/spark effects, the camera
// (FPV + spectator), and the 2D canvas minimap. The game logic (Match) is
// driven elsewhere; this class only renders whatever state the Match reports.

import * as THREE from 'three';
import type { Match } from '../game/match';
import type { MapData, Solid, Unit } from '../game/types';
import { NEON_BASTION } from '../game/map/mapData';
import { eyeOf } from '../game/combat/hitscan';

const BLUE = { body: 0x2f7bff, head: 0x9fd0ff, emissive: 0x123a8a };
const RED = { body: 0xff2f5e, head: 0xffc2d0, emissive: 0x7a1226 };

interface UnitVisual {
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
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
  private units: UnitVisual[] = [];
  private tracers: Tracer[] = [];
  private sparks: Spark[] = [];
  private sparkGeo: THREE.BoxGeometry;
  private minimap: CanvasRenderingContext2D;
  private minimapSize: number;
  private freeCamAngle = 0;

  constructor(canvas: HTMLCanvasElement, minimapCanvas: HTMLCanvasElement, map: MapData = NEON_BASTION) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060a);
    this.scene.fog = new THREE.Fog(0x05060a, 22, 72);

    this.camera = new THREE.PerspectiveCamera(78, 16 / 9, 0.1, 300);
    this.camera.position.set(0, 1.6, 27);

    this.minimap = minimapCanvas.getContext('2d')!;
    this.minimapSize = minimapCanvas.width;
    this.sparkGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);

    this.buildLights();
    this.buildArena(map);
    this.buildTracerPool(40);
    this.buildSparkPool(48);
    this.resize();
  }

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight(0x3a4a7a, 0x0a0a12, 0.85));
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(12, 24, 10);
    this.scene.add(dir);
    const blueLight = new THREE.PointLight(0x2f7bff, 220, 60, 2);
    blueLight.position.set(0, 8, 26);
    this.scene.add(blueLight);
    const redLight = new THREE.PointLight(0xff2f5e, 220, 60, 2);
    redLight.position.set(0, 8, -26);
    this.scene.add(redLight);
  }

  private solidMaterial(s: Solid): THREE.MeshStandardMaterial {
    let color = 0x1a2233;
    let emissive = 0x000000;
    let emissiveIntensity = 0;
    switch (s.kind) {
      case 'boundary': color = 0x11141e; break;
      case 'wall': color = 0x1c2438; break;
      case 'cover': color = 0x262f45; break;
      case 'platform': color = 0x2b3a5e; emissive = 0x112a55; emissiveIntensity = 0.5; break;
      case 'ramp': color = 0x232c42; break;
      case 'spawn': color = 0x2a2a3a; emissive = 0x101018; emissiveIntensity = 0.4; break;
    }
    return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.15, emissive, emissiveIntensity });
  }

  private buildArena(map: MapData): void {
    // Ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: 0x090b12, roughness: 1, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(64, 32, 0x274a86, 0x141d33);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    grid.position.y = 0.02;
    this.scene.add(grid);

    // Solids
    const edgeGeoCache = new Map<string, THREE.EdgesGeometry>();
    for (const s of map.solids) {
      const h = Math.max(0.05, s.top - s.bottom);
      const geo = new THREE.BoxGeometry(s.sx, h, s.sz);
      const mesh = new THREE.Mesh(geo, this.solidMaterial(s));
      mesh.position.set(s.x, s.bottom + h / 2, s.z);
      this.scene.add(mesh);

      const key = `${s.sx}|${h}|${s.sz}`;
      let edges = edgeGeoCache.get(key);
      if (!edges) {
        edges = new THREE.EdgesGeometry(geo);
        edgeGeoCache.set(key, edges);
      }
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: s.kind === 'platform' ? 0x3fa9ff : 0x2a3a5a, transparent: true, opacity: 0.5 })
      );
      line.position.copy(mesh.position);
      this.scene.add(line);
    }
  }

  /** Create the 8 unit visuals (blue 0-3, red 4-7). Call once at start. */
  buildUnits(units: Unit[]): void {
    for (const u of units) {
      const palette = u.team === 'blue' ? BLUE : RED;
      const bodyMat = new THREE.MeshStandardMaterial({
        color: palette.body, emissive: palette.emissive, emissiveIntensity: 0.6, roughness: 0.5, metalness: 0.2
      });
      const headMat = new THREE.MeshStandardMaterial({
        color: palette.head, emissive: palette.emissive, emissiveIntensity: 0.4, roughness: 0.4, metalness: 0.2
      });
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 0.8), bodyMat);
      body.position.y = 0.5;
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.4, 0.44), headMat);
      head.position.y = 1.28;
      const group = new THREE.Group();
      group.add(body);
      group.add(head);
      this.scene.add(group);
      this.units.push({ group, body, head, team: u.team, bodyMat, headMat });
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
      this.tracers.push({ line, mat, life: 0, max: 0.1 });
    }
  }

  private buildSparkPool(n: number): void {
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending });
      const mesh = new THREE.Mesh(this.sparkGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.sparks.push({ mesh, mat, life: 0, max: 0.25, vel: new THREE.Vector3() });
    }
  }

  private tracerCursor = 0;
  spawnTracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const t = this.tracers[this.tracerCursor++ % this.tracers.length];
    const attr = t.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(0, from.x, from.y, from.z);
    attr.setXYZ(1, to.x, to.y, to.z);
    attr.needsUpdate = true;
    t.life = t.max = 0.09;
    t.mat.color.setHex(0xffe08a);
    t.line.visible = true;
  }

  private sparkCursor = 0;
  spawnHitSpark(point: THREE.Vector3, head: boolean): void {
    const n = head ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const s = this.sparks[this.sparkCursor++ % this.sparks.length];
      s.mesh.position.copy(point);
      s.mat.color.setHex(head ? 0xff5a5a : 0xffd24a);
      s.life = s.max = 0.22;
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
      // A corpse lies down and dims; a live unit stands.
      if (dead) {
        v.group.rotation.z = Math.PI / 2;
        v.group.position.y = u.pos.y + 0.3;
        v.bodyMat.emissiveIntensity = 0.05;
        v.headMat.emissiveIntensity = 0.05;
      } else {
        v.group.rotation.z = 0;
        const flashing = u.flashUntil > now;
        v.bodyMat.emissiveIntensity = flashing ? 1.6 : 0.6;
        v.headMat.emissiveIntensity = flashing ? 1.4 : 0.4;
      }
      // The player's own body is hidden while in first person.
      const isPlayer = u.isPlayer;
      const fpv = match.spectate.mode === 'alive';
      v.group.visible = !isPlayer || !fpv;
    }

    this.updateCamera(match, dt);

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

  private updateCamera(match: Match, dt: number): void {
    const p = match.player;
    const mode = match.spectate.mode;
    if (mode === 'alive' && p.alive) {
      const eye = eyeOf(p);
      this.camera.position.set(eye.x, eye.y, eye.z);
      const cp = Math.cos(p.pitch);
      this.camera.lookAt(
        eye.x + Math.sin(p.yaw) * cp,
        eye.y + Math.sin(p.pitch),
        eye.z + Math.cos(p.yaw) * cp
      );
    } else {
      const targetId = match.spectate.targetId;
      let focus: THREE.Vector3 | null = null;
      if (mode === 'ally' && targetId != null) {
        const t = match.units.find((u) => u.id === targetId);
        if (t && t.alive) focus = new THREE.Vector3(t.pos.x, t.pos.y + 1.4, t.pos.z);
      }
      if (focus) {
        // Chase cam: offset behind/above the ally along a slowly drifting angle.
        this.freeCamAngle += dt * 0.25;
        const r = 6;
        const cx = focus.x + Math.sin(this.freeCamAngle) * r;
        const cz = focus.z + Math.cos(this.freeCamAngle) * r;
        this.camera.position.lerp(new THREE.Vector3(cx, focus.y + 3.2, cz), 0.15);
        this.camera.lookAt(focus);
      } else {
        // Free cam: high orbit over the arena centre.
        this.freeCamAngle += dt * 0.12;
        const r = 26;
        const cx = Math.sin(this.freeCamAngle) * r;
        const cz = Math.cos(this.freeCamAngle) * r;
        this.camera.position.lerp(new THREE.Vector3(cx, 24, cz), 0.05);
        this.camera.lookAt(0, 0, 0);
      }
    }
  }

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
    ctx.fillStyle = 'rgba(6,8,14,0.85)';
    ctx.fillRect(0, 0, S, S);
    // Solids
    ctx.fillStyle = 'rgba(90,120,180,0.5)';
    for (const s of this.map.solids) {
      ctx.fillRect(px(s.x - s.sx / 2), pz(s.z - s.sz / 2), Math.max(1, s.sx * scale), Math.max(1, s.sz * scale));
    }
    // Units
    for (const u of match.units) {
      if (!u.alive) continue;
      ctx.fillStyle = u.team === 'blue' ? '#3fa9ff' : '#ff4d6d';
      const r = u.isPlayer ? 4 : 3;
      ctx.beginPath();
      ctx.arc(px(u.pos.x), pz(u.pos.z), r, 0, Math.PI * 2);
      ctx.fill();
      if (u.isPlayer) {
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
