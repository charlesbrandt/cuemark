// Shared Digger-queue UI state — lifted out of DiggerQueue.svelte so a controller
// action (browse encoder, physical LOAD button) can read/move the same selection
// the panel renders, and so App.svelte's queue-panel visibility can be flipped from
// the MIDI handler too. See docs/design/ddj-flx4-feature-gaps.md §6.
import { writable, get } from 'svelte/store';
import { ask } from '@tauri-apps/plugin-dialog';
import { session, updateDeck } from '../state/session';
import { getCuemarkPayload, type DiggerQueueItem } from './api';
import { markGridSaved } from '../audio/gridSource';
import { setPendingTrackMeta } from '../state/history';
import { notifyManualLoadDisplaced } from './playedTracks';
import { debugLog } from '../debugLog';

export const diggerQueue = writable<DiggerQueueItem[]>([]);
export const selectedQueueIndex = writable(0);

/** Queue panel visibility. Was App.svelte-local `$state`; now a store so a
 * controller action can auto-open it. Defaults open — see the digger-integration
 * skill's "Queue panel is shown by default" convention. */
export const showDiggerQueue = writable(true);

/** Wraps at both ends (2026-08-23 design call) — turning past the last track
 * selects the first, and vice versa. No-op on an empty queue. */
export function moveQueueSelection(delta: number) {
  const items = get(diggerQueue);
  if (items.length === 0) return;
  const n = items.length;
  selectedQueueIndex.update((i) => ((i + delta) % n + n) % n);
}

/**
 * Loads one queue item to a deck — the guts of DiggerQueue.svelte's old
 * `loadToDeck()`, extracted so the panel's click-to-load buttons and the
 * MIDI-driven LOAD buttons share one implementation instead of drifting.
 * Throws on failure; callers decide how to surface that.
 *
 * Takes only the three fields it actually reads, not the full `DiggerQueueItem`
 * shape (which carries queue-entry-only fields like `id`/`position` that don't
 * exist for a track pulled straight from `GET /queue/next` or `/random` rather
 * than off the queue) — see autoDj.ts's fallback-to-suggestion path.
 *
 * `origin` distinguishes a human-driven load (search/queue click, the MIDI browse-encoder
 * LOAD button) from one Auto DJ made itself (autoDj.ts/autoMix.ts) — see
 * docs/design/auto-dj-transitions.md "Manual/auto interaction". A manual load marks
 * whatever it displaces as skipped (playedTracks.ts) so the queue picker doesn't loop
 * back to a track that was chosen but never actually played; default 'manual' since
 * most callers are UI-driven and the two automated call sites pass 'auto' explicitly.
 */
export async function loadQueueItemToDeck(
  item: Pick<DiggerQueueItem, 'track_id' | 'title' | 'artist'>,
  deckId: string,
  origin: 'manual' | 'auto' = 'manual',
): Promise<void> {
  const deck = get(session).decks.find((d) => d.id === deckId);
  const previousDiggerTrackId = deck?.diggerTrackId ?? null;
  if (deck?.playing && deck?.source) {
    const label = deck.source.type === 'video'
      ? deck.source.filePath.split('/').pop()
      : deck.id;
    const ok = await ask(`${deckId.replace('deck-', 'D')} is playing "${label}". Load anyway?`, { title: 'Deck is playing', kind: 'warning' });
    if (!ok) return;
  }
  // Load-latency instrumentation (docs/design/queue-prefetch-cache.md §1, item 3) — this
  // Digger HTTP round trip runs before any Rust code is entered at all, so it's inside the
  // user's perceived "load time" and worth timing on its own.
  const payloadStart = performance.now();
  const payload = await getCuemarkPayload(item.track_id);
  debugLog(`[queue-load] getCuemarkPayload track=${item.track_id} ms=${(performance.now() - payloadStart).toFixed(1)}`);
  if (!payload.filePath) throw new Error('No local file for this track');
  // Digger's API omits bpm/downbeat entirely when unset rather than sending JSON
  // `null`, which deserializes as `undefined` — normalize here so the rest of the
  // app (which only ever checks `!== null`, matching the Deck type) never sees
  // `undefined` and crashes on e.g. `deck.bpm.toFixed()`.
  const bpm = payload.bpm ?? null;
  const downbeat = payload.downbeat ?? null;
  // Only apply bpm/downbeat as a pair — a downbeat is only meaningful relative to
  // the bpm it was set against, so a partial grid would produce an inconsistent one.
  const hasGrid = bpm !== null && downbeat !== null;
  // A pair being present isn't the same as it being TRUSTWORTHY (see
  // docs/design/beatmatching.md "Root cause #2") — see api.ts's CuemarkPayload
  // doc comment for the full rule.
  const trusted = hasGrid && (
    payload.bpmSource === 'manual' || payload.bpmSource === 'imported' ||
    payload.beatGridAlgo === 'comb-v1'
  );
  // Deck has no title/artist fields — stash them for history.ts's session-store
  // subscriber to pick up right after this updateDeck() call lands.
  setPendingTrackMeta(deckId, item.title, item.artist);
  updateDeck(deckId, {
    source: { type: 'video', filePath: payload.filePath, duration: 0, loadSeq: Date.now() },
    playing: false,
    cuePoint: payload.cuePoint ?? 0,
    hotCues: payload.hotCues ?? [],
    diggerTrackId: item.track_id,
    diggerFileId: payload.fileId ?? null,
    // Same omitted-when-unset gotcha as bpm/downbeat above (api.ts's CuemarkPayload
    // doc comment) — normalize here rather than trust the JSON to carry `null`.
    outroPoint: payload.mixOut ?? null,
    introPoint: payload.mixIn ?? null,
    // Reset to the deck default (1.0) unless Digger supplies one — mirrors the
    // bpm/downbeat pull-on-load pattern above.
    gain: payload.gain ?? 1.0,
    ...(hasGrid ? { bpm, downbeat } : {}),
  });
  // Synchronous with updateDeck above, so this lands before App.svelte's rAF-deferred
  // syncVideoElements next inspects this deck — see gridSource.ts race-ordering note.
  if (trusted) markGridSaved(deckId, payload.filePath);
  if (origin === 'manual') notifyManualLoadDisplaced(previousDiggerTrackId);
}

/** MIDI queue_load — loads whatever the browse-encoder cursor currently selects.
 * Fire-and-forget from the handler, same convention as pushMarker/playStart. */
export function loadSelectedQueueItem(deckId: string): void {
  const items = get(diggerQueue);
  const item = items[get(selectedQueueIndex)];
  if (!item) return;
  loadQueueItemToDeck(item, deckId).catch((e) => console.error('[digger] queue_load failed', e));
}
