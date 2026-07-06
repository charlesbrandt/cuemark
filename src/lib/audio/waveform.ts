export const PEAKS_PER_SECOND = 30;

// Pre-computed color tables indexed by Math.floor(amplitude * 255).
// Built once at module load; shared across all WaveformCanvas instances.
export const COLOR_UPCOMING: string[] = new Array(256);
export const COLOR_PLAYED: string[] = new Array(256);

(() => {
  // [stop_amplitude, r, g, b]
  const stops: [number, number, number, number][] = [
    [0.00,   5,   8,  20],
    [0.20,  10,  40, 100],
    [0.45,   0, 120, 200],
    [0.65,   0, 200, 200],
    [0.80,  40, 220, 100],
    [0.92, 220, 230,   0],
    [1.00, 255, 120,   0],
  ];
  for (let i = 0; i < 256; i++) {
    const amp = i / 255;
    let r = stops[0][1], g = stops[0][2], b = stops[0][3];
    for (let s = 1; s < stops.length; s++) {
      if (amp <= stops[s][0]) {
        const t = (amp - stops[s - 1][0]) / (stops[s][0] - stops[s - 1][0]);
        r = Math.round(stops[s - 1][1] + (stops[s][1] - stops[s - 1][1]) * t);
        g = Math.round(stops[s - 1][2] + (stops[s][2] - stops[s - 1][2]) * t);
        b = Math.round(stops[s - 1][3] + (stops[s][3] - stops[s - 1][3]) * t);
        break;
      }
      r = stops[s][1]; g = stops[s][2]; b = stops[s][3];
    }
    COLOR_UPCOMING[i] = `rgb(${r},${g},${b})`;
    COLOR_PLAYED[i] = `rgb(${Math.round(r * 0.35)},${Math.round(g * 0.4)},${Math.round(b * 0.5)})`;
  }
})();

export function computeWaveform(buffer: AudioBuffer): Float32Array {
  const chunkCount = Math.ceil(buffer.duration * PEAKS_PER_SECOND);
  const peaks = new Float32Array(chunkCount);
  const numChannels = buffer.numberOfChannels;
  const totalSamples = buffer.length;
  const chunkSize = totalSamples / chunkCount;

  for (let i = 0; i < chunkCount; i++) {
    const start = Math.floor(i * chunkSize);
    const end = Math.min(Math.floor((i + 1) * chunkSize), totalSamples);
    let peak = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let s = start; s < end; s++) {
        const abs = Math.abs(data[s]);
        if (abs > peak) peak = abs;
      }
    }
    peaks[i] = peak;
  }
  return peaks;
}

/** Envelope samples per second from Rust. Must match ENVELOPE_RATE in analysis.rs. */
export const ENVELOPE_RATE = 210;

export interface AnalysisResult {
  peaks: Float32Array;
  bpm: number | null;        // fractional when the beat-grid fit succeeds, integer fallback otherwise
  gridOffset: number | null; // seconds; a beat lies at gridOffset + k·(60/bpm). null = no grid fit
}

export async function analyzeFile(filePath: string): Promise<AnalysisResult> {
  const { audioAnalyzeFile } = await import('./pipeline');
  // Rust decodes audio with video decoders disabled, avoiding the vaav1dec VA-API
  // corruption that decodeAudioData triggers on video+audio containers in WebKitGTK.
  const raw = await audioAnalyzeFile(filePath);
  const peaks = new Float32Array(raw.peaks);
  const envelope = new Float32Array(raw.envelope);
  const { detectBeatGrid, detectBpm } = await import('./bpm');
  const grid = detectBeatGrid(envelope, ENVELOPE_RATE);
  if (grid) return { peaks, bpm: grid.bpm, gridOffset: grid.gridOffset };
  // Fallback: coarse integer BPM from the display peaks, no grid phase.
  return { peaks, bpm: detectBpm(peaks, PEAKS_PER_SECOND), gridOffset: null };
}
