// DOM-based HUD: crosshair + hitmarker, HP/ammo, team totals, leaderboard,
// killfeed, spectator bar, floating damage numbers, a full debug panel, center
// messages, and the start / pause / result screens. Everything is derived from
// the live Match plus a few event calls.
//
// Type system (see design review): two distinct voices. NUMBERS (HP, ammo,
// score, FPS, debug) are monospaced + tabular so they never jitter. CALL-OUTS
// (title, kill feed, spectate, results, flash) are heavy, tracked, uppercase —
// a stencilled military-plate voice. Saturation is reserved for team identity
// (cyan / magenta) and hit feedback (gold).

import type { Match } from '../game/match';
import type { KillFeedItem } from '../game/match';
import type { Vec3 } from '../game/types';

const CSS = `
.nb-root{position:fixed;inset:0;pointer-events:none;z-index:10;user-select:none;
  --cyan:#18e0ff; --red:#ff3d63; --gold:#ffd24a; --ink:#e6eefb;
  --data:ui-monospace,'SF Mono','Cascadia Mono',Menlo,Consolas,monospace;
  font-family:system-ui,'Segoe UI',sans-serif;color:var(--ink);}
.nb-panel{background:rgba(8,11,18,.55);border:1px solid rgba(90,140,220,.22);backdrop-filter:blur(3px);border-radius:6px;}
.nb-num{font-family:var(--data);font-variant-numeric:tabular-nums;}

/* crosshair */
.nb-cross{position:absolute;left:50%;top:50%;width:22px;height:22px;transform:translate(-50%,-50%);}
.nb-cross::before,.nb-cross::after{content:'';position:absolute;background:rgba(232,244,255,.9);box-shadow:0 0 6px rgba(24,224,255,.6);}
.nb-cross::before{left:50%;top:0;width:2px;height:100%;transform:translateX(-50%);}
.nb-cross::after{top:50%;left:0;height:2px;width:100%;transform:translateY(-50%);}

/* hitmarker: 4 diagonal ticks, driven from JS (rise-then-fade) */
.nb-hitmark{position:absolute;left:50%;top:50%;width:0;height:0;transform:translate(-50%,-50%);opacity:0;color:#fff;}
.nb-hitmark i{position:absolute;left:-4px;top:-1px;width:8px;height:2px;background:currentColor;box-shadow:0 0 5px currentColor;}
.nb-hitmark i:nth-child(1){transform:translate(5px,-5px) rotate(45deg);}
.nb-hitmark i:nth-child(2){transform:translate(-5px,5px) rotate(45deg);}
.nb-hitmark i:nth-child(3){transform:translate(-5px,-5px) rotate(-45deg);}
.nb-hitmark i:nth-child(4){transform:translate(5px,5px) rotate(-45deg);}

/* floating damage numbers */
.nb-dmg{position:absolute;transform:translate(-50%,-100%);font-family:var(--data);font-weight:700;font-size:18px;color:#fff;
  text-shadow:0 1px 2px #000,0 0 8px rgba(0,0,0,.7);pointer-events:none;}
.nb-dmg.head{font-size:26px;color:var(--gold);}

/* bottom: HP (left) + ammo (right) */
.nb-bottom{position:absolute;left:0;right:0;bottom:0;padding:18px 22px;display:flex;justify-content:space-between;align-items:flex-end;}
.nb-hp .lbl,.nb-ammo .lbl{font-size:10px;letter-spacing:.22em;opacity:.6;text-transform:uppercase;font-weight:700;}
.nb-hpnum{font-family:var(--data);font-variant-numeric:tabular-nums;font-size:46px;font-weight:800;line-height:.85;color:#fff;}
.nb-hpbar{width:320px;height:6px;margin-top:10px;display:flex;gap:2px;}
.nb-hpbar span{flex:1;border-radius:1px;background:rgba(255,255,255,.1);transition:background .08s linear;}
.nb-hpbar span.on{box-shadow:0 0 8px currentColor;}
.nb-hpbar.low span.on{animation:nblow .9s ease-in-out infinite;}
@keyframes nblow{0%,100%{opacity:1}50%{opacity:.3}}
.nb-ammo{text-align:right;}
.nb-ammoinum{font-family:var(--data);font-variant-numeric:tabular-nums;font-size:26px;font-weight:700;line-height:1;opacity:.85;}
.nb-ammoinum .res{font-size:14px;opacity:.5;}
.nb-reload{font-size:11px;letter-spacing:.2em;color:var(--gold);margin-top:5px;height:13px;font-weight:700;}

/* team totals (top-centre) */
.nb-team{position:absolute;top:16px;left:50%;transform:translateX(-50%);display:flex;gap:16px;align-items:center;padding:8px 18px;font-weight:800;font-size:16px;letter-spacing:.06em;}
.nb-team .b{color:var(--cyan)}.nb-team .r{color:var(--red)}.nb-team .vs{opacity:.4;font-size:12px;letter-spacing:.14em;}

/* leaderboard (top-right) */
.nb-board{position:absolute;top:16px;right:22px;width:232px;padding:10px 12px;font-size:12.5px;}
.nb-board .h,.nb-board-lg .h{display:flex;justify-content:space-between;gap:16px;opacity:.55;letter-spacing:.1em;font-size:10px;text-transform:uppercase;margin-bottom:6px;}
.nb-board .h span:last-child,.nb-board-lg .h span:last-child{text-align:right;min-width:44px;}
.nb-row{display:flex;justify-content:space-between;align-items:center;padding:2px 0;gap:8px;font-variant-numeric:tabular-nums;}
.nb-row .nm{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.nb-row .sc{font-family:var(--data);min-width:44px;text-align:right;}
.nb-row.dead{opacity:.38}
.nb-row.me .nm{font-weight:700;color:#fff}
.nb-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:7px;flex:none;}

/* kill feed (right column, under the board) */
.nb-killfeed{position:absolute;right:22px;top:200px;display:flex;flex-direction:column;gap:5px;max-width:300px;align-items:flex-end;}
.nb-kf{font-size:12px;padding:4px 10px;border-radius:5px;letter-spacing:.02em;animation:nbkf .18s ease-out;}
.nb-kf .b{color:var(--cyan)}.nb-kf .r{color:var(--red)}.nb-kf .hs{color:var(--gold);font-weight:700}
@keyframes nbkf{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}

/* debug panel (left column, under the minimap) */
.nb-debug{position:absolute;left:22px;top:176px;width:214px;padding:8px 10px;font-size:10px;line-height:1.5;
  font-family:var(--data);font-variant-numeric:tabular-nums;color:#9fb4d8;letter-spacing:.02em;}
.nb-debug .t{color:#e6eefb;letter-spacing:.14em;font-weight:700;font-size:9px;text-transform:uppercase;opacity:.7;margin-bottom:3px;}
.nb-debug .row{display:flex;gap:6px;}
.nb-debug .row .k{opacity:.5;width:30px;flex:none;}
.nb-debug hr{border:0;border-top:1px solid rgba(90,140,220,.25);margin:5px 0;}
.nb-debug .ai{display:flex;gap:5px;white-space:nowrap;}
.nb-debug .ai .id{width:34px;opacity:.7;flex:none;}
.nb-debug .ai .st{width:44px;color:#cfe0ff;flex:none;}
.nb-debug .ai .t{width:26px;flex:none;}
.nb-debug .ai .ls{opacity:.6;}

/* spectator bar */
.nb-spectate{position:absolute;left:50%;bottom:64px;transform:translateX(-50%);padding:8px 16px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;}

/* center flash message */
.nb-msg{position:absolute;left:50%;top:34%;transform:translate(-50%,-50%);font-size:38px;font-weight:800;letter-spacing:.2em;
  text-transform:uppercase;text-align:center;opacity:0;transition:opacity .25s;text-shadow:0 0 24px currentColor;}

/* full-screen overlays */
.nb-screen{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:20px;
  background:radial-gradient(circle at 50% 40%,rgba(8,11,19,.92),rgba(4,6,10,.98));pointer-events:auto;text-align:center;}
.nb-title{font-size:58px;font-weight:800;letter-spacing:.16em;color:#e8f4ff;text-shadow:0 0 34px rgba(24,224,255,.4);}
.nb-title::after{content:'';display:block;width:150px;height:2px;background:linear-gradient(90deg,transparent,#18e0ff,transparent);margin:12px auto 0;}
.nb-sub{font-size:14px;letter-spacing:.4em;opacity:.7;text-transform:uppercase;font-weight:700;}
.nb-controls{display:grid;grid-template-columns:auto auto;gap:7px 24px;font-size:14px;opacity:.85;text-align:left;letter-spacing:.04em;}
.nb-controls b{color:#bfe9ff;font-weight:700}
.nb-cta{font-size:17px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#eafcff;padding:14px 34px;border-radius:8px;
  background:rgba(24,224,255,.12);border:1px solid #18e0ff;box-shadow:0 0 24px rgba(24,224,255,.28);animation:nbpulse 1.8s ease-in-out infinite;}
@keyframes nbpulse{0%,100%{box-shadow:0 0 24px rgba(24,224,255,.3)}50%{box-shadow:0 0 14px rgba(24,224,255,.16)}}
.nb-res-title{font-size:56px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;}
.nb-board-lg{width:440px;font-size:14px;padding:14px 16px;}

/* director mode (F2): everything hidden but a minimal win/lose line */
.nb-director{position:absolute;top:14px;left:50%;transform:translateX(-50%);padding:9px 22px;font-size:13px;letter-spacing:.18em;text-transform:uppercase;font-weight:800;display:none;gap:18px;align-items:center;}
.nb-director .b{color:var(--cyan)}.nb-director .r{color:var(--red)}.nb-director .vs{opacity:.4;font-size:11px}.nb-director .tg{opacity:.4;font-size:10px;}
.nb-root.nb-director > *:not(.nb-director):not(.nb-screen){display:none !important;}
body.nb-in-director .nb-minimap{display:none;}

/* match chrome must not bleed into the results screen (fixes the overlap bug) */
.nb-root.nb-results .nb-msg,.nb-root.nb-results .nb-board,.nb-root.nb-results .nb-killfeed,
.nb-root.nb-results .nb-debug,.nb-root.nb-results .nb-fps,.nb-root.nb-results .nb-team,
.nb-root.nb-results .nb-bottom,.nb-root.nb-results .nb-spectate,.nb-root.nb-results .nb-cross{display:none;}
body.nb-in-results .nb-minimap{display:none;}

/* honour prefers-reduced-motion: kill decorative animation, keep feedback */
@media (prefers-reduced-motion: reduce){
  .nb-cta,.nb-kf,.nb-hpbar.low span.on{animation:none;}
}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

interface DmgNum {
  el: HTMLElement;
  world: Vec3;
  age: number;
  max: number;
}

export type ScreenKind = 'start' | 'pause' | 'results' | 'none';

export class HUD {
  private root: HTMLDivElement;
  private hpSegs: HTMLSpanElement[] = [];
  private hpNum!: HTMLDivElement;
  private hpbar!: HTMLDivElement;
  private ammoNum!: HTMLDivElement;
  private reloadEl!: HTMLDivElement;
  private killfeed!: HTMLDivElement;
  private teamEl!: HTMLDivElement;
  private boardEl!: HTMLDivElement;
  private spectateEl!: HTMLDivElement;
  private msgEl!: HTMLDivElement;
  private fpsEl!: HTMLDivElement;
  private debugEl!: HTMLDivElement;
  private screenEl!: HTMLDivElement;
  private hitmark!: HTMLDivElement;
  private directorEl!: HTMLDivElement;
  private dmgWrap!: HTMLDivElement;
  private lastBoard = '';
  private lastDebug = '';
  private boardTimer = 0;
  private screenKind: ScreenKind = 'none';
  private stats = { activeParticles: 0 };
  private hitmarkAge = 1; // > max => hidden
  private readonly hitmarkMax = 0.21;
  private dmgPool: DmgNum[] = [];
  private lastVisual = performance.now();
  private reducedMotion = false;
  private msgTimer = 0;
  onPlayAgain: (() => void) | null = null;
  onOverlayClick: ((kind: ScreenKind) => void) | null = null;

  constructor(container: HTMLElement) {
    const style = el('style', '');
    style.textContent = CSS;
    container.appendChild(style);

    this.root = el('div', 'nb-root');
    container.appendChild(this.root);

    this.root.appendChild(el('div', 'nb-cross'));

    // hitmarker (4 ticks)
    this.hitmark = el('div', 'nb-hitmark');
    for (let i = 0; i < 4; i++) this.hitmark.appendChild(el('i'));
    this.root.appendChild(this.hitmark);

    // floating damage numbers layer
    this.dmgWrap = el('div', '');
    this.dmgWrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;';
    this.root.appendChild(this.dmgWrap);

    const bottom = el('div', 'nb-bottom');
    const hp = el('div', 'nb-hp');
    hp.appendChild(el('div', 'lbl', 'Health'));
    this.hpNum = el('div', 'nb-hpnum', '100');
    hp.appendChild(this.hpNum);
    this.hpbar = el('div', 'nb-hpbar');
    for (let i = 0; i < 4; i++) this.hpbar.appendChild(el('span'));
    this.hpSegs = Array.from(this.hpbar.children) as HTMLSpanElement[];
    hp.appendChild(this.hpbar);
    const ammo = el('div', 'nb-ammo');
    ammo.appendChild(el('div', 'lbl', 'Ammo'));
    this.ammoNum = el('div', 'nb-ammoinum', '30');
    this.ammoNum.innerHTML = '30 <span class="res">/ 90</span>';
    ammo.appendChild(this.ammoNum);
    this.reloadEl = el('div', 'nb-reload', '');
    ammo.appendChild(this.reloadEl);
    bottom.appendChild(hp);
    bottom.appendChild(ammo);
    this.root.appendChild(bottom);

    this.killfeed = el('div', 'nb-killfeed');
    this.root.appendChild(this.killfeed);

    this.teamEl = el('div', 'nb-team nb-panel');
    this.root.appendChild(this.teamEl);

    this.boardEl = el('div', 'nb-board nb-panel');
    this.root.appendChild(this.boardEl);

    this.debugEl = el('div', 'nb-debug nb-panel');
    this.root.appendChild(this.debugEl);

    this.spectateEl = el('div', 'nb-spectate nb-panel');
    this.spectateEl.style.display = 'none';
    this.root.appendChild(this.spectateEl);

    this.msgEl = el('div', 'nb-msg');
    this.root.appendChild(this.msgEl);

    this.fpsEl = el('div', 'nb-fps nb-num', '');
    this.fpsEl.style.cssText = 'position:absolute;top:20px;right:262px;font-size:11px;opacity:.55;letter-spacing:1px;';
    this.root.appendChild(this.fpsEl);

    // Director-mode minimal win/lose line (hidden unless director mode is on).
    this.directorEl = el('div', 'nb-director nb-panel');
    this.root.appendChild(this.directorEl);

    // IMPORTANT: the screen MUST be a child of `.nb-root` (not `container`).
    // All design tokens (--cyan/--red/--gold/--ink/--data, color, font-family)
    // are defined on `.nb-root`; a screen attached to `container` is a sibling
    // and resolves none of them, so the start/pause/results text rendered as
    // pure black browser-default Times on a near-black background (UI-02).
    this.screenEl = el('div', 'nb-screen');
    this.screenEl.style.display = 'none';
    this.screenEl.addEventListener('click', () => {
      if (this.screenKind === 'start' || this.screenKind === 'pause') this.onOverlayClick?.(this.screenKind);
    });
    this.root.appendChild(this.screenEl);
  }

  /** Set by the app: true when prefers-reduced-motion is active. */
  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  /** Live effect counters from the renderer (debug panel). */
  setStats(s: { activeParticles: number }): void {
    this.stats = s;
  }

  setDebugVisible(v: boolean): void {
    this.debugEl.style.display = v ? '' : 'none';
  }

  /** Director mode (F2): show only a minimal win/lose line, hide all other
   *   match chrome — for clean recording. Toggling off restores the HUD. */
  setDirector(on: boolean): void {
    this.root.classList.toggle('nb-director', on);
    document.body.classList.toggle('nb-in-director', on);
  }

  showScreen(kind: ScreenKind): void {
    this.screenKind = kind;
    const inResults = kind === 'results';
    this.root.classList.toggle('nb-results', inResults);
    document.body.classList.toggle('nb-in-results', inResults);
    if (inResults) this.dismissMessage();
    if (kind === 'none') {
      this.screenEl.style.display = 'none';
      return;
    }
    this.screenEl.style.display = 'flex';
    this.screenEl.innerHTML = '';
    if (kind === 'start') {
      this.screenEl.appendChild(el('div', 'nb-title', 'NEON BASTION'));
      this.screenEl.appendChild(el('div', 'nb-sub', '4v4 · ARENA · TEAM DEATHMATCH'));
      const c = el('div', 'nb-controls');
      c.innerHTML =
        '<b>Move</b><span>W A S D</span>' +
        '<b>Aim</b><span>Mouse</span>' +
        '<b>Shoot</b><span>Left click</span>' +
        '<b>Sprint</b><span>Shift</span>' +
        '<b>Reload</b><span>R</span>' +
        '<b>Spectate</b><span>Q / E</span>' +
        '<b>Pause</b><span>Esc</span>';
      this.screenEl.appendChild(c);
      this.screenEl.appendChild(el('div', 'nb-cta', 'CLICK TO DEPLOY'));
    } else if (kind === 'pause') {
      this.screenEl.appendChild(el('div', 'nb-title', 'PAUSED'));
      this.screenEl.appendChild(el('div', 'nb-cta', 'CLICK TO RESUME'));
    }
    // 'results' is populated by showResults()
  }

  showResults(winner: 'blue' | 'red', snapshot: ReturnType<Match['snapshot']>): void {
    this.showScreen('results');
    this.screenEl.innerHTML = '';
    const won = winner === 'blue';
    const title = el('div', 'nb-res-title', won ? 'BLUE WINS' : 'RED WINS');
    title.style.color = won ? 'var(--cyan)' : 'var(--red)';
    title.style.textShadow = `0 0 30px ${won ? 'rgba(24,224,255,.6)' : 'rgba(255,61,99,.6)'}`;
    this.screenEl.appendChild(title);
    this.screenEl.appendChild(el('div', 'nb-sub', won ? 'Victory' : 'Defeat'));

    const board = el('div', 'nb-board-lg nb-panel');
    board.appendChild(this.boardHeader());
    const rows = [...snapshot.units].sort((a, b) => b.totalScore - a.totalScore);
    for (const u of rows) {
      board.appendChild(this.boardRow(u.name, u.team, u.totalScore, u.kills, u.alive, u.isPlayer));
    }
    this.screenEl.appendChild(board);

    const cta = el('div', 'nb-cta', 'PLAY AGAIN');
    cta.addEventListener('click', () => this.onPlayAgain?.());
    this.screenEl.appendChild(cta);
  }

  private boardHeader(): HTMLElement {
    const h = el('div', 'h');
    h.appendChild(el('span', '', 'Player'));
    h.appendChild(el('span', '', 'K / S'));
    return h;
  }

  private boardRow(name: string, team: 'blue' | 'red', score: number, kills: number, alive: boolean, me: boolean): HTMLElement {
    const row = el('div', 'nb-row' + (me ? ' me' : '') + (alive ? '' : ' dead'));
    const left = el('span', 'nm');
    const dot = el('span', 'nb-dot');
    dot.style.background = team === 'blue' ? 'var(--cyan)' : 'var(--red)';
    left.appendChild(dot);
    left.appendChild(document.createTextNode(name));
    row.appendChild(left);
    row.appendChild(el('span', 'sc', `${kills} / ${score}`));
    return row;
  }

  addKill(item: KillFeedItem): void {
    const row = el('div', 'nb-kf nb-panel');
    const k = el('span', item.killerTeam === 'blue' ? 'b' : 'r', item.killer);
    const v = el('span', item.victimTeam === 'blue' ? 'b' : 'r', item.victim);
    row.appendChild(k);
    if (item.headshot) row.appendChild(el('span', 'hs', ' ⦿ '));
    row.appendChild(document.createTextNode(' ▸ '));
    row.appendChild(v);
    this.killfeed.prepend(row);
    while (this.killfeed.children.length > 5) this.killfeed.lastChild?.remove();
  }

  clearKillfeed(): void {
    this.killfeed.innerHTML = '';
  }

  setFps(fps: number): void {
    this.fpsEl.textContent = fps + ' FPS';
  }

  flashMessage(text: string, color: string): void {
    window.clearTimeout(this.msgTimer);
    this.msgEl.textContent = text;
    this.msgEl.style.color = color;
    this.msgEl.style.opacity = '1';
    this.msgTimer = window.setTimeout(() => {
      this.msgEl.style.opacity = '0';
    }, 1400);
  }

  private dismissMessage(): void {
    window.clearTimeout(this.msgTimer);
    this.msgEl.style.opacity = '0';
  }

  /** Player landed a hit: pulse the hitmarker + spawn a floating damage number. */
  onPlayerHit(head: boolean, world: Vec3, amount: number): void {
    this.hitmarkAge = 0;
    this.hitmark.style.color = head ? 'var(--gold)' : '#ffffff';
    this.hitmark.dataset.hits = String(Number(this.hitmark.dataset.hits ?? '0') + 1);
    const d = el('div', 'nb-dmg' + (head ? ' head' : ''), String(amount));
    this.dmgWrap.appendChild(d);
    this.dmgPool.push({ el: d, world, age: 0, max: 0.55 });
    // cap the pool so a burst can't build up unbounded DOM
    if (this.dmgPool.length > 24) {
      const old = this.dmgPool.shift()!;
      old.el.remove();
    }
  }

  /** On a player kill: a quick, bigger hitmarker blip (no extra element). */
  onKill(): void {
    this.hitmarkAge = 0;
    this.hitmark.dataset.kills = String(Number(this.hitmark.dataset.kills ?? '0') + 1);
  }

  /**
   * Advance the hitmarker + damage numbers. Called once per frame with a
   * world->CSS-pixel projector (from the renderer's camera).
   */
  tickVisual(project: (p: Vec3) => { x: number; y: number; behind: boolean }): void {
    const nowMs = performance.now();
    const dt = Math.min(0.05, (nowMs - this.lastVisual) / 1000);
    this.lastVisual = nowMs;

    // hitmarker: rise to full by 30%, then fade; scale-out unless reduced-motion.
    this.hitmarkAge += dt;
    const t = this.hitmarkAge / this.hitmarkMax;
    if (t >= 1) {
      this.hitmark.style.opacity = '0';
    } else {
      const opacity = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
      const scale = this.reducedMotion ? 1 : 0.7 + t * 0.7;
      this.hitmark.style.opacity = opacity.toFixed(3);
      this.hitmark.style.transform = `translate(-50%,-50%) scale(${scale.toFixed(3)})`;
    }

    // damage numbers: float up 42px, fade over life, re-projected each frame.
    for (let i = this.dmgPool.length - 1; i >= 0; i--) {
      const d = this.dmgPool[i];
      d.age += dt;
      if (d.age >= d.max) {
        d.el.remove();
        this.dmgPool.splice(i, 1);
        continue;
      }
      const p = project(d.world);
      const k = d.age / d.max;
      d.el.style.left = `${p.x}px`;
      d.el.style.top = `${p.y - k * 42}px`;
      d.el.style.opacity = k < 0.5 ? '1' : String(1 - (k - 0.5) * 2);
      d.el.style.display = p.behind ? 'none' : '';
    }
  }

  /** Called every frame. */
  /** Force the throttled team/leaderboard/debug block to repaint immediately.
   *  Headless rAF is throttled (~3fps), so E2E assertions use this to read the
   *  board deterministically instead of racing the 5-frame throttle. */
  repaint(match: Match): void {
    this.boardTimer = 4;
    this.update(match);
  }

  update(match: Match): void {
    const p = match.player;
    const hp = Math.max(0, Math.round(p.hp));
    const frac = hp / 100;
    const lit = hp <= 0 ? 0 : Math.ceil(hp / 25);
    const color = frac > 0.6 ? '#2fd08a' : frac >= 0.25 ? '#ffc93c' : '#ff3d63';
    this.hpNum.textContent = String(hp);
    this.hpNum.style.color = color;
    this.hpNum.style.textShadow = `0 0 14px ${color}55`;
    for (let i = 0; i < this.hpSegs.length; i++) {
      const on = i < lit;
      this.hpSegs[i].classList.toggle('on', on);
      this.hpSegs[i].style.background = on ? color : '';
      this.hpSegs[i].style.color = color;
    }
    this.hpbar.classList.toggle('low', hp > 0 && frac <= 0.25);

    this.ammoNum.innerHTML = `${p.mag} <span class="res">/ ${p.reserve}</span>`;
    this.reloadEl.textContent = p.reloading ? 'RELOADING' : p.mag === 0 ? 'OUT OF AMMO' : '';

    // Spectate bar
    const mode = match.spectate.mode;
    if (mode === 'alive') {
      this.spectateEl.style.display = 'none';
    } else {
      this.spectateEl.style.display = 'block';
      let label = '';
      if (mode === 'ally' && match.spectate.targetId != null) {
        const t = match.units.find((u) => u.id === match.spectate.targetId);
        label = `SPECTATING ${t?.name ?? ''}`;
      } else {
        label = 'FREE CAMERA';
      }
      this.spectateEl.textContent = `${label}   ·   Q / E`;
    }

    // Team totals + leaderboard + debug (throttled ~8Hz)
    this.boardTimer += 1;
    if (this.boardTimer % 5 !== 0) return;
    const blueScore = match.units.filter((u) => u.team === 'blue').reduce((s, u) => s + u.totalScore, 0);
    const redScore = match.units.filter((u) => u.team === 'red').reduce((s, u) => s + u.totalScore, 0);
    const blueAlive = match.units.filter((u) => u.team === 'blue' && u.alive).length;
    const redAlive = match.units.filter((u) => u.team === 'red' && u.alive).length;
    this.teamEl.innerHTML =
      `<span class="b">BLUE ${blueScore} · ${blueAlive}</span>` +
      `<span class="vs">VS</span>` +
      `<span class="r">RED ${redScore} · ${redAlive}</span>`;

    // Director mode minimal line (also used to read the current win/lose).
    this.directorEl.innerHTML =
      `<span class="b">BLUE ${blueScore} · ${blueAlive}</span>` +
      `<span class="vs">VS</span>` +
      `<span class="r">RED ${redScore} · ${redAlive}</span>` +
      `<span class="tg">DIRECTOR · F2</span>`;

    const rows = [...match.units].sort((a, b) => b.totalScore - a.totalScore);
    let html = this.boardHeader().outerHTML;
    for (const u of rows) {
      const cls = 'nb-row' + (u.isPlayer ? ' me' : '') + (u.alive ? '' : ' dead');
      const dot = u.team === 'blue' ? 'var(--cyan)' : 'var(--red)';
      html += `<div class="${cls}"><span class="nm"><span class="nb-dot" style="background:${dot}"></span>${u.name}</span><span class="sc">${u.kills} / ${u.totalScore}</span></div>`;
    }
    if (html !== this.lastBoard) {
      this.boardEl.innerHTML = html;
      this.lastBoard = html;
    }
    this.renderDebug(match, blueAlive, redAlive);
  }

  private renderDebug(match: Match, blueAlive: number, redAlive: number): void {
    const dist: Record<string, number> = {};
    for (const u of match.units) {
      if (u.isPlayer) continue;
      const st = u.ai?.state ?? '—';
      dist[st] = (dist[st] ?? 0) + 1;
    }
    const distStr = Object.entries(dist).map(([k, v]) => `${k.slice(0, 4)}:${v}`).join('  ');
    let ai = '';
    for (const u of match.units) {
      if (u.isPlayer) continue;
      const st = u.ai?.state ?? '—';
      const tgt = u.ai?.targetId ?? -1;
      const ls = u.ai?.lastSeenPos ? `${u.ai.lastSeenPos.x.toFixed(1)},${u.ai.lastSeenPos.z.toFixed(1)}` : '·';
      ai += `<div class="ai"><span class="id">${u.name.slice(0, 3)}</span><span class="st">${st}</span><span class="t">${tgt >= 0 ? 'T' + tgt : '·'}</span><span class="ls">${ls}</span></div>`;
    }
    const aliveUnits = match.units.filter((u) => u.alive).length;
    const html =
      `<div class="t">Debug · F3</div>` +
      `<div class="row"><span class="k">FPS</span><span class="v">${this.fpsEl.textContent}</span><span class="k">P</span><span>${aliveUnits}</span><span class="k">FX</span><span>${this.stats.activeParticles}</span></div>` +
      `<div class="row"><span class="k">BLUE</span><span>${blueAlive}</span><span class="k">RED</span><span>${redAlive}</span></div>` +
      `<div class="row"><span class="k">AI</span><span style="white-space:nowrap">${distStr}</span></div>` +
      `<hr>${ai}`;
    if (html !== this.lastDebug) {
      this.debugEl.innerHTML = html;
      this.lastDebug = html;
    }
  }

  dispose(): void {
    this.root.remove();
    this.screenEl.remove();
  }
}
