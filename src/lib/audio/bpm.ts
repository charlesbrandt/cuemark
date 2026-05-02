const MIN_BPM = 60;
const MAX_BPM = 200;
const ONSET_THRESHOLD = 1.8;   // energy must be 1.8× local average to count as onset
const MIN_ONSET_SEP = 0.2;      // seconds — 300 BPM max onset rate

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
