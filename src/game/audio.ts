// Procedural WebAudio SFX + BGM. No assets — every sound is synthesized.
// The context is created/resumed on the first user gesture (browsers require
// it); until then every play() call is a no-op.

// ---------------------------------------------------------------------------
// BGM (AUD-03) — a fast, tense, combat-style loop, fully synthesized.
// Five voices: a sawtooth melody (low-passed) and a square-wave driving
// eighth-note bass over an Am–F–G–F (A) / Am–F–G–E (B) progression, plus a
// synthesized drum skeleton (sine-drop kick, noise snare, high-passed noise
// hats) on a 150 BPM clock. The part data and the scheduling maths below are
// PURE (no AudioContext), so they are unit-testable in node; the class just
// turns them into nodes on a dedicated gain that stays well below the SFX
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

export const BGM_TEMPO_BPM = 150;
export const BGM_BEAT_SECONDS = 60 / BGM_TEMPO_BPM;
/** BGM bus level relative to the SFX master (0.5) — kept at 0.2 from AUD-02,
 *  never raised for AUD-03: gunshots (0.7) and hits (0.28–0.42) must always
 *  sit on top, and the added drums stay soft relative to the bus. */
export const BGM_LEVEL = 0.2;
/** One A/B section is 4 bars (16 beats); the full loop is A+B = 32 beats. */
export const BGM_SECTION_BEATS = 16;

/**
 * A/B structure: section A (beats 0–15) is Am–F–G–F, section B (beats 16–31)
 * is Am–F–G–E — the borrowed E (iv) on the final bar keeps the loop tense
 * instead of resolving, and falls straight back into the Am that opens A.
 * Every voice is exported both as A/B halves and as the combined 32-beat
 * loop, so the section lengths and the A→B switch point are unit-testable.
 */

/** Melody, section A: driving eighth-note riff, one bar per chord. */
export const BGM_MELODY_A: readonly BgmNoteDef[] = [
  [76, 0.5], [76, 0.5], [74, 0.5], [72, 0.5], [69, 1], [69, 0.5], [72, 0.5], // Am
  [69, 0.5], [72, 0.5], [74, 0.5], [77, 0.5], [74, 1], [null, 1],            // F
  [74, 0.5], [71, 0.5], [67, 0.5], [71, 0.5], [74, 0.5], [71, 0.5], [67, 1], // G
  [72, 0.5], [72, 0.5], [69, 0.5], [72, 0.5], [74, 1], [77, 0.5], [74, 0.5], // F
];

/** Melody, section B: same energy, inflected for Am–F–G–E. */
export const BGM_MELODY_B: readonly BgmNoteDef[] = [
  [76, 0.5], [74, 0.5], [76, 0.5], [74, 0.5], [76, 0.5], [74, 0.5], [72, 1], // Am
  [77, 0.5], [74, 0.5], [77, 0.5], [74, 0.5], [72, 0.5], [74, 0.5], [77, 1], // F
  [74, 0.5], [74, 0.5], [71, 0.5], [74, 0.5], [79, 0.5], [74, 0.5], [71, 1], // G
  [76, 0.5], [74, 0.5], [71, 0.5], [74, 0.5], [76, 0.5], [74, 0.5], [71, 1], // E
];

export const BGM_MELODY: readonly BgmNoteDef[] = [...BGM_MELODY_A, ...BGM_MELODY_B];

/** Bass, section A: root/octave eighth-note drive, one bar per chord. */
export const BGM_BASS_A: readonly BgmNoteDef[] = [
  [45, 0.5], [57, 0.5], [45, 0.5], [57, 0.5], [45, 0.5], [57, 0.5], [45, 0.5], [57, 0.5], // Am: A2/A3
  [41, 0.5], [53, 0.5], [41, 0.5], [53, 0.5], [41, 0.5], [53, 0.5], [41, 0.5], [53, 0.5], // F:  F2/F3
  [43, 0.5], [55, 0.5], [43, 0.5], [55, 0.5], [43, 0.5], [55, 0.5], [43, 0.5], [55, 0.5], // G:  G2/G3
  [41, 0.5], [53, 0.5], [41, 0.5], [53, 0.5], [41, 0.5], [53, 0.5], [41, 0.5], [53, 0.5], // F
];

/** Bass, section B: same drive, landing on an E pedal into the loop restart. */
export const BGM_BASS_B: readonly BgmNoteDef[] = [
  [45, 0.5], [57, 0.5], [45, 0.5], [57, 0.5], [45, 0.5], [57, 0.5], [45, 0.5], [57, 0.5], // Am: A2/A3
  [41, 0.5], [53, 0.5], [41, 0.5], [53, 0.5], [41, 0.5], [53, 0.5], [41, 0.5], [53, 0.5], // F:  F2/F3
  [43, 0.5], [55, 0.5], [43, 0.5], [55, 0.5], [43, 0.5], [55, 0.5], [43, 0.5], [55, 0.5], // G:  G2/G3
  [40, 0.5], [52, 0.5], [40, 0.5], [52, 0.5], [40, 0.5], [52, 0.5], [40, 0.5], [52, 0.5], // E:  E2/E3
];

export const BGM_BASS: readonly BgmNoteDef[] = [...BGM_BASS_A, ...BGM_BASS_B];

// ---------------------------------------------------------------------------
// Drum parts. Same pure data/scheduling paradigm as the pitched voices:
// `[kind (null = rest), length in beats]`, expanded by `scheduleBgmDrum()`
// into absolute times. Kicks are louder + snappy, hats deliberately the
// softest voice so the drum skeleton never fights gunshots (AUD-03 rule).
// ---------------------------------------------------------------------------

export type BgmDrumKind = 'kick' | 'snare' | 'hat';

/** One slot of a BGM drum part: `[drum kind (null = rest), length in beats]`. */
export type BgmDrumDef = readonly [kind: BgmDrumKind | null, beats: number];

export interface BgmScheduledDrum {
  /** Start offset in seconds from the loop boundary. */
  start: number;
  /** Slot length in seconds (the actual hit is always shorter). */
  dur: number;
  kind: BgmDrumKind;
}

/** Kick, section A: half-time backbeat (beats 1 and 3 of each bar). */
export const BGM_DRUM_KICK_A: readonly BgmDrumDef[] = [
  ['kick', 2], [null, 2],
  ['kick', 2], [null, 2],
  ['kick', 2], [null, 2],
  ['kick', 2], [null, 2],
];

/** Kick, section B: four-on-the-floor for maximum drive. */
export const BGM_DRUM_KICK_B: readonly BgmDrumDef[] = [
  ['kick', 1], ['kick', 1], ['kick', 1], ['kick', 1],
  ['kick', 1], ['kick', 1], ['kick', 1], ['kick', 1],
  ['kick', 1], ['kick', 1], ['kick', 1], ['kick', 1],
  ['kick', 1], ['kick', 1], ['kick', 1], ['kick', 1],
];

export const BGM_DRUM_KICK: readonly BgmDrumDef[] = [...BGM_DRUM_KICK_A, ...BGM_DRUM_KICK_B];

/** Snare, section A: straight backbeat (beats 2 and 4). */
export const BGM_DRUM_SNARE_A: readonly BgmDrumDef[] = [
  [null, 1], ['snare', 1], [null, 1], ['snare', 1],
  [null, 1], ['snare', 1], [null, 1], ['snare', 1],
  [null, 1], ['snare', 1], [null, 1], ['snare', 1],
  [null, 1], ['snare', 1], [null, 1], ['snare', 1],
];

/** Snare, section B: backbeat bars + a fill driving into the loop restart. */
export const BGM_DRUM_SNARE_B: readonly BgmDrumDef[] = [
  [null, 1], ['snare', 1], [null, 1], ['snare', 1],
  [null, 1], ['snare', 1], [null, 1], ['snare', 1],
  [null, 1], ['snare', 1], [null, 1], ['snare', 1],
  [null, 1], ['snare', 1], ['snare', 0.5], ['snare', 0.5], ['snare', 1], // fill
];

export const BGM_DRUM_SNARE: readonly BgmDrumDef[] = [...BGM_DRUM_SNARE_A, ...BGM_DRUM_SNARE_B];

/** Hats, section A: steady eighth notes. */
export const BGM_DRUM_HAT_A: readonly BgmDrumDef[] = Array.from(
  { length: BGM_SECTION_BEATS * 2 },
  (): BgmDrumDef => ['hat', 0.5],
);

/** Hats, section B: eighths, with a sixteenth run on the final bar. */
export const BGM_DRUM_HAT_B: readonly BgmDrumDef[] = [
  ...Array.from({ length: 12 * 2 }, (): BgmDrumDef => ['hat', 0.5] as const), // bars 5–7: eighths
  ['hat', 0.5], ['hat', 0.5], ['hat', 0.5], ['hat', 0.5], ['hat', 0.5], ['hat', 0.5],
  ['hat', 0.25], ['hat', 0.25], ['hat', 0.25], ['hat', 0.25], // bar 8: sixteenth run
];

export const BGM_DRUM_HAT: readonly BgmDrumDef[] = [...BGM_DRUM_HAT_A, ...BGM_DRUM_HAT_B];

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

/** Total length of a part in beats. Accepts both pitched (`BgmNoteDef`)
 *  and drum (`BgmDrumDef`) slots — only the second element is read. */
export function bgmLoopBeats(part: readonly (readonly [unknown, number])[]): number {
  return part.reduce((sum, [, beats]) => sum + beats, 0);
}

/** Total length of a part in seconds. */
export function bgmLoopSeconds(part: readonly (readonly [unknown, number])[]): number {
  return bgmLoopBeats(part) * BGM_BEAT_SECONDS;
}

/** Expand a drum part into scheduled hits (start/dur in seconds, relative to
 *  the loop boundary). Rests (`null`) are skipped. Mirrors `scheduleBgmPart`
 *  exactly so every BGM voice shares one scheduling paradigm. */
export function scheduleBgmDrum(part: readonly BgmDrumDef[]): BgmScheduledDrum[] {
  const hits: BgmScheduledDrum[] = [];
  let beat = 0;
  for (const [kind, beats] of part) {
    if (kind != null && beats > 0) {
      hits.push({
        start: beat * BGM_BEAT_SECONDS,
        dur: beats * BGM_BEAT_SECONDS,
        kind,
      });
    }
    beat += beats;
  }
  return hits;
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
  private bgmParts: {
    voice: 'melody' | 'bass' | 'drum';
    osc?: OscillatorType;
    vol?: number;
    cutoff?: number;
    notes: (BgmScheduledNote | BgmScheduledDrum)[];
    next: number;
    cycles: number;
  }[] = [];

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
    // AUD-03: five voices. The drum skeleton sits at the bottom of the BGM
    // bus (hats ≈0.1 of the 0.2 bus ≈ 0.01 of the SFX master — far below a
    // gunshot's 0.35) so it adds pulse without stealing gun clarity.
    this.bgmParts = [
      { voice: 'melody', osc: 'sawtooth', vol: 0.3, cutoff: 2400, notes: scheduleBgmPart(BGM_MELODY), next: 0, cycles: 0 },
      { voice: 'bass', osc: 'square', vol: 0.26, cutoff: 520, notes: scheduleBgmPart(BGM_BASS), next: 0, cycles: 0 },
      { voice: 'drum', notes: scheduleBgmDrum(BGM_DRUM_KICK), next: 0, cycles: 0 },
      { voice: 'drum', notes: scheduleBgmDrum(BGM_DRUM_SNARE), next: 0, cycles: 0 },
      { voice: 'drum', notes: scheduleBgmDrum(BGM_DRUM_HAT), next: 0, cycles: 0 },
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
        if (when >= now - 0.05) {
          const at = Math.max(when, now);
          if ('kind' in n) this.playBgmDrum(n.kind, at);
          else this.playBgmNote(part.osc ?? 'sine', part.vol ?? 0.3, n.freq, n.dur, at, part.cutoff ?? 4000);
        }
        part.next++;
        if (part.next === notes.length) {
          part.next = 0;
          part.cycles++;
        }
      }
    }
  }

  /** One BGM note: pitched tone through a low-pass (AUD-03: sawtooth/square
   *  bodies, tamed by the filter) with a punchy envelope — fast attack,
   *  slight duck under the sustain, short release so eighth notes stay
   *  articulate. */
  private playBgmNote(type: OscillatorType, vol: number, freq: number, dur: number, when: number, cutoff: number): void {
    const ctx = this.ctx;
    const g = this.bgmGain;
    if (!ctx || !g) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    f.Q.value = 0.8;
    const eg = ctx.createGain();
    const a = 0.006;
    const r = 0.05;
    eg.gain.setValueAtTime(0.0001, when);
    eg.gain.linearRampToValueAtTime(vol, when + a);
    eg.gain.setValueAtTime(vol * 0.75, Math.max(when + a, when + dur - r));
    eg.gain.linearRampToValueAtTime(0.0001, when + dur + r);
    o.connect(f);
    f.connect(eg);
    eg.connect(g);
    o.start(when);
    o.stop(when + dur + r + 0.05);
  }

  /** Dispatch a scheduled drum hit. All three reuse the pre-rendered
   *  white-noise buffer or a plain oscillator, and all route through the
   *  BGM gain bus so `M`-mute / pause / end-of-match fades cover them. */
  private playBgmDrum(kind: BgmDrumKind, when: number): void {
    const ctx = this.ctx;
    const g = this.bgmGain;
    if (!ctx || !g) return;
    if (kind === 'kick') {
      // Sine drop 160 → 45 Hz, ~130 ms: a tight, low thump.
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(160, when);
      o.frequency.exponentialRampToValueAtTime(45, when + 0.1);
      const eg = ctx.createGain();
      eg.gain.setValueAtTime(0.55, when);
      eg.gain.exponentialRampToValueAtTime(0.0001, when + 0.13);
      o.connect(eg);
      eg.connect(g);
      o.start(when);
      o.stop(when + 0.15);
      return;
    }
    if (!this.noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    const eg = ctx.createGain();
    if (kind === 'snare') {
      // Band-centred noise burst, ~90 ms: the short "snap" of a snare.
      f.type = 'bandpass';
      f.frequency.value = 1800;
      f.Q.value = 0.9;
      eg.gain.setValueAtTime(0.3, when);
      eg.gain.exponentialRampToValueAtTime(0.0001, when + 0.09);
    } else {
      // High-passed hiss, ~35 ms: the softest voice of the whole BGM.
      f.type = 'highpass';
      f.frequency.value = 7500;
      eg.gain.setValueAtTime(0.1, when);
      eg.gain.exponentialRampToValueAtTime(0.0001, when + 0.035);
    }
    src.connect(f);
    f.connect(eg);
    eg.connect(g);
    src.start(when);
    src.stop(when + 0.1);
  }
}
