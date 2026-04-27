import type { AudioAnalysis } from "../state/types";

export class AudioAnalyzer {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private masterGain: GainNode;
  private freqData: Uint8Array<ArrayBuffer>;
  private timeData: Float32Array<ArrayBuffer>;
  private readonly fftSize = 2048;

  constructor() {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.masterGain = this.ctx.createGain();
    this.analyser.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.timeData = new Float32Array(this.analyser.fftSize);
  }

  /** Connect a media element; returns the per-deck GainNode for volume control. */
  connectMediaElement(el: HTMLMediaElement): GainNode {
    const src = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    src.connect(gain);
    gain.connect(this.analyser);
    return gain;
  }

  setMasterVolume(v: number) {
    this.masterGain.gain.value = v;
  }

  read(): AudioAnalysis {
    this.analyser.getByteFrequencyData(this.freqData);
    this.analyser.getFloatTimeDomainData(this.timeData);

    const bins = this.analyser.frequencyBinCount;
    const bassEnd = Math.floor(bins * 0.05);
    const midEnd = Math.floor(bins * 0.25);

    const avg = (start: number, end: number) => {
      let sum = 0;
      for (let i = start; i < end; i++) sum += this.freqData[i];
      return sum / (end - start) / 255;
    };

    return {
      bass: avg(0, bassEnd),
      mid: avg(bassEnd, midEnd),
      high: avg(midEnd, bins),
      waveform: this.timeData.slice(),
    };
  }

  get destination(): AudioNode {
    return this.analyser;
  }

  resume() {
    return this.ctx.resume();
  }
}
