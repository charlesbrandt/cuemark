/**
 * Session-of-record push (freeze-watchdog.md phase 2). Subscribes to the Session store
 * and pushes a debounced snapshot to Rust so a webview reload/restart has something
 * authoritative to rebuild from — the store itself lives only in the disposable
 * WebKitWebProcess. Subscribing to the whole store (rather than hooking individual
 * mutation call sites) uniformly covers every path that reaches it, including
 * queueDeckPatch/queueCrossfader's rAF-throttled flush and direct updateDeck() calls,
 * without needing to track them one by one.
 *
 * Debounced 1s: continuous MIDI controls (rate/gain/volume/crossfader) never touch the
 * store faster than ~60fps already (audioSync.ts discipline — see project memory
 * project_midi_audio_latency), so this debounce is a further safety margin, not the
 * only thing standing between this and a MIDI-rate flood of IPC calls.
 */
import { sessionSync } from "../audio/pipeline";
import { session } from "./session";

const DEBOUNCE_MS = 1000;

export function startSessionSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = session.subscribe((value) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      sessionSync(value).catch((e) =>
        console.error("[session-recovery] sync failed:", e),
      );
    }, DEBOUNCE_MS);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
