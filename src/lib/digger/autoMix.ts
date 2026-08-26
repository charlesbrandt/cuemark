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
 *  - Tempo/phase sync (gap 5 / phase 3) is optional, gated on `autoMixSyncEnabled` (default
 *    off) — with it off, still cuts between tracks at their native tempo exactly as before.
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
import { nudgePhaseToMaster } from "../audio/phaseNudge";
import { markSkipped } from "./playedTracks";
import { showToast } from "../ui/toast";
import { debugLog } from "../debugLog";

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

/** Phase 3 (gap 5): when on, beatmatches the incoming deck — rate-locks it to the current
 *  main-beat reference and aligns its phase — before starting the crossfade ramp, reusing
 *  the same Lock+NUDGE machinery a DJ can trigger manually from DeckCard.svelte. Off by
 *  default and a separate toggle from Auto DJ itself, per the design doc's phase 3: with it
 *  off, Auto DJ keeps cutting between tracks at their native tempo exactly as phases 1-2 did. */
export const autoMixSyncEnabled = persistentWritable<boolean>("cuemark:autoMixSyncEnabled", false);

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

/** Exported for the manual/auto interaction rules (see below) — lets a manual action
 *  mark a deck's current track as "already handled" the same way the ramp trigger does,
 *  so handleDeckEos() doesn't treat a manually-managed transition as an unhandled EOS. */
export function markHandledOutgoing(deckId: string, filePath: string | undefined): void {
  if (filePath !== undefined) handledOutgoing.set(deckId, filePath);
}

// ── Manual/auto interaction — see docs/design/auto-dj-transitions.md "Manual/auto
// interaction" ────────────────────────────────────────────────────────────────────
//
// Principle: hand back control of exactly the thing touched, automatically, no
// negotiation — the same convention `syncLocked` and `manualTouch` already use.
// A blanket "turn Auto DJ off the moment a human does anything" was considered and
// rejected: the live-session bug this was built for wasn't caused by needing an off
// switch, it was Auto DJ having no bookkeeping for a human quietly taking over one
// deck. So most manual actions "park" (silent, Auto DJ stays on) rather than
// disengage (alert, Auto DJ turns off) — see the tiers below.

/**
 * Tier 2, silent — call right after a manual play-toggle flips a deck to playing
 * (DeckCard's Play button, the MIDI deck_play_toggle handler). Never called from an
 * automated path — startCrossfadeRamp already does its own bookkeeping.
 *
 * Live-session bug (2026-08-26): a DJ manually loaded+played an older track back onto
 * an idle mapped deck while its counterpart kept playing unattended. checkAutoMixTrigger
 * correctly refused to touch that pair (it bails whenever the incoming deck is already
 * playing — see below), but nothing recorded that the transition had, in effect, already
 * happened. When the manually-driven deck later reached its own real EOS, handleDeckEos
 * saw an unhandled transition and picked "the next unplayed track" — which was still
 * technically unplayed because the OTHER deck's crossfader-driven volume had been at
 * 0 the whole time it played (isPlayed() gates on audible volume, not just `playing`).
 * Same file loaded onto both decks. Marking both sides here as soon as the manual
 * takeover happens closes that gap without touching the crossfader or the toggle at all.
 */
export function notifyManualPlay(deckId: string): void {
  if (!get(autoDjEnabled)) return;
  const s = get(session);
  const { left, right } = s.crossfaderMapping;
  if (deckId !== left && deckId !== right) return;
  const otherId = deckId === left ? right : left;
  const other = getDeck(otherId);
  if (!other?.playing) return; // no overlap in progress — nothing to park
  const deck = getDeck(deckId);
  const deckPath = deck?.source?.type === "video" ? deck.source.filePath : undefined;
  const otherPath = other.source?.type === "video" ? other.source.filePath : undefined;
  markHandledOutgoing(deckId, deckPath);
  markHandledOutgoing(otherId, otherPath);
}

/**
 * Tier 2 (your ask, 2026-08-26) — advances the mapped deck that isn't currently the
 * audible one past whatever it's holding (preloaded-but-idle, or genuinely empty),
 * without touching autoDjEnabled or the crossfader. Marks the displaced track skipped
 * (playedTracks.ts) so pickNextTrack doesn't loop back to a track that was chosen but
 * never actually played, then loads a fresh pick with `origin: 'auto'` so the new track
 * stays eligible for the ordinary near-end crossfade — this is "give me a different next
 * track", not a manual takeover of the deck.
 */
export async function skipUpcomingTrack(): Promise<void> {
  const s = get(session);
  const { left, right } = s.crossfaderMapping;
  const leftDeck = getDeck(left);
  const rightDeck = getDeck(right);
  const incoming = !leftDeck?.playing ? leftDeck : !rightDeck?.playing ? rightDeck : undefined;
  if (!incoming) return; // both mapped decks playing — nothing idle to advance
  const outgoing = incoming.id === left ? rightDeck : leftDeck;
  if (incoming.diggerTrackId !== null) markSkipped(incoming.diggerTrackId);
  const owner = currentDjOrNull(get(currentDj));
  debugLog(`[auto-dj] skip: advancing deck-${incoming.id} past its current pick`);
  const next = await pickNextTrack(owner, outgoing?.diggerTrackId ?? null);
  await loadQueueItemToDeck(next, incoming.id, "auto");
}

// Tier 3, alert + disengage — Auto DJ's model of the mix is structurally broken, not
// just "a human did something": one of the two decks it's driving no longer exists.
// Deliberately the *only* structural trigger for now (see the design doc's open
// question about a usage-pattern-based one — declined: a heuristic that turns the
// toggle off on its own judgement is more likely to surprise a DJ than help one).
session.subscribe((s) => {
  if (!get(autoDjEnabled)) return;
  const { left, right } = s.crossfaderMapping;
  const stillExist = s.decks.some((d) => d.id === left) && s.decks.some((d) => d.id === right);
  if (!stillExist) {
    autoDjEnabled.set(false);
    showToast("Auto DJ disengaged — a mapped deck was removed", "warning");
  }
});

// Only one auto-mix transition in flight at a time — correct for the phase-1 two-deck scope
// (crossfaderMapping never names more than two decks), and simpler than tracking one ramp per
// deck pair for a case that can't currently arise.
let activeRamp: { cancel: () => void } | null = null;

// Phase 4 (gap 1): where "near-end" is measured from. A set `outroPoint` (Digger's
// auto-derived or manually-placed mix-out marker — see the Deck.outroPoint doc comment
// in types.ts) takes over from the literal track end; the existing threshold settings
// (autoMixThresholdSec / autoPreloadThresholdSec) still measure their lead time from
// whichever point applies, so a DJ with no marker data sees identical behavior to before
// this field existed. Clamped to duration defensively — Digger already does this
// server-side, but a stale/bad value here must never push the trigger point past EOS.
// Sanity floor: Digger's auto-derived marker ("16 bars before the last detected beat")
// is occasionally wrong for a specific track — a bad beat-grid fit landed one at ~18s
// into a 223s track live on 2026-08-26 ("Baddy On The Floor"), making the very next
// preload/crossfade pair fire within 8s of the track starting, right after it had just
// been mixed in. The doc's own clamp above only ever protected the high end (never past
// EOS); a marker inside the first third of the track is equally untrustworthy and is
// now ignored in favor of raw duration, same as no marker at all.
function nearEndReference(outroPoint: number | null, duration: number): number {
  if (outroPoint !== null && outroPoint >= duration / 3) return Math.min(outroPoint, duration);
  return duration;
}

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

  debugLog(`[auto-dj] ramp start: deck-${outgoingId} -> deck-${incomingId}, target=${target}, from=${startValue.toFixed(3)}, duration=${durationMs}ms`);

  function cancel(reason?: string) {
    if (done) return;
    done = true;
    cancelRaf(rafId);
    activeRamp = null;
    if (reason) {
      debugLog(`[auto-dj] ramp aborted: deck-${outgoingId} -> deck-${incomingId} (${reason})`);
    } else {
      debugLog(`[auto-dj] ramp complete: deck-${outgoingId} faded out, deck-${incomingId} at target=${target}`);
    }
  }

  function step() {
    if (done) return;
    // Deck removed mid-fade (gap 4) — abandon cleanly, no dangling loop.
    if (!getDeck(outgoingId) || !getDeck(incomingId)) { cancel("a deck vanished"); return; }
    // DJ grabbed the fader — hand control back immediately, at whatever position it's at.
    if (get(manualTouch) !== touchAtStart) { cancel("manual crossfader touch"); return; }

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
      // a deck being removed. syncLocked must be cleared here too — it's what drives both
      // the Lock button's `active` class and the controller's sync LED (App.svelte), and
      // nothing else resets it once the deck goes empty, so it stayed lit on a track that
      // no longer exists (found 2026-08-26).
      updateDeck(outgoingId, { playing: false, source: null, syncLocked: false });
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

  const remaining = nearEndReference(outgoing.outroPoint, outgoing.source.duration) - contentPos;
  if (remaining > get(autoMixThresholdSec) || remaining <= 0) return;
  if (wasAutoMixTriggered(deckId, outgoing.source.filePath)) return;

  handledOutgoing.set(deckId, outgoing.source.filePath);
  const target: 0 | 1 = deckId === left ? 1 : 0;
  debugLog(`[auto-dj] trigger: deck-${deckId} has ${remaining.toFixed(1)}s remaining (threshold ${get(autoMixThresholdSec)}s) -> crossfading to deck-${incomingId}, sync=${get(autoMixSyncEnabled)}`);

  if (get(autoMixSyncEnabled) && incoming.bpm !== null && s.bpm !== null) {
    // Lock the incoming deck's rate to the main beat, then align its phase, before it
    // starts playing — the same two-step the Lock button does (DeckCard.svelte). The 200ms
    // settle mirrors that button's own comment: writing playbackRate rebuilds the legacy
    // <video> pipeline, and seeking into that rebuild lands stale — see CLAUDE.md
    // "Rate-then-seek ordering".
    const rate = s.bpm / incoming.bpm;
    debugLog(`[auto-dj] sync: locking deck-${incomingId} to ${s.bpm.toFixed(1)}bpm (rate ${rate.toFixed(4)})`);
    const touchAtStart = get(manualTouch);
    updateDeck(incomingId, { syncLocked: true, playbackRate: rate });
    setTimeout(() => {
      if (get(manualTouch) !== touchAtStart) { debugLog(`[auto-dj] sync: aborted, fader touched during rate settle`); return; }
      if (!getDeck(deckId) || !getDeck(incomingId)) { debugLog(`[auto-dj] sync: aborted, a deck vanished during rate settle`); return; }
      // Here the incoming deck is still paused, so nudgePhaseToMaster() takes its "seek to
      // the in-phase position" branch (see phaseNudge.ts) — an immediate seekDeck() call
      // whose audio_seek IPC is fire-and-forget (seekBus.ts). That seek has not landed in
      // GStreamer by the time this function returns; setting playing:true right after it
      // used to race that landing, so the deck audibly started from its pre-nudge position
      // and the beat never appeared to change (reported live 2026-08-24). Give the seek the
      // same kind of settle window the rate change above already gets, before starting
      // playback and the crossfade.
      nudgePhaseToMaster(incomingId);
      debugLog(`[auto-dj] sync: phase-nudged deck-${incomingId}, settling seek before play`);
      setTimeout(() => {
        if (get(manualTouch) !== touchAtStart) { debugLog(`[auto-dj] sync: aborted, fader touched during seek settle`); return; }
        if (!getDeck(deckId) || !getDeck(incomingId)) { debugLog(`[auto-dj] sync: aborted, a deck vanished during seek settle`); return; }
        updateDeck(incomingId, { playing: true });
        debugLog(`[auto-dj] sync: deck-${incomingId} playing, starting crossfade`);
        startCrossfadeRamp(deckId, incomingId, target);
      }, 200);
    }, 200);
  } else {
    if (get(autoMixSyncEnabled)) {
      debugLog(`[auto-dj] sync skipped (no bpm reference): incoming.bpm=${incoming.bpm} session.bpm=${s.bpm}`);
    }
    updateDeck(incomingId, { playing: true });
    startCrossfadeRamp(deckId, incomingId, target);
  }
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

  const remaining = nearEndReference(outgoing.outroPoint, outgoing.source.duration) - contentPos;
  if (remaining > get(autoPreloadThresholdSec) || remaining <= 0) return;
  if (preloadedFor.get(deckId) === outgoing.source.filePath) return;

  preloadedFor.set(deckId, outgoing.source.filePath);
  const owner = currentDjOrNull(get(currentDj));
  debugLog(`[auto-dj] preload: deck-${deckId} has ${remaining.toFixed(1)}s remaining (threshold ${get(autoPreloadThresholdSec)}s) -> fetching next track for deck-${incomingId}`);
  pickNextTrack(owner, outgoing.diggerTrackId ?? null)
    .then((next) => {
      // Re-check: the DJ may have loaded something onto this deck (or unloaded the outgoing
      // one) while the fetch was in flight.
      if (getDeck(incomingId)?.source !== null) {
        debugLog(`[auto-dj] preload: deck-${incomingId} no longer empty, skipping load`);
        return;
      }
      debugLog(`[auto-dj] preload: loading "${next.title}" onto deck-${incomingId}`);
      return loadQueueItemToDeck(next, incomingId, "auto");
    })
    .catch((e) => {
      debugLog(`[auto-dj] preload failed: ${e}`);
      console.error("[auto-dj] preload failed", e);
    });
}
