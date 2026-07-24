/**
 * Forwards a timestamped line to the Rust log file (frontend_log Tauri command),
 * so JS-side timing can be read on the same timeline as GStreamer/MIDI events when
 * diagnosing a live-hardware stall — see the scratch/jog "chokes up" investigation
 * in docs/design/pcm-buffer-playback.md. Debug instrumentation only; not gated or
 * batched, so call sparingly (a handful of times per gesture, not per rAF frame) —
 * it goes through the same IPC bridge being investigated, so a flood here would
 * contaminate the very measurement it's meant to take.
 */
import { invoke } from "@tauri-apps/api/core";

export function debugLog(msg: string): void {
  invoke("frontend_log", { msg }).catch(() => {});
}
