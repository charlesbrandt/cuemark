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
import type { Deck } from "../state/types";
import { session, getDeck, updateDeck, setCrossfader } from "../state/session";
import { autoDjEnabled, pickNextTrack } from "./autoDj";
import { loadQueueItemToDeck } from "./queueStore";
import { currentDj, currentDjOrNull } from "./djSelector";
import { nudgePhaseToMaster } from "../audio/phaseNudge";
import { seekDeck } from "../renderer/seekBus";
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

/** Minimum lead time before the near-end reference at which the automated crossfade starts.
 *  Since phase 5 this is a *floor*, not the whole story: a track pair whose own mix markers
 *  ask for a longer blend than this triggers earlier, so the fade always finishes by the
 *  outgoing track's outro reference instead of being truncated by it. A pair with no marker
 *  data still triggers exactly here, at the flat `crossfadeDurationMs` — see
 *  `transitionPlan()` and docs/design/auto-dj-transitions.md "Phase 5". */
export const autoMixThresholdSec = persistentWritable<number>("cuemark:autoMixThresholdSec", 15);

/** Fallback duration of the automated crossfade ramp, in milliseconds — used when the track
 *  pair carries no usable mix-in/mix-out zone to derive one from (phase 5). Was the single
 *  duration for every transition before that. */
export const crossfadeDurationMs = persistentWritable<number>("cuemark:crossfadeDurationMs", 6000);

/** Phase 5 (2026-08-30): after a *beatmatched* transition completes, how long the incoming
 *  deck takes to ease its locked playbackRate back to 1.0 (its own native tempo). 0 = off,
 *  i.e. exactly the pre-2026-08-30 behavior — the rate stays pinned wherever the sync step
 *  put it, which is what let each transition's tempo reference compound off the previous
 *  one's already-adjusted rate over a set. Only ever active when `autoMixSyncEnabled` is on,
 *  since nothing else imposes a rate. See docs/design/auto-dj-transitions.md "Phase 5 —
 *  tempo drift-back". */
export const autoMixDriftBackSec = persistentWritable<number>("cuemark:autoMixDriftBackSec", 20);

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
 * Tier 2 — "change what's coming up", the *secondary* Skip control since 2026-08-30 (it
 * was the only one before that, which is what the "Skip did nothing" report was about —
 * see `skipCurrentTrack` below and the design doc's "Phase 5 — Skip"). Advances the mapped
 * deck that isn't currently the audible one past whatever it's holding
 * (preloaded-but-idle, or genuinely empty), without touching autoDjEnabled, the
 * crossfader, or the playing deck. Marks the displaced track skipped (playedTracks.ts) so
 * pickNextTrack doesn't loop back to a track that was chosen but never actually played,
 * then loads a fresh pick with `origin: 'auto'` so the new track stays eligible for the
 * ordinary near-end crossfade.
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

/** How long `skipCurrentTrack` waits for a just-loaded deck to report a real duration
 *  before giving up. Same readiness signal every other Auto DJ path gates on
 *  (`source.duration > 0`, gap 3 in the design doc) — not a fixed "the load is probably
 *  done by now" delay. Generous because a cold Digger fetch + demux over the SMB mount is
 *  seconds, not milliseconds (docs/design/preroll-latency.md). */
const SKIP_READY_TIMEOUT_MS = 15000;
const SKIP_READY_POLL_MS = 100;

/** Date.now(), not performance.now(): this is a wall-clock deadline on a human-initiated
 *  action, and it must not be affected by the fake performance clock the ramp tests
 *  install. */
async function awaitDeckReady(deckId: string): Promise<boolean> {
  const deadline = Date.now() + SKIP_READY_TIMEOUT_MS;
  for (;;) {
    const d = getDeck(deckId);
    if (!d) return false;
    if (d.source?.type === "video" && d.source.duration > 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, SKIP_READY_POLL_MS));
  }
}

/**
 * Tier 2 — **"get me off this track now"**: the primary Skip control since 2026-08-30.
 *
 * Why this exists: `skipUpcomingTrack` above (the ⏭ button's only behavior until now)
 * quietly requeues what's *next* and leaves the playing deck completely untouched. The
 * DJ's report was "the next track loaded, but nothing happened — I expected it to start
 * the transition automatically", which is what a Skip button reads as on every other DJ
 * tool: skip the thing I'm hearing. Rather than reinterpret one control to mean two
 * things, both behaviors are kept and separately labeled in DiggerQueue.svelte — see the
 * design doc's "Phase 5 — Skip" for the reasoning and the alternatives weighed.
 *
 * Runs the *same* transition the near-end trigger would have run later — same beatmatch
 * step, same ramp, same per-pair duration (phase 5) — just now instead of at the outro
 * point, plus the same `handledOutgoing` bookkeeping so the outgoing deck's eventual EOS
 * isn't treated as an unhandled one. Degrades to `skipUpcomingTrack()` when there's no
 * single playing mapped deck to skip *from* (nothing playing yet, or a manual overlap
 * where both are live and the DJ is mid-blend by hand): pressing Skip should always do
 * the most useful available thing rather than silently no-op, which is the failure mode
 * this whole entry is about.
 */
export async function skipCurrentTrack(): Promise<void> {
  const s = get(session);
  const { left, right } = s.crossfaderMapping;
  const leftDeck = getDeck(left);
  const rightDeck = getDeck(right);
  if (!leftDeck || !rightDeck) return;

  if (activeRamp || previewInFlight) {
    debugLog(`[auto-dj] skip-now: a crossfade or preview is already in flight, ignoring`);
    return;
  }

  const playing = [leftDeck, rightDeck].filter((d) => d.playing);
  if (playing.length !== 1) {
    debugLog(`[auto-dj] skip-now: ${playing.length} mapped decks playing — falling back to swapping the upcoming pick`);
    return skipUpcomingTrack();
  }

  const outgoing = playing[0];
  const incomingId = outgoing.id === left ? right : left;
  const outgoingPath = outgoing.source?.type === "video" ? outgoing.source.filePath : undefined;

  if (getDeck(incomingId)?.source === null) {
    const owner = currentDjOrNull(get(currentDj));
    debugLog(`[auto-dj] skip-now: deck-${incomingId} is empty, fetching a track before transitioning`);
    const next = await pickNextTrack(owner, outgoing.diggerTrackId ?? null);
    await loadQueueItemToDeck(next, incomingId, "auto");
  }

  if (!(await awaitDeckReady(incomingId))) {
    debugLog(`[auto-dj] skip-now: deck-${incomingId} never became ready, aborting`);
    showToast("Skip: the next track didn't load in time", "warning");
    return;
  }

  // Re-read everything: the load above, and the wait, both yielded to other code.
  const now = get(session);
  const outgoingNow = getDeck(outgoing.id);
  const incoming = getDeck(incomingId);
  if (!outgoingNow?.playing || !incoming || incoming.playing) {
    debugLog(`[auto-dj] skip-now: deck state changed while loading, aborting`);
    return;
  }
  if (activeRamp) {
    debugLog(`[auto-dj] skip-now: a crossfade started while loading, aborting`);
    return;
  }

  // The outgoing track is deliberately being cut short: mark it handled (so its later EOS
  // isn't treated as an unhandled transition) and skipped (so pickNextTrack doesn't offer
  // it again later in the set — it may not have been audible long enough for
  // playedTracks' own 15s "played" rule to have fired).
  markHandledOutgoing(outgoing.id, outgoingPath);
  if (outgoing.diggerTrackId !== null) markSkipped(outgoing.diggerTrackId);

  const target: 0 | 1 = outgoing.id === now.crossfaderMapping.left ? 1 : 0;
  const plan = transitionPlan(zonesOf(outgoingNow), zonesOf(incoming));
  debugLog(`[auto-dj] skip-now: deck-${outgoing.id} -> deck-${incomingId} over ${plan.ms}ms (duration from ${plan.source}), sync=${get(autoMixSyncEnabled)}`);
  beginTransition(outgoing.id, incomingId, incoming, target, plan.ms);
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
let activeRamp: { cancel: (reason?: string) => void } | null = null;

// A preview seeks the outgoing deck to exactly the point the live trigger fires at and starts
// it playing, then waits for the seek to settle before the ramp exists — a window in which
// `activeRamp` is still null, so the real trigger claimed the deck and ran a second,
// non-preview transition on top (live-hit 2026-09-19: two concurrent ramps, the outgoing deck
// freed and the next queue track loaded onto it). This flag holds the automation off from the
// moment the preview starts until its ramp ends. The timer is the fallback for every path that
// never reaches a ramp (sync path bailing, a deck vanishing), so the guard can never stick.
let previewInFlight = false;
let previewGuardTimer: ReturnType<typeof setTimeout> | null = null;

function beginPreviewGuard(maxMs: number): void {
  previewInFlight = true;
  if (previewGuardTimer) clearTimeout(previewGuardTimer);
  previewGuardTimer = setTimeout(endPreviewGuard, maxMs);
}

function endPreviewGuard(): void {
  previewInFlight = false;
  previewRestore = null;
  if (previewGuardTimer) { clearTimeout(previewGuardTimer); previewGuardTimer = null; }
}

// What a preview must put back so the next press (or the DJ's own mix) starts from the
// state the DJ left. Before this a preview parked the crossfader at the far end and left the
// incoming deck playing at a beatmatch-imposed rate, so every audition needed a manual
// recovery (D4, 2026-09-19). Restored only when the preview ran to completion: an abort
// (fader touched, deck vanished) means the DJ has taken over and nothing is moved for them.
interface PreviewRestore { incomingId: string; fader: number; rate: number; syncLocked: boolean }
let previewRestore: PreviewRestore | null = null;
let previewTailTimer: ReturnType<typeof setTimeout> | null = null;
/** How long the incoming deck keeps playing at full after the fade completes, so the
 *  audition includes hearing the new track settle rather than cutting the moment it wins. */
const PREVIEW_TAIL_MS = 3000;

function finishPreview(): void {
  previewTailTimer = null;
  const r = previewRestore;
  if (r && getDeck(r.incomingId)) {
    updateDeck(r.incomingId, { playing: false, playbackRate: r.rate, syncLocked: r.syncLocked });
    seekDeck(r.incomingId, 0, true);
    setCrossfader(r.fader);
    debugLog(`[auto-dj] preview: restored fader to ${r.fader.toFixed(3)}, deck-${r.incomingId} paused at 0 (rate ${r.rate.toFixed(4)})`);
  }
  endPreviewGuard();
}

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

// ── Phase 5 (2026-08-30): transition duration derived from the two tracks ────────────
//
// A blend can only be as long as the more constrained of the two tracks supports, so the
// duration is the *minimum* of two zone lengths:
//   - the outgoing track's OUTRO zone: `duration - outroPoint`, i.e. how much track sits
//     after its mix-out marker. For Digger's auto-derived marker that is 16 bars (~30s at
//     128bpm) — the tail the DJ is happy to have another track playing over.
//   - the incoming track's INTRO zone: `introPoint`, i.e. how much of its head is
//     blendable before its body starts.
// Either side missing (no marker, or an untrustworthy one) simply doesn't constrain;
// both missing falls back to the flat `crossfadeDurationMs` setting, which is the exact
// behavior every transition had before this existed — the same fallback discipline
// `nearEndReference` uses for `outroPoint` itself.
//
// ⚠️ In practice the intro side is almost always inert today, and that is not a bug in
// this function: Digger's `_derive_mix_points()` sets `mix_in` to `beat_times[0]`, the
// FIRST TRACKED BEAT of the track — typically well under a second, not "the end of the
// intro section". So `introPoint` only carries real information when a DJ has placed a
// manual mix_in marker. MIN_ZONE_SEC is what keeps those sub-second auto values from
// collapsing every transition to the 2s floor. A genuine intro/outro *length* (or the
// per-track "suggested fade time" the feature was asked for) needs new Digger-side
// analysis — written up as an open decision in the design doc, deliberately not built here.
const MIN_ZONE_SEC = 2;
const MIN_TRANSITION_MS = 2000;
const MAX_TRANSITION_MS = 20000;

/** The two per-track fields a transition duration is derived from, plus the duration they
 *  are relative to. Structural (not `Deck`) so callers can pass a bare object and so the
 *  incoming side can be `null` where it isn't known yet (the preload trigger). */
export interface TransitionZones {
  duration: number;
  outroPoint: number | null;
  introPoint: number | null;
}

/** Per-transition switches threaded from the caller down to the ramp driver. */
interface TransitionOptions {
  /** Deck whose rate the sync step imposed, and which owes itself native tempo back once
   *  the fade completes (phase 5's drift-back). */
  driftBackDeckId?: string;
  /** Audition rather than a real transition: keep the outgoing deck loaded, consume
   *  nothing from the set (phase 6's `previewTransition`). */
  preview?: boolean;
}

export interface TransitionDuration {
  ms: number;
  /** Which side(s) the duration came from — logged, and the thing to read when a
   *  transition felt too short/long live. `fallback` means neither track had usable
   *  marker data and the flat Settings duration applied. */
  source: "zones" | "outro" | "intro" | "fallback";
}

function usableZone(sec: number): number | null {
  return sec >= MIN_ZONE_SEC ? sec : null;
}

/**
 * Pure — the whole point, so it can be unit-tested directly (autoMix.test.ts). `incoming`
 * is `null` when the incoming track isn't loaded/measured yet, which the preload trigger
 * needs: it can only see the outgoing side, and an *over*-estimated duration there just
 * makes the preload fire a little earlier, never later.
 */
/** Usable length of the outgoing track's outro zone, or `null` when there is no trustworthy
 *  marker or the zone is too short to blend over. Exported so the marker panel reads the
 *  exact figure the engine will use, instead of printing raw `duration - outroPoint` for
 *  values the engine discards (a sub-2s zone, a marker in the first third). */
export function outroZoneSec(duration: number, outroPoint: number | null): number | null {
  return duration > 0 ? usableZone(duration - nearEndReference(outroPoint, duration)) : null;
}

/** Usable length of the incoming track's intro zone, or `null` — same contract as
 *  `outroZoneSec`. Ceiling mirrors nearEndReference's floor: a "mix in" past the first third
 *  of a track is as untrustworthy as a "mix out" inside it, and would otherwise propose a
 *  blend longer than the incoming track's own body. */
export function introZoneSec(duration: number, introPoint: number | null): number | null {
  return introPoint !== null && duration > 0 && introPoint <= duration / 3
    ? usableZone(introPoint)
    : null;
}

export function computeTransitionDurationMs(
  outgoing: TransitionZones,
  incoming: TransitionZones | null,
  fallbackMs: number,
): TransitionDuration {
  const outro = outroZoneSec(outgoing.duration, outgoing.outroPoint);
  const intro = incoming !== null ? introZoneSec(incoming.duration, incoming.introPoint) : null;

  if (outro === null && intro === null) return { ms: fallbackMs, source: "fallback" };
  const zoneSec = outro === null ? intro! : intro === null ? outro : Math.min(outro, intro);
  const ms = Math.max(MIN_TRANSITION_MS, Math.min(MAX_TRANSITION_MS, zoneSec * 1000));
  return { ms, source: outro !== null && intro !== null ? "zones" : outro !== null ? "outro" : "intro" };
}

/**
 * Duration + the lead time the crossfade must start at to finish by the outgoing track's
 * near-end reference. The lead is `max(setting, duration)` rather than the setting alone:
 * with a per-pair duration the two could otherwise disagree (a 20s blend triggered 15s from
 * the outro point would be cut off by the track ending 5s early), and taking the max keeps
 * the no-marker case — where the derived duration is the 6s default, below the 15s default
 * threshold — triggering at exactly the configured threshold, identical to before phase 5.
 */
function transitionPlan(outgoing: TransitionZones, incoming: TransitionZones | null) {
  const duration = computeTransitionDurationMs(outgoing, incoming, get(crossfadeDurationMs));
  // A usable outro marker means the blend runs OVER the outro zone, starting AT the marker
  // (2026-09-19). Until then the ramp was timed to *finish* at `outroPoint` and the outgoing
  // deck was unloaded there, so the region `[outroPoint, end]` — the very tail the marker
  // exists to say another track may play over, and the one its length is derived from —
  // was never heard. Digger's own doc reads it the same way: mix_out is "where the next
  // track starts coming in". Lead is then 0: the trigger fires when the playhead reaches the
  // marker. Every other case (no marker, or intro-only) keeps the old lead untouched.
  const startsAtOutro = duration.source === "zones" || duration.source === "outro";
  return {
    ...duration,
    startsAtOutro,
    leadSec: startsAtOutro ? 0 : Math.max(get(autoMixThresholdSec), duration.ms / 1000),
  };
}

/** Extra lead the preload needs over the crossfade's own trigger point, so a long
 *  marker-derived blend can never start before the incoming track has been fetched and
 *  demuxed. Only matters when the derived duration exceeds the preload setting's own
 *  margin; the 45s default already clears the 20s duration ceiling on its own. */
const PRELOAD_LEAD_MARGIN_SEC = 15;

function zonesOf(deck: Deck): TransitionZones {
  return { duration: deck.source?.duration ?? 0, outroPoint: deck.outroPoint, introPoint: deck.introPoint };
}

// ── Phase 7b (2026-09-19): where the incoming deck starts ────────────────────────────
//
// Until now nothing positioned the incoming deck at all: the live path started it wherever
// it happened to be parked (position 0 for a freshly preloaded deck) and Preview explicitly
// seeked it to 0, so the dead air at the head of a track played underneath the whole blend.
// `introPoint` bounded the blend's LENGTH and nothing else; `cuePoint` was — and still is —
// unused by transitions. Digger's own spec reads mix_in as a start point ("start the next
// track at its mix_in", `docs/design/playlist-management.md`), so this is what the marker
// was for. Design-doc open decision #5.
//
// Gated on `introZoneSec` rather than on `introPoint !== null` so that exactly one rule
// decides whether a mix-in marker is trustworthy, and the same rule the duration already
// uses: at least MIN_ZONE_SEC of head, and not past the first third of the track. Digger's
// auto-derived `mix_in` is `beat_times[0]` — the first tracked beat, typically well under a
// second — so on an auto-analysed track this returns null and the deck keeps starting where
// it was parked, byte-identical to before. It becomes real the moment a DJ places a marker
// by hand.
//
// ⚠️ `introPoint` is now doing double duty and the two readings disagree: as a LENGTH it
// says "[0, introPoint] is blendable head", and as a START it says "begin here", which
// skips that head. They coincide only while Digger's value is sub-second noise. The fix is
// the two-ended zone model (`intro_end`, review §3) where the length becomes
// `introEnd − introPoint`; until then a hand-placed marker means "start here" and the blend
// length falls back to the outro side. Recorded in the design doc rather than guessed at.
function introStartSec(deck: Deck): number | null {
  return introZoneSec(deck.source?.duration ?? 0, deck.introPoint) !== null ? deck.introPoint : null;
}

/** How long a fire-and-forget `seekDeck` (its `audio_seek` IPC never reports back — see
 *  seekBus.ts) is given to land in GStreamer before anything reads the deck's position or
 *  starts it playing. Was three copies of a bare `200`; named so the new intro-point seek
 *  is visibly the same window the rate settle and the phase-nudge settle already use, and
 *  so all four move together. See CLAUDE.md "Rate-then-seek ordering". */
const SEEK_SETTLE_MS = 200;

// requestAnimationFrame doesn't exist under vitest's node test environment; degrade to a 16ms
// setTimeout there so this module works the same (just not frame-synced) under `npm test`.
const raf: (cb: (t: number) => void) => number =
  typeof requestAnimationFrame !== "undefined"
    ? requestAnimationFrame
    : (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
const cancelRaf: (id: number) => void =
  typeof cancelAnimationFrame !== "undefined" ? cancelAnimationFrame : clearTimeout;

/**
 * `durationMs` is per-transition since phase 5 (derived from the pair's own mix zones —
 * see `transitionPlan`), not the flat setting it used to read internally.
 * `driftBackDeckId`, when set, is the incoming deck whose playbackRate this transition's
 * sync step imposed: once the fade completes it eases back to native tempo (see
 * `startRateDriftBack`). Left unset by the native-tempo path, which imposed no rate.
 * `preview` keeps the outgoing deck loaded at the end — see `previewTransition`.
 */
function startCrossfadeRamp(
  outgoingId: string,
  incomingId: string,
  target: 0 | 1,
  durationMs: number,
  opts: TransitionOptions = {},
): void {
  const { driftBackDeckId, preview } = opts;
  activeRamp?.cancel();

  const touchAtStart = get(manualTouch);
  const startValue = get(session).crossfaderValue;
  const startTime = performance.now();
  let rafId = 0;
  let done = false;

  debugLog(`[auto-dj] ramp start: deck-${outgoingId} -> deck-${incomingId}, target=${target}, from=${startValue.toFixed(3)}, duration=${durationMs}ms`);
  if (Math.abs(target - startValue) < 0.01) {
    // The 2026-08-25 trap: a ramp whose start already equals its target is a silent
    // zero-length "fade" — the outgoing deck is freed with nothing having been crossfaded.
    debugLog(`[auto-dj] WARN ramp is zero-length: the crossfader is already at target=${target} (from=${startValue.toFixed(3)}) — nothing will actually fade`);
  }

  function cancel(reason?: string) {
    if (done) return;
    done = true;
    cancelRaf(rafId);
    activeRamp = null;
    // A preview that ran to completion ends its guard in finishPreview() after the tail;
    // only an abort (a reason) ends it here, and forgets the restore snapshot with it.
    if (preview && reason) endPreviewGuard();
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
      // A drift-back still running on the deck that just faded out has nothing left to
      // ease — it's about to be empty. Cancel before the updateDeck below, so the tick
      // can't write a rate onto an unloaded deck.
      cancelRateDriftBack(outgoingId, "outgoing deck freed");
      // Preview is the one case that must NOT free the deck: the DJ is auditioning this
      // transition and will very likely run it again, and unloading here would also make
      // the idle deck look empty to checkAutoPreloadTrigger, which would then consume the
      // next queue entry for a transition that never actually happened.
      // diggerTrackId/diggerFileId must be cleared alongside source — otherwise the
      // just-played track keeps reading as "loaded on this deck" in DiggerQueue.svelte's
      // deck-btn highlight (deck.diggerTrackId === item.track_id) even though the deck is
      // now empty (found 2026-09-05).
      updateDeck(outgoingId, preview
        ? { playing: false }
        : { playing: false, source: null, syncLocked: false, diggerTrackId: null, diggerFileId: null });
      // The outgoing deck's updateDeck above is what promotes the incoming deck to
      // masterDeckId (session.ts's reconcileMaster — exactly one deck playing now), which
      // is also what pins Session.bpm to its *rate-adjusted* tempo. Start the drift-back
      // immediately after, so the reference walks back to the incoming track's real bpm
      // rather than staying wherever this transition's lock left it. See the design doc's
      // "Phase 5 — tempo drift-back".
      // A preview restores the incoming deck's rate itself (finishPreview), so no drift-back.
      if (preview) {
        previewTailTimer = setTimeout(finishPreview, PREVIEW_TAIL_MS);
      } else if (driftBackDeckId) {
        startRateDriftBack(driftBackDeckId);
      }
      cancel();
      return;
    }
    rafId = raf(step);
  }

  activeRamp = { cancel };
  rafId = raf(step);
}

// ── Phase 5 (2026-08-30): tempo drift-back ───────────────────────────────────────────
//
// Problem this solves (live report: "tempo gets locked at some strange tempos over
// time"). The sync step locks the incoming deck to `Session.bpm`. Once the transition
// finishes and that deck is the only one playing, session.ts's `reconcileMaster` promotes
// it to `masterDeckId` and sets `Session.bpm = deck.bpm * deck.playbackRate` — its
// *already-adjusted* tempo. Nothing ever put the rate back, so the next transition locked
// deck C to B's adjusted rate, the one after that to C's, and so on: every transition's
// reference derived from the previous transition's output, with no anchor to any track's
// real tempo. Over a set that compounds without bound in whichever direction the first
// few pairs happened to push.
//
// The fix is an anchor, not a clamp: after the fade completes, ease the now-solo deck's
// playbackRate back to 1.0 — its own native tempo, the tempo its detected `deck.bpm`
// describes. `refreshMasterBpm` recomputes `Session.bpm` from `deck.bpm * playbackRate`
// on every `updateDeck`, so the reference walks back to the track's true bpm alongside
// it, and the next transition starts from an anchored value.
//
// Why 1.0 and not some other "configured rate": there is no per-deck configured-rate
// concept in the data model (see types.ts) — `playbackRate` *is* the deviation from
// native, and `deck.bpm` is measured at native. 1.0 is the only value that makes
// `Session.bpm` mean "this track's real tempo".
//
// syncLocked is cleared at the START of the drift, not the end: while it's set,
// `applyLockedRates` re-pins the deck to `Session.bpm / deck.bpm` on every session write,
// which would undo each easing step as it lands. Clearing it first is also what the flag
// means here — the deck is no longer following a master, it's returning to its own tempo.

/** Rate step small enough to be inaudible, large enough to be worth a write: both
 *  `syncRate` (audioSync.ts) and the legacy `<video>` path ignore rate changes below
 *  0.005, so anything finer costs a Svelte store write and reaches nothing. */
const DRIFT_RATE_STEP = 0.005;
/** Anything larger than this between our own last write and what the deck now reports is
 *  somebody else's rate write — the tempo slider (step 0.001), a jog nudge, Sync/Lock, a
 *  MIDI tempo fader. That is the cancel condition: manual input wins immediately, the same
 *  convention `syncLocked` and `manualTouch` already follow, and unlike an explicit
 *  notify() call it cannot be forgotten at a rate-writing call site added later. */
const DRIFT_DIVERGENCE_EPS = 1e-4;

let activeDrift: { deckId: string; cancel: (reason: string) => void } | null = null;

/** Explicit cancel for the paths whose *audio* rate write bypasses the store and whose
 *  store write is rAF-deferred (midi/handler.ts's tempo fader and jog nudge) — the
 *  divergence check below would catch them a frame later, but a frame later is one stale
 *  rate write on top of what the DJ just did. Safe to call for any deck at any time. */
export function notifyManualRateInput(deckId: string): void {
  cancelRateDriftBack(deckId, "manual rate input");
}

function cancelRateDriftBack(deckId: string, reason: string): void {
  if (activeDrift?.deckId === deckId) activeDrift.cancel(reason);
}

function startRateDriftBack(deckId: string): void {
  activeDrift?.cancel("superseded");

  const deck = getDeck(deckId);
  if (!deck) return;
  const fromRate = deck.playbackRate;
  const durationMs = get(autoMixDriftBackSec) * 1000;
  if (durationMs <= 0) {
    // Off — exactly the pre-phase-5 behavior: the rate (and syncLocked) stay where the
    // sync step left them. Logged so "the tempo never came back" is answerable from the
    // log alone rather than by guessing at a setting.
    debugLog(`[auto-dj] drift-back: disabled (0s), deck-${deckId} stays at rate ${fromRate.toFixed(4)}`);
    return;
  }
  if (Math.abs(fromRate - 1) < DRIFT_RATE_STEP) {
    updateDeck(deckId, { playbackRate: 1, syncLocked: false });
    debugLog(`[auto-dj] drift-back: deck-${deckId} already at native tempo (rate ${fromRate.toFixed(4)}), unlocked`);
    return;
  }

  const startTime = performance.now();
  let lastWritten = fromRate;
  let rafId = 0;
  let done = false;

  debugLog(`[auto-dj] drift-back start: deck-${deckId} rate ${fromRate.toFixed(4)} -> 1.000 over ${durationMs}ms`);

  function finish(reason?: string) {
    if (done) return;
    done = true;
    cancelRaf(rafId);
    if (activeDrift?.deckId === deckId) activeDrift = null;
    debugLog(reason
      ? `[auto-dj] drift-back aborted: deck-${deckId} (${reason})`
      : `[auto-dj] drift-back complete: deck-${deckId} back at native tempo`);
  }

  // syncLocked off first — see the block comment above; with it set, applyLockedRates
  // re-pins the rate on every session write and every easing step below is undone.
  updateDeck(deckId, { syncLocked: false });

  function step() {
    if (done) return;
    const d = getDeck(deckId);
    if (!d) { finish("deck vanished"); return; }
    if (Math.abs(d.playbackRate - lastWritten) > DRIFT_DIVERGENCE_EPS) { finish("manual rate input"); return; }

    const t = Math.min(1, (performance.now() - startTime) / durationMs);
    if (t >= 1) {
      updateDeck(deckId, { playbackRate: 1 });
      finish();
      return;
    }
    const target = fromRate + (1 - fromRate) * t;
    if (Math.abs(target - lastWritten) >= DRIFT_RATE_STEP) {
      lastWritten = target;
      updateDeck(deckId, { playbackRate: target });
    }
    rafId = raf(step);
  }

  activeDrift = { deckId, cancel: finish };
  rafId = raf(step);
}

/**
 * The transition itself, shared by the near-end trigger and the Skip control (phase 5) so
 * there is exactly one implementation of "beatmatch if asked, start the incoming deck, run
 * the ramp" — Skip used to have none at all and did only bookkeeping, which is the whole
 * of the 2026-08-30 "Skip did nothing" report.
 */
function beginTransition(
  outgoingId: string,
  incomingId: string,
  incoming: Deck,
  target: 0 | 1,
  durationMs: number,
  opts: Omit<TransitionOptions, "driftBackDeckId"> = {},
): void {
  // Where the incoming deck starts (phase 7b, open decision #5). Each branch below issues
  // this seek at its own correct moment — see the two comments at those sites; both are
  // constrained by CLAUDE.md's "Rate-then-seek ordering", which is why this is only the
  // *value* here and not the seek itself.
  const introStart = introStartSec(incoming);

  const refBpm = get(session).bpm;
  if (get(autoMixSyncEnabled) && incoming.bpm !== null && refBpm !== null) {
    // Lock the incoming deck's rate to the main beat, then align its phase, before it
    // starts playing — the same two-step the Lock button does (DeckCard.svelte). The 200ms
    // settle mirrors that button's own comment: writing playbackRate rebuilds the legacy
    // <video> pipeline, and seeking into that rebuild lands stale — see CLAUDE.md
    // "Rate-then-seek ordering".
    const rate = refBpm / incoming.bpm;
    debugLog(`[auto-dj] sync: locking deck-${incomingId} to ${refBpm.toFixed(1)}bpm (rate ${rate.toFixed(4)})`);
    const touchAtStart = get(manualTouch);
    updateDeck(incomingId, { syncLocked: true, playbackRate: rate });
    setTimeout(() => {
      if (get(manualTouch) !== touchAtStart) { debugLog(`[auto-dj] sync: aborted, fader touched during rate settle`); return; }
      if (!getDeck(outgoingId) || !getDeck(incomingId)) { debugLog(`[auto-dj] sync: aborted, a deck vanished during rate settle`); return; }
      // Here the incoming deck is still paused, so nudgePhaseToMaster() takes its "seek to
      // the in-phase position" branch (see phaseNudge.ts) — an immediate seekDeck() call
      // whose audio_seek IPC is fire-and-forget (seekBus.ts). That seek has not landed in
      // GStreamer by the time this function returns; setting playing:true right after it
      // used to race that landing, so the deck audibly started from its pre-nudge position
      // and the beat never appeared to change (reported live 2026-08-24). Give the seek the
      // same kind of settle window the rate change above already gets, before starting
      // playback and the crossfade.
      // The mix-in seek belongs HERE, not before the rate write: on the legacy <video>
      // path the rate write rebuilds the WebKit pipeline, and that rebuild re-reads
      // GStreamer's still-pre-seek position and overwrites `v.currentTime` with it —
      // silently undoing a seek issued just before it (av-sync-architecture.md,
      // "Rate-then-seek ordering"). Inside the rate settle it costs no extra stage,
      // because `nudgePhaseToMaster` below then refines *this* position rather than
      // needing a window of its own: it corrects relative to the deck's current position
      // (getPhase → getDeckTime), and `seekDeck` updates the frontend's own position
      // sources synchronously (el.currentTime for a legacy deck, pendingSeekTarget for a
      // codec one), so it reads the mix-in point in this same tick. Two writes, one
      // effective landing, one settle.
      if (introStart !== null) {
        seekDeck(incomingId, introStart, true);
        debugLog(`[auto-dj] intro: deck-${incomingId} starting at its mix-in marker ${introStart.toFixed(2)}s`);
      }
      nudgePhaseToMaster(incomingId);
      debugLog(`[auto-dj] sync: phase-nudged deck-${incomingId}, settling seek before play`);
      setTimeout(() => {
        if (get(manualTouch) !== touchAtStart) { debugLog(`[auto-dj] sync: aborted, fader touched during seek settle`); return; }
        if (!getDeck(outgoingId) || !getDeck(incomingId)) { debugLog(`[auto-dj] sync: aborted, a deck vanished during seek settle`); return; }
        updateDeck(incomingId, { playing: true });
        debugLog(`[auto-dj] sync: deck-${incomingId} playing, starting crossfade`);
        // driftBackDeckId set: this path is the one that imposed a rate, so it's the one
        // that owes the deck its native tempo back once the fade finishes.
        startCrossfadeRamp(outgoingId, incomingId, target, durationMs, { ...opts, driftBackDeckId: incomingId });
      }, SEEK_SETTLE_MS);
    }, SEEK_SETTLE_MS);
  } else {
    if (get(autoMixSyncEnabled)) {
      debugLog(`[auto-dj] sync skipped (no bpm reference): incoming.bpm=${incoming.bpm} session.bpm=${refBpm}`);
    }
    const play = () => {
      updateDeck(incomingId, { playing: true });
      startCrossfadeRamp(outgoingId, incomingId, target, durationMs, opts);
    };
    // No intro marker: start immediately, exactly as this path always has.
    if (introStart === null) { play(); return; }
    // With one: nothing writes the rate on this branch, so there is no pipeline rebuild to
    // order against and the seek goes first — but there is also no settle window to borrow,
    // and playing straight through a fire-and-forget `audio_seek` is the 2026-08-24 race
    // (the deck audibly starts from its pre-seek position). So it gets a window of its own.
    seekDeck(incomingId, introStart, true);
    debugLog(`[auto-dj] intro: deck-${incomingId} starting at its mix-in marker ${introStart.toFixed(2)}s`);
    const touchAtStart = get(manualTouch);
    setTimeout(() => {
      if (get(manualTouch) !== touchAtStart) { debugLog(`[auto-dj] intro: aborted, fader touched during seek settle`); return; }
      if (!getDeck(outgoingId) || !getDeck(incomingId)) { debugLog(`[auto-dj] intro: aborted, a deck vanished during seek settle`); return; }
      play();
    }, SEEK_SETTLE_MS);
  }
}

/**
 * Phase 6 (2026-08-30) — **audition the transition now**, from the deck card, without
 * waiting for the real near-end trigger and without leaving cuemark for Digger.
 *
 * Deliberately the *real* path: same `beginTransition`, same beatmatch step, same ramp,
 * same per-pair duration. What the DJ hears is the transition that will actually run, not
 * a simulation of it — building a second ramp mechanism would guarantee the two drift
 * apart, and "the preview sounded fine" would stop meaning anything.
 *
 * Three deliberate differences from a live transition, all so an audition is repeatable
 * and consumes nothing:
 *  - the outgoing deck keeps its `source` at the end (`preview: true`) — it is paused
 *    where the fade left it, ready to be previewed again;
 *  - no `handledOutgoing` / `markSkipped` bookkeeping, so the set state is untouched;
 *  - once the fade and a short tail have played, everything is put back (crossfader,
 *    incoming deck paused at 0 and at its old rate), so pressing it again needs no manual
 *    recovery (`finishPreview`);
 *  - both decks are seeked first: the outgoing to exactly the point the trigger would
 *    have fired at (the outro marker, or `reference − lead` without one), the incoming
 *    back to 0 — where a freshly-loaded deck sits when a real transition starts it, so a
 *    second press auditions the same thing as the first. The incoming deck's *musical*
 *    start point is not decided here: since phase 7b `beginTransition` seeks it to its
 *    mix-in marker on the live path and this one alike (open decision #5, now decided
 *    yes), so the reset to 0 decides only where a *marker-less* track starts.
 *
 * Works with Auto DJ off: this is a workshopping tool, not part of the automation.
 */
export function previewTransition(outgoingId: string): void {
  const s = get(session);
  const { left, right } = s.crossfaderMapping;
  if (outgoingId !== left && outgoingId !== right) {
    showToast("Preview needs both decks mapped to the crossfader", "warning");
    return;
  }
  const incomingId = outgoingId === left ? right : left;
  const outgoing = getDeck(outgoingId);
  const incoming = getDeck(incomingId);
  if (!outgoing?.source || outgoing.source.type !== "video" || !(outgoing.source.duration > 0)
    || !incoming?.source || incoming.source.type !== "video" || !(incoming.source.duration > 0)) {
    debugLog(`[auto-dj] preview: needs a loaded, measured track on both deck-${outgoingId} and deck-${incomingId}`);
    showToast("Preview needs a track loaded on both crossfader decks", "warning");
    return;
  }

  // cancel() with a reason ends the guard and forgets the snapshot; a restart must keep it.
  const keptRestore = previewRestore;
  activeRamp?.cancel("preview restarting");
  previewRestore = keptRestore;
  // Pressed again during the previous preview's tail: cancel the pending reset, but keep
  // the ORIGINAL snapshot — the fader is at the far end now, not where the DJ left it.
  if (previewTailTimer) { clearTimeout(previewTailTimer); previewTailTimer = null; }
  if (!previewRestore) {
    previewRestore = { incomingId, fader: s.crossfaderValue, rate: incoming.playbackRate, syncLocked: incoming.syncLocked };
  }

  const plan = transitionPlan(zonesOf(outgoing), zonesOf(incoming));
  // Seek settle (200ms) + sync settle + the fade itself + the tail, with generous slack.
  beginPreviewGuard(plan.ms + PREVIEW_TAIL_MS + 8000);
  const startAt = Math.max(0, nearEndReference(outgoing.outroPoint, outgoing.source.duration) - plan.leadSec);
  const target: 0 | 1 = outgoingId === left ? 1 : 0;

  // Park the fader fully on the outgoing deck first, so the ramp has somewhere to travel
  // from — the same "from == target, a zero-length interpolation" trap the 2026-08-25
  // bootRestore incident produced, reached here by pressing preview twice in a row.
  setCrossfader(target === 1 ? 0 : 1);
  seekDeck(outgoingId, startAt, true);
  seekDeck(incomingId, 0, true);
  updateDeck(outgoingId, { playing: true });
  const introStart = introStartSec(incoming);
  debugLog(`[auto-dj] preview: deck-${outgoingId}@${startAt.toFixed(1)}s -> deck-${incomingId}@${introStart !== null ? `${introStart.toFixed(1)}s (mix-in)` : "0.0s (no mix-in)"}, ${plan.ms}ms (duration from ${plan.source}), lead ${plan.leadSec.toFixed(1)}s`);

  // Same settle rationale as the sync path above: seekDeck's audio_seek IPC is
  // fire-and-forget, and starting the fade before it lands would audition the wrong part
  // of the track.
  setTimeout(() => {
    const out = getDeck(outgoingId);
    const inc = getDeck(incomingId);
    if (!out || !inc) { endPreviewGuard(); debugLog(`[auto-dj] preview: aborted, a deck vanished during seek settle`); return; }
    beginTransition(outgoingId, incomingId, inc, target, plan.ms, { preview: true });
  }, SEEK_SETTLE_MS);
}

/**
 * Call on every position-poll resolution for a playing deck (positionPoll.ts). Cheap no-op
 * unless Auto DJ is on and this exact deck is the currently-audible half of `crossfaderMapping`
 * closing in on its end with the other half already loaded and idle.
 */
export function checkAutoMixTrigger(deckId: string, contentPos: number): void {
  if (!get(autoDjEnabled) || activeRamp || previewInFlight) return;

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

  const plan = transitionPlan(zonesOf(outgoing), zonesOf(incoming));
  const remaining = nearEndReference(outgoing.outroPoint, outgoing.source.duration) - contentPos;
  if (plan.startsAtOutro) {
    // Fire once the playhead is AT the marker. Not when too little track is left for the
    // blend (a deck seeked deep into its tail): that case is left to the EOS fallback,
    // exactly as `remaining <= 0` always was for the end-anchored path.
    if (remaining > 0) return;
    if (outgoing.source.duration - contentPos < plan.ms / 1000 - 0.5) return;
  } else if (remaining > plan.leadSec || remaining <= 0) {
    return;
  }
  if (wasAutoMixTriggered(deckId, outgoing.source.filePath)) return;

  handledOutgoing.set(deckId, outgoing.source.filePath);
  const target: 0 | 1 = deckId === left ? 1 : 0;
  debugLog(`[auto-dj] trigger: deck-${deckId} has ${remaining.toFixed(1)}s remaining (lead ${plan.leadSec.toFixed(1)}s) -> crossfading to deck-${incomingId} over ${plan.ms}ms (duration from ${plan.source}), sync=${get(autoMixSyncEnabled)}`);

  beginTransition(deckId, incomingId, incoming, target, plan.ms);
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
  if (!get(autoDjEnabled) || previewInFlight) return;

  const s = get(session);
  const { left, right } = s.crossfaderMapping;
  if (deckId !== left && deckId !== right) return;

  const outgoing = s.decks.find((d) => d.id === deckId);
  if (!outgoing || !outgoing.playing || outgoing.source?.type !== "video" || !(outgoing.source.duration > 0)) return;

  const incomingId = deckId === left ? right : left;
  const incoming = s.decks.find((d) => d.id === incomingId);
  if (!incoming || incoming.source !== null) return; // already loaded (by anyone) — don't clobber

  // The incoming track isn't known yet (that's what this trigger is for), so the plan is
  // computed from the outgoing side alone — which can only over-estimate the eventual
  // duration, i.e. preload earlier, never later. Taking the max with the setting keeps a
  // no-marker track's preload exactly where it was before phase 5 (45s default vs. a 30s
  // floor here), while a long marker-derived blend can never start before the load has had
  // PRELOAD_LEAD_MARGIN_SEC to finish.
  const plan = transitionPlan(zonesOf(outgoing), null);
  const leadSec = Math.max(get(autoPreloadThresholdSec), plan.leadSec + PRELOAD_LEAD_MARGIN_SEC);
  const remaining = nearEndReference(outgoing.outroPoint, outgoing.source.duration) - contentPos;
  if (remaining > leadSec || remaining <= 0) return;
  if (preloadedFor.get(deckId) === outgoing.source.filePath) return;

  preloadedFor.set(deckId, outgoing.source.filePath);
  const owner = currentDjOrNull(get(currentDj));
  debugLog(`[auto-dj] preload: deck-${deckId} has ${remaining.toFixed(1)}s remaining (lead ${leadSec.toFixed(1)}s) -> fetching next track for deck-${incomingId}`);
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
