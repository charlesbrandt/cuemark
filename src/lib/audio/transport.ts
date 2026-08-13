/**
 * Play/pause reconciliation between deck intent (`deck.playing`) and the Rust audio
 * pipeline. Extracted from App.svelte, unchanged — the comments here are the record of
 * why each piece exists, and all of them were paid for live.
 */
import { get } from "svelte/store";
import { audioPlay, audioPause } from "./pipeline";
import { session } from "../state/session";

// Last deck.playing value sent to the Rust audio pipeline. Tracked independently of
// v.paused because WebKitGTK temporarily pauses the video element during its internal
// pipeline rebuild (triggered by any v.playbackRate write). Without this, a play→pause
// toggle arriving in that window finds v.paused=true, matches neither branch, and
// audioPause is never called — leaving GStreamer playing with the deck appearing frozen.
const lastAudioPlaying = new Map<string, boolean>();

export function getLastAudioPlaying(deckId: string): boolean | undefined {
  return lastAudioPlaying.get(deckId);
}

export function setLastAudioPlaying(deckId: string, playing: boolean): void {
  lastAudioPlaying.set(deckId, playing);
}

export function clearLastAudioPlaying(deckId: string): void {
  lastAudioPlaying.delete(deckId);
}

// audioPlay/audioPause can legitimately race ahead of audio_load finishing pipeline
// creation (Digger fetch + GStreamer preroll can take several seconds) and fail with
// "no audio pipeline for deck". syncVideoElements only re-runs in response to a session
// store mutation (or the once-per-mount rAF after one), NOT on every animation frame —
// so relying on "the next tick will retry" (the old comment here) is false whenever
// nothing else happens to touch the store in the meantime. Confirmed live 2026-08-01:
// a failed audioPlay sat unretried for 4+ seconds after the pipeline actually became
// ready, during a Digger-fallback load. This helper schedules its own retry via
// setTimeout instead of depending on incidental store churn, capped so a genuinely
// dead pipeline (audio_load itself failed) doesn't retry forever.
const AUDIO_TRANSPORT_RETRY_MS = 200;
const AUDIO_TRANSPORT_MAX_RETRIES = 50; // ~10s
// At most one retry chain per deck.
//
// Without this the retry loop amplifies instead of converging (root-caused 2026-08-03
// from a 200ms-periodic burst of ~25 `detached-pipeline IPC received`/sec in the log).
// `lastAudioPlaying` is only set once the IPC *succeeds*, so for as long as attempts keep
// failing, `deck.playing !== wasAudioPlaying` stays true in syncVideoElements — and
// syncVideoElements runs on every session-store mutation, which during a jog gesture is
// every rAF tick. Each run started its own independent chain, so chains accumulated
// linearly (~60/sec of jogging), each retrying 5×/sec for up to 10s.
//
// Failures here are not rare or exceptional: `with_pipeline_detached` removes the
// pipeline from the map for the duration of a play/pause/stop_scratch, and `audio_load`
// removes it for the whole preroll, so *every* concurrent transport call during those
// windows fails with "no audio pipeline for deck" by design. A scratch gesture over a
// loading or mid-teardown deck is precisely the case that piles chains up.
//
// The storm lands on the GTK main thread, which dispatches every synchronous Tauri
// command — so it inflates the `toRust` leg of every position poll (the master clock's
// transport, see pollStats.ts) and delays the `audio_scratch` calls that drive the
// scratch feeder's rate, which is felt as the jog wheel jumping around.
interface TransportChain { playing: boolean; timer: ReturnType<typeof setTimeout> | null; cancelled: boolean }
const transportChains = new Map<string, TransportChain>();

export function reconcileAudioTransport(deckId: string, playing: boolean): void {
  const existing = transportChains.get(deckId);
  if (existing) {
    // Already converging on this exact state — that chain owns the retry.
    if (existing.playing === playing) return;
    // Desired state flipped: cancel rather than race. Both chains would otherwise keep
    // calling, and whichever landed last would win nondeterministically.
    existing.cancelled = true;
    if (existing.timer) clearTimeout(existing.timer);
  }
  const chain: TransportChain = { playing, timer: null, cancelled: false };
  transportChains.set(deckId, chain);

  const attempt = (n: number) => {
    if (chain.cancelled) return;
    (playing ? audioPlay(deckId) : audioPause(deckId))
      .then(() => {
        if (chain.cancelled) return; // a newer chain owns the map entry and the state
        lastAudioPlaying.set(deckId, playing);
        transportChains.delete(deckId);
      })
      .catch((e) => {
        if (chain.cancelled) return;
        // Superseded: the deck moved on to a different desired state since this call
        // was scheduled — the newer reconcileAudioTransport call owns the retry.
        if (get(session).decks.find((d) => d.id === deckId)?.playing !== playing) {
          transportChains.delete(deckId);
          return;
        }
        if (n >= AUDIO_TRANSPORT_MAX_RETRIES) {
          console.error(`[audio-transport] ${deckId} giving up after ${n} retries:`, e);
          transportChains.delete(deckId);
          return;
        }
        chain.timer = setTimeout(() => attempt(n + 1), AUDIO_TRANSPORT_RETRY_MS);
      });
  };
  attempt(0);
}

/**
 * Stop any pending transport retry for a deck whose pipeline is going away. Without
 * this, unloading mid-retry leaves a chain calling audioPlay/audioPause against a deck
 * that no longer has a pipeline — failing on exactly the error it retries on, for the
 * full 10s budget. Call alongside `clearLastAudioPlaying(deckId)`.
 */
export function cancelAudioTransport(deckId: string): void {
  const chain = transportChains.get(deckId);
  if (!chain) return;
  chain.cancelled = true;
  if (chain.timer) clearTimeout(chain.timer);
  transportChains.delete(deckId);
}
