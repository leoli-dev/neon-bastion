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
// red team is a hot magenta-red. ART-06 moved the scene to DAYLIGHT: a warm
// sandy ground gives the frame a bright background, a directional sun +
// sky-coloured hemisphere light do the illumination, and the ACES tonemap now
// works on a scene that actually has highlights instead of masking a black
// arena.

import * as THREE from 'three';
import type { Match } from '../game/match';
import type { MapData, Solid, Unit, Vec3 } from '../game/types';
import { NEON_BASTION } from '../game/map/mapData';
import { CONFIG } from '../game/constants';
import { MAX_BULLETS } from '../game/combat/bullet';
import { eyeOf } from '../game/combat/hitscan';
import { sharedViewCanSee } from '../game/ai/aiPerception';

// Team identity colours. Cyan blue vs magenta red: ~158° apart on the hue
// wheel, both fully saturated, sitting on a desaturated ~210°/8% environment.
const BLUE = { body: 0x18e0ff, head: 0xb8f6ff, emissive: 0x0a6e8c, ring: 0x18e0ff };
const RED = { body: 0xff3d63, head: 0xffc9d4, emissive: 0x8a1530, ring: 0xff3d63 };

// FX-04: tracers and bullet trails used to be THREE.Line + LineBasicMaterial,
// but WebGL rasterizes line primitives at 1 px on virtually every platform
// (linewidth is ignored — a documented Three.js/WebGL limitation), so no
// opacity/length knob could ever make the ballistic visible as more than a
// hairline. They are now thin two-layer CYLINDERS (diameter =
// CONFIG.bulletTrailWidth, aligned with the flight direction via a
// quaternion): a bright inner core and a wide, faint halo of the same warm
// gold, so the centre reads hot and the edge stays soft instead of a solid
// bar. Cylinders were chosen over camera-facing billboards because they keep
// real thickness from every viewing angle — including dead-on (a billboard
// streak degenerates to nothing exactly when a bullet flies at you) — and
// cost no per-frame camera-matrix math.
const TRAIL_UP = new THREE.Vector3(0, 1, 0); // cylinder axis before alignment
const TRAIL_CORE_OPACITY = 0.95; // bright core
const TRAIL_HALO_OPACITY = 0.35; // soft edge
const TRAIL_HALO_MULT = 2.2; // halo diameter / core diameter

// Arena palette: pure lightness steps, no hue. Each class is ~1.5x brighter
// than the one before it, so cover (the thing you judge in a split second) is
// the brightest architecture and the boundary recedes into the background.
const ENV = {
  // ART-05: procedural sky palette. The horizon colour doubles as the fog
  // colour so far geometry fades into the sky instead of a black void.
  skyZenith: 0x1c4f9e,
  skyHorizon: 0xbcd9f2,
  // ART-06: warm daylight sand — the bright background the dark night-lit
  // build never had. Grain/brightness perturbation is painted into a
  // procedural texture (see makeSandTexture) so the floor is not a flat fill.
  ground: 0xd9c08a,
  // ART-07: the boundary was the night-era near-black 0x0e1013, which drew a
  // dark horizon band across the blue-sky/sand daylight scene. Now a neutral
  // light grey-beige: clearly darker than the sand, neutral (NOT the hedge
  // green) so the four wall classes still read as lightness steps, yet far
  // too bright to pass for the void it used to be — the 4 m wall shape +
  // edge lines keep the "impassable" read.
  boundary: 0x97917f,
  // ART-03: raised from 0x1a1d22 (~11% lightness, unreadable in real play).
  wall: 0x23272e,
  ramp: 0x2a2f36,
  platform: 0x333a44,
  spawn: 0x14181f,
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
  core: THREE.Mesh;
  halo: THREE.Mesh;
  coreMat: THREE.MeshBasicMaterial;
  haloMat: THREE.MeshBasicMaterial;
  life: number;
  max: number;
}

interface BulletTrail {
  core: THREE.Mesh;
  halo: THREE.Mesh;
  coreMat: THREE.MeshBasicMaterial;
  haloMat: THREE.MeshBasicMaterial;
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
  /** ART-05 sky dome (hidden temporarily by the FX-04 probe). */
  private sky!: THREE.Mesh;
  private units: UnitVisual[] = [];
  private tracers: Tracer[] = [];
  private bulletTrails: BulletTrail[] = [];
  private muzzles: Muzzle[] = [];
  private sparks: Spark[] = [];
  private sparkGeo: THREE.BoxGeometry;
  private muzzleGeo: THREE.SphereGeometry;
  /** FX-04: shared unit trail geometry — a cylinder of diameter 1 and
   *  height 1 along +Y, capped. Each pooled slot scales it to
   *  (width, length, width) and aligns its Y axis with the flight
   *  direction; one geometry serves every tracer/trail (object pooling). */
  private trailGeo: THREE.CylinderGeometry;
  /** Scratch vectors for the quaternion alignment (no per-frame allocs). */
  private tmpDir = new THREE.Vector3();
  private tmpQuat = new THREE.Quaternion();
  private minimap: CanvasRenderingContext2D;
  private minimapSize: number;
  // ART-05: drifting cloud sprites (procedural canvas texture, no assets).
  private cloudGroup = new THREE.Group();
  private clouds: Array<{ sprite: THREE.Sprite; speed: number }> = [];
  /** UX-12: last time/spot each enemy unit was inside the player team's
   *  shared view — drives the short fade-out at the last known position. */
  private enemyLastSeen = new Map<number, { x: number; z: number; at: number }>();
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
    // ACES filmic tonemap + sRGB output: compresses the daylight range without
    // clipping the sunlit sand or the sky highlights.
    // ART-06: exposure REBALANCED 1.5 -> 1.0. The 1.5 was stacked on top to
    // rescue an otherwise near-black scene (ART-03); now that the ground is
    // bright sand lit by a sun, 1.5 would blow the frame out.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    // ART-05: the flat near-black background is replaced by a procedural sky
    // dome (zenith deep blue -> horizon pale blue). The scene background is
    // kept at the HORIZON colour as a seam-free fallback, and the fog colour
    // is pinned to it too — otherwise far walls fade to black and the arena
    // looks sliced off from the blue sky. (Deliberately NOT touching ground,
    // materials, exposure or lights: that is task 8.)
    this.scene.background = new THREE.Color(ENV.skyHorizon);
    // The arena is only ~64 units wide; fogging at 22m smeared the whole
    // firefight. Push it back so depth is a subtle cue, not a blur.
    this.scene.fog = new THREE.Fog(ENV.skyHorizon, 38, 95);
    this.buildSky();

    this.camera = new THREE.PerspectiveCamera(CONFIG.fovBase, 16 / 9, 0.1, 300);
    this.camera.position.set(0, 1.6, 27);

    this.minimap = minimapCanvas.getContext('2d')!;
    this.minimapSize = minimapCanvas.width;
    this.sparkGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
    this.muzzleGeo = new THREE.SphereGeometry(0.1, 8, 8);
    // 8 radial segments for a round silhouette; CLOSED ends are important:
    // a bullet flying straight at the camera is seen dead-on, where an
    // open-ended cylinder degenerates to zero area — the cap is what fills
    // the (small, bright) disc in that view, and it doubles as the tracer
    // head dot in oblique views.
    this.trailGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1, false);

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

  /** Honours prefers-reduced-motion: no tracers, fewer sparks, static cameras,
   *  and static clouds (ART-05 keeps the clouds on screen, only stops them). */
  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  // ------------------------------------------------------------------ sky
  /** ART-05: a large BackSide sphere with a hand-rolled gradient shader
   *  (deep zenith blue -> pale horizon blue). Fully procedural — no external
   *  textures/HDR (CSP + offline). Fog is disabled on the material so the
   *  horizon stays its full brightness no matter the camera distance. */
  private buildSky(): void {
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(150, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        fog: false,
        depthWrite: false,
        uniforms: {
          topColor: { value: new THREE.Color(ENV.skyZenith) },
          bottomColor: { value: new THREE.Color(ENV.skyHorizon) },
        },
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 topColor;
          uniform vec3 bottomColor;
          varying vec3 vDir;
          void main() {
            float h = clamp(normalize(vDir).y, 0.0, 1.0);
            float t = pow(h, 0.55);
            gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      })
    );
    this.scene.add(this.sky);

    // Two layers of soft, semi-transparent sprite clouds, seeded so the
    // layout is deterministic across reloads (E2E can rely on it).
    const texA = this.makeCloudTexture(0x1234abcd);
    const texB = this.makeCloudTexture(0x98765432);
    const COUNT = 14;
    for (let i = 0; i < COUNT; i++) {
      const t = i / COUNT;
      const h1 = ((i + 1) * 0.61803398875) % 1; // golden-ratio hash per index
      const h2 = ((i + 1) * 0.37709178234) % 1;
      const h3 = ((i + 1) * 0.53073372275) % 1;
      const ang = t * Math.PI * 2 + h1 * 0.9;
      const rad = 30 + h2 * 32; // 30..62 m out from arena centre
      const y = 34 + h3 * 20; // 34..54 m up: a band above the wall tops
      const mat = new THREE.SpriteMaterial({
        map: i % 2 === 0 ? texA : texB,
        transparent: true,
        opacity: 0.30 + h1 * 0.22,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(Math.sin(ang) * rad, y, Math.cos(ang) * rad * 0.7);
      const w = 16 + h2 * 14;
      sprite.scale.set(w, w * 0.42, 1);
      this.cloudGroup.add(sprite);
      // "noticeable only if you watch": ~0.2-0.45 m/s drift.
      this.clouds.push({ sprite, speed: 0.2 + h3 * 0.25 });
    }
    this.scene.add(this.cloudGroup);
  }

  /** One fluff of overlapping soft radial gradients on a 2D canvas — the
   *  whole cloud texture budget of this build (no image assets, offline). */
  private makeCloudTexture(seed: number): THREE.CanvasTexture {
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, S, S);
    let s = seed >>> 0 || 1;
    const rnd = (): number => {
      s = (s * 48271) % 2147483647; // Park-Minimal LCG: stable per seed
      return s / 2147483647;
    };
    for (let i = 0; i < 24; i++) {
      const x = S * (0.18 + 0.64 * rnd());
      const y = S * (0.38 + 0.24 * rnd());
      const r = S * (0.07 + 0.15 * rnd());
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.5)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.20)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    return new THREE.CanvasTexture(cv);
  }

  /** Advance the cloud drift by dt real seconds. No-op under reduced motion
   *  (the clouds stay on screen, only the animation stops). */
  private updateClouds(dt: number): void {
    if (this.reducedMotion) return;
    for (const c of this.clouds) {
      c.sprite.position.x += c.speed * dt;
      if (c.sprite.position.x > 90) c.sprite.position.x -= 180; // wrap the band
    }
  }

  /** ART-05 E2E hook: deterministically advance the sky (cloud drift) by
   *  `seconds` and repaint once, so a pixel diff between two calls measures
   *  the drift alone — independent of the (throttled) headless rAF cadence. */
  stepSky(seconds: number): void {
    this.updateClouds(seconds);
    this.renderer.render(this.scene, this.camera);
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
    // ART-06: the six warm 0xffb45a sodium lamps are REMOVED — they were a
    // night-time industrial setting that contradicted the blue-sky daytime
    // scene and were the direct source of the ART-04 over-warm cast. The light
    // rig is now actual daylight:
    //  * a strong warm-white directional SUN (the single key light),
    //  * a HEMISPHERE light in the sky colour with a sand-coloured ground
    //    bounce (the floor reflects warm light back into shadowed faces),
    //  * a small COOL ambient so faces pointing away from the sun never fall
    //    to pure black.
    this.scene.add(new THREE.HemisphereLight(ENV.skyHorizon, 0xcdb27e, 0.85));
    const sun = new THREE.DirectionalLight(0xfff6e6, 1.7);
    sun.position.set(18, 28, 10);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xdfe9f7, 0.15));

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
    // ART-06: warm sand ground with a procedural grain texture — matte
    // (high roughness, zero metalness) so the sun reads as diffuse daylight,
    // not a specular sheen. The old tech GridHelper is gone: a neon grid on
    // sand makes no sense.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ map: this.makeSandTexture(), roughness: 1, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    this.scene.add(ground);

    this.buildArenaSolids(map);
  }

  /** ART-06: procedural sand grain — a deterministic (seeded LCG, stable
   *  across reloads) per-pixel lightness jitter over the base sand colour,
   *  plus a scattering of soft dark/light patches so the floor has visible
   *  texture and no large dead-flat region. Repeats across the 120 m plane.
   *  The mottling is painted on its OWN transparent layer (kept for the
   *  ART-07 seam probe) and composited over the grain — the final texture is
   *  pixel-identical to painting both on one canvas. */
  private makeSandTexture(): THREE.CanvasTexture {
    const S = 256;
    let s = 0x5a7d0d5a >>> 0; // fixed seed: deterministic texture
    const rnd = (): number => {
      s = (s * 48271) % 2147483647; // Park-Minimal LCG: stable per seed
      return s / 2147483647;
    };
    // Base sand 0xd9c08a with ±10 per-pixel lightness jitter (the grain).
    const grain = document.createElement('canvas');
    grain.width = grain.height = S;
    const gctx = grain.getContext('2d')!;
    const img = gctx.createImageData(S, S);
    const [br, bg, bb] = [217, 192, 138];
    for (let i = 0; i < img.data.length; i += 4) {
      const j = (rnd() - 0.5) * 20;
      img.data[i] = br + j;
      img.data[i + 1] = bg + j * 0.9;
      img.data[i + 2] = bb + j * 0.8;
      img.data[i + 3] = 255;
    }
    gctx.putImageData(img, 0, 0);
    // Soft mottling: a handful of translucent light/dark patches on top.
    // ART-07: each patch is ALSO repainted at the 8 neighbouring tile
    // offsets, so a patch crossing a tile edge continues on the opposite
    // side and the 14×14-repeat ground has no right-angle seam where a
    // radial falloff used to be hard-clipped at the tile boundary.
    const mottle = document.createElement('canvas');
    mottle.width = mottle.height = S;
    const mctx = mottle.getContext('2d')!;
    for (let i = 0; i < 36; i++) {
      const x = S * rnd();
      const y = S * rnd();
      const r = S * (0.05 + 0.16 * rnd());
      const dark = rnd() < 0.5;
      const a = 0.05 + rnd() * 0.09;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const px = x + ox * S;
          const py = y + oy * S;
          const g = mctx.createRadialGradient(px, py, 0, px, py, r);
          g.addColorStop(0, dark ? `rgba(120,95,55,${a})` : `rgba(255,240,205,${a})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          mctx.fillStyle = g;
          mctx.beginPath();
          mctx.arc(px, py, r, 0, Math.PI * 2);
          mctx.fill();
        }
      }
    }
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(grain, 0, 0);
    ctx.drawImage(mottle, 0, 0);
    // Kept for the ART-07 E2E seam probe (the wrap-continuity of the
    // mottling layer is exactly what a hard clip would break).
    this.sandCanvas = cv;
    this.sandMottleCanvas = mottle;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(14, 14);
    return tex;
  }

  private sandCanvas: HTMLCanvasElement | null = null;
  private sandMottleCanvas: HTMLCanvasElement | null = null;
  /** ART-07 E2E hook: the sand texture's source canvases (unrepeated) so the
   *  test can check the repeat wrap has no hard seam. */
  getSandTextureCanvases(): { base: HTMLCanvasElement; mottle: HTMLCanvasElement } {
    return { base: this.sandCanvas!, mottle: this.sandMottleCanvas! };
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

  /** FX-04: one pooled two-layer trail (bright core + wide faint halo),
   *  sharing the unit cylinder geometry. Both meshes are hidden and fully
   *  transparent until their slot is driven. */
  private makeTrailPair(): { core: THREE.Mesh; halo: THREE.Mesh; coreMat: THREE.MeshBasicMaterial; haloMat: THREE.MeshBasicMaterial } {
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const haloMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const core = new THREE.Mesh(this.trailGeo, coreMat);
    const halo = new THREE.Mesh(this.trailGeo, haloMat);
    for (const m of [core, halo]) {
      m.frustumCulled = false;
      m.visible = false;
      this.scene.add(m);
    }
    return { core, halo, coreMat, haloMat };
  }

  private buildTracerPool(n: number): void {
    for (let i = 0; i < n; i++) {
      const pair = this.makeTrailPair();
      this.tracers.push({ ...pair, life: 0, max: CONFIG.tracerLife });
    }
  }

  /** One trail slot per pooled bullet (see combat/bullet.ts). Unlike the old
   *  fire-time tracer (muzzle -> impact, drawn as one full line at the moment
   *  of firing), the trail is re-positioned EVERY FRAME on the bullet's
   *  CURRENT position — a short streak that follows the projectile, so the
   *  player can see a bullet coming AT them from a specific direction. */
  private buildBulletTrailPool(n: number): void {
    for (let i = 0; i < n; i++) {
      this.bulletTrails.push(this.makeTrailPair());
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
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.max(0.05, Math.sqrt(dx * dx + dy * dy + dz * dz));
    this.tmpDir.set(dx / len, dy / len, dz / len);
    this.tmpQuat.setFromUnitVectors(TRAIL_UP, this.tmpDir);
    // Cylinder is centred: park it at the segment midpoint, scale to the
    // segment length, and additively blend a bright core under a wide halo.
    t.core.position.set(
      from.x + this.tmpDir.x * len * 0.5,
      from.y + this.tmpDir.y * len * 0.5,
      from.z + this.tmpDir.z * len * 0.5,
    );
    t.halo.position.copy(t.core.position);
    t.core.quaternion.copy(this.tmpQuat);
    t.halo.quaternion.copy(this.tmpQuat);
    const w = CONFIG.bulletTrailWidth;
    t.core.scale.set(w, len, w);
    t.halo.scale.set(w * TRAIL_HALO_MULT, len, w * TRAIL_HALO_MULT);
    // FX-01: 0.09s (~5 frames) sat at the edge of perception; CONFIG.tracerLife
    // (0.18s, ~11 frames) is the single source of truth.
    t.life = t.max = CONFIG.tracerLife;
    t.coreMat.color.setHex(0xffe08a);
    t.haloMat.color.setHex(0xffe08a);
    t.core.visible = true;
    t.halo.visible = true;
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
    this.syncBulletTrails(match);

    // Tracers
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.core.visible = false;
        t.halo.visible = false;
        t.coreMat.opacity = 0;
        t.haloMat.opacity = 0;
      } else {
        const k = t.life / t.max;
        t.coreMat.opacity = TRAIL_CORE_OPACITY * k;
        t.haloMat.opacity = TRAIL_HALO_OPACITY * k;
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

    // ART-05: drift the clouds (no-op under reduced motion).
    this.updateClouds(dt);

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

  /** ART-06 E2E hook: is the world point inside the camera frustum AND inside
   *  the central screen band (38%..62% both axes) that the team-colour pixel
   *  assertions sample? Lets the test park a unit where it is guaranteed to
   *  land in the sampled band, on any map seed. */
  pointInViewBand(x: number, y: number, z: number): boolean {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (v.z > 1) return false; // behind the camera
    const sx = (v.x + 1) / 2;
    const sy = (1 - v.y) / 2;
    return sx > 0.38 && sx < 0.62 && sy > 0.38 && sy < 0.62;
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

    // UX-12: vision cones — the ±45° display arc (CONFIG.minimap) of every
    // living participant of the PLAYER'S team, so the player can see which
    // spots the team is covering. Own-team cones only (drawing the enemies'
    // cones would leak their awareness). Purely visual: the AI keeps its own
    // wider CONFIG.ai.fovHalfDeg perception cone.
    const p = match.player;
    const coneHalf = (CONFIG.minimap.fovHalfDeg * Math.PI) / 180;
    const coneR = CONFIG.minimap.visionDist * scale;
    for (const u of match.units) {
      if (u.team !== p.team || !u.alive) continue;
      const x = px(u.pos.x);
      const y = pz(u.pos.z);
      const a = Math.PI / 2 - u.yaw; // canvas angle of the facing direction
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, coneR, a - coneHalf, a + coneHalf);
      ctx.closePath();
      ctx.fillStyle = p.team === 'blue' ? 'rgba(24,224,255,0.10)' : 'rgba(255,61,99,0.10)';
      ctx.fill();
    }

    // Units. Own team (alive = filled dot, dead = hollow ring) always shows —
    // rule unchanged. ENEMIES (UX-12) only appear while inside the player
    // team's shared view (player OR any living teammate); just-lost enemies
    // fade out at their last known spot over CONFIG.minimap.lastSeenFade.
    const now = match.now;
    const fade = CONFIG.minimap.lastSeenFade;
    for (const u of match.units) {
      let x = px(u.pos.x);
      let y = pz(u.pos.z);
      const col = u.team === 'blue' ? '#18e0ff' : '#ff3d63';
      const r = u.isPlayer ? 4 : 3;
      let alpha = 1;
      if (u.team !== p.team) {
        if (sharedViewCanSee(match.solids, match.units, p.team, u)) {
          this.enemyLastSeen.set(u.id, { x: u.pos.x, z: u.pos.z, at: now });
        }
        const ls = this.enemyLastSeen.get(u.id);
        if (!ls) continue; // never seen -> never shown (no wallhack)
        const age = now - ls.at;
        if (age < 0 || age > fade) {
          this.enemyLastSeen.delete(u.id);
          continue;
        }
        x = px(ls.x);
        y = pz(ls.z);
        alpha = age <= 0 ? 1 : 1 - age / fade; // live = 1, eases to 0
      }
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (u.alive) {
        ctx.fillStyle = col;
        ctx.fill();
      } else {
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (u.isPlayer && u.alive) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  /** Re-position every pooled bullet trail from the live bullet pool. Called
   *  each frame from update() and by the FX-04 probe hook. */
  private syncBulletTrails(match: Match): void {
    const trailLen = CONFIG.bulletTrail;
    const wCore = CONFIG.bulletTrailWidth;
    const wHalo = wCore * TRAIL_HALO_MULT;
    for (let i = 0; i < this.bulletTrails.length; i++) {
      const t = this.bulletTrails[i];
      const b = match.bullets.bullets[i];
      if (b && b.active) {
        this.tmpDir.set(b.dir.x, b.dir.y, b.dir.z);
        if (this.tmpDir.lengthSq() < 1e-8) this.tmpDir.set(0, 1, 0);
        else this.tmpDir.normalize();
        this.tmpQuat.setFromUnitVectors(TRAIL_UP, this.tmpDir);
        // Centred cylinder spanning [pos - dir*len, pos] (streak BEHIND the
        // flying bullet).
        t.core.position.set(
          b.pos.x - this.tmpDir.x * trailLen * 0.5,
          b.pos.y - this.tmpDir.y * trailLen * 0.5,
          b.pos.z - this.tmpDir.z * trailLen * 0.5,
        );
        t.halo.position.copy(t.core.position);
        t.core.quaternion.copy(this.tmpQuat);
        t.halo.quaternion.copy(this.tmpQuat);
        t.core.scale.set(wCore, trailLen, wCore);
        t.halo.scale.set(wHalo, trailLen, wHalo);
        t.coreMat.opacity = TRAIL_CORE_OPACITY;
        t.haloMat.opacity = TRAIL_HALO_OPACITY;
        t.core.visible = true;
        t.halo.visible = true;
      } else {
        t.coreMat.opacity = 0;
        t.haloMat.opacity = 0;
        t.core.visible = false;
        t.halo.visible = false;
      }
    }
  }

  /** FX-04 E2E hook: re-sync the bullet-trail pool from the given Match,
   *  render ONE frame with the camera parked at a fixed pose looking ~70° up,
   *  with the sky dome, clouds and sky background temporarily hidden so the
   *  backdrop is pure black and the ONLY lit thing in the frame is the trail.
   *  Returns the count of bright warm-gold (0xffe08a family) pixels. Note
   *  the ACES tonemap washes saturated additive gold toward pale yellow, so
   *  "warm gold" is luma >= 120 with blue clearly below red/green — NOT a
   *  strict r >> b gap (additive gold over the daylight sky would saturate
   *  to white anyway, which is why the backdrop is black). The caller
   *  spawns the probe bullet in the match's bullet pool around this call.
   *  The camera is harmless to leave: the next update() re-derives it. */
  probeTrailWarmGoldPixels(match: Match): number {
    this.syncBulletTrails(match);
    const bg = this.scene.background as THREE.Color;
    this.scene.background = new THREE.Color(0x000000);
    this.sky.visible = false;
    this.cloudGroup.visible = false;
    // 70° elevation, half-vfov 39° -> the whole frame is sky (no geometry).
    this.camera.position.set(0, 4, 12);
    this.camera.lookAt(0, 13.3969, 8.5798);
    this.renderer.render(this.scene, this.camera);
    const gl = this.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = gl.width;
    c.height = gl.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(gl, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      // Bright warm gold: ACES-compressed additive 0xffe08a lands near
      // (235-255, 245-255, 180-225) — blue channel clearly below r and g.
      if (luma >= 120 && Math.min(r, g) >= b + 15) n++;
    }
    this.scene.background = bg;
    this.sky.visible = true;
    this.cloudGroup.visible = true;
    return n;
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
