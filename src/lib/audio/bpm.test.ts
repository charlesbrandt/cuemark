/**
 * Beat-grid algorithm tests — synthetic RMS envelopes with known ground truth.
 *
 * These are the acceptance criteria for the fractional-BPM work: a fit that is
 * "plausible but 0.2% off" is exactly the failure mode beat matching cannot
 * tolerate (0.2% ≈ one beat of drift every ~4 minutes), so the tolerances here
 * are deliberately tight. Run with `npm test`.
 */
import { describe, expect, it } from 'vitest';
import { detectBeatGrid, detectBpm, snapToNearestOnset, tapTempo } from './bpm';

const RATE = 210; // envelope samples/sec — must match ENVELOPE_RATE in waveform.ts

// Deterministic LCG so failures reproduce exactly.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface ClickOpts {
  bpm: number;
  offset: number;      // seconds — time of the first beat
  duration: number;    // seconds
  seed?: number;
  noiseFloor?: number; // baseline RMS noise amplitude
  dropProb?: number;   // probability a beat is silently skipped
  ampJitter?: number;  // ± fraction of amplitude variation per click
  halfBeatAmp?: number; // if > 0, add clicks between beats at this amplitude (8th notes)
}

/** Synthesize an RMS envelope of a click track: exponential-decay bumps on a noise floor. */
function clickEnvelope(opts: ClickOpts): Float32Array {
  const {
    bpm, offset, duration,
    seed = 42, noiseFloor = 0.004, dropProb = 0, ampJitter = 0, halfBeatAmp = 0,
  } = opts;
  const rng = makeRng(seed);
  const n = Math.round(duration * RATE);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = noiseFloor * (0.5 + rng());

  const period = 60 / bpm;
  const decay = 0.03; // 30 ms click decay
  const addClick = (t: number, amp: number) => {
    const startIdx = Math.max(0, Math.ceil(t * RATE));
    const endIdx = Math.min(n, startIdx + Math.round(0.12 * RATE));
    for (let i = startIdx; i < endIdx; i++) {
      const dt = i / RATE - t;
      env[i] += amp * Math.exp(-dt / decay);
    }
  };

  for (let k = 0; ; k++) {
    const t = offset + k * period;
    if (t >= duration) break;
    if (rng() >= dropProb) {
      addClick(t, 0.8 * (1 + ampJitter * (2 * rng() - 1)));
    }
    if (halfBeatAmp > 0) {
      const th = t + period / 2;
      if (th < duration) addClick(th, halfBeatAmp);
    }
  }
  return env;
}

/** Distance between two beat anchors modulo the beat period (both mark "a beat"). */
function phaseDistance(a: number, b: number, period: number): number {
  const d = (((a - b) % period) + period) % period;
  return Math.min(d, period - d);
}

describe('detectBeatGrid', () => {
  it('recovers fractional BPM and phase from a clean click track', () => {
    const truth = { bpm: 127.53, offset: 0.31 };
    const env = clickEnvelope({ ...truth, duration: 120 });
    const grid = detectBeatGrid(env, RATE);
    expect(grid).not.toBeNull();
    expect(Math.abs(grid!.bpm - truth.bpm)).toBeLessThan(0.05);
    expect(phaseDistance(grid!.gridOffset, truth.offset, 60 / truth.bpm)).toBeLessThan(0.02);
    expect(grid!.confidence).toBeGreaterThan(0.5);
  });

  it('returns the onset list the fit was computed from, close to the true click times', () => {
    const truth = { bpm: 127.53, offset: 0.31 };
    const env = clickEnvelope({ ...truth, duration: 120 });
    const grid = detectBeatGrid(env, RATE);
    expect(grid).not.toBeNull();
    expect(grid!.onsets.length).toBeGreaterThan(200); // ~254 beats over 120s at this tempo
    // Every synthetic click should have a detected onset nearby — loose enough to tolerate
    // the exponential-decay click shape's effect on sub-sample peak refinement, tight enough
    // to prove these are real per-click detections and not, say, one onset per several beats.
    const period = 60 / truth.bpm;
    for (let k = 0; k < 20; k++) {
      const t = truth.offset + k * period;
      const nearest = Math.min(...grid!.onsets.map((o) => Math.abs(o - t)));
      expect(nearest).toBeLessThan(0.1);
    }
  });

  it('stays accurate with dropped beats and amplitude jitter', () => {
    const truth = { bpm: 93.87, offset: 1.02 };
    const env = clickEnvelope({
      ...truth, duration: 180, dropProb: 0.2, ampJitter: 0.5, seed: 7,
    });
    const grid = detectBeatGrid(env, RATE);
    expect(grid).not.toBeNull();
    expect(Math.abs(grid!.bpm - truth.bpm)).toBeLessThan(0.1);
    expect(phaseDistance(grid!.gridOffset, truth.offset, 60 / truth.bpm)).toBeLessThan(0.025);
  });

  it('picks the beat level, not the half-tempo octave, with 8th-note onsets', () => {
    const truth = { bpm: 128, offset: 0.2 };
    const env = clickEnvelope({ ...truth, duration: 90, halfBeatAmp: 0.35, seed: 3 });
    const grid = detectBeatGrid(env, RATE);
    expect(grid).not.toBeNull();
    // 64 would be the systematic-downward-bias failure; 256 is out of range by design.
    expect(Math.abs(grid!.bpm - 128)).toBeLessThan(0.1);
  });

  it('works at high tempo (drum & bass range)', () => {
    const truth = { bpm: 174.35, offset: 0.05 };
    const env = clickEnvelope({ ...truth, duration: 120, seed: 11 });
    const grid = detectBeatGrid(env, RATE);
    expect(grid).not.toBeNull();
    expect(Math.abs(grid!.bpm - truth.bpm)).toBeLessThan(0.1);
  });

  it('returns null for a flat noise envelope', () => {
    const rng = makeRng(99);
    const env = new Float32Array(60 * RATE);
    for (let i = 0; i < env.length; i++) env[i] = 0.02 * (0.5 + rng());
    expect(detectBeatGrid(env, RATE)).toBeNull();
  });

  it('returns null when the track is too short to fit a grid', () => {
    const env = clickEnvelope({ bpm: 120, offset: 0.1, duration: 5 });
    expect(detectBeatGrid(env, RATE)).toBeNull();
  });
});

describe('snapToNearestOnset', () => {
  it('snaps to the nearest onset within tolerance', () => {
    const onsets = [1.0, 2.0, 3.5];
    expect(snapToNearestOnset(2.06, onsets)).toBe(2.0);
    expect(snapToNearestOnset(0.95, onsets)).toBe(1.0);
  });

  it('picks the closer of two onsets both within tolerance', () => {
    const onsets = [1.0, 1.08];
    expect(snapToNearestOnset(1.03, onsets)).toBe(1.0);
    expect(snapToNearestOnset(1.05, onsets)).toBe(1.08);
  });

  it('leaves the stamp unchanged when no onset is within tolerance', () => {
    const onsets = [1.0, 5.0];
    expect(snapToNearestOnset(2.5, onsets)).toBe(2.5);
  });

  it('leaves the stamp unchanged for an empty onset list', () => {
    expect(snapToNearestOnset(2.5, [])).toBe(2.5);
  });
});

describe('detectBpm (integer fallback, regression)', () => {
  it('still detects integer BPM from 30/s display peaks', () => {
    const peaksRate = 30;
    const rng = makeRng(5);
    const duration = 120;
    const peaks = new Float32Array(duration * peaksRate);
    for (let i = 0; i < peaks.length; i++) peaks[i] = 0.05 * rng();
    const period = 60 / 120;
    for (let k = 0; k * period < duration; k++) {
      const idx = Math.round(k * period * peaksRate);
      if (idx < peaks.length) peaks[idx] = 0.9;
    }
    expect(detectBpm(peaks, peaksRate)).toBe(120);
  });
});

describe('tapTempo (regression)', () => {
  it('averages tap intervals', () => {
    const t0 = 1_000_000;
    const taps = [0, 500, 1000, 1500, 2000].map((ms) => t0 + ms);
    expect(tapTempo(taps)).toBe(120);
  });
});
