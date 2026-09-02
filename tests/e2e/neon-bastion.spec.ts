// ============================================================================
// Neon Bastion — Playwright E2E (5 scenarios, 4 real-game screenshots)
// ----------------------------------------------------------------------------
// These drive the REAL built app (vite preview) in headless Chromium with
// WebGL (SwiftShader). Logic is advanced deterministically through the
// window.__teamArenaTest hooks (fastForward / teleport / shoot / applyDamage /
// forceSpectate / restart), so the assertions are stable and network-free.
// Four screenshots of the real rendered game are saved to screenshots/.
//
// NOTE: page.evaluate serializes only its callback, so inside each callback we
// access the hooks via `window.__teamArenaTest` directly (no free vars).
// ============================================================================

import { test, expect } from '@playwright/test';

type U = {
  id: number;
  hp: number;
  alive: boolean;
  mag: number;
  totalScore: number;
  pos: { x: number; y: number; z: number };
};
type Snap = {
  now: number;
  state: string;
  winner: 'blue' | 'red' | null;
  spectate: { mode: string; targetId: number | null };
  units: U[];
};

/** Sample the WebGL canvas and return color-diversity stats (guards against a
 *  blank/solid render being mistaken for a valid frame). */
async function frameStats(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const c = document.getElementById('webgl-canvas') as HTMLCanvasElement;
    const tmp = document.createElement('canvas');
    tmp.width = c.width;
    tmp.height = c.height;
    const ctx = tmp.getContext('2d')!;
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
    const total = tmp.width * tmp.height;
    const q = new Map<string, number>();
    for (let i = 0; i < d.length; i += 4) {
      const key = (d[i] >> 5) + ',' + (d[i + 1] >> 5) + ',' + (d[i + 2] >> 5);
      q.set(key, (q.get(key) ?? 0) + 1);
    }
    let maxc = 0;
    for (const v of q.values()) maxc = Math.max(maxc, v);
    return { distinct: q.size, maxShare: maxc / total };
  });
}

const GL_NOISE = /GL|WebGL|SwiftShader|fallback|GPU|driver|ANGLE|Vulkan/i;

// ---------------------------------------------------------------------------
test('1: boots, shows HUD + start screen, renders the 3D arena', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();

  // Start screen.
  await expect(page.locator('.nb-screen')).toBeVisible();
  await expect(page.locator('.nb-title')).toHaveText('NEON BASTION');

  // HUD is present behind the start screen.
  await expect(page.locator('.nb-hp')).toBeVisible();
  await expect(page.locator('.nb-ammo')).toBeVisible();
  await expect(page.locator('.nb-board')).toBeVisible();
  await expect(page.locator('.nb-team')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(2); // webgl + minimap

  // Deploy.
  await page.evaluate(() => (window as any).__teamArenaTest.start());
  await expect(page.locator('.nb-screen')).toBeHidden();
  await page.waitForTimeout(500);

  const stats = await frameStats(page);
  console.log('ARENA PIXELS', JSON.stringify(stats));
  expect(stats.distinct, 'arena should render with multiple colors').toBeGreaterThan(8);
  expect(stats.maxShare, 'arena should not be a single flat color').toBeLessThan(0.9);

  await page.screenshot({ path: 'screenshots/01-arena.png' });

  const real = errors.filter((e) => !GL_NOISE.test(e));
  expect(real, 'no real JS errors: ' + real.join(' | ')).toHaveLength(0);
});

// ---------------------------------------------------------------------------
test('2: AI combat runs; the player weapon fires', async ({ page }) => {
  await page.goto('/');
  const init = await page.evaluate((): Snap => {
    const t = (window as any).__teamArenaTest;
    t.start();
    return t.state();
  });

  // Player can shoot (alive right after deploy): firing consumes ammo.
  const shot = await page.evaluate(() => {
    const t = (window as any).__teamArenaTest;
    const m0 = t.state().units[0].mag;
    const r = t.shoot({ x: 0, y: 0, z: -1 });
    const m1 = t.state().units[0].mag;
    return { m0, m1, fired: r != null };
  });
  expect(shot.fired).toBe(true);
  expect(shot.m1).toBeLessThan(shot.m0);

  // Let the AI fight for ~12 logic-seconds.
  await page.evaluate(() => (window as any).__teamArenaTest.fastForward(12));
  const combat = await page.evaluate((): Snap => (window as any).__teamArenaTest.state());

  const moved = combat.units.some(
    (u, i) => Math.hypot(u.pos.x - init.units[i].pos.x, u.pos.z - init.units[i].pos.z) > 2,
  );
  expect(moved, 'units should move during combat').toBe(true);

  const damaged = combat.units.some((u) => u.hp < 100);
  const scored = combat.units.some((u) => u.totalScore > 0);
  expect(damaged || scored, 'combat should produce damage or score').toBe(true);

  await page.waitForTimeout(250);
  await page.screenshot({ path: 'screenshots/02-combat.png' });
});

// ---------------------------------------------------------------------------
test('3: death switches the player to spectator', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const t = (window as any).__teamArenaTest;
    t.start();
    t.forceSpectate();
  });
  await page.waitForTimeout(250);

  const st = await page.evaluate((): Snap => (window as any).__teamArenaTest.state());
  expect(st.units[0].alive).toBe(false);
  expect(st.spectate.mode).not.toBe('alive');

  // The spectator bar is shown.
  await expect(page.locator('.nb-spectate')).toBeVisible();
  const bar = await page.locator('.nb-spectate').textContent();
  expect(bar ?? '').toMatch(/SPECTATING|FREE CAMERA/i);

  await page.screenshot({ path: 'screenshots/03-spectator.png' });
});

// ---------------------------------------------------------------------------
test('4: match ends -> results -> restart resets state', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const t = (window as any).__teamArenaTest;
    t.start();
    // Blue unit 0 scores the kill on every red -> red team wiped -> blue wins.
    [4, 5, 6, 7].forEach((id) => t.applyDamage(id, 999, 0));
  });
  await page.waitForTimeout(250);

  const st = await page.evaluate((): Snap => (window as any).__teamArenaTest.state());
  expect(st.state).toBe('ended');
  expect(st.winner).toBe('blue');

  await expect(page.locator('.nb-res-title')).toBeVisible();
  await expect(page.locator('.nb-res-title')).toHaveText('BLUE WINS');
  await page.screenshot({ path: 'screenshots/04-results.png' });

  // Restart via the results CTA.
  await page.locator('.nb-cta').click();
  await page.waitForTimeout(250);
  const st2 = await page.evaluate((): Snap => (window as any).__teamArenaTest.state());
  expect(st2.state).toBe('running');
  expect(st2.units.every((u) => u.alive && u.hp === 100)).toBe(true);
  await expect(page.locator('.nb-screen')).toBeHidden();
});

// ---------------------------------------------------------------------------
test('5: hitscan respects wall occlusion (no through-wall damage)', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(() => {
    const t = (window as any).__teamArenaTest;
    t.start();
    const hp = (id: number) => t.state().units.find((u: U) => u.id === id).hp;

    // Blocked: player south-centre, red far north. The 3m central column at
    // (0,13) sits between them on the x=0 line and stops the bullet.
    t.teleport(0, 0, 24);
    t.teleport(4, 0, -24);
    const beforeA = hp(4);
    t.shoot({ x: 0, y: 0, z: -1 });
    const afterA = hp(4);

    // Elapse the weapon cooldown, then a clear line of fire just ahead.
    t.fastForward(0.3);
    t.teleport(0, 0, 24);
    t.teleport(4, 0, 20);
    t.shoot({ x: 0, y: 0, z: -1 });
    const afterB = hp(4);

    return { beforeA, afterA, afterB };
  });

  expect(r.afterA, 'the wall should block the shot (no damage)').toBe(r.beforeA);
  expect(r.afterB, 'the clear shot should deal damage').toBeLessThan(r.afterA);
});
