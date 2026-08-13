/**
 * The legacy `<video>`-element presentation backend: element lifecycle, per-pass property
 * sync, and the mechanism-B stall self-heal. Extracted from App.svelte unchanged.
 *
 * Decks on the WebCodecs path (`codecPlayer.ts`) have no element here at all — every
 * mutation of a `<video>` element in the app goes through this module, which is what makes
 * `getLegacyVideoOpCounts()` a usable proof of that isolation (docs/design/
 * webcodecs-video-path.md phase 3).
 */
import { get } from "svelte/store";
import { registerVideoEl, unregisterVideoEl, getDeckTime } from "../renderer/seekBus";
import { audioSeek } from "../audio/pipeline";
import { reconcileAudioTransport, getLastAudioPlaying } from "../audio/transport";
import { session, updateDeck } from "../state/session";
import { debugLog } from "../debugLog";
import type { Deck } from "../state/types";

// Hidden <video> elements keyed by deck id; lives outside Svelte reactivity.
const videoEls = new Map<string, HTMLVideoElement>();
// Per-deck in-flight play() promises; prevents overlapping play() calls that abort each
// other. Shared with the stall self-heal below, which parks its whole recovery sequence
// in here so the ordinary play/pause sync can't race a v.play() against it.
const playPromises = new Map<string, Promise<void>>();
// Last playbackRate applied to each video element. Setting v.playbackRate triggers
// WebKitGTK to rebuild its internal GStreamer pipeline; only update on actual change.
const lastPlaybackRate = new Map<string, number>();
// Last video.currentTime shipped to the output window for each deck. The output path does
// a full-resolution drawImage + createImageBitmap — skip it when the frame hasn't advanced
// (paused) to avoid burning CPU/GPU every RAF tick while idle. Still catches seeks made
// while paused since currentTime changes even with playing=false.
const lastUploadedTime = new Map<string, number>();

export function getLegacyVideoEl(deckId: string): HTMLVideoElement | undefined {
  return videoEls.get(deckId);
}

export function hasLegacyVideoEl(deckId: string): boolean {
  return videoEls.has(deckId);
}

export function legacyVideoDeckIds(): string[] {
  return [...videoEls.keys()];
}

// Phase 3 proof instrumentation (docs/design/webcodecs-video-path.md "Phase 3 results"):
// counts every actual <video>-element mutation (currentTime write, playbackRate write,
// play()/pause() call) per deck. A webcodecs-backend deckId should show zero counts here
// for its entire lifetime. Kept permanently (cheap Map bump, same style as the rest of
// __cuemarkDebug) as a live sanity check for the codec-path isolation this design doc
// claims, not just a one-off test hook.
const legacyVideoOpCounts = new Map<string, { currentTime: number; playbackRate: number; playPause: number }>();

function recordLegacyOp(deckId: string, kind: "currentTime" | "playbackRate" | "playPause") {
  const c = legacyVideoOpCounts.get(deckId) ?? { currentTime: 0, playbackRate: 0, playPause: 0 };
  c[kind]++;
  legacyVideoOpCounts.set(deckId, c);
}

export function getLegacyVideoOpCounts(deckId: string) {
  return legacyVideoOpCounts.get(deckId) ?? { currentTime: 0, playbackRate: 0, playPause: 0 };
}

/**
 * Creates the legacy `<video>` element for a deck and points it at filePath. Everything
 * per-pass (event handlers, loop bookkeeping, rate throttle, play/pause) runs separately
 * in syncLegacyVideoElement below — this only covers the one-time "src changed" work.
 */
export function createLegacyVideoEl(
  deckId: string,
  filePath: string,
  mediaServerPort: number | null,
  adoptedPos?: number,
): HTMLVideoElement {
  // Dev: serve via Vite's HTTP middleware (localhost:1420/media/<abs-path>).
  // Prod: serve via our own local HTTP server (see media_server.rs) — the custom
  // media:// scheme doesn't work reliably with WebKitGTK's GStreamer media backend.
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const src = import.meta.env.DEV ? "/media" + encodedPath : `http://127.0.0.1:${mediaServerPort}${encodedPath}`;
  console.log(`[${deckId}] creating video element`);
  const v = document.createElement("video");
  v.style.cssText = "position:fixed;top:-9999px;width:1px;height:1px;pointer-events:none";
  v.muted = true; // audio is handled by Rust/GStreamer; video element is for decode only
  // Video is served cross-origin (http://127.0.0.1:<port> vs. tauri://localhost in prod).
  // Without this, drawImage/texImage2D reads in fbo.ts taint the canvas with a
  // SecurityError, silently killing the compositor's render loop after one frame.
  v.crossOrigin = "anonymous";
  document.body.appendChild(v);
  registerVideoEl(deckId, v);
  videoEls.set(deckId, v);
  console.log(`[${deckId}] setting src:`, src);
  v.src = src;
  v.load();
  if (adoptedPos !== undefined) {
    v.addEventListener("loadedmetadata", () => { v.currentTime = adoptedPos; recordLegacyOp(deckId, "currentTime"); }, { once: true });
  }
  setTimeout(() => {
    console.log(`[${deckId}] state@500ms: readyState=${v.readyState} networkState=${v.networkState} error=${v.error?.code ?? "none"} src=${v.src}`);
  }, 500);
  return v;
}

/**
 * Removes a deck's `<video>` element and every per-element memo keyed to it. No-op for a
 * deck that never had one (codec-path decks). Does NOT touch the audio pipeline — a live
 * legacy↔webcodecs toggle calls this and must leave audio running untouched.
 */
export function destroyLegacyVideoEl(deckId: string): void {
  const v = videoEls.get(deckId);
  if (!v) return;
  v.pause();
  v.remove();
  unregisterVideoEl(deckId);
  videoEls.delete(deckId);
  // Every memo below describes *this* element; keeping any of it across a teardown makes
  // the next element inherit a value it was never given (a stale lastPlaybackRate means
  // the rate re-apply below sees "unchanged" and leaves the fresh element at 1.0, and a
  // stale playPromises entry blocks the next element's play/pause sync outright).
  playPromises.delete(deckId);
  lastPlaybackRate.delete(deckId);
  lastUploadedTime.delete(deckId);
  stallWatch.delete(deckId);
}

/**
 * Per-sync-pass property/handler/transport sync for a deck already on the legacy path.
 * Runs unconditionally on every syncVideoElements pass, unlike createLegacyVideoEl.
 */
export function syncLegacyVideoElement(deck: Deck, filePath: string, v: HTMLVideoElement): void {
  const deckId = deck.id;

  // Update event handlers each sync so they capture the current filePath / deckId
  v.onloadedmetadata = () => {
    console.log(`[${deckId}] loadedmetadata fired, duration:`, v.duration);
    const s = get(session).decks.find((d) => d.id === deckId)?.source;
    // v.duration is Infinity for non-fast-start MP4s (moov atom at the end of the
    // file) until enough of the file has streamed — Infinity is truthy in JS, so
    // storing it here would permanently block the audioLoad duration fallback
    // (`!s.duration` never matches Infinity) and pins the waveform playhead at x=0
    // forever (currentTime / Infinity = 0). Only accept a real, finite duration.
    if (s?.type === "video" && s.filePath === filePath && Number.isFinite(v.duration)) {
      // Preserve s.loadSeq — see DeckSource.loadSeq's doc comment.
      updateDeck(deckId, { source: { type: "video", filePath, duration: v.duration, loadSeq: s.loadSeq } });
    }
  };
  // Retry play if the user clicked play before the video had loaded enough data
  v.oncanplay = () => {
    console.log(`[${deckId}] canplay fired`);
    const d = get(session).decks.find((d) => d.id === deckId);
    if (d?.playing && v.paused) v.play().catch(console.error);
  };
  v.onerror = () => console.error(`[${deckId}] video error: code=${v.error?.code} message=${v.error?.message} src=${v.src}`);
  v.onstalled = () => console.warn(`[${deckId}] stalled (networkState=${v.networkState})`);
  v.onended = () => updateDeck(deckId, { playing: false });

  // Custom loop: when loopIn/loopOut are set and loop is on, seek back manually
  // rather than relying on native video loop (which loops the whole file).
  if (deck.loop && deck.loopIn !== null && deck.loopOut !== null) {
    const loopIn = deck.loopIn;
    const loopOut = deck.loopOut;
    v.loop = false;
    v.ontimeupdate = () => {
      if (v.currentTime >= loopOut) {
        v.currentTime = loopIn;
        recordLegacyOp(deckId, "currentTime");
        audioSeek(deckId, loopIn).catch(console.error);
      }
    };
  } else {
    v.loop = deck.loop;
    v.ontimeupdate = null;
  }

  // v.volume=0 survives WebKitGTK pipeline rebuilds (it's a JS property, not pipeline state).
  // v.muted=true is belt-and-suspenders but can be lost on playbackRate-triggered rebuilds.
  // Both together ensure no audio bleed even during the brief rebuild window.
  v.volume = 0;
  v.muted = true;
  // Only update playbackRate when it changes meaningfully: setting v.playbackRate causes
  // WebKitGTK to rebuild its internal GStreamer pipeline, causing CPU spikes and PipeWire
  // xruns when called at rAF rate. Use a 0.5% tolerance to absorb the tiny oscillation
  // between 14-bit fader MSB (CC 8) and LSB (CC 40) arriving in adjacent rAF frames —
  // each pair would otherwise trigger two rebuilds per fader position.
  const targetRate = Math.max(0.0625, deck.playbackRate);
  const lastRate = lastPlaybackRate.get(deckId) ?? -1;
  if (Math.abs(targetRate - lastRate) > 0.005) {
    lastPlaybackRate.set(deckId, targetRate);
    v.playbackRate = targetRate;
    recordLegacyOp(deckId, "playbackRate");
    v.volume = 0;
    v.muted = true;
  }
  // Video element: sync play/pause based on element state.
  if (deck.playing && v.paused && !playPromises.has(deckId)) {
    recordLegacyOp(deckId, "playPause");
    const p = v.play().catch((e) => {
      if (e.name !== "AbortError") console.error(e);
    }).finally(() => playPromises.delete(deckId)) as Promise<void>;
    playPromises.set(deckId, p);
  } else if (!deck.playing && !v.paused) {
    playPromises.delete(deckId); // pending play() will abort; that's intentional
    recordLegacyOp(deckId, "playPause");
    v.pause();
  }

  // Audio pipeline: driven by deck.playing intent, independent of video element state.
  // WebKitGTK temporarily pauses the video element on any v.playbackRate write (it rebuilds
  // its internal pipeline). A play→pause toggle arriving in that window finds v.paused=true,
  // making both branches above no-ops. Tracking audio state separately ensures audioPause
  // always fires when deck.playing flips to false, regardless of the video element state.
  if (deck.playing !== getLastAudioPlaying(deckId)) {
    // See reconcileAudioTransport's doc comment — only marks this play/pause as handled
    // once the IPC call actually succeeds, and retries on its own timer rather than
    // depending on syncVideoElements running again (it doesn't, on every tick).
    reconcileAudioTransport(deckId, deck.playing);
  }
}

/**
 * Has this deck's `<video>` produced a frame the output window hasn't seen? Records the
 * new position as shipped when it has, so callers must only call this when they are
 * actually going to ship the frame.
 */
export function takeLegacyFrameIfAdvanced(deckId: string, v: HTMLVideoElement): boolean {
  if (v.currentTime === lastUploadedTime.get(deckId)) return false;
  lastUploadedTime.set(deckId, v.currentTime);
  return true;
}

/** Forget what the output window has been shipped, so the next tick re-sends every deck. */
export function forgetShippedLegacyFrames(): void {
  lastUploadedTime.clear();
}

/** Snapshot of the rate last written to a deck's element — the self-heal restores it. */
export function getLastPlaybackRate(deckId: string): number | undefined {
  return lastPlaybackRate.get(deckId);
}

// Mechanism-B self-heal (freeze-watchdog.md phase 4): WebKitGTK's <video> element can
// silently stop advancing (readyState stuck < HAVE_FUTURE_DATA) while the separate
// Rust/GStreamer audio pipeline keeps playing fine — see project_webkit_freeze_mechanisms
// memory, "Mechanism B". Detected per-frame from frame() itself — never a store
// $effect (an $effect only re-runs on store mutation, so it silently never fires during a
// stall with no other UI activity; this is the same lesson the Eleventh-mechanism/
// nearTrackEnd attempt paid for four times before being reverted, see that memory).
// lastVideoCt/lastChangeMs track native v.currentTime (never the IPC-fed audio clock,
// for the same "must be reliably fresh" reason documented elsewhere); refAudioPos
// snapshots the audio content position at the moment video last moved, so a later stall
// check can ask "did audio advance since video stopped?" over exactly the stalled span.
// lastAttemptMs bounds recovery to at most once per deck per 10s (design doc: "if it
// recurs, it recurs" — no permanent give-up, unlike the watchdog's 3-strike rule).
type StallWatch = { lastVideoCt: number; lastChangeMs: number; refAudioPos: number; lastAttemptMs: number };
const stallWatch = new Map<string, StallWatch>();

/** Drop a deck's stall history — on teardown, or on a fresh load of a new file. */
export function resetStallWatch(deckId: string): void {
  stallWatch.delete(deckId);
}

/**
 * One per-frame stall check for a deck on the legacy path, recovering the element with a
 * full `load()` + reseek when WebKit's decoder has wedged while audio kept advancing.
 * Callers must skip audio-only decks — their currentTime legitimately never moves, which
 * this would misread as a wedged decoder and "recover" every ~10s for the whole track.
 */
export function checkLegacyVideoStall(deck: Deck, v: HTMLVideoElement, nowMs: number): void {
  const deckId = deck.id;
  let st = stallWatch.get(deckId);
  if (!st) {
    st = { lastVideoCt: v.currentTime, lastChangeMs: nowMs, refAudioPos: getDeckTime(deckId) ?? 0, lastAttemptMs: 0 };
    stallWatch.set(deckId, st);
  }
  if (v.currentTime !== st.lastVideoCt) {
    st.lastVideoCt = v.currentTime;
    st.lastChangeMs = nowMs;
    st.refAudioPos = getDeckTime(deckId) ?? st.refAudioPos;
  }
  const stalledMs = nowMs - st.lastChangeMs;
  if (!(
    deck.playing && !v.paused && !v.ended && v.readyState < 3 &&
    stalledMs > 2000 && nowMs - st.lastAttemptMs > 10000
  )) return;

  const curAudioPos = getDeckTime(deckId);
  // "Audio kept advancing while video didn't" over the exact stalled span — the design
  // doc's condition that distinguishes a real WebKit stall from a legitimate
  // pause/paused-deck/end-of-track state (already excluded above).
  if (curAudioPos === null || curAudioPos - st.refAudioPos <= 0.05) return;

  st.lastAttemptMs = nowMs;
  st.lastChangeMs = nowMs; // restart the clock; don't re-trigger before canplay lands
  const target = curAudioPos;
  const rate = lastPlaybackRate.get(deckId) ?? 1.0;
  debugLog(`[self-heal] ${deckId} <video> stalled ${(stalledMs / 1000).toFixed(1)}s ` +
    `while audio advanced ${(curAudioPos - st.refAudioPos).toFixed(2)}s — resetting element to ${target.toFixed(2)}s`);
  // Guard via playPromises (the same map syncLegacyVideoElement checks before calling
  // v.play() itself) so its play/pause branch doesn't race a v.play() call against the
  // recovery sequence below while v.load() is still settling. Safety-valve timeout: if
  // canplay never fires (decoder wedged even after load()), release the guard anyway
  // rather than permanently blocking normal play/pause sync for this deck.
  const releaseGuard = () => playPromises.delete(deckId);
  const guardTimeout = setTimeout(releaseGuard, 5000);
  playPromises.set(deckId, new Promise<void>((resolve) => {
    v.addEventListener("canplay", () => {
      clearTimeout(guardTimeout);
      v.currentTime = target;
      recordLegacyOp(deckId, "currentTime");
      v.volume = 0;
      v.muted = true;
      v.playbackRate = rate;
      recordLegacyOp(deckId, "playbackRate");
      lastPlaybackRate.set(deckId, rate);
      // Rate-then-seek ordering doesn't apply here (load() built a fresh pipeline, no
      // in-flight rebuild) but keep the 200ms settle delay anyway — cheap insurance per
      // the design doc.
      setTimeout(() => {
        recordLegacyOp(deckId, "playPause");
        v.play().catch((e) => { if (e.name !== "AbortError") console.error(e); })
          .finally(() => { releaseGuard(); resolve(); });
      }, 200);
    }, { once: true });
    v.load(); // full element reset — discards WebKit's wedged internal pipeline
  }));
}

/**
 * Snap the element's clock to the audio master clock. Separate from the poll that computes
 * `contentPos` so that the "never write currentTime during a scratch / for an audio-only
 * deck" rules stay with their callers, where the reasons for them live.
 */
export function resyncLegacyVideoClock(deckId: string, v: HTMLVideoElement, contentPos: number): void {
  v.currentTime = contentPos; // snap video to audio clock
  recordLegacyOp(deckId, "currentTime");
}
