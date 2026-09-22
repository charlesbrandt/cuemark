/**
 * Auto DJ — "keep the music going": when a deck reaches EOS and this is enabled,
 * auto-load the next track and start it, instead of leaving the deck stopped.
 * Wired from App.svelte's `deck-eos` listener (see docs/design/... none yet;
 * this is the todo.md "Auto DJ toggle" item, replacing the old unused Rnd/Nxt
 * queue-panel buttons).
 *
 * Source picked, in order (changed 2026-08-24 — see `pickNextTrack`'s own comment):
 *   1. The current DJ's Digger queue (`GET /queue`), honoring its own order —
 *      the "ordered list of upcoming loads" is the thing a human curated, so
 *      Auto DJ should play through it in the order it was built rather than
 *      skip straight to a random suggestion or shuffle it.
 *   2. `GET /queue/next` (weighted-random suggestion) as a backstop once
 *      nothing unplayed remains in the queue, so Auto DJ never just stops
 *      because nobody queued anything — the literal behavior the todo item
 *      named.
 *
 * Fetches the queue directly rather than reading the `diggerQueue` store,
 * because that store is only kept live while `DiggerQueue.svelte` is mounted
 * (`{#if $showDiggerQueue}` in App.svelte) — a DJ closing the sidebar mid-set
 * is normal, and Auto DJ must keep working with the panel hidden.
 */
import { writable, get } from "svelte/store";
import { getQueue, queueNext, type DiggerQueueItem } from "./api";
import { loadQueueItemToDeck } from "./queueStore";
import { currentDj, currentDjOrNull } from "./djSelector";
import { updateDeck, getDeck } from "../state/session";
import { wasAutoMixTriggered, promotePreloadedCounterpart } from "./autoMix";
import { isPlayed, isSkipped } from "./playedTracks";
import { showToast } from "../ui/toast";

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

/** Persisted so a toggle made mid-set survives a reload/watchdog recovery. */
export const autoDjEnabled = persistentWritable<boolean>("cuemark:autoDj", false);

/**
 * The queue-order/`queueNext()`-fallback sourcing rule described in this module's doc
 * comment, without touching any deck — shared by `handleDeckEos` (fires at EOS) and
 * `autoMix.ts`'s auto-preload (fires ahead of EOS, onto whichever deck `crossfaderMapping`
 * isn't currently favoring). Throws on failure (network error, empty queue *and* no
 * suggestion available) — callers decide how to handle that.
 *
 * **Changed 2026-08-24**: no longer deletes queue entries as they're picked. Live-session
 * feedback was that the queue is a set list, not a work stack — a DJ wants it to stay put
 * and reflect what's coming up, the same way it reads in Digger's own web UI on another
 * screen. Instead this leans on `playedTracks.ts`'s existing session-local "played" tracking
 * (already built for the queue panel's checkmark, gated on a track actually being audible
 * on the main output — see that module's own comment) to skip what's already been played:
 *
 *   1. If `currentTrackId` is itself a queue entry, take the next *unplayed* entry after its
 *      position — this is what keeps a multi-lap set advancing through the DJ's curated
 *      order deck-by-deck (each deck's `diggerTrackId`, once loaded, becomes the next
 *      anchor) rather than re-picking the same front-of-queue track forever now that
 *      nothing removes it.
 *   2. No anchor (first track of the set, or the current track isn't a queue entry at all —
 *      a manually-loaded/searched track) — fall back to the first unplayed entry, queue order.
 *   3. Nothing unplayed left in the queue — `GET /queue/next` random-suggestion backstop,
 *      same as before.
 */
export async function pickNextTrack(
  owner: string | null,
  currentTrackId: number | null,
): Promise<Pick<DiggerQueueItem, "track_id" | "title" | "artist">> {
  const queued = await getQueue(owner);

  if (currentTrackId !== null) {
    const idx = queued.findIndex((item) => item.track_id === currentTrackId);
    if (idx !== -1) {
      const after = queued.slice(idx + 1).find((item) => !isPlayed(item.track_id) && !isSkipped(item.track_id));
      if (after) return after;
    }
  }

  const first = queued.find((item) => !isPlayed(item.track_id) && !isSkipped(item.track_id));
  if (first) return first;

  const track = await queueNext(owner);
  return { track_id: track.id, title: track.title, artist: track.artist };
}

/**
 * Call on every `deck-eos`. No-ops immediately if Auto DJ is off. Best-effort —
 * logs and gives up on failure (e.g. Digger unreachable) rather than throwing,
 * matching the fire-and-forget convention of the other Digger side-effect calls
 * in this directory (pushMarker, playStart, etc.).
 */
export async function handleDeckEos(deckId: string): Promise<void> {
  if (!get(autoDjEnabled)) return;
  // The near-end lookahead (autoMix.ts) already started or finished a crossfade away from
  // this exact track — don't also cold-reload the deck it just faded out of. Still runs the
  // normal fallback below for the genuine case: lookahead never fired (unknown/zero duration,
  // no incoming deck loaded, feature toggled on only after this track was already playing).
  const outgoingDeck = getDeck(deckId);
  const outgoingSource = outgoingDeck?.source;
  if (wasAutoMixTriggered(deckId, outgoingSource?.type === "video" ? outgoingSource.filePath : undefined)) return;
  // The lookahead may have already preloaded the next track onto this deck's mapped
  // counterpart without ever firing the crossfade itself — see promotePreloadedCounterpart's
  // own comment. Start that instead of fetching a second copy of the same pick.
  if (promotePreloadedCounterpart(deckId)) return;
  const owner = currentDjOrNull(get(currentDj));
  // Captured before loadQueueItemToDeck overwrites this deck's diggerTrackId below.
  const currentTrackId = outgoingDeck?.diggerTrackId ?? null;
  try {
    const next = await pickNextTrack(owner, currentTrackId);
    await loadQueueItemToDeck(next, deckId, "auto");
    updateDeck(deckId, { playing: true });
  } catch (e) {
    // Tier 3: every subsequent EOS will fail the same way (network down, Digger
    // unreachable, empty queue with no suggestion available either) — leaving the
    // toggle "on" but silently non-functional is worse than disengaging and saying so,
    // since a DJ has no other way to notice a deck just stopped instead of advancing.
    console.error("[auto-dj] advance failed", e);
    autoDjEnabled.set(false);
    showToast(`Auto DJ disengaged — couldn't advance deck-${deckId}: ${e}`, "warning");
  }
}
