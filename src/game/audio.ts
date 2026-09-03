// Procedural WebAudio SFX + BGM. No assets — every sound is synthesized.
// The context is created/resumed on the first user gesture (browsers require
// it); until then every play() call is a no-op.

// ---------------------------------------------------------------------------
// BGM (AUD-02) — a short, calm, looping background melody, fully synthesized.
// Two voices: a soft triangle melody over a sine bass (Am–F–C–G, 8 bars).
// The melody/bass data and the scheduling maths below are PURE (no
// AudioContext), so they are unit-testable in node; the class just turns
// them into OscillatorNodes on a dedicated gain that sits far below the SFX
// master level so gunshots and hit feedback always stay on top.
// ---------------------------------------------------------------------------

/** One slot of a BGM part: `[midi note (null = rest), length in beats]`. */
export type BgmNoteDef = readonly [midi: number | null, beats: number];

export interface BgmScheduledNote {
  /** Start offset in seconds from the loop boundary. */
  start: number;
  /** Length in seconds. */
  dur: number;
  freq: number;
}

export const BGM_TEMPO_BPM = 84;
export const BGM_BEAT_SECONDS = 60 / BGM_TEMPO_BPM;
/** BGM bus level relative to the SFX master (0.5) — comfortably below every
 *  one-shot effect, per AUD-02. */
export const BGM_LEVEL = 0.2;

/** Bass voice: root + fifth per bar, one bar per chord (Am F C G × 2). */
export const BGM_BASS: readonly BgmNoteDef[] = [
  [45, 2], [52, 2], // Am: A2, E3
  [41, 2], [48, 2], // F:  F2, C3
  [48, 2], [55, 2], // C:  C3, G3
  [43, 2], [50, 2], // G:  G2, D3
  [45, 2], [52, 2], // Am
  [41, 2], [48, 2], // F
  [48, 2], [55, 2], // C
  [43, 2], [50, 2], // G
];

/** Melody voice: a gentle A-minor pentatonic line, one bar per chord. */
export const BGM_MELODY: readonly BgmNoteDef[] = [
  [76, 1], [72, 1], [69, 2], // Am: E5 C5 A4
  [69, 1], [72, 1], [74, 2], // F:  A4 C5 D5
  [76, 2], [74, 1], [72, 1], // C:  E5 D5 C5
  [67, 2], [74, 2],          // G:  G4 D5
  [76, 1], [74, 1], [72, 2], // Am: E5 D5 C5
  [69, 1], [67, 1], [65, 2], // F:  A4 G4 F4
  [67, 2], [76, 1], [67, 1], // C:  G4 E5 G4
  [69, 3], [null, 1],        // G:  A4 — (breath)
];

/** MIDI number → frequency in Hz (A4 = 440). */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Expand a part into scheduled notes (start/dur in seconds, relative to the
 *  loop boundary). Rests (`null`) are skipped. The part is designed so the
 *  last note ends exactly on the loop boundary, making it seamlessly loopable. */
export function scheduleBgmPart(part: readonly BgmNoteDef[]): BgmScheduledNote[] {
  const notes: BgmScheduledNote[] = [];
  let beat = 0;
  for (const [midi, beats] of part) {
    if (midi != null && beats > 0) {
      notes.push({
        start: beat * BGM_BEAT_SECONDS,
        dur: beats * BGM_BEAT_SECONDS,
        freq: midiToFreq(midi),
      });
    }
    beat += beats;
  }
  return notes;
}

/** Total length of a part in beats. */
export function bgmLoopBeats(part: readonly BgmNoteDef[]): number {
  return part.reduce((sum, [, beats]) => sum + beats, 0);
}

/** Total length of a part in seconds. */
export function bgmLoopSeconds(part: readonly BgmNoteDef[]): number {
  return bgmLoopBeats(part) * BGM_BEAT_SECONDS;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  enabled = true;
  /** AUD-02: BGM mute state (toggled with `M`; SFX are never affected). */
  bgmMuted = false;
  /** AUD-02: true while the BGM scheduler is running. */
  bgmPlaying = false;
  private bgmGain: GainNode | null = null;
  private bgmTimer: number | null = null;
  private bgmAnchor = 0;
  private bgmParts: { osc: OscillatorType; vol: number; notes: BgmScheduledNote[]; next: number; cycles: number }[] = [];

  /** Create/resume the context. Call from a user gesture. */
  init(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
        // Pre-render a white-noise buffer for gunshots.
        const len = Math.floor(this.ctx.sampleRate * 0.5);
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      // AUD-02: the BGM runs on its own gain node, deliberately ~0.2 of the
      // master (≈0.5) — gunshots (0.7) and hits (0.28–0.4) always stay louder.
      if (!this.bgmGain && this.master) {
        this.bgmGain = this.ctx.createGain();
        this.bgmGain.gain.value = BGM_LEVEL;
        this.bgmGain.connect(this.master);
      }
    } catch {
      this.ctx = null;
    }
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  private env(gain: number, attack: number, decay: number): GainNode | null {
    if (!this.ctx || !this.master) return null;
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(this.master);
    return g;
  }

  private blip(freq: number, endFreq: number, dur: number, vol: number, type: OscillatorType = 'sine'): void {
    if (!this.ready || !this.enabled) return;
    const g = this.env(vol, 0.002, dur);
    if (!g || !this.ctx) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    const t = this.ctx.currentTime;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + dur);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(vol: number, dur: number, filterFreq: number, q = 1): void {
    if (!this.ready || !this.enabled || !this.noiseBuf || !this.ctx) return;
    const g = this.env(vol, 0.001, dur);
    if (!g) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = filterFreq;
    f.Q.value = q;
    src.connect(f);
    f.connect(g);
    const t = this.ctx.currentTime;
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** Footstep (AUD-01): a short, dry "scuff" of sand — the shared white-noise
   *  buffer through a narrow bandpass centred in the 2–4 kHz range with a very
   *  short (60–120 ms) decay. Deliberately QUIET (ambient, never a cue — well
   *  below a gunshot) and randomly nudged in frequency + level + length per
   *  call so consecutive steps never sound mechanically identical. `intensity`
   *  0..1 (sprint / landing are louder than a plain walk step). */
  footstep(intensity: number): void {
    if (!this.ready || !this.enabled) return;
    const v = Math.max(0.03, Math.min(1, intensity));
    const freq = 2200 + Math.random() * 1600; // 2.2–3.8 kHz band centre
    const vol = 0.12 * v * (0.8 + Math.random() * 0.4); // far below a gunshot
    const dur = 0.06 + Math.random() * 0.06; // 60–120 ms tail
    this.noise(vol, dur, freq, 1.4);
  }

  /** Gunshot. `vol` 0..1 (distance-attenuated). */
  shot(vol: number): void {
    if (!this.ready || !this.enabled) return;
    const v = Math.max(0.02, Math.min(1, vol));
    this.noise(0.7 * v, 0.12, 1800, 0.8);
    this.blip(180, 60, 0.12, 0.5 * v, 'triangle');
  }

  /** Hitmarker. */
  hit(head: boolean): void {
    if (!this.ready || !this.enabled) return;
    this.blip(head ? 1400 : 900, head ? 900 : 700, 0.06, head ? 0.4 : 0.28, 'square');
  }

  /** Kill confirmation. */
  kill(): void {
    if (!this.ready || !this.enabled) return;
    this.blip(660, 660, 0.09, 0.3, 'sine');
    this.blip(990, 990, 0.12, 0.28, 'sine');
  }

  /** Taking damage (the player WAS hit). A low, dull thud — deliberately
   *  down an octave and in a different waveform family from `hit()`, the
   *  bright square-wave hitmarker the player makes when Hitting an enemy. */
  hurt(head: boolean): void {
    if (!this.ready || !this.enabled) return;
    this.blip(head ? 130 : 95, head ? 45 : 40, 0.16, head ? 0.55 : 0.42, 'sawtooth');
    this.noise(head ? 0.3 : 0.22, 0.1, 320, 0.6);
  }

  end(won: boolean): void {
    if (!this.ready || !this.enabled) return;
    const notes = won ? [523, 659, 784, 1046] : [392, 330, 262, 196];
    notes.forEach((f, i) => setTimeout(() => this.blip(f, f, 0.22, 0.3, 'triangle'), i * 140));
  }

  // ---- BGM (AUD-02) -------------------------------------------------------

  /** Start the looping BGM (or resume after a pause). No-op while muted or
   *  before the context exists (the first user gesture creates it). */
  bgmEnsurePlaying(): void {
    if (this.bgmMuted || !this.ready || !this.ctx || !this.master) return;
    if (this.bgmTimer != null) return; // already running
    if (!this.bgmGain) {
      this.bgmGain = this.ctx.createGain();
      this.bgmGain.gain.value = BGM_LEVEL;
      this.bgmGain.connect(this.master);
    }
    this.bgmParts = [
      { osc: 'triangle', vol: 0.5, notes: scheduleBgmPart(BGM_MELODY), next: 0, cycles: 0 },
      { osc: 'sine', vol: 0.42, notes: scheduleBgmPart(BGM_BASS), next: 0, cycles: 0 },
    ];
    this.bgmAnchor = this.ctx.currentTime;
    this.bgmPlaying = true;
    this.bgmTimer = window.setInterval(() => this.tickBgm(), 100);
    this.tickBgm();
  }

  /** Stop the BGM with a short fade (also used for the match-end hand-off to
   *  the win/lose stinger). Idempotent. */
  bgmStop(): void {
    if (this.bgmTimer != null) {
      window.clearInterval(this.bgmTimer);
      this.bgmTimer = null;
    }
    this.bgmPlaying = false;
    const g = this.bgmGain;
    const ctx = this.ctx;
    this.bgmGain = null;
    if (g && ctx) {
      try {
        g.gain.cancelScheduledValues(ctx.currentTime);
        g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
        g.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
        window.setTimeout(() => {
          try { g.disconnect(); } catch { /* already gone */ }
        }, 400);
      } catch { /* headless / already closed */ }
    }
  }

  /** Pause the BGM (Esc / pointer-lock loss). Resuming goes through
   *  `bgmEnsurePlaying()`, which restarts the loop from its top. */
  bgmPause(): void {
    this.bgmStop();
  }

  /** `M` key: flip the BGM mute. Muting stops the scheduler now; unmuting
   *  restarts it if the context is ready. SFX are never affected. */
  toggleBgmMute(): boolean {
    this.bgmMuted = !this.bgmMuted;
    if (this.bgmMuted) this.bgmStop();
    else this.bgmEnsurePlaying();
    return this.bgmMuted;
  }

  /** Lookahead scheduler: every 100 ms, schedule not-yet-sounded notes of
   *  both voices whose loop-time falls within the next 0.3 s. */
  private tickBgm(): void {
    const ctx = this.ctx;
    const gain = this.bgmGain;
    if (!ctx || !gain || !this.bgmPlaying) return;
    const now = ctx.currentTime;
    const loop = bgmLoopSeconds(BGM_MELODY);
    for (const part of this.bgmParts) {
      const { notes } = part;
      while (part.next < notes.length) {
        const n = notes[part.next];
        const when = this.bgmAnchor + part.cycles * loop + n.start;
        if (when > now + 0.3) break;
        if (when >= now - 0.05) this.playBgmNote(part.osc, part.vol, n.freq, n.dur, Math.max(when, now));
        part.next++;
        if (part.next === notes.length) {
          part.next = 0;
          part.cycles++;
        }
      }
    }
  }

  /** One BGM note: soft triangle/sine tone with a gentle ADSR (fast attack,
   *  slight duck under the sustain, short linear release) — no percussive
   *  transients, so it stays pleasant under a long loop. */
  private playBgmNote(type: OscillatorType, vol: number, freq: number, dur: number, when: number): void {
    const ctx = this.ctx;
    const g = this.bgmGain;
    if (!ctx || !g) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const eg = ctx.createGain();
    const a = 0.03;
    const r = 0.12;
    eg.gain.setValueAtTime(0.0001, when);
    eg.gain.linearRampToValueAtTime(vol, when + a);
    eg.gain.setValueAtTime(vol * 0.85, Math.max(when + a, when + dur - r));
    eg.gain.linearRampToValueAtTime(0.0001, when + dur + r);
    o.connect(eg);
    eg.connect(g);
    o.start(when);
    o.stop(when + dur + r + 0.05);
  }
}
