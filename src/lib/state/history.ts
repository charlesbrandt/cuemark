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
}

const live = new Map<string, Live>();

function finalize(deckId: string) {
  const l = live.get(deckId);
  if (!l || l.playStartedAt === null) return;
  l.entry.playedMs += Date.now() - l.playStartedAt;
  l.playStartedAt = null;
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
      finalize(deck.id);
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
      live.set(deck.id, { entry, playStartedAt: deck.playing ? Date.now() : null });
      history.update((h) => [entry, ...h].slice(0, MAX_ENTRIES));
    } else if (!filePath && prevFilePath) {
      finalize(deck.id);
      live.delete(deck.id);
    } else if (filePath) {
      const l = live.get(deck.id);
      if (l) {
        if (deck.playing && l.playStartedAt === null) {
          l.playStartedAt = Date.now();
        } else if (!deck.playing && l.playStartedAt !== null) {
          finalize(deck.id);
          history.update((h) => h); // trigger reactivity for the now-frozen playedMs
        }
      }
    }
    prevDecks.set(deck.id, deck);
  }
  // Deck removed entirely (removeDeck()) — finalize and drop its live tracking.
  for (const deckId of [...prevDecks.keys()]) {
    if (!seen.has(deckId)) {
      finalize(deckId);
      live.delete(deckId);
      prevDecks.delete(deckId);
    }
  }
});
