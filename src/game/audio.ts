// Procedural WebAudio SFX. No assets — every sound is synthesized. The context
// is created/resumed on the first user gesture (browsers require it); until
// then every play() call is a no-op.

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  enabled = true;

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

  reload(): void {
    if (!this.ready || !this.enabled) return;
    this.blip(500, 320, 0.05, 0.2, 'square');
    setTimeout(() => this.blip(360, 520, 0.06, 0.2, 'square'), 160);
  }

  empty(): void {
    if (!this.ready || !this.enabled) return;
    this.blip(220, 180, 0.05, 0.18, 'square');
  }

  end(won: boolean): void {
    if (!this.ready || !this.enabled) return;
    const notes = won ? [523, 659, 784, 1046] : [392, 330, 262, 196];
    notes.forEach((f, i) => setTimeout(() => this.blip(f, f, 0.22, 0.3, 'triangle'), i * 140));
  }
}
