// Session playback history — a running log of what has played this session, derived
// by observing the `session` store rather than instrumenting every play/pause call
// site (there are several: DeckCard's transport button, App.svelte's EOS handler,
// the MIDI handler, video.onended, sync_toggle — see CLAUDE.md/av-sync-architecture.md).
// A low-frequency subscription is the right tool here (like `audioSetCue`'s
// guard-only pattern) since play/pause/load are discrete user actions, not
// continuous MIDI controls that need the audioSync.ts bypass.
import { writable } from "svelte/store";
import { session } from "./session";
import type { Deck } from "./types";
import { playStart, playHeartbeat, playFinish } from "../digger/api";

export interface HistoryEntry {
  id: string;
  deckId: string;
  diggerTrackId: number | null;
  title: string;
  artist: string;
  filePath: string;
  startedAt: number; // epoch ms — when this track was loaded onto the deck
  playedMs: number;  // accumulated time spent actually playing (excludes paused time)
}

export const history = writable<HistoryEntry[]>([]);

const MAX_ENTRIES = 200;

// Title/artist aren't part of Deck — loaders (DiggerQueue, DeckCard's file picker)
// call this immediately before updateDeck() sets the new source, so the subscriber
// below picks it up on the next store tick.
const pendingMeta = new Map<string, { title: string; artist: string }>();

export function setPendingTrackMeta(deckId: string, title: string, artist: string) {
  pendingMeta.set(deckId, { title, artist });
}

interface Live {
  entry: HistoryEntry;
  playStartedAt: number | null; // epoch ms if currently playing, else null
  // Resolves to Digger's plays.id once POST /plays/start returns, or null if this
  // deck has no diggerTrackId (untracked load) or the request failed — best-effort,
  // Digger being unreachable shouldn't block local history tracking.
  diggerPlayId: Promise<number | null> | null;
}

const live = new Map<string, Live>();

// Accumulates playedMs (if currently playing) and stops the running clock. Returns
// the Live record so the caller can decide whether this is a real end (report
// playFinish) or just a pause (report playHeartbeat) — finalize() itself doesn't
// know which, since both paths reach it the same way.
function finalize(deckId: string): Live | undefined {
  const l = live.get(deckId);
  if (!l) return undefined;
  if (l.playStartedAt !== null) {
    l.entry.playedMs += Date.now() - l.playStartedAt;
    l.playStartedAt = null;
  }
  return l;
}

function reportFinish(l: Live | undefined) {
  if (!l?.diggerPlayId) return;
  l.diggerPlayId.then((playId) => {
    if (playId !== null) playFinish(playId, l.entry.playedMs).catch(console.error);
  });
}

function reportHeartbeat(l: Live | undefined) {
  if (!l?.diggerPlayId) return;
  l.diggerPlayId.then((playId) => {
    if (playId !== null) playHeartbeat(playId, l.entry.playedMs).catch(console.error);
  });
}

// Extra playedMs accrued since the last finalize/update, for a deck currently playing —
// lets the panel show a live-ticking duration without the history store itself needing
// a per-second update.
export function liveElapsedMs(deckId: string): number {
  const l = live.get(deckId);
  if (!l || l.playStartedAt === null) return 0;
  return Date.now() - l.playStartedAt;
}

function filePathOf(deck: Deck): string | null {
  return deck.source?.type === "video" ? deck.source.filePath : null;
}

let prevDecks = new Map<string, Deck>();

session.subscribe((s) => {
  const seen = new Set<string>();
  for (const deck of s.decks) {
    seen.add(deck.id);
    const prev = prevDecks.get(deck.id);
    const filePath = filePathOf(deck);
    const prevFilePath = prev ? filePathOf(prev) : null;

    if (filePath && filePath !== prevFilePath) {
      reportFinish(finalize(deck.id));
      const meta = pendingMeta.get(deck.id);
      pendingMeta.delete(deck.id);
      const entry: HistoryEntry = {
        id: `${deck.id}-${Date.now()}`,
        deckId: deck.id,
        diggerTrackId: deck.diggerTrackId,
        title: meta?.title ?? filePath.split("/").pop() ?? filePath,
        artist: meta?.artist ?? "",
        filePath,
        startedAt: Date.now(),
        playedMs: 0,
      };
      const diggerPlayId = deck.diggerTrackId !== null
        ? playStart(deck.diggerTrackId, deck.id).catch((e) => { console.error(e); return null; })
        : null;
      live.set(deck.id, { entry, playStartedAt: deck.playing ? Date.now() : null, diggerPlayId });
      history.update((h) => [entry, ...h].slice(0, MAX_ENTRIES));
    } else if (!filePath && prevFilePath) {
      reportFinish(finalize(deck.id));
      live.delete(deck.id);
    } else if (filePath) {
      const l = live.get(deck.id);
      if (l) {
        if (deck.playing && l.playStartedAt === null) {
          l.playStartedAt = Date.now();
        } else if (!deck.playing && l.playStartedAt !== null) {
          reportHeartbeat(finalize(deck.id));
          history.update((h) => h); // trigger reactivity for the now-frozen playedMs
        }
      }
    }
    prevDecks.set(deck.id, deck);
  }
  // Deck removed entirely (removeDeck()) — finalize and drop its live tracking.
  for (const deckId of [...prevDecks.keys()]) {
    if (!seen.has(deckId)) {
      reportFinish(finalize(deckId));
      live.delete(deckId);
      prevDecks.delete(deckId);
    }
  }
});

// Heartbeat every 30s for decks currently playing — the design doc's convention
// (docs/design/play-tracking.md in the digger repo), so a crash loses at most 30s
// of duration on the open plays row instead of the whole session.
setInterval(() => {
  const now = Date.now();
  for (const l of live.values()) {
    if (l.playStartedAt === null || !l.diggerPlayId) continue;
    const durationMs = l.entry.playedMs + (now - l.playStartedAt);
    l.diggerPlayId.then((playId) => {
      if (playId !== null) playHeartbeat(playId, durationMs).catch(console.error);
    });
  }
}, 30_000);
