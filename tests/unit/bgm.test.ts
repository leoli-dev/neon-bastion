// AUD-03: pure BGM data + scheduling maths (no AudioContext involved —
// `src/game/audio.ts` exports them so node can test them directly).

import { describe, it, expect } from 'vitest';
import {
  BGM_BASS,
  BGM_BASS_A,
  BGM_BASS_B,
  BGM_BEAT_SECONDS,
  BGM_DRUM_HAT,
  BGM_DRUM_HAT_A,
  BGM_DRUM_HAT_B,
  BGM_DRUM_KICK,
  BGM_DRUM_KICK_A,
  BGM_DRUM_KICK_B,
  BGM_DRUM_SNARE,
  BGM_DRUM_SNARE_A,
  BGM_DRUM_SNARE_B,
  BGM_LEVEL,
  BGM_MELODY,
  BGM_MELODY_A,
  BGM_MELODY_B,
  BGM_SECTION_BEATS,
  BGM_TEMPO_BPM,
  bgmLoopBeats,
  bgmLoopSeconds,
  midiToFreq,
  scheduleBgmDrum,
  scheduleBgmPart,
  type BgmDrumDef,
  type BgmNoteDef,
} from '../../src/game/audio';

describe('midiToFreq', () => {
  it('A4 (MIDI 69) is exactly 440 Hz', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
  });

  it('matches known reference pitches', () => {
    expect(midiToFreq(60)).toBeCloseTo(261.6256, 3); // C4
    expect(midiToFreq(45)).toBeCloseTo(110.0, 3); // A2
    expect(midiToFreq(81)).toBeCloseTo(880.0, 3); // A5
  });

  it('octaves are exactly 2× and each semitone is the 12th root of 2', () => {
    expect(midiToFreq(81) / midiToFreq(69)).toBeCloseTo(2, 9);
    expect(midiToFreq(70) / midiToFreq(69)).toBeCloseTo(Math.pow(2, 1 / 12), 9);
  });
});

describe('scheduleBgmPart', () => {
  const melodyNotes = scheduleBgmPart(BGM_MELODY);

  it('note n starts at the cumulative beat offset of the part (rests advance the clock)', () => {
    // Walk the slots: rests count toward the beat clock but schedule nothing.
    const expected: number[] = [];
    let beat = 0;
    for (const [midi, beats] of BGM_MELODY) {
      if (midi != null) expected.push(beat * BGM_BEAT_SECONDS);
      beat += beats;
    }
    expect(melodyNotes).toHaveLength(expected.length);
    for (let i = 0; i < melodyNotes.length; i++) {
      expect(melodyNotes[i].start).toBeCloseTo(expected[i], 9);
    }
  });

  it('each note lasts exactly its slot length (beats → seconds)', () => {
    // Walk slots and compare against scheduled durations.
    const durations: number[] = [];
    for (const [midi, beats] of BGM_MELODY) {
      if (midi != null) durations.push(beats * BGM_BEAT_SECONDS);
    }
    for (let i = 0; i < melodyNotes.length; i++) {
      expect(melodyNotes[i].dur).toBeCloseTo(durations[i], 9);
    }
  });

  it('note frequencies are midiToFreq of the part', () => {
    const slots = BGM_MELODY.filter(([m]) => m != null) as [number, number][];
    expect(melodyNotes[0].freq).toBeCloseTo(midiToFreq(slots[0][0]), 9); // E5
    expect(melodyNotes[4].freq).toBeCloseTo(midiToFreq(slots[4][0]), 9);
  });

  it('rests (null) are skipped — the melody has 56 slots, 1 rest, 55 notes', () => {
    const rests = BGM_MELODY.filter(([m]) => m == null).length;
    expect(rests).toBe(1);
    expect(melodyNotes).toHaveLength(BGM_MELODY.length - rests);
  });

  it('notes never overlap and no part ends more than one beat early (trailing rest = breath)', () => {
    for (let i = 1; i < melodyNotes.length; i++) {
      expect(melodyNotes[i].start).toBeGreaterThanOrEqual(melodyNotes[i - 1].start + melodyNotes[i - 1].dur - 1e-9);
    }
    const last = melodyNotes[melodyNotes.length - 1];
    const loop = bgmLoopSeconds(BGM_MELODY);
    expect(last.start + last.dur).toBeLessThanOrEqual(loop + 1e-9);
    expect(last.start + last.dur).toBeGreaterThanOrEqual(loop - BGM_BEAT_SECONDS - 1e-9);
  });
});

describe('scheduleBgmDrum', () => {
  const kicks = scheduleBgmDrum(BGM_DRUM_KICK);
  const hats = scheduleBgmDrum(BGM_DRUM_HAT);

  it('drum hits start at the cumulative beat offset of their part (rests advance the clock)', () => {
    const expected: number[] = [];
    let beat = 0;
    for (const [kind, beats] of BGM_DRUM_KICK) {
      if (kind != null) expected.push(beat * BGM_BEAT_SECONDS);
      beat += beats;
    }
    expect(kicks).toHaveLength(expected.length);
    for (let i = 0; i < kicks.length; i++) {
      expect(kicks[i].start).toBeCloseTo(expected[i], 9);
    }
  });

  it('keeps the drum kind and slot length on every scheduled hit', () => {
    expect(kicks.every((h) => h.kind === 'kick')).toBe(true);
    expect(hats.every((h) => h.kind === 'hat')).toBe(true);
    // Eighth grid, with a sixteenth run only on the final bar of section B.
    const slotBeats = (h: { dur: number }): number => +(h.dur / BGM_BEAT_SECONDS).toFixed(6);
    for (const h of hats) {
      expect([0.25, 0.5]).toContain(slotBeats(h));
    }
    expect(hats.filter((h) => slotBeats(h) === 0.25)).toHaveLength(4); // exactly one bar of sixteenths
  });

  it('rests (null) are skipped', () => {
    const rests = BGM_DRUM_KICK.filter(([k]) => k == null).length;
    expect(rests).toBeGreaterThan(0);
    expect(kicks).toHaveLength(BGM_DRUM_KICK.length - rests);
  });

  it('hits never overlap within a part', () => {
    for (const part of [BGM_DRUM_KICK, BGM_DRUM_SNARE, BGM_DRUM_HAT]) {
      const hits = scheduleBgmDrum(part);
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i].start).toBeGreaterThanOrEqual(hits[i - 1].start + hits[i - 1].dur - 1e-9);
      }
    }
  });
});

describe('tempo (AUD-03)', () => {
  it('is a fast combat tempo in the 140–165 BPM range', () => {
    expect(BGM_TEMPO_BPM).toBeGreaterThanOrEqual(140);
    expect(BGM_TEMPO_BPM).toBeLessThanOrEqual(165);
    expect(BGM_TEMPO_BPM).toBe(150);
  });

  it('is well above the old 84 BPM background tune', () => {
    expect(BGM_TEMPO_BPM).toBeGreaterThan(84);
  });

  it('BGM_BEAT_SECONDS is the exact 60/BPM reciprocal', () => {
    expect(BGM_BEAT_SECONDS).toBeCloseTo(60 / BGM_TEMPO_BPM, 12);
    expect(BGM_BEAT_SECONDS).toBeCloseTo(0.4, 9); // 150 BPM
  });

  it('BGM_LEVEL stays at 0.2 — the SFX ratio must not grow (gunshots still on top)', () => {
    expect(BGM_LEVEL).toBeCloseTo(0.2, 9);
    expect(BGM_LEVEL).toBeLessThan(0.35); // 0.35 = 0.5 master × gunshot 0.7
  });
});

describe('A/B structure and loop length', () => {
  const pitchedParts: [string, readonly BgmNoteDef[], readonly BgmNoteDef[], readonly BgmNoteDef[]][] = [
    ['melody', BGM_MELODY_A, BGM_MELODY_B, BGM_MELODY],
    ['bass', BGM_BASS_A, BGM_BASS_B, BGM_BASS],
  ];
  const drumParts: [string, readonly BgmDrumDef[], readonly BgmDrumDef[], readonly BgmDrumDef[]][] = [
    ['kick', BGM_DRUM_KICK_A, BGM_DRUM_KICK_B, BGM_DRUM_KICK],
    ['snare', BGM_DRUM_SNARE_A, BGM_DRUM_SNARE_B, BGM_DRUM_SNARE],
    ['hat', BGM_DRUM_HAT_A, BGM_DRUM_HAT_B, BGM_DRUM_HAT],
  ];

  it('every section half spans exactly 16 beats (4 bars of 4/4)', () => {
    expect(BGM_SECTION_BEATS).toBe(16);
    for (const [name, a, b] of pitchedParts) {
      expect(bgmLoopBeats(a), `${name} A`).toBe(16);
      expect(bgmLoopBeats(b), `${name} B`).toBe(16);
    }
    for (const [name, a, b] of drumParts) {
      expect(bgmLoopBeats(a), `${name} A`).toBe(16);
      expect(bgmLoopBeats(b), `${name} B`).toBe(16);
    }
  });

  it('both A and B sections are 6.4 s at 150 BPM', () => {
    expect(bgmLoopSeconds(BGM_MELODY_A)).toBeCloseTo(6.4, 9);
    expect(bgmLoopSeconds(BGM_MELODY_B)).toBeCloseTo(6.4, 9);
  });

  it('the A→B switch point is exactly 16 beats (6.4 s) into the loop', () => {
    const switchPoint = BGM_SECTION_BEATS * BGM_BEAT_SECONDS;
    expect(switchPoint).toBeCloseTo(6.4, 9);
    // No note of the A half leaks past the switch; each half ends on the grid.
    for (const [name, a] of [...pitchedParts, ...drumParts]) {
      expect(bgmLoopBeats(a) * BGM_BEAT_SECONDS, name).toBeCloseTo(switchPoint, 9);
    }
  });

  it('the full loop is A+B = 32 beats for every one of the six voices', () => {
    for (const [name, , , full] of pitchedParts) {
      expect(bgmLoopBeats(full), name).toBe(32);
    }
    for (const [name, , , full] of drumParts) {
      expect(bgmLoopBeats(full), name).toBe(32);
    }
  });

  it('loop seconds = 32 beats at the tempo (150 BPM = 12.8 s)', () => {
    const seconds = bgmLoopSeconds(BGM_MELODY);
    expect(seconds).toBeCloseTo(32 * (60 / BGM_TEMPO_BPM), 9);
    expect(seconds).toBeCloseTo(12.8, 9);
  });

  it('all six voices loop over the same length (they must stay in sync)', () => {
    const loop = bgmLoopSeconds(BGM_MELODY);
    for (const [name, , , full] of pitchedParts) {
      expect(bgmLoopSeconds(full), name).toBeCloseTo(loop, 9);
    }
    for (const [name, , , full] of drumParts) {
      expect(bgmLoopSeconds(full), name).toBeCloseTo(loop, 9);
    }
  });

  it('every scheduled note/hit of all six voices fits inside one loop', () => {
    for (const part of [BGM_MELODY, BGM_BASS]) {
      const loop = bgmLoopSeconds(part);
      for (const n of scheduleBgmPart(part)) {
        expect(n.start).toBeGreaterThanOrEqual(0);
        expect(n.start + n.dur).toBeLessThanOrEqual(loop + 1e-9);
      }
    }
    for (const part of [BGM_DRUM_KICK, BGM_DRUM_SNARE, BGM_DRUM_HAT]) {
      const loop = bgmLoopSeconds(part);
      for (const h of scheduleBgmDrum(part)) {
        expect(h.start).toBeGreaterThanOrEqual(0);
        expect(h.start + h.dur).toBeLessThanOrEqual(loop + 1e-9);
      }
    }
  });
});
