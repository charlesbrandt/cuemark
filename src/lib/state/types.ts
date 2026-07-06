export type DeckSource =
  | { type: "video"; filePath: string; duration: number }
  | null;

// Global visualization layer, composited above all decks in the output stage —
// not tied to any single deck, so selecting one never interrupts deck playback.
export interface Visualization {
  fragmentSrc: string;
  uniforms: Record<string, number>;
  name?: string;
}

export interface DeckEQ {
  low: number;   // ±12 dB low shelf  @ 250 Hz
  mid: number;   // ±12 dB mid peak   @ 1 kHz
  high: number;  // ±12 dB high shelf @ 4 kHz
}

export interface Deck {
  id: string;
  source: DeckSource;
  playing: boolean;
  playbackRate: number;   // 0.25–4.0
  gain: number;           // 0–4 pre-fader trim; >1.0 boosts quiet tracks (~+12 dB max)
  volume: number;         // 0–1 post-fader level (driven by crossfader)
  opacity: number;        // 0–1 compositor weight
  loop: boolean;
  cuePoint: number;       // seconds
  hotCues: number[];      // up to 4 time markers
  bpm: number | null;      // detected or tapped BPM for this deck
  downbeat: number | null; // absolute playback position (seconds) of beat 1; null = unset
  loopIn: number | null;   // loop region start (seconds); null = use track start
  loopOut: number | null; // loop region end (seconds); null = use track end
  eq: DeckEQ;
  cueEnabled: boolean;    // route pre-fader signal to headphone cue context
}

export interface AudioAnalysis {
  bass: number; // 0–1 normalized
  mid: number;
  high: number;
  waveform: Float32Array;
}

export interface Effect {
  type: string;
  params: Record<string, number>;
}

export type CrossfaderTarget = "opacity" | "volume";

// linear: simple 1-v / v — quiet dip at center
// equal-power: cos/sin curve — constant perceived loudness (industry standard)
// cut: both sources at full until well past center, then quick drop (battle/scratch style)
export type CrossfaderCurve = "linear" | "equal-power" | "cut";

export interface Session {
  decks: Deck[];          // ordered array; render back-to-front
  masterVolume: number;
  bpm: number | null;
  crossfaderMapping: {
    left: string;         // deck id
    right: string;        // deck id
  };
  /** Which software deck the left/right sides of the MIDI controller address. */
  midiMapping: {
    left: string;         // deck id driven by left controller channel
    right: string;        // deck id driven by right controller channel
  };
  crossfaderValue: number;              // 0.0 (full left) – 1.0 (full right)
  crossfaderTargets: CrossfaderTarget[]; // which deck properties the crossfader drives
  audioCurve: CrossfaderCurve;
  visualCurve: CrossfaderCurve;
  snapToBeat: boolean;    // when true, seek/cue/loop actions quantize to the nearest beat
  effects: Effect[];      // global post-process chain
  visualization: Visualization | null; // global layer, composited above all decks
  visualizationOpacity: number;        // 0–1 — how it blends over the deck output
}
