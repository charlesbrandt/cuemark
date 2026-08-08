<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { ask } from '@tauri-apps/plugin-dialog';
  import { session, updateDeck } from '../lib/state/session';
  import {
    search, randomTrack, getQueue, addToQueue, removeFromQueue, queueNext,
    getCuemarkPayload, setDiggerBaseUrl, getDiggerBaseUrl, getDiggerWebUrl,
    subscribeQueueChanges,
    type DiggerTrack, type DiggerQueueItem,
  } from '../lib/digger/api';
  import { markGridSaved } from '../lib/audio/gridSource';
  import { setPendingTrackMeta } from '../lib/state/history';
  import HistoryPanel from './HistoryPanel.svelte';

  let activeTab = $state<'tracks' | 'history'>('tracks');
  let queue = $state<DiggerQueueItem[]>([]);
  let searchResults = $state<DiggerTrack[]>([]);
  let searchQuery = $state('');
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let error = $state<string | null>(null);
  let loading = $state(false);
  let baseUrl = $state(getDiggerBaseUrl());
  let showUrlInput = $state(false);

  const decks = $derived($session.decks);

  let unsubscribeQueue: (() => void) | undefined;

  function resubscribe() {
    unsubscribeQueue?.();
    unsubscribeQueue = subscribeQueueChanges(refreshQueue);
  }

  onMount(() => {
    refreshQueue();
    resubscribe();
  });

  onDestroy(() => { unsubscribeQueue?.(); });

  async function refreshQueue() {
    try {
      error = null;
      queue = await getQueue();
    } catch (e) {
      error = `Digger unreachable (${baseUrl})`;
    }
  }

  function onSearchInput() {
    clearTimeout(searchTimer);
    if (searchQuery.length < 2) { searchResults = []; return; }
    searchTimer = setTimeout(runSearch, 300);
  }

  async function runSearch() {
    if (searchQuery.length < 2) return;
    try {
      loading = true;
      searchResults = await search(searchQuery, true, 20);
    } catch {
      searchResults = [];
    } finally {
      loading = false;
    }
  }

  async function addRandom() {
    try {
      const track = await randomTrack(true);
      await addToQueue(track.id);
      await refreshQueue();
    } catch (e) {
      error = String(e);
    }
  }

  async function addSuggested() {
    try {
      const track = await queueNext();
      await addToQueue(track.id);
      await refreshQueue();
    } catch (e) {
      error = String(e);
    }
  }

  async function addSearchResult(track: DiggerTrack) {
    try {
      await addToQueue(track.id);
      await refreshQueue();
      searchQuery = '';
      searchResults = [];
    } catch (e) {
      error = String(e);
    }
  }

  async function removeItem(itemId: number) {
    try {
      await removeFromQueue(itemId);
      queue = queue.filter(q => q.id !== itemId);
    } catch (e) {
      error = String(e);
    }
  }

  async function loadToDeck(item: DiggerQueueItem, deckId: string) {
    try {
      const deck = decks.find(d => d.id === deckId);
      if (deck?.playing && deck?.source) {
        const label = deck.source.type === 'video'
          ? deck.source.filePath.split('/').pop()
          : deck.id;
        const ok = await ask(`${deckId.replace('deck-', 'D')} is playing "${label}". Load anyway?`, { title: 'Deck is playing', kind: 'warning' });
        if (!ok) return;
      }
      const payload = await getCuemarkPayload(item.track_id);
      if (!payload.filePath) { error = 'No local file for this track'; return; }
      // Digger's API omits bpm/downbeat entirely when unset rather than sending JSON
      // `null`, which deserializes as `undefined` — normalize here so the rest of the
      // app (which only ever checks `!== null`, matching the Deck type) never sees
      // `undefined` and crashes on e.g. `deck.bpm.toFixed()`.
      const bpm = payload.bpm ?? null;
      const downbeat = payload.downbeat ?? null;
      // Only apply bpm/downbeat as a pair — a downbeat is only meaningful relative to
      // the bpm it was set against, so a partial grid would produce an inconsistent one.
      const hasGrid = bpm !== null && downbeat !== null;
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
        ...(hasGrid ? { bpm, downbeat } : {}),
      });
      // Synchronous with updateDeck above, so this lands before App.svelte's rAF-deferred
      // syncVideoElements next inspects this deck — see gridSource.ts race-ordering note.
      if (hasGrid) markGridSaved(deckId, payload.filePath);
    } catch (e) {
      error = String(e);
    }
  }

  function openDiggerWeb() {
    openUrl(getDiggerWebUrl()).catch((e) => { error = String(e); });
  }

  function applyBaseUrl() {
    setDiggerBaseUrl(baseUrl || '/digger-api');
    showUrlInput = false;
    refreshQueue();
    resubscribe();
  }

  function trackLabel(item: { title: string; artist: string }): string {
    return item.artist ? `${item.title} — ${item.artist}` : item.title;
  }
</script>

<div class="digger-panel">
  <div class="digger-header">
    <span class="digger-title">Digger Queue</span>
    <button class="icon-btn" onclick={openDiggerWeb} title="Open Digger in browser">↗</button>
    <button class="icon-btn" onclick={refreshQueue} title="Refresh">↻</button>
    <button class="icon-btn" onclick={() => { showUrlInput = !showUrlInput; }} title="Settings">⚙</button>
  </div>

  <div class="seg tab-seg" role="radiogroup">
    <button type="button" class="seg-opt" class:on={activeTab === 'tracks'} onclick={() => { activeTab = 'tracks'; }}>Tracks</button>
    <button type="button" class="seg-opt" class:on={activeTab === 'history'} onclick={() => { activeTab = 'history'; }}>History</button>
  </div>

  {#if showUrlInput}
    <div class="url-row">
      <input
        class="url-input"
        type="text"
        bind:value={baseUrl}
        onkeydown={(e) => { if (e.key === 'Enter') applyBaseUrl(); }}
        placeholder="http://localhost:8200"
      />
      <button class="small-btn" onclick={applyBaseUrl}>Apply</button>
    </div>
  {/if}

  {#if error}
    <div class="digger-error">{error}</div>
  {/if}

  {#if activeTab === 'tracks'}
    <div class="search-row">
      <input
        class="search-input"
        type="text"
        placeholder="Search tracks..."
        bind:value={searchQuery}
        oninput={onSearchInput}
        onkeydown={(e) => { if (e.key === 'Enter') runSearch(); }}
      />
      <button class="small-btn" onclick={addRandom} title="Add random track">Rnd</button>
      <button class="small-btn" onclick={addSuggested} title="Add suggested track">Nxt</button>
    </div>

    {#if searchQuery.length >= 2}
      <div class="results-list">
        {#if loading}
          <div class="list-hint">searching…</div>
        {:else if searchResults.length === 0}
          <div class="list-hint">no results</div>
        {:else}
          {#each searchResults as track (track.id)}
            <div class="result-row">
              <span class="track-label">{trackLabel(track)}</span>
              <button class="add-btn" onclick={() => addSearchResult(track)}>+</button>
            </div>
          {/each}
        {/if}
      </div>
    {:else}
      <div class="queue-list">
        {#if queue.length === 0}
          <div class="list-hint">Queue is empty — search or add random</div>
        {:else}
          {#each queue as item (item.id)}
            <div class="queue-row">
              <span class="track-label">{trackLabel(item)}</span>
              {#if item.bpm != null}<span class="bpm-badge">{Math.round(item.bpm)}</span>{/if}
              <div class="queue-actions">
                {#each decks as deck (deck.id)}
                  <button
                    class="deck-btn"
                    onclick={() => loadToDeck(item, deck.id)}
                    title="Load to {deck.id}"
                  >→{deck.id.replace('deck-', 'D')}</button>
                {/each}
                <button class="remove-btn" onclick={() => removeItem(item.id)} title="Remove from queue">✕</button>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  {:else}
    <HistoryPanel />
  {/if}
</div>

<style>
  .digger-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 16px 16px 0;
    font-size: calc(12px * var(--font-scale));
    color: var(--text);
  }

  .digger-header {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-bottom: 12px;
    flex-shrink: 0;
  }

  .digger-title {
    font-family: var(--font-heading);
    font-weight: 800;
    color: var(--text);
    font-size: calc(11px * var(--font-scale));
    text-transform: uppercase;
    letter-spacing: 0.08em;
    flex: 1;
  }

  .icon-btn {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--text) 55%, transparent);
    cursor: pointer;
    padding: 4px;
    font-size: calc(14px * var(--font-scale));
    line-height: 1;
    border-radius: var(--radius-sm);
  }
  .icon-btn:hover { color: var(--accent); }

  .tab-seg {
    margin-bottom: 12px;
    flex-shrink: 0;
  }

  .url-row {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
    flex-shrink: 0;
  }

  .url-input {
    flex: 1;
    background: var(--surface2);
    border: 1px solid var(--divider);
    color: var(--text);
    padding: 6px 8px;
    font-size: calc(12px * var(--font-scale));
    border-radius: var(--radius-sm);
  }

  .digger-error {
    color: #ff6b6b;
    font-size: calc(11px * var(--font-scale));
    margin-bottom: 6px;
    flex-shrink: 0;
  }

  .search-row {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    background: var(--surface2);
    border: 1px solid var(--divider);
    color: var(--text);
    padding: 6px 8px;
    font-size: calc(12px * var(--font-scale));
    border-radius: var(--radius-sm);
    font-family: var(--font-body);
  }
  .search-input:focus { outline: none; border-color: var(--accent); }

  .small-btn {
    font-family: var(--font-heading);
    font-weight: 600;
    background: var(--surface2);
    border: 1px solid var(--divider);
    color: var(--text);
    padding: 6px 10px;
    font-size: calc(11px * var(--font-scale));
    cursor: pointer;
    border-radius: var(--radius-sm);
  }
  .small-btn:hover { border-color: var(--accent); color: var(--accent); }

  .results-list,
  .queue-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .list-hint {
    color: color-mix(in srgb, var(--text) 40%, transparent);
    font-size: calc(11px * var(--font-scale));
    padding: 4px 0;
  }

  .result-row,
  .queue-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid var(--divider);
  }

  .track-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: calc(12px * var(--font-scale));
  }

  .bpm-badge {
    color: color-mix(in srgb, var(--text) 45%, transparent);
    font-size: calc(10px * var(--font-scale));
    flex-shrink: 0;
    min-width: 24px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .queue-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .deck-btn {
    background: var(--accent-soft);
    border: 1px solid transparent;
    color: var(--accent);
    padding: 2px 6px;
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: calc(10px * var(--font-scale));
    cursor: pointer;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }
  .deck-btn:hover { filter: brightness(1.15); }

  .add-btn {
    background: var(--accent-soft);
    border: 1px solid transparent;
    color: var(--accent);
    padding: 2px 7px;
    font-size: calc(13px * var(--font-scale));
    cursor: pointer;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }
  .add-btn:hover { filter: brightness(1.15); }

  .remove-btn {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--text) 35%, transparent);
    cursor: pointer;
    padding: 2px 5px;
    font-size: calc(12px * var(--font-scale));
  }
  .remove-btn:hover { color: #ff6b6b; }
</style>
