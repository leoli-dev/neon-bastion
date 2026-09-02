// DOM-based HUD: crosshair, HP/ammo, team totals, leaderboard, killfeed,
// spectator bar, center messages, and the start / pause / result screens.
// Everything is derived from the Match snapshot plus a few event calls.

import type { Match, KillFeedItem } from '../game/match';

const CSS = `
.nb-root{position:fixed;inset:0;pointer-events:none;z-index:10;font-family:'Segoe UI',system-ui,sans-serif;color:#dfe6f5;user-select:none;}
.nb-panel{background:rgba(9,12,20,.62);border:1px solid rgba(90,140,220,.25);backdrop-filter:blur(3px);border-radius:8px;}
.nb-cross{position:absolute;left:50%;top:50%;width:22px;height:22px;transform:translate(-50%,-50%);}
.nb-cross::before,.nb-cross::after{content:'';position:absolute;background:rgba(230,240,255,.85);box-shadow:0 0 6px rgba(120,200,255,.7);}
.nb-cross::before{left:50%;top:0;width:2px;height:100%;transform:translateX(-50%);}
.nb-cross::after{top:50%;left:0;height:2px;width:100%;transform:translateY(-50%);}
.nb-bottom{position:absolute;left:0;right:0;bottom:0;padding:18px 22px;display:flex;justify-content:space-between;align-items:flex-end;}
.nb-hp .lbl,.nb-ammo .lbl{font-size:11px;letter-spacing:2px;opacity:.7;text-transform:uppercase;}
.nb-hpbar{width:240px;height:14px;border-radius:7px;background:rgba(255,255,255,.08);border:1px solid rgba(120,160,230,.3);overflow:hidden;margin-top:4px;}
.nb-hpfill{height:100%;background:linear-gradient(90deg,#2fd08a,#7affc2);transition:width .08s linear;}
.nb-hpnum{font-size:30px;font-weight:700;line-height:1;margin-top:2px;text-shadow:0 0 12px rgba(80,220,160,.5);}
.nb-ammo{text-align:right;}
.nb-ammoinum{font-size:34px;font-weight:700;line-height:1;text-shadow:0 0 12px rgba(120,200,255,.5);}
.nb-reload{font-size:12px;letter-spacing:2px;color:#ffd24a;margin-top:4px;height:14px;}
.nb-killfeed{position:absolute;left:22px;top:180px;display:flex;flex-direction:column;gap:5px;max-width:340px;}
.nb-kf{font-size:13px;padding:5px 10px;border-radius:6px;}
.nb-kf .b{color:#5bb0ff}.nb-kf .r{color:#ff6d8a}.nb-kf .hs{color:#ffd24a;font-weight:700}
.nb-team{position:absolute;top:16px;left:50%;transform:translateX(-50%);display:flex;gap:18px;align-items:center;padding:8px 18px;font-weight:700;font-size:16px;letter-spacing:1px;}
.nb-fps{position:absolute;top:20px;right:262px;font-size:11px;opacity:.55;font-variant-numeric:tabular-nums;letter-spacing:1px;}
.nb-team .b{color:#5bb0ff}.nb-team .r{color:#ff6d8a}.nb-team .vs{opacity:.5;font-size:12px}
.nb-board{position:absolute;top:16px;right:22px;width:230px;padding:10px 12px;font-size:12.5px;}
.nb-board .h{display:flex;justify-content:space-between;opacity:.6;letter-spacing:1px;font-size:10px;text-transform:uppercase;margin-bottom:6px;}
.nb-row{display:flex;justify-content:space-between;align-items:center;padding:2px 0;gap:8px;}
.nb-row .nm{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.nb-row .sc{font-variant-numeric:tabular-nums;min-width:34px;text-align:right;}
.nb-row.dead{opacity:.4}
.nb-row.me .nm{font-weight:700;color:#fff}
.nb-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px;flex:none}
.nb-spectate{position:absolute;left:50%;bottom:64px;transform:translateX(-50%);padding:8px 16px;font-size:14px;letter-spacing:1px;}
.nb-msg{position:absolute;left:50%;top:34%;transform:translate(-50%,-50%);font-size:40px;font-weight:800;letter-spacing:3px;text-align:center;opacity:0;transition:opacity .25s;text-shadow:0 0 24px currentColor;}
.nb-screen{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:18px;background:radial-gradient(circle at 50% 40%,rgba(10,14,24,.72),rgba(5,6,10,.94));pointer-events:auto;text-align:center;}
.nb-title{font-size:64px;font-weight:800;letter-spacing:6px;background:linear-gradient(90deg,#5bb0ff,#c48bff,#ff6d8a);-webkit-background-clip:text;background-clip:text;color:transparent;}
.nb-sub{font-size:15px;letter-spacing:3px;opacity:.75;}
.nb-controls{display:grid;grid-template-columns:auto auto;gap:6px 22px;font-size:14px;opacity:.85;text-align:left;}
.nb-controls b{color:#9fc4ff;font-weight:600}
.nb-cta{font-size:20px;font-weight:700;letter-spacing:2px;color:#fff;padding:14px 34px;border-radius:10px;background:linear-gradient(90deg,#2f7bff,#8b5cff);box-shadow:0 8px 30px rgba(90,120,255,.4);animation:nbpulse 1.6s ease-in-out infinite;}
@keyframes nbpulse{0%,100%{opacity:1;box-shadow:0 8px 30px rgba(90,120,255,.4)}50%{opacity:.8;box-shadow:0 8px 22px rgba(90,120,255,.28)}}
.nb-res-title{font-size:56px;font-weight:800;letter-spacing:4px;}
.nb-board-lg{width:420px;font-size:14px;padding:14px 16px;}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export type ScreenKind = 'start' | 'pause' | 'results' | 'none';

export class HUD {
  private root: HTMLDivElement;
  private hpFill!: HTMLDivElement;
  private hpNum!: HTMLDivElement;
  private ammoNum!: HTMLDivElement;
  private reloadEl!: HTMLDivElement;
  private killfeed!: HTMLDivElement;
  private teamEl!: HTMLDivElement;
  private boardEl!: HTMLDivElement;
  private spectateEl!: HTMLDivElement;
  private msgEl!: HTMLDivElement;
  private fpsEl!: HTMLDivElement;
  private screenEl!: HTMLDivElement;
  private lastBoard = '';
  private boardTimer = 0;
  private screenKind: ScreenKind = 'none';
  onPlayAgain: (() => void) | null = null;
  onOverlayClick: ((kind: ScreenKind) => void) | null = null;

  constructor(container: HTMLElement) {
    const style = el('style', '');
    style.textContent = CSS;
    container.appendChild(style);

    this.root = el('div', 'nb-root');
    container.appendChild(this.root);

    this.root.appendChild(el('div', 'nb-cross'));

    const bottom = el('div', 'nb-bottom');
    const hp = el('div', 'nb-hp');
    hp.appendChild(el('div', 'lbl', 'Health'));
    const hpbar = el('div', 'nb-hpbar');
    this.hpFill = el('div', 'nb-hpfill');
    hpbar.appendChild(this.hpFill);
    hp.appendChild(hpbar);
    this.hpNum = el('div', 'nb-hpnum', '100');
    hp.appendChild(this.hpNum);
    const ammo = el('div', 'nb-ammo');
    ammo.appendChild(el('div', 'lbl', 'Ammo'));
    this.ammoNum = el('div', 'nb-ammoinum', '30');
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

    this.spectateEl = el('div', 'nb-spectate nb-panel');
    this.spectateEl.style.display = 'none';
    this.root.appendChild(this.spectateEl);

    this.msgEl = el('div', 'nb-msg');
    this.root.appendChild(this.msgEl);

    this.fpsEl = el('div', 'nb-fps', '');
    this.root.appendChild(this.fpsEl);

    this.screenEl = el('div', 'nb-screen');
    this.screenEl.style.display = 'none';
    this.screenEl.addEventListener('click', () => {
      if (this.screenKind === 'start' || this.screenKind === 'pause') this.onOverlayClick?.(this.screenKind);
    });
    container.appendChild(this.screenEl);
  }

  showScreen(kind: ScreenKind): void {
    this.screenKind = kind;
    if (kind === 'none') {
      this.screenEl.style.display = 'none';
      return;
    }
    this.screenEl.style.display = 'flex';
    this.screenEl.innerHTML = '';
    if (kind === 'start') {
      this.screenEl.appendChild(el('div', 'nb-title', 'NEON BASTION'));
      this.screenEl.appendChild(el('div', 'nb-sub', '4v4  ARENA  TEAM  DEATHMATCH'));
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
    } else if (kind === 'results') {
      // populated by showResults()
    }
  }

  showResults(winner: 'blue' | 'red', snapshot: ReturnType<Match['snapshot']>): void {
    this.screenEl.style.display = 'flex';
    this.screenEl.innerHTML = '';
    const won = winner === 'blue';
    const title = el('div', 'nb-res-title', won ? 'BLUE WINS' : 'RED WINS');
    title.style.color = won ? '#5bb0ff' : '#ff6d8a';
    title.style.textShadow = `0 0 30px ${won ? 'rgba(91,176,255,.7)' : 'rgba(255,109,138,.7)'}`;
    this.screenEl.appendChild(title);
    this.screenEl.appendChild(el('div', 'nb-sub', won ? 'VICTORY' : 'DEFEAT'));

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
    const l = el('span', '', 'Player');
    const r = el('span', '', 'K / S');
    h.appendChild(l);
    h.appendChild(r);
    return h;
  }

  private boardRow(name: string, team: 'blue' | 'red', score: number, kills: number, alive: boolean, me: boolean): HTMLElement {
    const row = el('div', 'nb-row' + (me ? ' me' : '') + (alive ? '' : ' dead'));
    const left = el('span', 'nm');
    const dot = el('span', 'nb-dot');
    dot.style.background = team === 'blue' ? '#5bb0ff' : '#ff6d8a';
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
    this.msgEl.textContent = text;
    this.msgEl.style.color = color;
    this.msgEl.style.opacity = '1';
    window.setTimeout(() => {
      this.msgEl.style.opacity = '0';
    }, 1400);
  }

  /** Called every frame. */
  update(match: Match): void {
    const p = match.player;
    this.hpFill.style.width = `${Math.max(0, p.hp)}%`;
    this.hpNum.textContent = String(Math.max(0, Math.round(p.hp)));
    this.ammoNum.textContent = String(p.mag);
    this.reloadEl.textContent = p.reloading ? 'RELOADING…' : p.mag === 0 ? 'OUT OF AMMO' : '';

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
      this.spectateEl.textContent = `${label}   ·   Q / E to switch`;
    }

    // Team totals + leaderboard (throttled ~8Hz)
    this.boardTimer += 1;
    if (this.boardTimer % 5 === 0) {
      const blueScore = match.units.filter((u) => u.team === 'blue').reduce((s, u) => s + u.totalScore, 0);
      const redScore = match.units.filter((u) => u.team === 'red').reduce((s, u) => s + u.totalScore, 0);
      const blueAlive = match.units.filter((u) => u.team === 'blue' && u.alive).length;
      const redAlive = match.units.filter((u) => u.team === 'red' && u.alive).length;
      this.teamEl.innerHTML =
        `<span class="b">BLUE ${blueScore} · ${blueAlive}</span>` +
        `<span class="vs">VS</span>` +
        `<span class="r">RED ${redScore} · ${redAlive}</span>`;

      const rows = [...match.units].sort((a, b) => b.totalScore - a.totalScore);
      let html = this.boardHeader().outerHTML;
      for (const u of rows) {
        const cls = 'nb-row' + (u.isPlayer ? ' me' : '') + (u.alive ? '' : ' dead');
        const dot = u.team === 'blue' ? '#5bb0ff' : '#ff6d8a';
        html += `<div class="${cls}"><span class="nm"><span class="nb-dot" style="background:${dot}"></span>${u.name}</span><span class="sc">${u.kills} / ${u.totalScore}</span></div>`;
      }
      if (html !== this.lastBoard) {
        this.boardEl.innerHTML = html;
        this.lastBoard = html;
      }
    }
  }

  dispose(): void {
    this.root.remove();
    this.screenEl.remove();
  }
}
