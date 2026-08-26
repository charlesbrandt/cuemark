<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { session } from '../lib/state/session';
  import {
    search, getQueue, addToQueue, removeFromQueue,
    setDiggerBaseUrl, getDiggerBaseUrl, getDiggerBaseUrlHistory, getDiggerWebUrl,
    subscribeQueueChanges,
    type DiggerTrack, type DiggerQueueItem,
  } from '../lib/digger/api';
  import { diggerQueue, selectedQueueIndex, loadQueueItemToDeck } from '../lib/digger/queueStore';
  import { currentDj, currentDjOrNull } from '../lib/digger/djSelector';
  import { autoDjEnabled } from '../lib/digger/autoDj';
  import { skipUpcomingTrack } from '../lib/digger/autoMix';
  import { playedTrackIds, clearPlayed, clearAllPlayed } from '../lib/digger/playedTracks';
  import HistoryPanel from './HistoryPanel.svelte';

  let activeTab = $state<'tracks' | 'history'>('tracks');

  const totalQueueMs = $derived(
    $diggerQueue.reduce((sum, item) => sum + (item.duration_ms ?? 0), 0)
  );

  function formatTotalDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = (totalSec % 60).toString().padStart(2, '0');
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
  }
  let searchResults = $state<DiggerTrack[]>([]);
  let searchQuery = $state('');
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let error = $state<string | null>(null);
  let loading = $state(false);
  let baseUrl = $state(getDiggerBaseUrl());
  let showUrlInput = $state(false);

  // Named presets for the two places Digger's API actually runs (see
  // docs/design/offline-crate.md's "cuemark needs zero changes" section, point 1):
  // Home = the GPU box Digger normally runs on; Local = a Digger stack running on
  // this same laptop for offline/travel use. Free-text input stays available below
  // for anything else (e.g. a Tailscale address).
  const DIGGER_PRESETS = {
    Home: 'http://10.20.2.99:8200',
    Local: 'http://localhost:8200',
  } as const;

  // Recently-used custom URLs (e.g. a Tailscale address) — excludes the two
  // named presets above, which already have their own buttons.
  let recentUrls = $state(
    getDiggerBaseUrlHistory().filter((u) => u !== DIGGER_PRESETS.Home && u !== DIGGER_PRESETS.Local)
  );

  const decks = $derived($session.decks);
  const activePreset = $derived(
    baseUrl === DIGGER_PRESETS.Home ? 'Home' :
    baseUrl === DIGGER_PRESETS.Local ? 'Local' :
    null
  );

  function shortLabel(url: string): string {
    return url.replace(/^https?:\/\//, '');
  }

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

  // Resubscribe/refetch when the DJ selector changes — same path already used
  // when the Digger base URL changes (applyBaseUrl below), per guest-djs.md
  // item 3. The websocket subscription itself stays global (Digger broadcasts
  // queue_changed to everyone and each client refetches its own scope, per
  // the design doc), so only a refetch is needed here, not resubscribe(). The
  // first run duplicates onMount's own refreshQueue() call — a spurious
  // refetch is cheap, per the same doc's reasoning about the websocket.
  $effect(() => {
    void $currentDj;
    refreshQueue();
  });

  async function refreshQueue() {
    try {
      error = null;
      const items = await getQueue(currentDjOrNull($currentDj));
      diggerQueue.set(items);
      // Keep the MIDI-driven cursor in range after a refresh shrinks the list
      // (item consumed/removed elsewhere) rather than pointing past the end.
      if ($selectedQueueIndex >= items.length) selectedQueueIndex.set(Math.max(0, items.length - 1));
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

  async function addSearchResult(track: DiggerTrack) {
    try {
      await addToQueue(track.id, currentDjOrNull($currentDj));
      await refreshQueue();
      searchQuery = '';
      searchResults = [];
    } catch (e) {
      error = String(e);
    }
  }

  async function removeItem(itemId: number) {
    try {
      await removeFromQueue(itemId, currentDjOrNull($currentDj));
      diggerQueue.update(q => q.filter(item => item.id !== itemId));
    } catch (e) {
      error = String(e);
    }
  }

  async function loadToDeck(item: DiggerQueueItem, deckId: string) {
    try {
      await loadQueueItemToDeck(item, deckId);
    } catch (e) {
      error = String(e);
    }
  }

  function skipUpcoming() {
    skipUpcomingTrack().catch((e) => { error = String(e); });
  }

  function openDiggerWeb() {
    openUrl(getDiggerWebUrl()).catch((e) => { error = String(e); });
  }

  function applyBaseUrl(url?: string) {
    setDiggerBaseUrl((url ?? baseUrl) || '/digger-api');
    baseUrl = getDiggerBaseUrl();
    recentUrls = getDiggerBaseUrlHistory().filter((u) => u !== DIGGER_PRESETS.Home && u !== DIGGER_PRESETS.Local);
    showUrlInput = false;
    refreshQueue();
    resubscribe();
  }

  function trackLabel(item: { title: string; artist: string }): string {
    return item.artist ? `${item.title} — ${item.artist}` : item.title;
  }

  // Keeps the browse-encoder cursor visible when it's driven from the controller —
  // without this, turning the knob past the visible rows leaves the highlight
  // (and the fact that anything moved at all) off-screen.
  function scrollSelectedIntoView(node: HTMLElement, selected: boolean) {
    if (selected) node.scrollIntoView({ block: 'nearest' });
    return {
      update(sel: boolean) {
        if (sel) node.scrollIntoView({ block: 'nearest' });
      },
    };
  }
</script>

<div class="digger-panel">
  <div class="digger-header">
    <span class="digger-title">Digger Queue</span>
    <button
      class="icon-btn"
      class:active={activeTab === 'history'}
      onclick={() => { activeTab = activeTab === 'history' ? 'tracks' : 'history'; }}
      title={activeTab === 'history' ? 'Back to tracks' : 'This session\'s play history'}
    >🕓</button>
    <button class="icon-btn" onclick={openDiggerWeb} title="Open Digger in browser">↗</button>
    <button class="icon-btn" onclick={refreshQueue} title="Refresh">↻</button>
    <button class="icon-btn" onclick={() => { showUrlInput = !showUrlInput; }} title="Settings">⚙</button>
  </div>

  {#if showUrlInput}
    <div class="url-row">
      <button
        class="small-btn preset-btn"
        class:active={activePreset === 'Home'}
        onclick={() => applyBaseUrl(DIGGER_PRESETS.Home)}
        title={DIGGER_PRESETS.Home}
      >Home</button>
      <button
        class="small-btn preset-btn"
        class:active={activePreset === 'Local'}
        onclick={() => applyBaseUrl(DIGGER_PRESETS.Local)}
        title={DIGGER_PRESETS.Local}
      >Local</button>
      <input
        class="url-input"
        type="text"
        bind:value={baseUrl}
        onkeydown={(e) => { if (e.key === 'Enter') applyBaseUrl(); }}
        placeholder="http://localhost:8200"
      />
      <button class="small-btn" onclick={() => applyBaseUrl()}>Apply</button>
    </div>
    {#if recentUrls.length > 0}
      <div class="recent-row">
        {#each recentUrls as url (url)}
          <button
            class="small-btn preset-btn recent-btn"
            class:active={baseUrl === url}
            onclick={() => applyBaseUrl(url)}
            title={url}
          >{shortLabel(url)}</button>
        {/each}
      </div>
    {/if}
    <div class="played-row">
      <button
        class="small-btn"
        disabled={$playedTrackIds.size === 0}
        onclick={() => clearAllPlayed()}
        title="Clear the played marker from every track tracked this session"
      >Clear played ({$playedTrackIds.size})</button>
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
      <button
        class="small-btn"
        class:active={$autoDjEnabled}
        onclick={() => autoDjEnabled.set(!$autoDjEnabled)}
        title="Auto DJ — when a deck's clip ends, auto-load the next queued track (or a suggestion if the queue is empty) and play it"
      >Auto</button>
      {#if $autoDjEnabled}
        <button
          class="small-btn icon-btn"
          onclick={skipUpcoming}
          title="Skip — swap the upcoming/preloaded track for a different one, without turning Auto DJ off"
        >⏭</button>
      {/if}
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
              <button
                class="played-mark"
                class:played={$playedTrackIds.has(track.id)}
                disabled={!$playedTrackIds.has(track.id)}
                onclick={(e) => { e.stopPropagation(); clearPlayed(track.id); }}
                title={$playedTrackIds.has(track.id) ? 'Played this session — click to clear' : 'Not played this session'}
              >✓</button>
              <span class="track-label">{trackLabel(track)}</span>
              <button class="add-btn" onclick={() => addSearchResult(track)}>+</button>
            </div>
          {/each}
        {/if}
      </div>
    {:else}
      {#if $diggerQueue.length > 0}
        <div class="queue-summary">{$diggerQueue.length} track{$diggerQueue.length === 1 ? '' : 's'} · {formatTotalDuration(totalQueueMs)}</div>
      {/if}
      <div class="queue-list">
        {#if $diggerQueue.length === 0}
          <div class="list-hint">Queue is empty — search or add random</div>
        {:else}
          {#each $diggerQueue as item, i (item.id)}
            <div
              class="queue-row"
              class:selected={i === $selectedQueueIndex}
              use:scrollSelectedIntoView={i === $selectedQueueIndex}
            >
              <button
                class="played-mark"
                class:played={$playedTrackIds.has(item.track_id)}
                disabled={!$playedTrackIds.has(item.track_id)}
                onclick={(e) => { e.stopPropagation(); clearPlayed(item.track_id); }}
                title={$playedTrackIds.has(item.track_id) ? 'Played this session — click to clear' : 'Not played this session'}
              >✓</button>
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
  .icon-btn.active { color: var(--accent); }

  .queue-summary {
    color: color-mix(in srgb, var(--text) 45%, transparent);
    font-size: calc(10px * var(--font-scale));
    margin-bottom: 4px;
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

  .small-btn.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  .preset-btn.active {
    background: #3a5a3a;
    border-color: #5a8a5a;
    color: #cfc;
  }
  .preset-btn.active:hover { background: #446644; }

  .recent-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
    flex-shrink: 0;
  }

  .recent-btn {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .played-row {
    margin-bottom: 8px;
    flex-shrink: 0;
  }

  .played-mark {
    flex-shrink: 0;
    width: 16px;
    background: none;
    border: none;
    padding: 0;
    font-size: calc(11px * var(--font-scale));
    color: transparent;
    cursor: default;
  }
  .played-mark.played {
    color: var(--accent);
    cursor: pointer;
  }
  .played-mark.played:hover {
    color: #ff6b6b;
  }

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

  /* Browse-encoder cursor position — MIDI-driven, not clickable-selection */
  .queue-row.selected {
    background: var(--accent-soft);
    margin: 0 -8px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
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
