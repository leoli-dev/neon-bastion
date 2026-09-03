// ============================================================================
// Neon Bastion — Playwright E2E
// ----------------------------------------------------------------------------
// Drives the REAL built app (vite preview, dist/) in headless Chromium with
// WebGL (SwiftShader). Logic is advanced deterministically through the
// window.__teamArenaTest hooks (start / shoot / applyDamage / teleport /
// fastForward / forceSpectate). Determinism trick: any setup + action +
// readout that must be atomic happens inside ONE page.evaluate, so the browser
// rAF loop (which also ticks the match in real time) cannot interleave.
//
// Seven scenarios:
//   1. boot + pointer lock + WASD/D movement + wall collision + real render
//      (asserted in canvas PIXELS, not screenshot bytes)
//   2. body + head hits -> HP / score / leaderboard / hitmarker, then a
//      wall-blocked shot (no through-wall damage)
//   3. death -> can't fire -> spectate ally -> switch -> free camera
//   4. blue wins -> match freezes -> results board (readable, token-coloured
//      text asserted via computed style) -> restart resets 8 units
//   5. seeded AI fast-forward -> match terminates, no negative HP, and the
//      scoring invariant totalScore === hitScore + 3*kills holds for everyone
//   6. player-taken damage -> red vignette + damage-direction arc + camera
//      kick (the 'hit' event is consumed), firing recoil accumulates
//   7. no-WebGL fallback (?nogl=1) -> legible 2D status, no white screen/error
//   8. MAP-01 glass wall: a red unit parked behind the glass maze wall is
//      visible through it (red-team pixels sampled from the canvas centre)
// Eight screenshots of the real rendered game are saved to screenshots/.
// ============================================================================

import { test, expect, type Page } from '@playwright/test';

// MAP-04: every match's map is generated from the seed. E2E pins the seed
// explicitly at the start of each test so the layout is fixed: seed 16 gives
// the 'Classic' layout (identical to the old NEON_BASTION geometry, so all
// hardcoded coordinates below stay valid) AND rolls `glass` on the south-
// east maze wall that test 8 sees through.
const PINNED_SEED = 16;
async function pinSeed(page: Page): Promise<void> {
  await page.evaluate(
    (s) => (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest.seed(s),
    PINNED_SEED
  );
}

type U = {
  id: number;
  name: string;
  team: 'blue' | 'red';
  isPlayer: boolean;
  alive: boolean;
  hp: number;
  pos: { x: number; y: number; z: number };
  yaw: number;
  kills: number;
  hitScore: number;
  totalScore: number;
  aiState: string | null;
  aiTarget: number;
  aiLastSeen: { x: number; z: number } | null;
};
type Snap = {
  now: number;
  state: 'running' | 'ended';
  winner: 'blue' | 'red' | null;
  spectate: { mode: 'alive' | 'ally' | 'free'; targetId: number | null };
  killfeed: unknown[];
  units: U[];
};

type Hooks = {
  version: string;
  ready: boolean;
  fallback?: boolean;
  state: () => Snap;
  seed: (s?: number) => number;
  start: () => void;
  playAgain: () => void;
  restart: (s?: number) => void;
  mouseTurn: (dx: number, dy: number) => void;
  input: (key: string, down: boolean) => void;
  shoot: (dir?: { x: number; y: number; z: number }) => unknown;
  applyDamage: (victimId: number, amount: number, causeId?: number) => void;
  simulateHitOnPlayer: (causeId: number, part?: 'head' | 'body') => void;
  cameraKicks: () => { kickYaw: number; kickPitch: number; recoil: number; recoilCharge: number };
  fastForwardSky: (seconds: number) => void;
  /** ART-06: a sight-clear spot on the player's facing that lands in the
   *  central screen band (null if none exists on this seed). */
  findCenterViewSpot: () => { x: number; z: number } | null;
  teleport: (unitId: number, x: number, z: number) => void;
  fastForward: (seconds: number) => void;
  /** AUD-01: how many player footstep triggers have fired since spawn/reseed. */
  footstepCount: () => number;
  forceSpectate: () => void;
  repaintHud: () => void;
};

async function snap(page: import('@playwright/test').Page): Promise<Snap> {
  return page.evaluate(() => (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest.state());
}

/** Pixel statistics of the WebGL canvas itself (not the full page — the DOM
 *  HUD is excluded). The old "screenshot bytes > 20 KB" proxy was defeated by
 *  the rich HUD: a page whose 3D scene is all-black still compresses large.
 *  The renderer is built with `preserveDrawingBuffer: true`, so reading the
 *  canvas via an in-page drawImage is reliable (no racy composited frame).
 *  We sample a few frames (headless rAF is throttled) and keep the best. */
interface SceneStats {
  brightFrac: number; // fraction of pixels clearly above the near-black background
  std: number;        // luminance standard deviation
  maxLuma: number;
}
async function arenaSceneStats(page: import('@playwright/test').Page): Promise<SceneStats> {
  let best: SceneStats = { brightFrac: 0, std: 0, maxLuma: 0 };
  for (let i = 0; i < 6; i++) {
    const s = await page.evaluate((): SceneStats => {
      const gl = document.getElementById('webgl-canvas') as HTMLCanvasElement;
      const c = document.createElement('canvas');
      c.width = gl.width;
      c.height = gl.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(gl, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const n = d.length / 4;
      let bright = 0;
      let sum = 0;
      let sumsq = 0;
      let maxLuma = 0;
      for (let i = 0; i < d.length; i += 4) {
        const luma = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        // background is 0x05070b (luma ~7); 28 is well above any tonemap drift
        if (luma > 28) bright++;
        sum += luma;
        sumsq += luma * luma;
        if (luma > maxLuma) maxLuma = luma;
      }
      const mean = sum / n;
      const std = Math.sqrt(Math.max(0, sumsq / n - mean * mean));
      return { brightFrac: bright / n, std, maxLuma };
    });
    if (s.brightFrac > best.brightFrac) best = s;
    if (best.brightFrac > 0.05) break;
    await page.waitForTimeout(150);
  }
  return best;
}

// SwiftShader / GPU driver chatter is not a real app error.
const GL_NOISE = /GL|WebGL|SwiftShader|fallback|GPU|driver|ANGLE|Vulkan|dawn|Vulkan/i;

function trackErrors(page: import('@playwright/test').Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

async function ready(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __teamArenaTest?: { ready: boolean } }).__teamArenaTest?.ready === true);
}

// ---------------------------------------------------------------------------
test('1: boots, deploys (pointer lock), WASD moves, walls block, arena renders', async ({ page }) => {
  const errors = trackErrors(page);
  await ready(page);
  await pinSeed(page);

  // Start screen + HUD present.
  await expect(page.locator('.nb-screen')).toBeVisible();
  await expect(page.locator('.nb-title')).toHaveText('NEON BASTION');
  // UI-02 regression: the screen must actually RESOLVE the design tokens.
  // toHaveText/toBeVisible pass for black-on-black, so assert computed style.
  const titleCs = await page.locator('.nb-title').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { color: cs.color, font: cs.fontFamily };
  });
  expect(titleCs.color, 'start title must use its design colour, not browser-default black').toBe('rgb(232, 244, 255)');
  expect(titleCs.font, 'the screen must inherit the .nb-root font stack, not Times').toContain('system-ui');
  await expect(page.locator('.nb-hp')).toBeVisible();
  await expect(page.locator('.nb-ammo')).toBeVisible();
  await expect(page.locator('.nb-board')).toBeVisible();
  await expect(page.locator('.nb-team')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(2); // webgl + minimap

  // Capture that the game requests pointer lock on deploy.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__plRequested = false;
    const orig = HTMLCanvasElement.prototype.requestPointerLock;
    HTMLCanvasElement.prototype.requestPointerLock = function (...args: unknown[]) {
      (window as unknown as Record<string, unknown>).__plRequested = true;
      return (orig as () => Promise<void>).apply(this, args as []);
    };
  });
  // Deploy via a real click (a user gesture) so the browser can grant pointer lock.
  await page.locator('.nb-screen').click();
  await expect(page.locator('.nb-screen')).toBeHidden();
  await page.waitForTimeout(700);

  // The game must REQUEST pointer lock on deploy. Whether the headless browser
  // actually GRANTS it is environment-dependent (it usually does not); the
  // request is the app behaviour under test, and WASD/wall checks prove control.
  const requested = await page.evaluate(() => (window as unknown as Record<string, boolean>).__plRequested);
  expect(requested, 'the game should request pointer lock on deploy').toBe(true);
  const granted = await page.evaluate(() => document.pointerLockElement === document.getElementById('webgl-canvas'));
  console.log('pointer lock requested=true granted=' + granted);

  // --- WASD movement: facing north (spawn yaw), hold W -> move -Z ---
  const move = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.teleport(0, -3, 24); // clear south lane, still facing north
    const z0 = t.state().units[0].pos.z;
    t.input('KeyW', true);
    t.fastForward(0.6);
    t.input('KeyW', false);
    return { z0, z1: t.state().units[0].pos.z };
  });
  expect(move.z1, 'holding W should move the player forward (north)').toBeLessThan(move.z0 - 1);

  // --- Wall collision: run north into the central south column and be stopped.
  // The cover column at (0,13) spans z 11.5..14.5; the player must not pass it.
  const wall = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.teleport(0, 0, 20);
    t.input('KeyW', true);
    t.fastForward(2.0);
    t.input('KeyW', false);
    return { z: t.state().units[0].pos.z };
  });
  expect(wall.z, 'player should have moved toward the wall').toBeLessThan(20);
  expect(wall.z, 'the column must block the player (no pass-through)').toBeGreaterThan(14.5);

  // --- D strafes to screen-right (CTRL-01 regression). Spawn yaw is π
  // (facing -Z/north), so screen-right is +X: holding D must increase x.
  const strafe = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.teleport(0, -3, 24);
    const x0 = t.state().units[0].pos.x;
    t.input('KeyD', true);
    t.fastForward(0.6);
    t.input('KeyD', false);
    return { x0, x1: t.state().units[0].pos.x };
  });
  expect(strafe.x1, 'holding D (facing north) should strafe right (+X)').toBeGreaterThan(strafe.x0 + 1);

  // Real render, not a blank/flat screen — measured in PIXELS of the WebGL
  // canvas (the HUD is DOM, so it cannot inflate this number). First move the
  // player to (5, 16), a position with a clear sight line onto the opening
  // central zone (the south column at (0,13) would otherwise block the view from
  // (0,20)), so the screenshot shows the flat central arena.
  await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.teleport(0, 5, 16); // facing north (spawn yaw) = straight at the centre
  });
  await page.waitForTimeout(200); // let a few rendered frames present
  const stats = await arenaSceneStats(page);
  console.log('ARENA SCENE PIXELS', JSON.stringify(stats));
  expect(stats.brightFrac, 'the 3D scene must contain visible geometry (a flat black canvas is ~0)').toBeGreaterThan(0.05);
  expect(stats.maxLuma, 'the scene must contain pixels far brighter than the near-black background').toBeGreaterThan(60);

  await page.screenshot({ path: 'screenshots/01-arena.png' });

  const real = errors.filter((e) => !GL_NOISE.test(e));
  expect(real, 'no real JS errors: ' + real.join(' | ')).toHaveLength(0);
});

// ---------------------------------------------------------------------------
test('2: body+head hits score correctly, hitmarker fires; wall blocks shots', async ({ page }) => {
  const errors = trackErrors(page);
  await ready(page);
  await pinSeed(page);

  // --- Body hit: red unit 4 (Raxx) at 3m, clear lane, player deals 20. ---
  const body = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.start();
    t.teleport(0, -3, 24);
    t.teleport(4, -3, 21);
    const st = t.state();
    const p = st.units.find((u) => u.id === 0)!;
    const target = st.units.find((u) => u.id === 4)!;
    const eye = { x: p.pos.x, y: p.pos.y + 1.62, z: p.pos.z };
    const p0 = { x: target.pos.x, y: target.pos.y + 0.7, z: target.pos.z };
    let dx = p0.x - eye.x, dy = p0.y - eye.y, dz = p0.z - eye.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    const r = t.shoot({ x: dx / l, y: dy / l, z: dz / l });
    const s2 = t.state();
    return {
      fired: !!(r as { fired?: boolean }).fired,
      kind: (r as { resolution?: { kind: string } }).resolution?.kind,
      part: (r as { part?: string }).part,
      damage: (r as { damage?: number }).damage,
      hp4: s2.units.find((u) => u.id === 4)!.hp,
      pScore: s2.units.find((u) => u.id === 0)!.totalScore,
      hits: Number(document.querySelector('.nb-hitmark')?.getAttribute('data-hits') || '0'),
    };
  });
  expect(body.fired).toBe(true);
  expect(body.kind).toBe('unit');
  expect(body.part, 'aimed at the torso -> body hit').toBe('body');
  expect(body.damage).toBe(20);
  expect(body.hp4, 'body hit should remove 20 HP').toBe(80);
  expect(body.pScore, 'a clean hit should add 1 point').toBeGreaterThanOrEqual(1);
  expect(body.hits, 'the hitmarker should have registered a hit').toBeGreaterThanOrEqual(1);

  // --- Head hit: advance the fire cooldown, re-place target, aim at the head.
  // The damage delta is measured inside ONE evaluate (no logic tick can run
  // in between), and the blue AIs are parked out of the lane first: with the
  // shared 1-shot/second cadence the cooldown wait (1.1s) gives them time to
  // chip down the red unit camped in the blue spawn area. ---
  const head = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.fastForward(1.1); // > fireInterval (1.0s) so the player may fire again
    [1, 2, 3].forEach((id) => t.teleport(id, 0, -25)); // park the blue AIs far from the lane
    t.teleport(4, -3, 21);
    const st = t.state();
    const p = st.units.find((u) => u.id === 0)!;
    const target = st.units.find((u) => u.id === 4)!;
    const eye = { x: p.pos.x, y: p.pos.y + 1.62, z: p.pos.z };
    const p0 = { x: target.pos.x, y: target.pos.y + 1.6, z: target.pos.z }; // head center
    let dx = p0.x - eye.x, dy = p0.y - eye.y, dz = p0.z - eye.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    const before = target.hp;
    const r = t.shoot({ x: dx / l, y: dy / l, z: dz / l });
    return {
      fired: !!(r as { fired?: boolean }).fired,
      part: (r as { part?: string }).part,
      damage: (r as { damage?: number }).damage,
      before,
      hp4: t.state().units.find((u) => u.id === 4)!.hp,
    };
  });
  expect(head.fired).toBe(true);
  expect(head.part, 'aimed at the head -> headshot').toBe('head');
  expect(head.damage).toBe(50);
  expect(head.hp4, 'headshot should remove 50 HP (clamped at 0)').toBe(Math.max(0, head.before - 50));

  // --- Wall-blocked: column between the player and the target -> no damage. ---
  const blocked = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.fastForward(1.1); // shared 1-shot/second cadence
    t.teleport(0, 0, 20); // south of the central column
    t.teleport(4, 0, -20); // north of it, behind cover
    const before = t.state().units.find((u) => u.id === 4)!.hp;
    const r = t.shoot({ x: 0, y: 0, z: -1 }); // straight north, into the column
    return {
      kind: (r as { resolution?: { kind: string } }).resolution?.kind,
      before,
      after: t.state().units.find((u) => u.id === 4)!.hp,
    };
  });
  expect(blocked.kind, 'the column should stop the bullet').toBe('wall');
  expect(blocked.after, 'no damage may pass through the wall').toBe(blocked.before);

  // --- Leaderboard reflects the player's score. The board repaints on a 5-frame
  // throttle and headless rAF is throttled, so force a deterministic repaint. ---
  await page.evaluate(() => (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest.repaintHud());
  const board = await page.locator('.nb-board').textContent();
  expect(board, 'leaderboard should list the player (Vega) with a score').toMatch(/Vega/);
  expect(board?.replace(/\s+/g, ' ')).toMatch(/Vega[\s\S]*\/\s*[1-9]/);

  const st = await snap(page);
  expect(st.units.find((u) => u.isPlayer)!.totalScore).toBeGreaterThanOrEqual(2); // body + head

  await page.screenshot({ path: 'screenshots/02-combat-hit.png' });
  const real = errors.filter((e) => !GL_NOISE.test(e));
  expect(real, 'no real JS errors: ' + real.join(' | ')).toHaveLength(0);
});

// ---------------------------------------------------------------------------
test('3: death -> cannot fire -> spectate ally -> switch -> free camera', async ({ page }) => {
  await ready(page);
  await pinSeed(page);
  await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.start();
    t.forceSpectate(); // player dies
  });
  await page.waitForTimeout(300);

  // Dead + cannot fire.
  const dead = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    const alive = t.state().units[0].alive;
    const r = t.shoot({ x: 0, y: 0, z: -1 });
    return { alive, fired: !!(r as { fired?: boolean } | null)?.fired };
  });
  expect(dead.alive).toBe(false);
  expect(dead.fired, 'a dead player cannot fire').toBe(false);

  // Spectating a living ally by default.
  await expect(page.locator('.nb-spectate')).toBeVisible();
  const spec = (await snap(page)).spectate;
  expect(spec.mode).toBe('ally');
  expect(spec.targetId).not.toBeNull();

  await page.screenshot({ path: 'screenshots/03-spectator.png' });

  // Switch to the next ally (E).
  const sw = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    const before = t.state().spectate.targetId;
    t.input('KeyE', true);
    t.fastForward(0.1);
    t.input('KeyE', false);
    return { before, after: t.state().spectate.targetId };
  });
  expect(sw.after, 'Q/E should switch the spectated ally').not.toEqual(sw.before);

  // Wipe the remaining blue allies -> no one left to spectate -> free camera.
  await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    [1, 2, 3].forEach((id) => t.applyDamage(id, 999, 4));
  });
  const end = await snap(page);
  expect(end.spectate.mode, 'with no living ally the camera goes free').toBe('free');
  expect(end.spectate.targetId).toBeNull();
  // Blue is fully eliminated, so the match ends (red wins) at that moment.
  expect(end.state).toBe('ended');
  expect(end.winner).toBe('red');
});

// ---------------------------------------------------------------------------
test('4: blue wins -> match freezes -> results board -> restart resets 8 units', async ({ page }) => {
  await ready(page);
  await pinSeed(page);
  await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.start();
    [4, 5, 6, 7].forEach((id) => t.applyDamage(id, 999, 0)); // blue wipes red
  });
  await page.waitForTimeout(250);

  const st = await snap(page);
  expect(st.state).toBe('ended');
  expect(st.winner).toBe('blue');

  // Results screen + full board; the match-chrome must not bleed through.
  await expect(page.locator('.nb-res-title')).toBeVisible();
  await expect(page.locator('.nb-res-title')).toHaveText('BLUE WINS');
  // UI-02 regression: the title's inline `var(--cyan)` must RESOLVE. When the
  // screen was outside .nb-root the variable was out of scope and the title
  // rendered as black Times on a near-black background — invisible, while
  // toHaveText still passed. Assert what is actually painted.
  const resCs = await page.locator('.nb-res-title').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { color: cs.color, font: cs.fontFamily };
  });
  expect(resCs.color, 'results title must resolve --cyan, not fall back to black').toBe('rgb(24, 224, 255)');
  expect(resCs.font, 'results screen must use the .nb-root font stack, not Times').toContain('system-ui');
  await expect(page.locator('.nb-board-lg .nb-row')).toHaveCount(8);
  await expect(page.locator('.nb-root')).toHaveClass(/nb-results/);
  await expect(page.locator('.nb-msg')).toBeHidden(); // the ENEMY DOWN flash is gone
  await expect(page.locator('.nb-killfeed .nb-kf').first()).toBeHidden();

  await page.screenshot({ path: 'screenshots/04-results.png' });

  // Frozen: nothing advances once the match is over.
  const frozen = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    const before = t.state().now;
    t.fastForward(5);
    return { before, after: t.state().now, state: t.state().state };
  });
  expect(frozen.after, 'the clock must not advance after the match ends').toBe(frozen.before);
  expect(frozen.state).toBe('ended');

  // Restart via the results CTA -> a fresh 8-unit match at full HP.
  await page.locator('.nb-cta').click();
  await page.waitForTimeout(250);
  const st2 = await snap(page);
  expect(st2.state).toBe('running');
  expect(st2.units).toHaveLength(8);
  expect(st2.units.every((u) => u.alive && u.hp === 100)).toBe(true);
  await expect(page.locator('.nb-screen')).toBeHidden();
});

// ---------------------------------------------------------------------------
test('5: seeded AI fight terminates; no negative HP; scoring invariant holds', async ({ page }) => {
  await ready(page);
  await pinSeed(page);
  await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.start();
    // Remove the passive human player so the match is pure AI (blue 3 vs red 4);
    // otherwise the human unit camps at spawn and the match never reaches a
    // terminal state.
    t.forceSpectate();
    t.fastForward(90); // let the (seeded) AI fight to completion
  });

  const st = await snap(page);
  expect(st.state, 'a seeded 4v4 should terminate').toBe('ended');
  expect(st.winner).not.toBeNull();

  // No unit may have negative HP.
  expect(st.units.every((u) => u.hp >= 0)).toBe(true);

  // The losing team is fully wiped; the winner still has members.
  const loser = st.winner === 'blue' ? 'red' : 'blue';
  expect(st.units.filter((u) => u.team === loser && u.alive).length).toBe(0);
  expect(st.units.filter((u) => u.team === st.winner && u.alive).length).toBeGreaterThan(0);

  // Scoring invariant for every unit: totalScore === hitScore + 3*kills.
  const invariant = st.units.every((u) => u.totalScore === u.hitScore + 3 * u.kills);
  expect(invariant, `invariant violated: ${st.units.map((u) => `${u.name} ${u.totalScore}!=${u.hitScore}+3*${u.kills}`).join(', ')}`).toBe(true);

  // Real combat actually happened (someone died with a killer, or scored).
  expect(st.units.some((u) => u.kills > 0) || st.units.some((u) => u.hitScore > 0)).toBe(true);
});

// ---------------------------------------------------------------------------
test('6: player hit -> vignette + damage-direction arc + camera kick; firing -> recoil', async ({ page }) => {
  const errors = trackErrors(page);
  await ready(page);
  await pinSeed(page);

  // --- Player is hit by unit 4: red vignette flash, damage-direction arc at
  // the attacker's bearing, camera kick, pain sfx wiring — all from the
  // 'hit' event alone (no HP change: this is the FEEDBACK path). The attacker
  // is placed on the player's own right axis using the player's live yaw, so
  // the expected arc rotation is exact regardless of spawn orientation. ---
  const hit = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.start();
    const p = t.state().units.find((u) => u.isPlayer)!;
    const yaw = p.yaw;
    const rx = -Math.cos(yaw); // screen-right in world space (CTRL-01 fix)
    const rz = Math.sin(yaw);
    t.teleport(4, p.pos.x + rx * 8, p.pos.z + rz * 8); // 8 m to the player's right
    const hpBefore = p.hp;
    const arcEl = document.querySelector('.nb-dmgdir circle') as SVGElement;
    t.simulateHitOnPlayer(4);
    return {
      hpAfter: t.state().units.find((u) => u.isPlayer)!.hp,
      hpBefore,
      vignette: (document.querySelector('.nb-vignette') as HTMLElement).style.opacity,
      dmgdir: (document.querySelector('.nb-dmgdir') as HTMLElement).style.opacity,
      arcTransform: arcEl.getAttribute('transform') ?? '',
      arcHits: Number((document.querySelector('.nb-dmgdir') as HTMLElement).getAttribute('data-hits') || '0'),
      kicks: t.cameraKicks(),
    };
  });
  expect(hit.hpAfter, 'simulateHitOnPlayer is feedback-only: no HP change').toBe(hit.hpBefore);
  expect(hit.vignette, 'red vignette must snap to full opacity on the hit').toBe('1');
  expect(hit.dmgdir, 'damage-direction arc must appear on the hit').toBe('1');
  expect(hit.arcHits).toBeGreaterThanOrEqual(1);
  // Attacker exactly to the right => bearing +90° => arc rotated from its
  // straight-ahead (-90°) rest to 0° (3 o'clock on the ring).
  expect(hit.arcTransform, 'arc must point at the attacker (right => rotate(0))').toMatch(/^rotate\(0\.\d{2} 75 75\)$/);
  expect(hit.kicks.kickPitch, 'hit kick must snap the pitch up by hitKick (0.06)').toBeGreaterThanOrEqual(0.06);

  // Second hit from straight ahead => arc back to 12 o'clock (rotate(-90)).
  const hit2 = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.fastForward(0.2);
    const p = t.state().units.find((u) => u.isPlayer)!;
    const fx = Math.sin(p.yaw); // forward in world space
    const fz = Math.cos(p.yaw);
    t.teleport(5, p.pos.x + fx * 6, p.pos.z + fz * 6);
    t.simulateHitOnPlayer(5);
    return (document.querySelector('.nb-dmgdir circle') as SVGElement).getAttribute('transform') ?? '';
  });
  expect(hit2, 'attacker straight ahead => arc at 12 o\'clock (rotate(-90))').toMatch(/^rotate\(-90\.\d{2} 75 75\)$/);

  // The vignette must FADE out (short flash, not a stuck overlay): poll in
  // page until the inline opacity returns to '0' (a later AI hit could re-arm
  // it, so "observed fading" is the assertion, not the final state).
  const faded = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const el = document.querySelector('.nb-vignette') as HTMLElement;
        const t0 = performance.now();
        const check = () => {
          if (el.style.opacity === '0') return resolve(true);
          if (performance.now() - t0 > 2000) return resolve(false);
          setTimeout(check, 40);
        };
        check();
      })
  );
  expect(faded, 'the vignette must fade back to transparent after the flash').toBe(true);

  // --- Firing recoil: each player shot adds CONFIG.shotKick (0.02) to the
  // synchronous recoil charge; the charge accumulates over a burst. ---
  const recoil = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    const c0 = t.cameraKicks().recoilCharge;
    t.shoot({ x: 0, y: 0, z: -1 });
    const c1 = t.cameraKicks().recoilCharge;
    t.fastForward(1.05); // past the shared 1-shot/second cooldown so the 2nd/3rd shots fire
    t.shoot({ x: 0, y: 0, z: -1 });
    t.fastForward(1.05);
    t.shoot({ x: 0, y: 0, z: -1 });
    const c3 = t.cameraKicks().recoilCharge;
    return { c0, c1, c3 };
  });
  expect(recoil.c1 - recoil.c0, 'one shot must add exactly one shotKick of charge').toBeCloseTo(0.02, 5);
  expect(recoil.c3 - recoil.c1, 'the burst must accumulate ~2 more shotKicks (decay aside)').toBeGreaterThanOrEqual(0.025);

  await page.screenshot({ path: 'screenshots/06-damage-feedback.png' });
  const real = errors.filter((e) => !GL_NOISE.test(e));
  expect(real, 'no real JS errors: ' + real.join(' | ')).toHaveLength(0);
});

// ---------------------------------------------------------------------------
test('7: no-WebGL fallback shows a legible 2D status, never a white screen', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?nogl=1');
  await page.waitForFunction(() => (window as unknown as { __teamArenaTest?: { ready: boolean } }).__teamArenaTest?.ready === true);

  // The 3D canvas app must NOT have booted; the fallback must be present.
  await expect(page.locator('.nb-fallback')).toBeVisible();
  await expect(page.locator('.nb-fallback h1')).toHaveText('NEON BASTION');

  const text = (await page.locator('.nb-fallback').textContent()) ?? '';
  expect(text, 'a clear "3D / WebGL unavailable" notice').toMatch(/WebGL|3D/);
  expect(text, 'controls are explained').toMatch(/Move/);

  // A live 2D battle status (canvas + score line) is rendered.
  await expect(page.locator('.nb-fb-map')).toBeVisible();
  await expect(page.locator('.nb-fb-score')).not.toBeEmpty();

  const hook = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: { fallback?: boolean; state: () => { state: string; blueAlive: number; redAlive: number } } }).__teamArenaTest;
    return { fallback: t.fallback, state: t.state() };
  });
  expect(hook.fallback).toBe(true);
  expect(hook.state.blueAlive).toBeGreaterThanOrEqual(0);
  expect(hook.state.redAlive).toBeGreaterThanOrEqual(0);

  await page.screenshot({ path: 'screenshots/07-fallback.png' });
  const real = errors.filter((e) => !GL_NOISE.test(e));
  expect(real, 'no real JS errors in the fallback: ' + real.join(' | ')).toHaveLength(0);
});

// ---------------------------------------------------------------------------
interface RedSample {
  count: number;
  sample: [number, number, number];
}
/** Count red-team-coloured pixels (0xff3d63-ish: strong R, R >> G, R > B)
 *  inside a central band of the WebGL canvas. Central band only, so the hit is
 *  attributed to the unit on the sight axis, not to off-axis scenery. Samples
 *  several frames (headless rAF is throttled) and keeps the best. */
async function redPixelsInCentre(page: import('@playwright/test').Page): Promise<RedSample> {
  let best: RedSample = { count: 0, sample: [0, 0, 0] };
  for (let i = 0; i < 8; i++) {
    const r = await page.evaluate((): RedSample => {
      const gl = document.getElementById('webgl-canvas') as HTMLCanvasElement;
      const c = document.createElement('canvas');
      c.width = gl.width;
      c.height = gl.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(gl, 0, 0);
      const x0 = Math.floor(c.width * 0.38);
      const x1 = Math.ceil(c.width * 0.62);
      const y0 = Math.floor(c.height * 0.38);
      const y1 = Math.ceil(c.height * 0.62);
      const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let count = 0;
      let sample: [number, number, number] = [0, 0, 0];
      let bestLuma = -1;
      for (let i = 0; i < d.length; i += 4) {
        const pr = d[i], pg = d[i + 1], pb = d[i + 2];
        // red team 0xff3d63 family: bright red dominant, well above green,
        // blue present but below red (the pale-cyan glass tint does not match).
        if (pr > 100 && pg < pr * 0.6 && pb < pr * 0.95) {
          count++;
          const luma = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
          if (luma > bestLuma) {
            bestLuma = luma;
            sample = [pr, pg, pb];
          }
        }
      }
      return { count, sample };
    });
    if (r.count > best.count) best = r;
    if (best.count > 40) break;
    await page.waitForTimeout(150);
  }
  return best;
}

test('8: glass wall is see-through — red unit behind it is visible in canvas pixels', async ({ page }) => {
  const errors = trackErrors(page);
  await ready(page);
  await pinSeed(page);

  // Static pre-start scene: the fixed-tick loop only runs after start(), so
  // this placement cannot drift while frames present.
  //
  // maze-se-a (solid 27) is the GLASS maze wall: spans x 7..9, z 14..20, 0..3 m
  // high. Put the player 1.5 m south of it (spawn yaw π = facing north, i.e.
  // straight at the wall) and a red unit 1 m north of it. The view from the
  // player's eye (y 1.62) to the unit passes through the glass volume, so the
  // unit can only be seen THROUGH the wall.
  await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.teleport(0, 8, 21.5); // player, facing north, straight at the glass wall
    t.teleport(4, 8, 13); // red unit Raxx, just behind the glass wall
    [5, 6, 7].forEach((id) => t.teleport(id, -26, -20)); // park other reds far west, off-axis
  });

  await page.waitForTimeout(300); // let a few rendered frames present
  const red = await redPixelsInCentre(page);
  console.log('GLASS SEE-THROUGH RED PIXELS', JSON.stringify(red));
  expect(
    red.count,
    `a red unit behind the glass wall must be visible through it (sample ${red.sample.join(',')})`
  ).toBeGreaterThan(40);

  await page.screenshot({ path: 'screenshots/08-glass-see-through.png' });
  const real = errors.filter((e) => !GL_NOISE.test(e));
  expect(real, 'no real JS errors: ' + real.join(' | ')).toHaveLength(0);
});

// ---------------------------------------------------------------------------
interface MinimRed {
  count: number;
  sample: [number, number, number];
}
/** Count red-team-coloured (0xff3d63-ish) pixels in a small box of the
 *  MINIMAP canvas around the world position (wx, wz). Uses the same world ->
 *  minimap mapping as Renderer.drawMinimap (bounds ±30, 92% fit, centred).
 *  Samples several frames (headless rAF is throttled) and keeps the max. */
async function minimapRedCount(page: Page, wx: number, wz: number, box = 5): Promise<MinimRed> {
  let best: MinimRed = { count: 0, sample: [0, 0, 0] };
  for (let i = 0; i < 8; i++) {
    const r = await page.evaluate(
      (args: { wx: number; wz: number; box: number }): MinimRed => {
        const { wx, wz, box } = args;
        const mm = document.querySelector('canvas.nb-minimap') as HTMLCanvasElement;
        const S = mm.width;
        const span = 60; // map bounds are ±30 on both axes
        const scale = (S * 0.92) / span;
        const X = wx * scale + S / 2;
        const Y = wz * scale + S / 2;
        const x0 = Math.max(0, Math.floor(X - box / 2));
        const y0 = Math.max(0, Math.floor(Y - box / 2));
        const x1 = Math.min(S, Math.ceil(X + box / 2));
        const y1 = Math.min(S, Math.ceil(Y + box / 2));
        const d = mm.getContext('2d')!.getImageData(x0, y0, x1 - x0, y1 - y0).data;
        let count = 0;
        let sample: [number, number, number] = [0, 0, 0];
        let bestLuma = -1;
        for (let i = 0; i < d.length; i += 4) {
          const pr = d[i], pg = d[i + 1], pb = d[i + 2];
          // red team 0xff3d63: bright red dominant. The 14%-alpha spawn wedge,
          // blueprint lines and cyan own-team dots do NOT match this.
          if (pr > 100 && pg < pr * 0.6 && pb < pr * 0.95) {
            count++;
            const luma = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
            if (luma > bestLuma) {
              bestLuma = luma;
              sample = [pr, pg, pb];
            }
          }
        }
        return { count, sample };
      },
      { wx, wz, box }
    );
    if (r.count > best.count) best = r;
    if (best.count > 0) break;
    await page.waitForTimeout(150);
  }
  return best;
}

test('9: UX-12 minimap — enemy hidden behind the player, appears when in front', async ({ page }) => {
  const errors = trackErrors(page);
  await ready(page);
  await pinSeed(page); // seed 16 = Classic layout

  // Static pre-start scene (the fixed-tick loop only runs after start()), so
  // placements cannot drift while frames present.
  // Player at (0, 26) keeps the spawn yaw π (facing -Z / north). All three
  // blue teammates are parked far north, ≥ 57 m from the enemy spot — beyond
  // the 38 m vision radius — so only the PLAYER can contribute shared view.
  await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.teleport(0, 0, 26); // player, facing -Z
    t.teleport(1, 0, -28);
    t.teleport(2, -26, -28);
    t.teleport(3, 26, -28);
    t.teleport(4, 0, 29.5); // enemy 3.5 m BEHIND the player
    [5, 6, 7].forEach((id, i) => t.teleport(id, -10 + i * 10, -24)); // park rest of reds north
  });
  await page.waitForTimeout(300);

  // Behind: 180° off the player's facing, outside every vision cone — the
  // minimap must NOT mark it (the old always-draw minimap was a wallhack).
  const behind = await minimapRedCount(page, 0, 29.5);
  console.log('MINIMAP ENEMY BEHIND', JSON.stringify(behind));
  expect(behind.count, `enemy behind the player must NOT be on the minimap (sample ${behind.sample.join(',')})`).toBe(0);

  // In front: 6 m straight down the player's facing, clear line of sight —
  // the shared view now contains it and the minimap MUST mark it.
  await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.teleport(4, 0, 20);
  });
  const ahead = await minimapRedCount(page, 0, 20);
  console.log('MINIMAP ENEMY AHEAD', JSON.stringify(ahead));
  expect(ahead.count, `enemy straight ahead MUST appear on the minimap (sample ${ahead.sample.join(',')})`).toBeGreaterThan(0);

  await page.screenshot({ path: 'screenshots/09-minimap-vision.png' });
  const real = errors.filter((e) => !GL_NOISE.test(e));
  expect(real, 'no real JS errors: ' + real.join(' | ')).toHaveLength(0);
});

// ---------------------------------------------------------------------------
interface SkySample {
  meanR: number;
  meanG: number;
  meanB: number;
  luma: number;
}
/** Mean channel values of a horizontal band of the WebGL canvas (defaults to
 *  the UPPER band: with the camera pitched to the zenith this is pure sky).
 *  With `store=true` also stashes the raw pixels on window for a later diff.
 *  preserveDrawingBuffer:true makes the in-page drawImage read reliable. */
async function sampleSkyBand(
  page: Page,
  y0: number,
  y1: number,
  store: boolean
): Promise<SkySample> {
  return page.evaluate(
    ([y0, y1, store]) => {
      const gl = document.getElementById('webgl-canvas') as HTMLCanvasElement;
      const c = document.createElement('canvas');
      c.width = gl.width;
      c.height = gl.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(gl, 0, 0);
      const xa = 0;
      const ya = Math.floor(c.height * y0);
      const w = c.width;
      const h = Math.max(1, Math.ceil(c.height * y1) - ya);
      const d = ctx.getImageData(xa, ya, w, h).data;
      if (store) {
        (window as unknown as Record<string, unknown>).__skyPrev = d;
      }
      let r = 0,
        g = 0,
        b = 0,
        luma = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
        luma += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
      const n = d.length / 4;
      return { meanR: r / n, meanG: g / n, meanB: b / n, luma: luma / n };
    },
    [y0, y1, store] as [number, number, boolean]
  );
}

/** Count pixels in the band (y0..y1) that differ from the previously stored
 *  `__skyPrev` frame by more than `eps` per-channel sum. */
async function diffAgainstStoredSky(
  page: Page,
  y0: number,
  y1: number,
  eps: number
): Promise<number> {
  return page.evaluate(
    ([y0, y1, eps]) => {
      const prev = (window as unknown as { __skyPrev?: Uint8ClampedArray }).__skyPrev!;
      const gl = document.getElementById('webgl-canvas') as HTMLCanvasElement;
      const c = document.createElement('canvas');
      c.width = gl.width;
      c.height = gl.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(gl, 0, 0);
      const ya = Math.floor(c.height * y0);
      const w = c.width;
      const h = Math.max(1, Math.ceil(c.height * y1) - ya);
      const d = ctx.getImageData(0, ya, w, h).data;
      let changed = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const dr = Math.abs(d[i] - prev[i]);
        const dg = Math.abs(d[i + 1] - prev[i + 1]);
        const db = Math.abs(d[i + 2] - prev[i + 2]);
        if (dr + dg + db > eps) changed++;
      }
      void n;
      return changed;
    },
    [y0, y1, eps] as [number, number, number]
  );
}

/** Point the player's camera ~50° up and let a rendered frame present.
 *  Pre-start scene: the fixed-tick loop does not run, so the camera stays
 *  exactly where we put it. At ~50° pitch the WHOLE frame is sky (FOV 78°:
 *  top edge ≈ 89° elevation, bottom edge ≈ 13° — the zenith sits at the
 *  screen centre), so the upper band is near-zenith sky and the lower band
 *  sits close to the pale horizon. */
async function lookAtSky(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.teleport(0, 0, 20);
    // pitch = clamp(pitch - dy * 0.0022, -1.35, 1.35): dy -409 -> pitch ≈ +0.9
    // rad (~51.5°) above the horizon (a NEGATIVE dy pitches UP).
    t.mouseTurn(0, -409);
  });
  await page.waitForTimeout(300); // let a few rendered frames present
}

test('10: ART-05 sky — blue gradient overhead, clouds drift, frozen under reduced motion', async ({ page }) => {
  const errors = trackErrors(page);
  await ready(page);
  await pinSeed(page);
  await lookAtSky(page);

  // --- The upper half is SKY: blue channel mean well above red channel mean
  // (the old flat 0x05070b background had R≈B≈8 and luma ≈ 8). The upper
  // band (near zenith) is dominated by the deep blue. ---
  const sky = await sampleSkyBand(page, 0.02, 0.48, false);
  console.log('SKY UPPER BAND', JSON.stringify(sky));
  expect(
    sky.meanB - sky.meanR,
    `looking up must be BLUE sky, not black/warm (R=${sky.meanR.toFixed(1)} B=${sky.meanB.toFixed(1)})`
  ).toBeGreaterThan(20);
  expect(
    sky.luma,
    `the upper band must be clearly brighter than the old near-black background (luma ~8) — got ${sky.luma.toFixed(1)}`
  ).toBeGreaterThan(28);
  // The gradient: the lower band (near the horizon at this pitch) reads
  // brighter than the zenith band — deep-blue zenith -> pale horizon.
  const horizonBand = await sampleSkyBand(page, 0.6, 0.92, false);
  console.log('SKY HORIZON BAND', JSON.stringify(horizonBand));
  expect(
    horizonBand.luma - sky.luma,
    `horizon must be paler/brighter than zenith (horizon ${horizonBand.luma.toFixed(1)} vs zenith ${sky.luma.toFixed(1)})`
  ).toBeGreaterThan(5);

  await page.screenshot({ path: 'screenshots/10-sky.png' });

  // --- Drifting clouds: store the whole sky frame, advance the sky
  // deterministically via the hook (independent of throttled headless rAF),
  // then the same band must differ by a real number of pixels — the clouds
  // moved. ---
  await sampleSkyBand(page, 0.05, 0.9, true);
  await page.evaluate(() => (
    (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest.fastForwardSky(3.0)
  ));
  const drifted = await diffAgainstStoredSky(page, 0.05, 0.9, 12);
  const totalPx = await page.evaluate(() => {
    const gl = document.getElementById('webgl-canvas') as HTMLCanvasElement;
    return Math.ceil(gl.height * 0.85) * gl.width;
  });
  console.log('SKY DRIFT', JSON.stringify({ drifted, totalPx }));
  expect(
    drifted,
    `clouds must be drifting (only ${drifted} of ${totalPx} band pixels changed after 3s of sky time)`
  ).toBeGreaterThan(totalPx * 0.005);

  // --- Reduced motion: same setup, clouds stay ON SCREEN but do not move.
  // A 3-second sky advance must change (essentially) no pixels. ---
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  await pinSeed(page);
  await lookAtSky(page);
  const rm = await sampleSkyBand(page, 0.05, 0.9, true);
  expect(rm.meanB - rm.meanR, 'reduced-motion: the sky must still be blue').toBeGreaterThan(20);
  await page.evaluate(() => (
    (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest.fastForwardSky(3.0)
  ));
  const frozen = await diffAgainstStoredSky(page, 0.05, 0.9, 12);
  console.log('SKY REDUCED MOTION', JSON.stringify({ frozen, totalPx }));
  expect(
    frozen,
    `under prefers-reduced-motion the clouds must be static (${frozen} of ${totalPx} band pixels changed after 3s)`
  ).toBeLessThan(totalPx * 0.001);

  const real = errors.filter((e) => !GL_NOISE.test(e));
  expect(real, 'no real JS errors: ' + real.join(' | ')).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// ART-06: measurable brightness floor for the daylight arena.
//
// The reviewer's probe (and this test) use the EXACT same instrumentation:
//   seed 20260212 (the app's default seed), player teleported to (0, 20)
//   facing the centre (spawn yaw π = facing -Z = straight at the centre),
//   WebGL canvas resampled to 320×180,
//   L = 0.2126R + 0.7152G + 0.0722B.
// Before ART-06 that probe measured meanLuma 21.4, darkFrac 0.748, 2 non-
// empty histogram buckets and no pixel above L=96. The floors below are the
// numbers the task commits to — they live in the TEST, not the commit message.
interface Art06Probe {
  meanLuma: number;
  darkFrac: number; // fraction of pixels with L < 32
  buckets: number[]; // 8 histogram buckets, 32 luma wide each
  nonEmptyBuckets: number;
  meanR: number;
  meanB: number;
}
async function art06Probe(page: Page): Promise<Art06Probe> {
  // The pre-start scene is static (the fixed-tick loop only runs after
  // start()), so every sampled frame is the same settled view; sample a few
  // anyway because headless rAF is throttled and the first frame after the
  // teleport may not have presented yet. Keep the brightest (settled) one.
  let best: Art06Probe = { meanLuma: 0, darkFrac: 1, buckets: [0, 0, 0, 0, 0, 0, 0, 0], nonEmptyBuckets: 0, meanR: 0, meanB: 0 };
  for (let i = 0; i < 6; i++) {
    const p = await page.evaluate((): Art06Probe => {
      const gl = document.getElementById('webgl-canvas') as HTMLCanvasElement;
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 180;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(gl, 0, 0, 320, 180);
      const d = ctx.getImageData(0, 0, 320, 180).data;
      const n = d.length / 4;
      let sumL = 0, sumR = 0, sumB = 0, dark = 0;
      const buckets = [0, 0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sumL += L;
        sumR += r;
        sumB += b;
        if (L < 32) dark++;
        buckets[Math.min(7, Math.floor(L / 32))]++;
      }
      return {
        meanLuma: sumL / n,
        darkFrac: dark / n,
        buckets,
        nonEmptyBuckets: buckets.filter((x) => x > 0).length,
        meanR: sumR / n,
        meanB: sumB / n,
      };
    });
    if (p.meanLuma > best.meanLuma) best = p;
    await page.waitForTimeout(150);
  }
  return best;
}

test('11: ART-06 daylight arena — measurable brightness floor, no over-warm cast', async ({ page }) => {
  const errors = trackErrors(page);
  await ready(page);
  await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.seed(20260212); // the reviewer probe's seed (= the app default)
    t.teleport(0, 0, 20); // facing the centre: spawn yaw π = facing -Z
  });
  await page.waitForTimeout(300); // let a few settled frames present

  const probe = await art06Probe(page);
  console.log('ART-06 PROBE', JSON.stringify(probe));

  // 1. Mean luminance floor: the pre-ART-06 frame measured 21.4.
  expect(
    probe.meanLuma,
    `meanLuma must be ≥ 90 (the pre-ART-06 frame measured 21.4) — got ${probe.meanLuma.toFixed(1)}`
  ).toBeGreaterThanOrEqual(90);

  // 2. Dark-fraction ceiling: fraction of pixels below L=32 (was 0.748).
  expect(
    probe.darkFrac,
    `darkFrac (L<32) must be ≤ 0.15 (was 0.748) — got ${probe.darkFrac.toFixed(3)}`
  ).toBeLessThanOrEqual(0.15);

  // 3. Luminance spread: at least 4 of the 8 histogram buckets (width 32)
  // must be non-empty — a lit scene, not a flat wash.
  expect(
    probe.nonEmptyBuckets,
    `at least 4 of 8 histogram buckets (width 32) must be non-empty (buckets ${probe.buckets.join(',')})`
  ).toBeGreaterThanOrEqual(4);

  // 4. Over-warm guard (the ART-04 lesson): the whole frame's red-minus-blue
  // channel mean must stay ≤ 40 — sunlit sand alone is warm, so the sky
  // contribution must keep the balance honest.
  expect(
    probe.meanR - probe.meanB,
    `mean(R)-mean(B) must be ≤ 40 (warm-neutral daylight, not an orange cast) — got ${(probe.meanR - probe.meanB).toFixed(1)} (R=${probe.meanR.toFixed(1)} B=${probe.meanB.toFixed(1)})`
  ).toBeLessThanOrEqual(40);

  // 5. Team identity is not sacrificed to the brightness: on this same
  // daylight frame a red unit placed on a sight-clear spot inside the central
  // screen band must still read as red-team-coloured pixels (same 0xff3d63-
  // family classifier the glass test uses).
  const placed = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    const spot = t.findCenterViewSpot();
    if (spot) t.teleport(4, spot.x, spot.z);
    [5, 6, 7].forEach((id) => t.teleport(id, -26, -24)); // park the rest off-axis
    return spot;
  });
  expect(placed, 'a sight-clear spot in the player\u2019s view band must exist on this seed').not.toBeNull();
  await page.waitForTimeout(300);
  const red = await redPixelsInCentre(page);
  console.log('ART-06 RED UNIT ON SAND', JSON.stringify(red));
  expect(
    red.count,
    `a red unit (0xff3d63) on the sand must stay clearly team-readable (sample ${red.sample.join(',')})`
  ).toBeGreaterThan(40);

  await page.screenshot({ path: 'screenshots/11-daylight.png' });
  const real = errors.filter((e) => !GL_NOISE.test(e));
  expect(real, 'no real JS errors: ' + real.join(' | ')).toHaveLength(0);
});

// ---------------------------------------------------------------------------
test('12: AUD-01 footstep — walking increments the trigger counter, standing still does not', async ({ page }) => {
  const errors = trackErrors(page);
  await ready(page);
  await pinSeed(page);

  // We do NOT assert on the sound itself (headless AudioContext never runs and
  // audio is intentionally environment/cue-quiet). Instead we assert on the
  // pure trigger counter exposed on the test hooks: it must grow with
  // distance travelled while grounded, and stop growing when the player stands
  // still.
  const res = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.start();
    t.teleport(0, -3, 24); // clear south lane, facing north
    const baseline = t.footstepCount();

    // Walk a distance: holding W for 1.5s covers several strides at walk speed.
    t.input('KeyW', true);
    t.fastForward(1.5);
    t.input('KeyW', false);
    const afterMove = t.footstepCount();
    const movedZ = t.state().units[0].pos.z;

    // Now stand still: no input, advance the sim again — the counter must NOT
    // grow while the player is not moving.
    t.fastForward(1.5);
    const afterStill = t.footstepCount();
    const stillZ = t.state().units[0].pos.z;

    return { baseline, afterMove, afterStill, movedZ, stillZ };
  });

  // The player actually travelled (so the trigger has real distance to spend).
  expect(res.movedZ, 'holding W should move the player forward').toBeLessThan(24 - 1);

  expect(
    res.afterMove - res.baseline,
    'walking a distance while grounded must fire footstep triggers'
  ).toBeGreaterThan(0);

  expect(
    res.stillZ,
    'releasing W should stop the player'
  ).toBeCloseTo(res.movedZ, 0);

  expect(
    res.afterStill,
    'standing still must not fire any further footstep triggers'
  ).toBe(res.afterMove);

  const real = errors.filter((e) => !GL_NOISE.test(e));
  expect(real, 'no real JS errors: ' + real.join(' | ')).toHaveLength(0);
});
