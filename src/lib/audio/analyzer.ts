import type { AudioAnalysis } from "../state/types";

interface DeckChain {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  lowShelf: BiquadFilterNode;
  midPeak: BiquadFilterNode;
  highShelf: BiquadFilterNode;
  cueEnabled: boolean;
  cueStreamDest?: MediaStreamAudioDestinationNode;
}

interface CuePath {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
}

type SinkableContext = AudioContext & { setSinkId(id: string): Promise<void> };

export class AudioAnalyzer {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private masterGain: GainNode;
  private freqData: Uint8Array<ArrayBuffer>;
  private timeData: Float32Array<ArrayBuffer>;
  private readonly fftSize = 2048;
  private chains = new Map<string, DeckChain>();

  private cueCtx: AudioContext | null = null;
  private cueMasterGain: GainNode | null = null;
  private cuePaths = new Map<string, CuePath>();

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

  /** Connect a media element; returns the GainNode so the caller can set gain×volume. */
  connectMediaElement(deckId: string, el: HTMLMediaElement): GainNode {
    const source = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();

    const lowShelf = this.ctx.createBiquadFilter();
    lowShelf.type = "lowshelf";
    lowShelf.frequency.value = 250;

    const midPeak = this.ctx.createBiquadFilter();
    midPeak.type = "peaking";
    midPeak.frequency.value = 1000;
    midPeak.Q.value = 1.0;

    const highShelf = this.ctx.createBiquadFilter();
    highShelf.type = "highshelf";
    highShelf.frequency.value = 4000;

    source.connect(gain);
    gain.connect(lowShelf);
    lowShelf.connect(midPeak);
    midPeak.connect(highShelf);
    highShelf.connect(this.analyser);

    this.chains.set(deckId, {
      source,
      gain,
      lowShelf,
      midPeak,
      highShelf,
      cueEnabled: false,
    });
    return gain;
  }

  setDeckEQ(deckId: string, low: number, mid: number, high: number) {
    const chain = this.chains.get(deckId);
    if (!chain) return;
    chain.lowShelf.gain.value = low;
    chain.midPeak.gain.value = mid;
    chain.highShelf.gain.value = high;
  }

  setCueDeck(deckId: string, enabled: boolean) {
    const chain = this.chains.get(deckId);
    if (!chain) return;
    chain.cueEnabled = enabled;
    if (enabled) {
      this.connectCuePath(deckId);
    } else {
      this.disconnectCuePath(deckId);
    }
  }

  setCueVolume(v: number) {
    if (this.cueMasterGain) this.cueMasterGain.gain.value = v;
  }

  async setCueOutputDevice(deviceId: string): Promise<void> {
    // Tear down existing cue context
    if (this.cueCtx) {
      for (const deckId of this.cuePaths.keys()) {
        this.disconnectCuePath(deckId);
      }
      await this.cueCtx.close();
      this.cueCtx = null;
      this.cueMasterGain = null;
    }

    if (!deviceId) return;

    this.cueCtx = new AudioContext();
    if ("setSinkId" in this.cueCtx) {
      await (this.cueCtx as SinkableContext).setSinkId(deviceId);
    }
    this.cueMasterGain = this.cueCtx.createGain();
    this.cueMasterGain.connect(this.cueCtx.destination);
    this.cueCtx.resume().catch(console.error);

    // Reconnect any decks that already have cue enabled
    for (const [deckId, chain] of this.chains) {
      if (chain.cueEnabled) this.connectCuePath(deckId);
    }
  }

  private connectCuePath(deckId: string) {
    if (!this.cueCtx || !this.cueMasterGain) return;
    const chain = this.chains.get(deckId);
    if (!chain) return;
    if (this.cuePaths.has(deckId)) return; // already connected

    if (!chain.cueStreamDest) {
      chain.cueStreamDest = this.ctx.createMediaStreamDestination();
    }
    chain.highShelf.connect(chain.cueStreamDest);

    const source = this.cueCtx.createMediaStreamSource(chain.cueStreamDest.stream);
    const gain = this.cueCtx.createGain();
    source.connect(gain);
    gain.connect(this.cueMasterGain);
    this.cuePaths.set(deckId, { source, gain });
  }

  private disconnectCuePath(deckId: string) {
    const chain = this.chains.get(deckId);
    if (chain?.cueStreamDest) {
      try { chain.highShelf.disconnect(chain.cueStreamDest); } catch { /* already disconnected */ }
    }
    const cuePath = this.cuePaths.get(deckId);
    if (cuePath) {
      cuePath.gain.disconnect();
      this.cuePaths.delete(deckId);
    }
  }

  disconnectDeck(deckId: string) {
    this.disconnectCuePath(deckId);
    const chain = this.chains.get(deckId);
    if (!chain) return;
    chain.gain.disconnect();
    chain.lowShelf.disconnect();
    chain.midPeak.disconnect();
    chain.highShelf.disconnect();
    this.chains.delete(deckId);
  }

  setMasterVolume(v: number) {
    this.masterGain.gain.value = v;
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    if ("setSinkId" in this.ctx) {
      await (this.ctx as SinkableContext).setSinkId(deviceId);
    }
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
