# Neon Bastion — 4v4 Neon Arena FPS

A complete, **self-contained, no-backend, no-CDN** browser FPS. One human (Vega) + 3
AI teammates vs 4 AI opponents on a symmetric neon arena. Every byte is local: the
engine, the map, the AI, the audio (synthesized WebAudio) and the text (a system
monospace stack — **no external font request**) all ship from `src/`.

Build with Vite, run with a static file server, test with Vitest (unit) and Playwright
(E2E, SwiftShader WebGL in headless Chromium).

## Status

Playable and tested. The fixed-tick sim, navmesh AI, and rendering are implemented and
covered by 38 unit tests and 6 Playwright E2E scenarios. Two rounds of design review
blocker and P2 items have been addressed — see [What changed in this pass](#what-changed-in-this-pass).

## Controls

The table below is 1:1 with `applyKey()` in `src/app.ts` — every row is a real
binding, and every real binding is listed.

| Input | Action |
|---|---|
| `WASD` / arrows | Move |
| Mouse | Aim (pointer-locked) |
| Left click | Fire (full-auto pulse rifle, hold to keep firing) |
| `Shift` | Sprint (1.56× speed, subtle FOV push + head bob) |
| `Space` | Jump |
| `R` | Reload |
| `Q` / `E` | Spectate previous / next ally (after you die) |
| `Esc` | Release the mouse / open the pause screen |
| `F2` | Director mode (score-only overlay, hides all match chrome) |
| `F3` / `` ` `` | Toggle the debug panel (units, AI states, perf) |

Not yet implemented (honest list): crouch, melee, weapon switching, Tab leaderboard
hold, `P` pause, `M` mute.

Deploy / resume / restart are on-screen buttons (the deploy button also requests pointer
lock, which the browser requires a user gesture for).

## What's implemented

- **Gameplay** — hitscan full-auto pulse rifle (body 20 / head 50, i.e. headshot ×2.5),
  30-round mag + 90 reserve, reload, 8 units, team-elimination win, and a results
  screen with a per-unit board sorted by score. Full-auto is per spec (the brief
  calls for an automatic rifle); fire rate is ~11.7 rounds/s.
- **Deterministic sim** — a fixed 60 Hz tick. Same seed ⇒ same input stream ⇒ same
  match. Damage and score are pure functions of the sim, so the leaderboard is exact.
- **Navmesh AI** — a 29-node graph (A\*) with line-of-sight routing. States:
  `idle → patrol → alert → combat → cautious` (and a final `advancing` last-man stance).
  `alert` means the unit heard a shot/footstep and walks a navmesh route to investigate;
  combat uses a waypoint approach, strafing, burst fire with inaccuracy, and an alert
  timer so a unit that loses sight de-escalates instead of chasing forever.
- **Spectating** — on death you spectate your living allies (Q / E cycles), then a free
  orbit camera once your team is wiped.
- **Renderer** — three.js, a desaturated "night facility" environment (cool grey walls,
  warm sodium lamps, one-lane lighting) so the only saturated colours are the team
  identity (cyan vs magenta) and hit feedback (gold). Muzzle flash, additive tracers
  (fired from the muzzle, not the eye, so your own fire is visible) and impact sparks
  (unit hits AND wall hits), a live blueprint minimap (units as filled/hollow dots +
  team spawn wedges), fog, and ACES filmic tonemapping with a brightness floor
  (ambient + 6 sodium lamps) so the scene stays legible.
- **Audio** — fully synthesized (fire, impact, headshot, reload, UI, ambient hum); no
  assets.
- **No backend** — the whole match runs client-side; "restart" just reseeds the RNG.

## What changed in this pass

Addressing a design/code review:

- **`alert` AI state** — previously a unit that heard a shot but saw no enemy would
  freeze in `cautious`/`patrol` and never close in. It now walks a navmesh route to the
  sound, then re-evaluates. A regression test runs full matches on 3 seeds and asserts
  they always terminate (no stalemate).
- **Hit feedback** — a hitmarker (X ticks + headshot flag), a floating damage number at
  the hit point, and a brief gold hit-flash on the victim, all driven by real sim events
  (not a cosmetic fake).
- **Spectator before end** — the spectator target is recomputed when a player dies,
  before the match-end check, so dying players are never left on a stale camera.
- **No-WebGL fallback** — if WebGL is unavailable (or `?nogl=1`), the page shows a
  legible 2D status + control list and still runs the deterministic match headlessly.
  It never renders a blank screen.
- **Results overlap fix** — the results screen now hides the in-match HUD chrome
  (score bar, leaderboard, minimap, crosshair) so nothing overlaps.
- **Director mode (`F2`)** and a **debug panel (`F3` / `` ` ``)** for observing AI and
  perf without the match UI.
- **Reduced motion** — honours `prefers-reduced-motion` (freezes the spectator orbit,
  shortens tracers, halves impact sparks) with CSS + JS hooks.
- **E2E coverage** — grew from 3 smoke checks to 6 scenarios covering deploy+move+wall,
  body/head scoring + hitmarker, death→spectate→free-camera, win→freeze→results→restart,
  seeded-AI-termination + invariants, and the no-WebGL fallback.

## What changed after the round-2 review (manual-play fixes)

A human play session found issues the automated suite structurally could not (see the
methodology note in the review). All fixed, each with a regression test:

- **Overlay text was unreadable (P1)** — the start/pause/results screen was attached
  to `#app` instead of `.nb-root`, so it inherited none of the design tokens and
  rendered as pure black Times on a near-black background. One-line fix: the screen
  is now a child of `.nb-root`. The E2E now asserts the *computed* colour and
  font-family of the results title, so black-on-black fails the suite.
- **A/D strafe was inverted (P1)** — screen-right is `f × up = (-cos θ, sin θ)`;
  the code had its negation, so A strafed right and D strafed left. Fixed in
  `match.ts` + a pure-logic unit test (`tests/unit/movement.test.ts`) asserting
  D moves to screen-right at four headings, plus a D-strafe check in the E2E.
- **Combat feedback was invisible (P1)** — tracers now start at the muzzle
  (a line from the FPV eye projects to a screen-centre dot and can't be seen),
  tracer life doubled (0.09s → 0.18s via `CONFIG.tracerLife`), a real muzzle flash
  was implemented (`CONFIG.muzzleLife` was a dead constant), and wall hits now
  spark too (previously only unit hits did).
- **Scene was too dark in real play (P2)** — exposure 1.15 → 1.5, walls
  `#1A1D22` → `#23272E`, a new `AmbientLight` brightness floor, and 6 sodium lamps
  at 220 intensity (was 4 at 150).
- **README documented 6 controls that don't exist (P1)** — the controls table is
  now 1:1 with `applyKey()` (Space=jump, Q/E=spectate, no crouch/melee/weapons/
  Tab/P/M), and the "What's implemented" section no longer claims melee, crouch,
  first-to-30, a 90 s clock, a countdown, or a *sortable* board.
- **Sprint is now perceptible** — smooth FOV push (78° → 85°) and a subtle head bob
  while sprinting (the sim already had a 1.56× speed; nothing signalled it).
- **E2E "arena rendered" assertion hardened (P2)** — the old "screenshot bytes > 20 KB"
  proxy was defeated by the rich HUD (a page whose 3D scene is all-black still
  compresses large). The suite now reads the WebGL canvas pixels directly
  (`preserveDrawingBuffer` makes the in-page read reliable) and asserts a minimum
  fraction of non-background pixels, from a camera position facing the central
  platform.

## Architecture

```
src/
  app.ts            orchestrates: boot, input, rAF render, fixed-tick loop, screens
  render/
    renderer.ts     three.js scene: arena, units, tracers/sparks, minimap, camera
    hud.ts          DOM overlay: score, crosshair, hitmarker, damage, debug, results
  game/
    constants.ts    all tunables in one place
    types.ts        shared types
    rng.ts          deterministic seeded RNG (mulberry32) + hashing
    match.ts        Match: owns units/weapon/spectator, the fixed tick, events
    units/units.ts  unit factory + body-AABB / head-sphere hitboxes
    combat/weapon.ts  ammo, fire intervals, reload, spread
    combat/hitscan.ts ray vs AABB (map) + sphere (head/torso), nearest hit wins
    map/mapData.ts  procedural layout (data-driven, no image assets)
    map/geometry.ts  raycasts, ground height, walkability checks
    map/navmesh.ts  nav graph (LOS-derived links) + A* pathfinding
    map/movement.ts  gravity, wall collision, ground follow
    ai/             perception (LOS/hearing), controller (state machine),
                    spectator target resolution
    audio.ts        synthesized SFX + ambience
  testHooks.ts      window.__teamArenaTest (E2E + manual inspection API)
```

## Testing

**Unit (`npx vitest run`)** — 38 tests:
- geometry (solids, navmesh links)
- hitscan (AABB + head/torso spheres, nearest-hit)
- pathing (A\* finds connected routes, none when disconnected)
- movement (**strafe direction regression**: D moves to screen-right at four
  headings, A is its mirror, strafing is pure lateral)
- match (damage/hitbox head-vs-body scoring, **the scoring invariant**
  `totalScore === hitScore + 3×kills` across every unit)
- ai (patrol→combat escalation, de-escalation, alert, **full-match termination on
  3 seeds** with the invariant + no-negative-HP + a winner asserted)

**E2E (`npx playwright test`)** — 6 scenarios in real headless Chromium (SwiftShader
WebGL, `?nogl=1` for the fallback). They drive the game through the public test hooks
(`window.__teamArenaTest`) so they are deterministic — no image matching, no flaky
AI-wins. See [test hooks](#test-hooks).

```
npm run build && npm test          # typecheck, unit, e2e
npm run test:unit                  # vitest only
npm run test:e2e                   # playwright only
npm run test:all                   # unit + e2e
```

## Test hooks

`window.__teamArenaTest` exposes a deterministic API used by the E2E suite (and handy
for manual inspection in the DevTools console):

```js
__teamArenaTest.seed(7)            // pin the RNG seed (returns current if no arg)
__teamArenaTest.start()            // deploy
__teamArenaTest.state()            // full match snapshot (units, scores, state, spectator)
__teamArenaTest.shoot({x,y,z})     // fire with an explicit aim vector (deterministic hit)
__teamArenaTest.applyDamage(victimId, amount, causeId?)
__teamArenaTest.teleport(unitId, x, z)
__teamArenaTest.fastForward(seconds)  // run the fixed-tick loop synchronously
__teamArenaTest.forceSpectate()    // kill the player, enter spectator
__teamArenaTest.playAgain(seed?)   // restart (optionally reseed)
__teamArenaTest.repaintHud()       // force the (throttled) leaderboard to repaint
```

## How to run

```
npm install
npm run build        # typecheck + vite build -> dist/
npm run preview      # static server on :4173, then open http://localhost:4173
```

`npm run dev` serves the Vite dev build on `:5173` for iteration.

## Known limitations

- **Headless pointer lock** — headless Chromium does not grant pointer lock even on a
  real click gesture. The game *requests* it (the E2E asserts the request fires); on a
  real browser the lock is granted and the mouse aims normally. The E2E drives aim via
  `__teamArenaTest.mouseTurn()` instead, which is what matters for the sim.
- **Headless rAF is throttled** — in headless Chromium `requestAnimationFrame` fires at
  a few Hz, so the E2E suite advances the sim deterministically via
  `fastForward()`/`shoot()` (synchronous) rather than relying on the render loop, and
  polls for a real presented frame when it checks the canvas is not blank.
- **Bundle size** — three.js is large, so the single production chunk is ~580 kB
  (~150 kB gzip). That is expected for a 3D game and Vite warns about it; it is not
  split because the renderer is needed immediately on load.
- **AI is competent, not competitive** — the AI fights and matches terminate, but it is
  tuned for "a fair, watchable fight," not for beating a skilled human.
