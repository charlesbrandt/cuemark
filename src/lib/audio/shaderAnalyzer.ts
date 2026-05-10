export interface BandAnalysis {
  bass: number;
  mid: number;
  high: number;
}

// Analysis-only Web Audio context for shader uniforms.
// Video elements are routed through this context's AnalyserNode for FFT data,
// then to a MediaStreamAudioDestinationNode (not ctx.destination) so no audible
// output is produced — this is a pure analysis tap.
export class ShaderAnalyzer {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private freqData: Uint8Array<ArrayBuffer>;
  private sources = new Map<string, MediaElementAudioSourceNode>();

  constructor() {
    // Force 48000 Hz to match PipeWire's native graph rate. Without this, WebKit
    // negotiates at the source material's rate (often 44100 Hz), producing a
    // non-power-of-two quantum in PipeWire (e.g. 3969) → scheduling xruns.
    this.ctx = new AudioContext({ sampleRate: 48000 });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.8;
    // Route to a silent stream dest so the graph is processed without speaker output.
    this.analyser.connect(this.ctx.createMediaStreamDestination());
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.ctx.resume().catch(console.error);
  }

  connect(deckId: string, el: HTMLMediaElement) {
    if (this.sources.has(deckId)) return;
    try {
      const source = this.ctx.createMediaElementSource(el);
      source.connect(this.analyser);
      this.sources.set(deckId, source);
    } catch (e) {
      console.warn('[shaderAnalyzer] connect failed for', deckId, e);
    }
  }

  disconnect(deckId: string) {
    const source = this.sources.get(deckId);
    if (!source) return;
    try { source.disconnect(); } catch { /* already gone */ }
    this.sources.delete(deckId);
  }

  read(): BandAnalysis {
    this.analyser.getByteFrequencyData(this.freqData);
    const bins = this.analyser.frequencyBinCount;
    const bassEnd = Math.floor(bins * 0.05);
    const midEnd = Math.floor(bins * 0.25);
    const avg = (start: number, end: number) => {
      let sum = 0;
      for (let i = start; i < end; i++) sum += this.freqData[i];
      return sum / ((end - start) * 255);
    };
    return {
      bass: avg(0, bassEnd),
      mid: avg(bassEnd, midEnd),
      high: avg(midEnd, bins),
    };
  }

  destroy() {
    for (const id of [...this.sources.keys()]) this.disconnect(id);
    this.ctx.close().catch(console.error);
  }
}
