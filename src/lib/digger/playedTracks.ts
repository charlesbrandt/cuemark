// Tracks which Digger tracks have actually been played out to the room this
// session, so DiggerQueue.svelte can show a played marker next to queue/search
// rows. Deliberately separate from history.ts, which logs a HistoryEntry (and
// reports to Digger's plays API) the moment a track is *loaded* onto a deck —
// that already fires for a track previewed in headphones and never faded in.
//
// "Played" here means audible on the main output for a meaningful stretch:
// deck.playing && deck.volume > AUDIBLE_VOLUME_THRESHOLD, accumulated past
// PLAYED_THRESHOLD_MS. deck.volume is the one field both the crossfader
// (session.ts setCrossfader) and the per-deck volume fader (DeckCard.svelte)
// write to, so "volume near zero" is the best available signal that a deck is
// cued/previewed but not actually in the main mix — there is no lower-level
// instrumentation of the GStreamer output tee to observe this more precisely.
import { writable, get } from "svelte/store";
import { session } from "../state/session";
import type { Deck } from "../state/types";

const STORAGE_KEY = "cuemark:playedTrackIds";
const SKIPPED_STORAGE_KEY = "cuemark:skippedTrackIds";
const AUDIBLE_VOLUME_THRESHOLD = 0.05;
const PLAYED_THRESHOLD_MS = 15_000;

function loadSet(key: string): Set<number> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function persistSet(key: string, ids: Set<number>) {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // best-effort — a private/full localStorage just loses session persistence
  }
}

export const playedTrackIds = writable<Set<number>>(loadSet(STORAGE_KEY));

export function isPlayed(trackId: number): boolean {
  return get(playedTrackIds).has(trackId);
}

// A track a manual load displaced before it ever played — see queueStore.ts's
// notifyManualLoadDisplaced(). Distinct from "played": pickNextTrack() must not offer
// it again (the DJ deliberately moved past it), but it never actually sounded, so it
// shouldn't show a played checkmark either. Session-local, same persistence pattern as
// playedTrackIds — see docs/design/auto-dj-transitions.md "Manual/auto interaction".
export const skippedTrackIds = writable<Set<number>>(loadSet(SKIPPED_STORAGE_KEY));

export function isSkipped(trackId: number): boolean {
  return get(skippedTrackIds).has(trackId);
}

export function markSkipped(trackId: number): void {
  skippedTrackIds.update((s) => {
    if (s.has(trackId)) return s;
    const next = new Set(s);
    next.add(trackId);
    persistSet(SKIPPED_STORAGE_KEY, next);
    return next;
  });
}

/** Call right after a manual load lands on a deck, with the deck's *previous*
 *  diggerTrackId (read before the load overwrote it). No-op for a local file load
 *  (null) or when the deck was already empty. */
export function notifyManualLoadDisplaced(previousTrackId: number | null): void {
  if (previousTrackId !== null) markSkipped(previousTrackId);
}

export function clearAllPlayed(): void {
  playedTrackIds.set(new Set());
  persistSet(STORAGE_KEY, new Set());
}

export function clearPlayed(trackId: number): void {
  playedTrackIds.update((s) => {
    if (!s.has(trackId)) return s;
    const next = new Set(s);
    next.delete(trackId);
    persistSet(STORAGE_KEY, next);
    return next;
  });
}

function markPlayed(trackId: number) {
  playedTrackIds.update((s) => {
    if (s.has(trackId)) return s;
    const next = new Set(s);
    next.add(trackId);
    persistSet(STORAGE_KEY, next);
    return next;
  });
}

function audible(deck: Deck): boolean {
  return deck.playing && deck.volume > AUDIBLE_VOLUME_THRESHOLD;
}

// Per-deck accumulator of audible-on-main-output time for whatever track is
// currently loaded there. Reset whenever the deck's diggerTrackId changes.
interface Accum {
  trackId: number;
  ms: number;
  runningSince: number | null;
}
const accum = new Map<string, Accum>();

function checkThreshold(a: Accum) {
  const total = a.ms + (a.runningSince !== null ? Date.now() - a.runningSince : 0);
  if (total >= PLAYED_THRESHOLD_MS) markPlayed(a.trackId);
}

let prevDecks = new Map<string, Deck>();

session.subscribe((s) => {
  const seen = new Set<string>();
  for (const deck of s.decks) {
    seen.add(deck.id);
    const trackId = deck.diggerTrackId;
    let a = accum.get(deck.id);

    if (!a || a.trackId !== trackId) {
      // Track changed (or cleared) on this deck — finalize whatever was running,
      // then start a fresh accumulator for the new track (if any).
      if (a && a.runningSince !== null) a.ms += Date.now() - a.runningSince;
      if (trackId !== null) {
        a = { trackId, ms: 0, runningSince: null };
        accum.set(deck.id, a);
      } else {
        accum.delete(deck.id);
        a = undefined;
      }
    }

    if (a) {
      const isAudible = audible(deck);
      if (isAudible && a.runningSince === null) {
        a.runningSince = Date.now();
      } else if (!isAudible && a.runningSince !== null) {
        a.ms += Date.now() - a.runningSince;
        a.runningSince = null;
      }
      checkThreshold(a);
    }
    prevDecks.set(deck.id, deck);
  }
  for (const deckId of [...prevDecks.keys()]) {
    if (!seen.has(deckId)) {
      accum.delete(deckId);
      prevDecks.delete(deckId);
    }
  }
});

// Catches a deck that has been sitting audible past the threshold with no other
// session-store change to re-trigger the subscriber above (e.g. crossfader left
// parked mid-track) — same convention as history.ts's 30s Digger heartbeat.
setInterval(() => {
  for (const a of accum.values()) {
    if (a.runningSince !== null) checkThreshold(a);
  }
}, 5_000);
