export type DeckSource =
  | {
      type: "video";
      filePath: string;
      duration: number;
      // Set to a fresh value (Date.now()) by every user-initiated load call (drag-drop,
      // DiggerQueue "load to deck") — including a reload of the file already on this
      // deck. syncVideoElements compares this alongside filePath to detect a deliberate
      // reload; filePath alone can't, since backendState is keyed by filePath and treats
      // "same path" as nothing-to-do (see docs/design/webcodecs-video-path.md's
      // "reloading the identical file path is a no-op" note). Every internal duration-fill
      // write (ensureAudioLoaded, startCodecPath, the legacy <video> loadedmetadata
      // handler) MUST carry the existing loadSeq through unchanged — inventing a new one
      // there would make that write look like another deliberate reload and loop forever.
      loadSeq?: number;
    }
  | null;

// Global visualization layer, composited above all decks in the output stage —
// not tied to any single deck, so selecting one never interrupts deck playback.
export interface Visualization {
  fragmentSrc: string;
  uniforms: Record<string, number>;
  name?: string;
}

// Realised in GStreamer as one `equalizer-nbands` (num-bands=3) per deck, sitting
// between input_selector and output_queue — downstream of the scratch branch's join so
// a gesture is EQ'd like normal playback, upstream of the tee so the headphone cue
// hears it too. See make_eq() in src-tauri/src/audio/pipeline.rs.
export interface DeckEQ {
  // Range is −24…+12 dB, not symmetric: that is `equalizer-nbands`' own limit, and it
  // matches how mixers are marked (gentle boost, cut deep enough to work as a kill).
  // The backend clamps, so a wider UI slider would silently do nothing past the edge.
  low: number;   // −24…+12 dB low shelf  @ 250 Hz
  mid: number;   // −24…+12 dB mid peak   @ 1 kHz
  high: number;  // −24…+12 dB high shelf @ 4 kHz
}

// Deepest cut the EQ can actually reach — the low end of the element's range, used as
// the "kill" value by the UI's kill buttons and by the MIDI bass-kill toggle.
export const EQ_KILL_DB = -24;
export const EQ_MAX_DB = 12;

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
  diggerTrackId: number | null; // Digger track id if loaded from the Digger queue; null = local file
  diggerFileId: number | null; // Digger `files.id` behind the loaded track — used as a
                                // remote-fetch fallback (media_cache.rs) when the local
                                // mount cuemark expects isn't present; null = no known
                                // Digger file (local load, or Digger had none either)
  loopIn: number | null;   // loop region start (seconds); null = use track start
  loopOut: number | null; // loop region end (seconds); null = use track end
  eq: DeckEQ;
  filter: number;         // sweep filter: −1 full low-pass … 0 off … +1 full high-pass.
                          // A single knob covering both filter types, as on a DJ mixer;
                          // realised as a parked high-pass/low-pass pair, not a
                          // mode-switched element (switching mode mid-stream clicks).
  cueEnabled: boolean;    // route pre-fader signal to headphone cue context
  syncLocked: boolean;    // continuously re-locks playbackRate to Session.bpm as it changes
                          // (vs. the one-shot Sync button); cleared automatically by any
                          // manual rate input (slider, pitch fader, jog nudge) on this deck
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
  // Deck this bpm is live-derived from (kept in sync as that deck's own bpm/playbackRate
  // change), or null when bpm is an independent manual reference (tap tempo) not tied to
  // any deck. See reconcileMaster()/refreshMasterBpm() in session.ts.
  masterDeckId: string | null;
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
