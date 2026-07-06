const MIN_BPM = 60;
const MAX_BPM = 200;
const ONSET_THRESHOLD = 1.8;   // energy must be 1.8× local average to count as onset
const MIN_ONSET_SEP = 0.2;      // seconds — 300 BPM max onset rate

// ── Beat grid (fractional BPM + phase) ─────────────────────────────────────────
//
// detectBeatGrid() fits a constant-tempo grid to a high-rate RMS envelope
// (210 samples/s from Rust `audio_analyze_file`). Three stages:
//   1. Onset detection — log-domain half-wave-rectified envelope difference,
//      peak-picked with parabolic sub-sample timing refinement.
//   2. Coarse tempo — pairwise inter-onset-interval histogram (integer BPM bins)
//      weighted by onset strength and a log-normal tempo prior centered at 120 BPM.
//      The prior replaces the old ×2-harmonic folding: pairwise IOIs inherently
//      contain harmonic intervals, and the prior resolves octave ties toward
//      danceable tempo instead of systematically favoring the slower octave.
//   3. Refinement — a comb/Fourier scan: S(f) = Σ wⱼ·exp(2πi·f·tⱼ) is evaluated
//      over ±3% around the coarse candidate; |S| peaks where onsets align to a
//      grid of beat frequency f, and arg S gives the grid phase for free.
//      Parabolic interpolation of |S|² localizes f well below the scan step.
//
// The result is a beat-LEVEL grid: gridOffset marks *a* beat, not bar-beat-1.
// All current consumers (getPhase, phase nudge) work mod one beat, so bar-level
// downbeat identity is irrelevant; SET BEAT remains a manual override for it.

const GRID_MIN_ONSETS = 16;      // fewer onsets than this → no reliable fit
const GRID_MIN_SPAN = 8;         // seconds of onset coverage required
const GRID_CONFIDENCE_FLOOR = 0.15; // |S|/Σw below this → reject fit
const ONSET_MIN_SEP = 0.1;       // seconds — allows 16th notes up to 150 BPM
const PAIR_WINDOW = 1.5;         // seconds — max inter-onset gap considered
const PRIOR_CENTER = 120;        // BPM — log-normal tempo prior center
const PRIOR_SIGMA = 0.4;         // log-space width of the prior

export interface BeatGrid {
  bpm: number;        // fractional, rounded to 0.01
  gridOffset: number; // seconds in [0, 60/bpm): a beat lies at gridOffset + k·(60/bpm)
  confidence: number; // |S|/Σw in [0, 1] — 1.0 = every onset exactly on the grid
}

interface Onsets {
  times: number[];   // seconds, sub-sample refined
  weights: number[]; // linear envelope rise per onset, normalized to max 1
}

function detectOnsets(envelope: Float32Array, envelopeRate: number): Onsets {
  const n = envelope.length;
  const times: number[] = [];
  const weights: number[] = [];
  if (n < 4) return { times, weights };

  // Log-domain onset strength for DETECTION: loudness-invariant, so quiet intros
  // contribute onsets on equal footing with the drop.
  const o = new Float32Array(n);
  // Linear envelope rise for WEIGHTS: beat-marking hits (kicks) must outweigh
  // off-beat texture (hi-hats) in the comb sum, or S(f) at the beat frequency
  // partially cancels. Log compression flattens exactly that contrast — a 0.35
  // hat and a 0.8 kick both jump ~5 log units off a quiet floor — so weights
  // stay linear even though detection is logarithmic. Linear weights also make
  // spurious noise-floor onsets numerically negligible in the fit.
  const oLin = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const d = Math.log(envelope[i] + 1e-6) - Math.log(envelope[i - 1] + 1e-6);
    o[i] = d > 0 ? d : 0;
    const dl = envelope[i] - envelope[i - 1];
    oLin[i] = dl > 0 ? dl : 0;
  }

  // 3-tap smoothing so parabolic peak refinement sees a smooth local maximum.
  const s = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) s[i] = (o[i - 1] + o[i] + o[i + 1]) / 3;

  // Rolling mean over ±1 s via prefix sum (same trick as detectBpm).
  const halfWin = Math.round(envelopeRate);
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + s[i];
  const minSep = Math.round(ONSET_MIN_SEP * envelopeRate);
  let lastIdx = -minSep;

  for (let i = 1; i < n - 1; i++) {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(n - 1, i + halfWin);
    const localMean = (cum[hi + 1] - cum[lo]) / (hi - lo + 1);
    if (
      s[i] > 2 * localMean &&
      localMean > 0 &&
      s[i] >= s[i - 1] &&
      s[i] >= s[i + 1] &&
      i - lastIdx >= minSep
    ) {
      // Parabolic sub-sample refinement of the peak position.
      const denom = s[i - 1] - 2 * s[i] + s[i + 1];
      const delta = denom !== 0 ? 0.5 * (s[i - 1] - s[i + 1]) / denom : 0;
      const dClamped = Math.max(-0.5, Math.min(0.5, delta));
      times.push((i + dClamped) / envelopeRate);
      // The linear-rise maximum can land one hop off the smoothed-log peak.
      weights.push(Math.max(oLin[i - 1], oLin[i], oLin[i + 1]));
      lastIdx = i;
    }
  }

  const maxW = weights.reduce((a, b) => Math.max(a, b), 0);
  if (maxW > 0) for (let i = 0; i < weights.length; i++) weights[i] /= maxW;
  return { times, weights };
}

function tempoPrior(bpm: number): number {
  const z = Math.log(bpm / PRIOR_CENTER) / PRIOR_SIGMA;
  return Math.exp(-0.5 * z * z);
}

// Integer-BPM candidate from a pairwise IOI histogram. Pairwise (not just
// consecutive) intervals are used so busy passages with 8th/16th-note onsets
// still contribute beat-length intervals between non-adjacent onsets.
function coarseGridBpm(onsets: Onsets): number | null {
  const { times, weights } = onsets;
  const hist = new Float64Array(MAX_BPM + 1);
  for (let i = 0; i < times.length; i++) {
    for (let j = i + 1; j < times.length; j++) {
      const ioi = times[j] - times[i];
      if (ioi > PAIR_WINDOW) break;
      const bpm = 60 / ioi;
      if (bpm < MIN_BPM || bpm > MAX_BPM) continue;
      const w = weights[i] * weights[j] * tempoPrior(bpm);
      // Spread across neighbouring bins (±1) to handle timing jitter.
      const bin = Math.round(bpm);
      for (let d = -1; d <= 1; d++) {
        const b = bin + d;
        if (b >= MIN_BPM && b <= MAX_BPM) hist[b] += d === 0 ? w : 0.3 * w;
      }
    }
  }
  let best = -1;
  let bestScore = 0;
  for (let b = MIN_BPM; b <= MAX_BPM; b++) {
    if (hist[b] > bestScore) { bestScore = hist[b]; best = b; }
  }
  return bestScore > 0 ? best : null;
}

// Comb/Fourier refinement around the coarse candidate. Returns fractional BPM,
// grid phase, and a normalized alignment confidence.
function refineGrid(onsets: Onsets, coarseBpm: number): BeatGrid | null {
  const { times, weights } = onsets;
  const span = times[times.length - 1] - times[0];
  const f0 = coarseBpm / 60;
  const fLo = f0 * 0.97;
  const fHi = f0 * 1.03;
  // Peak width of |S| is ~1/span Hz; step at 1/(8·span) so the parabolic
  // interpolation always has well-resolved neighbours.
  const df = 1 / (8 * span);
  const steps = Math.max(3, Math.ceil((fHi - fLo) / df) + 1);

  const mag2 = new Float64Array(steps);
  let bestIdx = 0;
  for (let k = 0; k < steps; k++) {
    const f = fLo + k * df;
    let re = 0, im = 0;
    for (let j = 0; j < times.length; j++) {
      const a = 2 * Math.PI * f * times[j];
      re += weights[j] * Math.cos(a);
      im += weights[j] * Math.sin(a);
    }
    mag2[k] = re * re + im * im;
    if (mag2[k] > mag2[bestIdx]) bestIdx = k;
  }

  // Parabolic interpolation on |S|² around the best scan point.
  let fBest = fLo + bestIdx * df;
  if (bestIdx > 0 && bestIdx < steps - 1) {
    const denom = mag2[bestIdx - 1] - 2 * mag2[bestIdx] + mag2[bestIdx + 1];
    if (denom !== 0) {
      const delta = 0.5 * (mag2[bestIdx - 1] - mag2[bestIdx + 1]) / denom;
      fBest += Math.max(-0.5, Math.min(0.5, delta)) * df;
    }
  }

  // Recompute S at the interpolated frequency for the final phase + confidence.
  let re = 0, im = 0, wSum = 0;
  for (let j = 0; j < times.length; j++) {
    const a = 2 * Math.PI * fBest * times[j];
    re += weights[j] * Math.cos(a);
    im += weights[j] * Math.sin(a);
    wSum += weights[j];
  }
  const confidence = wSum > 0 ? Math.sqrt(re * re + im * im) / wSum : 0;
  if (confidence < GRID_CONFIDENCE_FLOOR) return null;

  // Onsets at t = t₀ + k/f contribute exp(2πi·f·t₀) each, so
  // arg S = 2π·f·t₀ (mod 2π) → t₀ = arg S / (2π·f) (mod beat period).
  const period = 1 / fBest;
  const phaseFrac = Math.atan2(im, re) / (2 * Math.PI); // [-0.5, 0.5]
  const gridOffset = ((phaseFrac % 1) + 1) % 1 * period;

  return {
    bpm: Math.round(fBest * 60 * 100) / 100,
    gridOffset,
    confidence,
  };
}

/**
 * Fit a constant-tempo beat grid (fractional BPM + phase) to a high-rate RMS
 * envelope. Returns null when there aren't enough onsets, the onsets span too
 * little time, or they don't align to any grid confidently — callers should
 * fall back to `detectBpm` on the coarse peaks array in that case.
 */
export function detectBeatGrid(
  envelope: Float32Array,
  envelopeRate: number,
): BeatGrid | null {
  const onsets = detectOnsets(envelope, envelopeRate);
  if (onsets.times.length < GRID_MIN_ONSETS) return null;
  if (onsets.times[onsets.times.length - 1] - onsets.times[0] < GRID_MIN_SPAN) return null;
  const coarse = coarseGridBpm(onsets);
  if (coarse === null) return null;

  // The histogram can land on the wrong octave (e.g. 87 when the truth is 174:
  // the k=2 pairwise intervals plus the 120-centered prior favor the half tempo).
  // The comb measurement is the arbiter: onsets spaced at period T alternate in
  // phase on a 2T grid, so |S| collapses at the half tempo but stays high at the
  // true one. Refine the candidate and its in-range octaves, then pick by
  // confidence — preferring the slower candidate on a near-tie, because a pure
  // beat-spaced click track aligns perfectly to its own double-tempo grid too
  // (every other gridline empty), making 2× confidence spuriously equal.
  const candidates = [Math.round(coarse / 2), coarse, coarse * 2]
    .filter((b) => b >= MIN_BPM && b <= MAX_BPM);
  let best: BeatGrid | null = null;
  for (const cand of candidates) { // ascending BPM order
    const grid = refineGrid(onsets, cand);
    if (grid && (best === null || grid.confidence > best.confidence * 1.05)) {
      best = grid;
    }
  }
  return best;
}

/**
 * Estimate BPM from a pre-computed peak amplitude array.
 * Uses energy-onset detection: finds local energy spikes above a rolling average,
 * computes inter-onset intervals, then picks the most populated BPM bin.
 */
export function detectBpm(peaks: Float32Array, peaksPerSecond: number): number | null {
  if (peaks.length < peaksPerSecond * 4) return null;

  // Square amplitude → energy
  const energy = new Float32Array(peaks.length);
  for (let i = 0; i < peaks.length; i++) energy[i] = peaks[i] * peaks[i];

  // Rolling average over ~1s using a prefix sum for O(n) speed
  const winSize = Math.round(peaksPerSecond);
  const halfWin = Math.floor(winSize / 2);
  const cumSum = new Float32Array(peaks.length + 1);
  for (let i = 0; i < peaks.length; i++) cumSum[i + 1] = cumSum[i] + energy[i];
  const smoothed = new Float32Array(peaks.length);
  for (let i = 0; i < peaks.length; i++) {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(peaks.length - 1, i + halfWin);
    smoothed[i] = (cumSum[hi + 1] - cumSum[lo]) / (hi - lo + 1);
  }

  // Onset detection: local max above threshold, enforcing minimum separation
  const minSepSamples = Math.round(MIN_ONSET_SEP * peaksPerSecond);
  const onsets: number[] = []; // times in seconds
  let lastOnsetIdx = -minSepSamples;

  for (let i = 1; i < peaks.length - 1; i++) {
    if (
      smoothed[i] > 0 &&
      energy[i] > ONSET_THRESHOLD * smoothed[i] &&
      energy[i] >= energy[i - 1] &&
      energy[i] >= energy[i + 1] &&
      i - lastOnsetIdx >= minSepSamples
    ) {
      onsets.push(i / peaksPerSecond);
      lastOnsetIdx = i;
    }
  }

  if (onsets.length < 4) return null;

  // Build BPM histogram from inter-onset intervals
  const histSize = MAX_BPM + 1;
  const hist = new Float32Array(histSize);
  for (let i = 1; i < onsets.length; i++) {
    const ioi = onsets[i] - onsets[i - 1];
    if (ioi <= 0) continue;
    const bpm = 60 / ioi;
    if (bpm >= MIN_BPM && bpm <= MAX_BPM) {
      // Spread across neighbouring bins (±1) to handle slight timing jitter
      for (let delta = -1; delta <= 1; delta++) {
        const bin = Math.round(bpm) + delta;
        if (bin >= MIN_BPM && bin <= MAX_BPM) {
          hist[bin] += delta === 0 ? 1.0 : 0.3;
        }
      }
    }
  }

  // Fold in 2× harmonic (e.g. 140 BPM evidence also supports 70 BPM)
  for (let b = MIN_BPM; b <= MAX_BPM; b++) {
    if (hist[b] === 0) continue;
    const half = Math.round(b / 2);
    if (half >= MIN_BPM && half <= MAX_BPM) hist[half] += hist[b] * 0.4;
  }

  let bestBpm = -1;
  let bestScore = 0;
  for (let b = MIN_BPM; b <= MAX_BPM; b++) {
    if (hist[b] > bestScore) { bestScore = hist[b]; bestBpm = b; }
  }

  return bestScore >= 3 ? bestBpm : null;
}

/**
 * Compute BPM from an array of tap timestamps (milliseconds, e.g. from Date.now()).
 * Uses up to the last 8 taps; ignores intervals outside a 30–300 BPM range.
 */
export function tapTempo(timestamps: number[]): number | null {
  if (timestamps.length < 2) return null;
  const taps = timestamps.slice(-8);
  let total = 0;
  let count = 0;
  for (let i = 1; i < taps.length; i++) {
    const ms = taps[i] - taps[i - 1];
    if (ms >= 200 && ms <= 2000) { total += ms; count++; }
  }
  if (count === 0) return null;
  return Math.round(60000 / (total / count));
}
