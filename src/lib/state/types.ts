export type DeckSource =
  | { type: "video"; filePath: string; duration: number }
  | { type: "shader"; fragmentSrc: string; uniforms: Record<string, number> }
  | null;

export interface Deck {
  id: string;
  source: DeckSource;
  playing: boolean;
  playbackRate: number;   // 0.25–4.0
  volume: number;         // 0–1 audio
  opacity: number;        // 0–1 compositor weight
  loop: boolean;
  cuePoint: number;       // seconds
  hotCues: number[];      // up to 4 time markers
  bpm: number | null;     // detected or tapped BPM for this deck
  loopIn: number | null;  // loop region start (seconds); null = use track start
  loopOut: number | null; // loop region end (seconds); null = use track end
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

export interface Session {
  decks: Deck[];          // ordered array; render back-to-front
  masterVolume: number;
  bpm: number | null;
  crossfaderMapping: {
    left: string;         // deck id
    right: string;        // deck id
  };
  crossfaderValue: number;              // 0.0 (full left) – 1.0 (full right)
  crossfaderTargets: CrossfaderTarget[]; // which deck properties the crossfader drives
  effects: Effect[];      // global post-process chain
}
