export function computeWaveform(buffer: AudioBuffer, chunkCount = 1000): Float32Array {
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

export async function analyzeFile(filePath: string): Promise<Float32Array> {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  const url = import.meta.env.DEV
    ? '/media' + encoded
    : 'media://localhost' + encoded;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching waveform: ${url}`);
  const arrayBuffer = await res.arrayBuffer();

  const audioCtx = new AudioContext();
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    return computeWaveform(audioBuffer);
  } finally {
    audioCtx.close();
  }
}
