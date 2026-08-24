/**
 * Auto DJ, phases 1-2: near-end crossfade automation between the two decks named in
 * `Session.crossfaderMapping`, plus auto-preload of the idle one ahead of time — see
 * docs/design/auto-dj-transitions.md. This is the "real" auto-mix (fade *as a track
 * approaches its end*), distinct from `autoDj.ts`'s `handleDeckEos()` (cold reload *after*
 * a track has already finished), which stays in place as a safety net — see the
 * interaction rule at the bottom of this file.
 *
 * Phase 1 (near-end crossfade) + phase 2 (auto-preload) scope, deliberately not more (see
 * the design doc's phased plan):
 *  - Fixed remaining-time thresholds only, no per-track outro marker (gap 1).
 *  - Exactly the two decks in `crossfaderMapping`, no N-deck auto-mixing (gap 2).
 *  - Preload readiness is `source.duration > 0` (the same signal the crossfade trigger
 *    already gates on, not a fixed timeout — gap 3) rather than any deeper preroll check;
 *    if the preload threshold is set too close to the crossfade threshold for a given
 *    track's demux time, the crossfade trigger still just waits for a loaded deck as it
 *    always has, and `autoDj.ts`'s EOS fallback remains the backstop either way.
 *  - No tempo/phase sync (gap 5 / phase 3) — cuts between tracks at their native tempo.
 *  - Preload never overwrites a deck the DJ (or a previous load) already put a track on —
 *    it only fires onto a genuinely empty (`source === null`) deck, same "manual wins"
 *    posture as the crossfade ramp's interruption handling.
 *
 * Gated on the same `autoDjEnabled` toggle as the EOS fallback — this is what makes the
 * `Auto` button in DiggerQueue.svelte "the real thing" rather than the cold-reload stand-in.
 */
import { writable, get } from "svelte/store";
import { session, getDeck, updateDeck, setCrossfader } from "../state/session";
import { autoDjEnabled, pickNextTrack } from "./autoDj";
import { loadQueueItemToDeck } from "./queueStore";
import { currentDj, currentDjOrNull } from "./djSelector";

function persistentWritable<T>(key: string, defaultValue: T) {
  let initial: T;
  try {
    const raw = localStorage.getItem(key);
    initial = raw !== null ? (JSON.parse(raw) as T) : defaultValue;
  } catch {
    initial = defaultValue;
  }

  const store = writable<T>(initial);

  return {
    subscribe: store.subscribe,
    set(value: T) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
      store.set(value);
    },
  };
}

/** How many seconds of remaining playback trigger the automated crossfade. Settings-configurable
 *  per the design doc ("likely Settings-configurable, not hardcoded") — see AudioSettings.svelte. */
export const autoMixThresholdSec = persistentWritable<number>("cuemark:autoMixThresholdSec", 15);

/** Duration of the automated crossfade ramp, in milliseconds. */
export const crossfadeDurationMs = persistentWritable<number>("cuemark:crossfadeDurationMs", 6000);

/** How many seconds of remaining playback trigger auto-preloading the next track onto the
 *  idle mapped deck (phase 2, gap 3) — deliberately larger than `autoMixThresholdSec` so the
 *  incoming deck has time to demux and report a real `source.duration` before the crossfade
 *  trigger goes looking for one. Settings-configurable — see AudioSettings.svelte. */
export const autoPreloadThresholdSec = persistentWritable<number>("cuemark:autoPreloadThresholdSec", 45);

// Bumped by notifyManualCrossfaderTouch() on every manual crossfader input (on-screen fader,
// MIDI CC) — never by the ramp driver's own setCrossfader() calls. A ramp captures the counter
// at start and aborts the instant it changes, mirroring the syncLocked convention: manual input
// wins immediately, no negotiation. See Crossfader.svelte and midi/handler.ts's queueCrossfader.
const manualTouch = writable(0);
export function notifyManualCrossfaderTouch(): void {
  manualTouch.update((n) => n + 1);
}

// deckId -> the source filePath whose near-end trigger already started (or completed) a
// crossfade away from it. Lets autoDj.ts's handleDeckEos() (the EOS fallback) tell "this
// track's transition was already handled by the lookahead path" from "lookahead never fired,
// this is the genuine EOS case" — see the design doc's "Interaction with the existing EOS
// fallback" section. Keyed by filePath (not just deckId) so a *later* track loaded onto the
// same deck gets a fresh chance at the EOS fallback.
const handledOutgoing = new Map<string, string>();

export function wasAutoMixTriggered(deckId: string, filePath: string | undefined): boolean {
  return filePath !== undefined && handledOutgoing.get(deckId) === filePath;
}

// Only one auto-mix transition in flight at a time — correct for the phase-1 two-deck scope
// (crossfaderMapping never names more than two decks), and simpler than tracking one ramp per
// deck pair for a case that can't currently arise.
let activeRamp: { cancel: () => void } | null = null;

// requestAnimationFrame doesn't exist under vitest's node test environment; degrade to a 16ms
// setTimeout there so this module works the same (just not frame-synced) under `npm test`.
const raf: (cb: (t: number) => void) => number =
  typeof requestAnimationFrame !== "undefined"
    ? requestAnimationFrame
    : (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
const cancelRaf: (id: number) => void =
  typeof cancelAnimationFrame !== "undefined" ? cancelAnimationFrame : clearTimeout;

function startCrossfadeRamp(outgoingId: string, incomingId: string, target: 0 | 1): void {
  activeRamp?.cancel();

  const touchAtStart = get(manualTouch);
  const startValue = get(session).crossfaderValue;
  const durationMs = get(crossfadeDurationMs);
  const startTime = performance.now();
  let rafId = 0;
  let done = false;

  function cancel() {
    if (done) return;
    done = true;
    cancelRaf(rafId);
    activeRamp = null;
  }

  function step() {
    if (done) return;
    // Deck removed mid-fade (gap 4) — abandon cleanly, no dangling loop.
    if (!getDeck(outgoingId) || !getDeck(incomingId)) { cancel(); return; }
    // DJ grabbed the fader — hand control back immediately, at whatever position it's at.
    if (get(manualTouch) !== touchAtStart) { cancel(); return; }

    const elapsed = performance.now() - startTime;
    const t = durationMs <= 0 ? 1 : Math.min(1, elapsed / durationMs);
    setCrossfader(startValue + (target - startValue) * t);

    if (t >= 1) {
      // Fully faded out — free the deck for its next load. Clearing source (not just
      // playing) is load-bearing: checkAutoPreloadTrigger and checkAutoMixTrigger both
      // treat a non-null source as "already has a track" (the "manual wins, never clobber"
      // rule), so leaving the just-played file in place made this deck look permanently
      // loaded and silently starved every subsequent preload/crossfade cycle — the second
      // mapped deck never got a new track after the first swap. source: null also drives
      // App.svelte's syncVideoElements to tear the backend + audio pipeline down, same as
      // a deck being removed.
      updateDeck(outgoingId, { playing: false, source: null });
      cancel();
      return;
    }
    rafId = raf(step);
  }

  activeRamp = { cancel };
  rafId = raf(step);
}

/**
 * Call on every position-poll resolution for a playing deck (positionPoll.ts). Cheap no-op
 * unless Auto DJ is on and this exact deck is the currently-audible half of `crossfaderMapping`
 * closing in on its end with the other half already loaded and idle.
 */
export function checkAutoMixTrigger(deckId: string, contentPos: number): void {
  if (!get(autoDjEnabled) || activeRamp) return;

  const s = get(session);
  const { left, right } = s.crossfaderMapping;
  if (deckId !== left && deckId !== right) return;

  const outgoing = s.decks.find((d) => d.id === deckId);
  if (!outgoing || !outgoing.playing || outgoing.source?.type !== "video" || !(outgoing.source.duration > 0)) return;

  const incomingId = deckId === left ? right : left;
  const incoming = s.decks.find((d) => d.id === incomingId);
  // Only handles the "one deck live, the other idle" case — a manual overlap already in
  // progress (both playing) is left alone. An incoming deck with no loaded/measured track
  // yet is left for checkAutoPreloadTrigger (below) to have filled in ahead of time, or —
  // failing that — for the DJ or the EOS fallback to handle.
  if (!incoming || incoming.playing || incoming.source?.type !== "video" || !(incoming.source.duration > 0)) return;

  const remaining = outgoing.source.duration - contentPos;
  if (remaining > get(autoMixThresholdSec) || remaining <= 0) return;
  if (wasAutoMixTriggered(deckId, outgoing.source.filePath)) return;

  handledOutgoing.set(deckId, outgoing.source.filePath);
  updateDeck(incomingId, { playing: true });
  startCrossfadeRamp(deckId, incomingId, deckId === left ? 1 : 0);
}

// deckId -> the outgoing-track filePath a preload was already triggered for. Prevents
// re-fetching every polled frame while remaining time stays inside the threshold and the
// async load is still in flight (or already landed) — same keying rationale as
// `handledOutgoing` above: a later track on the same deck gets a fresh chance.
const preloadedFor = new Map<string, string>();

/**
 * Call on every position-poll resolution for a playing deck (positionPoll.ts), alongside
 * `checkAutoMixTrigger`. Cheap no-op unless Auto DJ is on, this deck is the currently-audible
 * half of `crossfaderMapping` closing in on its end, and the *other* half is genuinely empty
 * (no source at all — never overwrites a deck the DJ, or a previous auto-preload, already put
 * a track on). Fires the same queue-order/`queueNext()`-fallback sourcing `handleDeckEos` uses,
 * anchored on the *outgoing* deck's current track so a multi-lap set keeps advancing through
 * the queue in order — just earlier and onto the idle deck rather than the one that just
 * ended. See the design doc's phase 2 and `pickNextTrack`'s own comment.
 */
export function checkAutoPreloadTrigger(deckId: string, contentPos: number): void {
  if (!get(autoDjEnabled)) return;

  const s = get(session);
  const { left, right } = s.crossfaderMapping;
  if (deckId !== left && deckId !== right) return;

  const outgoing = s.decks.find((d) => d.id === deckId);
  if (!outgoing || !outgoing.playing || outgoing.source?.type !== "video" || !(outgoing.source.duration > 0)) return;

  const incomingId = deckId === left ? right : left;
  const incoming = s.decks.find((d) => d.id === incomingId);
  if (!incoming || incoming.source !== null) return; // already loaded (by anyone) — don't clobber

  const remaining = outgoing.source.duration - contentPos;
  if (remaining > get(autoPreloadThresholdSec) || remaining <= 0) return;
  if (preloadedFor.get(deckId) === outgoing.source.filePath) return;

  preloadedFor.set(deckId, outgoing.source.filePath);
  const owner = currentDjOrNull(get(currentDj));
  pickNextTrack(owner, outgoing.diggerTrackId ?? null)
    .then((next) => {
      // Re-check: the DJ may have loaded something onto this deck (or unloaded the outgoing
      // one) while the fetch was in flight.
      if (getDeck(incomingId)?.source !== null) return;
      return loadQueueItemToDeck(next, incomingId);
    })
    .catch((e) => console.error("[auto-dj] preload failed", e));
}
