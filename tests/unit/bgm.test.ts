// AUD-02: pure BGM data + scheduling maths (no AudioContext involved —
// `src/game/audio.ts` exports them so node can test them directly).

import { describe, it, expect } from 'vitest';
import {
  BGM_BASS,
  BGM_BEAT_SECONDS,
  BGM_MELODY,
  BGM_TEMPO_BPM,
  bgmLoopBeats,
  bgmLoopSeconds,
  midiToFreq,
  scheduleBgmPart,
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

  it('note n starts at the cumulative beat offset of the part', () => {
    // Cumulative beats of the first five SCHEDULED melody notes.
    // (BGM_MELODY has no rests before the final bar, so scheduled index n
    //  is simply the sum of the first n+1 slot lengths.)
    const beatsOf = (i: number): number =>
      BGM_MELODY.slice(0, i + 1).reduce((sum, [, b]) => sum + b, 0) - BGM_MELODY[i][1];
    for (let i = 0; i < 5; i++) {
      expect(melodyNotes[i].start).toBeCloseTo(beatsOf(i) * BGM_BEAT_SECONDS, 9);
    }
  });

  it('each note lasts exactly its slot length (beats → seconds)', () => {
    for (let i = 0; i < 5; i++) {
      expect(melodyNotes[i].dur).toBeCloseTo(BGM_MELODY[i][1] * BGM_BEAT_SECONDS, 9);
    }
  });

  it('note frequencies are midiToFreq of the part', () => {
    expect(melodyNotes[0].freq).toBeCloseTo(midiToFreq(76), 9); // E5
    expect(melodyNotes[2].freq).toBeCloseTo(midiToFreq(69), 9); // A4
  });

  it('rests (null) are skipped — the melody has 31 slots, 1 rest, 30 notes', () => {
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

describe('loop length', () => {
  it('both voices span exactly 32 beats (8 bars of 4/4)', () => {
    expect(bgmLoopBeats(BGM_MELODY)).toBe(32);
    expect(bgmLoopBeats(BGM_BASS)).toBe(32);
  });

  it('loop seconds = 32 beats at the tempo (84 BPM ≈ 22.86 s)', () => {
    const seconds = bgmLoopSeconds(BGM_MELODY);
    expect(seconds).toBeCloseTo(32 * (60 / BGM_TEMPO_BPM), 9);
    expect(seconds).toBeCloseTo(22.857142, 4);
  });

  it('melody and bass loops are the same length (they must stay in sync)', () => {
    expect(bgmLoopSeconds(BGM_MELODY)).toBeCloseTo(bgmLoopSeconds(BGM_BASS), 9);
  });

  it('every scheduled note of both voices fits inside one loop', () => {
    for (const part of [BGM_MELODY, BGM_BASS]) {
      const loop = bgmLoopSeconds(part);
      for (const n of scheduleBgmPart(part)) {
        expect(n.start).toBeGreaterThanOrEqual(0);
        expect(n.start + n.dur).toBeLessThanOrEqual(loop + 1e-9);
      }
    }
  });
});
