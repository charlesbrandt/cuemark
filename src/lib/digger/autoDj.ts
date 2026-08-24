/**
 * Auto DJ — "keep the music going": when a deck reaches EOS and this is enabled,
 * auto-load the next track and start it, instead of leaving the deck stopped.
 * Wired from App.svelte's `deck-eos` listener (see docs/design/... none yet;
 * this is the todo.md "Auto DJ toggle" item, replacing the old unused Rnd/Nxt
 * queue-panel buttons).
 *
 * Source picked, in order:
 *   1. The front of the current DJ's Digger queue (`GET /queue`, consumed via
 *      `DELETE /queue/{id}`) — the "ordered list of upcoming loads" is the
 *      thing a human curated, so Auto DJ should play through it rather than
 *      skip straight to a random suggestion while it's non-empty.
 *   2. `GET /queue/next` (weighted-random suggestion) as a backstop when the
 *      queue is empty, so Auto DJ never just stops because nobody queued
 *      anything — the literal behavior the todo item named.
 *
 * Fetches the queue directly rather than reading the `diggerQueue` store,
 * because that store is only kept live while `DiggerQueue.svelte` is mounted
 * (`{#if $showDiggerQueue}` in App.svelte) — a DJ closing the sidebar mid-set
 * is normal, and Auto DJ must keep working with the panel hidden.
 */
import { writable, get } from "svelte/store";
import { getQueue, queueNext, removeFromQueue } from "./api";
import { loadQueueItemToDeck } from "./queueStore";
import { currentDj, currentDjOrNull } from "./djSelector";
import { updateDeck, getDeck } from "../state/session";
import { wasAutoMixTriggered } from "./autoMix";

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
  const outgoingSource = getDeck(deckId)?.source;
  if (wasAutoMixTriggered(deckId, outgoingSource?.type === "video" ? outgoingSource.filePath : undefined)) return;
  const owner = currentDjOrNull(get(currentDj));
  try {
    const queued = await getQueue(owner);
    const next = queued[0];
    if (next) {
      await loadQueueItemToDeck(next, deckId);
      // Fire-and-forget: the deck is already loaded and about to play, and Digger
      // broadcasts queue_changed to reconcile every client's view either way.
      removeFromQueue(next.id, owner).catch((e) => console.error("[auto-dj] queue/remove failed", e));
    } else {
      const track = await queueNext(owner);
      await loadQueueItemToDeck({ track_id: track.id, title: track.title, artist: track.artist }, deckId);
    }
    updateDeck(deckId, { playing: true });
  } catch (e) {
    console.error("[auto-dj] advance failed", e);
  }
}
