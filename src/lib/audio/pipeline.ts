/**
 * Typed wrappers around the Rust audio pipeline Tauri commands.
 *
 * All audio playback, EQ, gain, and device routing goes through these calls.
 * The <video> element handles video decode only; audio is owned by Rust/GStreamer.
 */
import { invoke } from "@tauri-apps/api/core";

export interface AudioDevice {
  id: string;
  label: string;
}

export type RecordFormat = "opus" | "flac";

// ── Device enumeration ────────────────────────────────────────────────────────

export function listAudioDevices(): Promise<AudioDevice[]> {
  return invoke("list_audio_devices");
}

// ── Per-deck lifecycle ────────────────────────────────────────────────────────

// Returns the track duration in seconds as determined by the GStreamer audio
// pipeline. This is the only reliable duration source when the system lacks a
// video decoder for the file's codec (e.g. AV1/H264) — the muted <video>
// element's loadedmetadata never fires in that case, but audio-only decode
// still succeeds and GStreamer can query the demuxed duration directly.
export function audioLoad(deckId: string, filePath: string): Promise<number | null> {
  return invoke("audio_load", { deckId, filePath });
}

export function audioUnload(deckId: string): Promise<void> {
  return invoke("audio_unload", { deckId });
}

// ── Per-deck transport ────────────────────────────────────────────────────────

export function audioPlay(deckId: string): Promise<void> {
  return invoke("audio_play", { deckId });
}

export function audioPause(deckId: string): Promise<void> {
  return invoke("audio_pause", { deckId });
}

export function audioSeek(deckId: string, secs: number): Promise<void> {
  return invoke("audio_seek", { deckId, secs });
}

export function audioSetRate(deckId: string, rate: number): Promise<void> {
  return invoke("audio_set_rate", { deckId, rate });
}

/**
 * Variable-rate scratch playback while paused: walks a pre-decoded PCM buffer forward
 * or backward at `rate` (negative = reverse), so pitch bends with speed/direction like
 * real vinyl — unlike audioSetRate, which is pitch-preserving (soundtouch `tempo`) and
 * positive-only. See docs/design/pcm-buffer-playback.md. Cheap to call repeatedly: only
 * the first call in a gesture does real setup (starts the feeder thread); later calls
 * just update the rate it reads — still worth throttling call frequency on the caller
 * side (e.g. once per rAF) since it's an IPC round-trip either way.
 *
 * `holdMs`: how long (from this call) the feeder keeps free-running at `rate` before
 * decaying to silence/hold if no further audioScratch() call refreshes it. Large for
 * shuttle-style scratch (never decays within a real gesture); small for vinyl-style
 * direct manipulation (decays almost immediately once the wheel stops). See
 * `SCRATCH_MODE_PARAMS` in handler.ts.
 */
export function audioScratch(deckId: string, rate: number, holdMs: number): Promise<void> {
  return invoke("audio_scratch", { deckId, rate, holdMs });
}

/** Stops scratch playback and returns to Paused. The next audioPlay() resyncs to the position the scratch cursor reached. */
export function audioStopScratch(deckId: string): Promise<void> {
  return invoke("audio_stop_scratch", { deckId });
}

// ── Per-deck levels ───────────────────────────────────────────────────────────

/** Pre-fader trim (0–1): normalise source level independently of the crossfader. */
export function audioSetGain(deckId: string, gain: number): Promise<void> {
  return invoke("audio_set_gain", { deckId, gain });
}

/** Post-fader level (0–1): driven by crossfader / volume fader. */
export function audioSetVolume(deckId: string, volume: number): Promise<void> {
  return invoke("audio_set_volume", { deckId, volume });
}

/** EQ bands in dB. Shelf/peak frequencies match the Web Audio defaults. */
export function audioSetEq(
  deckId: string,
  lowDb: number,
  midDb: number,
  highDb: number,
): Promise<void> {
  return invoke("audio_set_eq", { deckId, lowDb, midDb, highDb });
}

// ── Per-deck cue ──────────────────────────────────────────────────────────────

/** Route this deck into the headphone cue mix. */
export function audioSetCue(deckId: string, enabled: boolean): Promise<void> {
  return invoke("audio_set_cue", { deckId, enabled });
}

// ── Position (audio is master clock) ─────────────────────────────────────────

/**
 * Returns the GStreamer pipeline's current position in seconds, or null if
 * the pipeline isn't playing yet. The frontend uses this to sync <video>
 * elements: if |video.currentTime - audioPosition| > 80ms, seek the video.
 */
export function audioGetPosition(deckId: string): Promise<number | null> {
  return invoke("audio_get_position", { deckId });
}

// ── Master mix ────────────────────────────────────────────────────────────────

export function audioSetMasterVolume(volume: number): Promise<void> {
  return invoke("audio_set_master_volume", { volume });
}

/** Set one or more PipeWire sinks for the main output. Empty array = system default only. */
export function audioSetMainDevices(deviceIds: string[]): Promise<void> {
  return invoke("audio_set_main_devices", { deviceIds });
}

/** Set the PipeWire sink for the headphone cue output. */
export function audioSetCueDevice(deviceId: string): Promise<void> {
  return invoke("audio_set_cue_device", { deviceId });
}

/** Master gain for the headphone cue bus (0–1). */
export function audioSetCueGain(gain: number): Promise<void> {
  return invoke("audio_set_cue_gain", { gain });
}

// ── Recording ─────────────────────────────────────────────────────────────────

/** Begin recording the master mix to disk. Format: "opus" (lossy) or "flac" (lossless). */
export function audioRecordStart(outputPath: string, format: RecordFormat): Promise<void> {
  return invoke("audio_record_start", { outputPath, format });
}

export function audioRecordStop(): Promise<void> {
  return invoke("audio_record_stop");
}

// ── Waveform analysis ─────────────────────────────────────────────────────────

/** Mirrors `AnalysisData` in analysis.rs. */
export interface AudioAnalysisData {
  /** Peak amplitude per 1/30 s chunk (waveform display). */
  peaks: number[];
  /** RMS amplitude per 1/210 s hop (beat-grid onset detection). */
  envelope: number[];
}

/** Decode audio in Rust and return waveform peaks (30/s) plus a beat-grid RMS
 *  envelope (210/s). Avoids decodeAudioData which triggers vaav1dec on
 *  video+audio containers in WebKitGTK. */
export function audioAnalyzeFile(filePath: string): Promise<AudioAnalysisData> {
  return invoke("audio_analyze_file", { filePath });
}

// ── Grid persistence (local sidecar) ─────────────────────────────────────────

export interface SavedGrid {
  bpm: number;
  downbeat: number;
}

/** Looks up a saved bpm/downbeat for this file path from the local JSON sidecar. */
export function gridGetSaved(filePath: string): Promise<SavedGrid | null> {
  return invoke("grid_get_saved", { filePath });
}

/** Persists a bpm/downbeat pair for this file path to the local JSON sidecar. */
export function gridSave(filePath: string, bpm: number, downbeat: number): Promise<void> {
  return invoke("grid_save", { filePath, bpm, downbeat });
}
