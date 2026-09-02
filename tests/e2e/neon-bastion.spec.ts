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
// Seven screenshots of the real rendered game are saved to screenshots/.
// ============================================================================

import { test, expect } from '@playwright/test';

type U = {
  id: number;
  name: string;
  team: 'blue' | 'red';
  isPlayer: boolean;
  alive: boolean;
  hp: number;
  pos: { x: number; y: number; z: number };
  yaw: number;
  mag: number;
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
  start: () => void;
  playAgain: () => void;
  restart: (s?: number) => void;
  input: (key: string, down: boolean) => void;
  shoot: (dir?: { x: number; y: number; z: number }) => unknown;
  applyDamage: (victimId: number, amount: number, causeId?: number) => void;
  simulateHitOnPlayer: (causeId: number, part?: 'head' | 'body') => void;
  cameraKicks: () => { kickYaw: number; kickPitch: number; recoil: number; recoilCharge: number };
  teleport: (unitId: number, x: number, z: number) => void;
  fastForward: (seconds: number) => void;
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
  // player to (5, 16), a position with a clear sight line onto the central
  // platform (the south column at (0,13) would otherwise block the view from
  // (0,20)), so the screenshot shows the opening central zone.
  await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.teleport(0, 5, 16); // facing north (spawn yaw) = straight at the platform
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

  // --- Head hit: advance the fire cooldown, re-place target, aim at the head. ---
  const head = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.fastForward(0.15); // > fireInterval (0.085s) so the player may fire again
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
  expect(head.hp4, 'headshot should remove 50 HP').toBe(head.before - 50);

  // --- Wall-blocked: column between the player and the target -> no damage. ---
  const blocked = await page.evaluate(() => {
    const t = (window as unknown as { __teamArenaTest: Hooks }).__teamArenaTest;
    t.fastForward(0.15);
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
    t.fastForward(0.15); // past fireInterval so the 2nd/3rd shots fire
    t.shoot({ x: 0, y: 0, z: -1 });
    t.fastForward(0.15);
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
