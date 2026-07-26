<script lang="ts">
  import { onDestroy } from 'svelte';
  import { history, liveElapsedMs, type HistoryEntry } from '../lib/state/history';
  import { addToQueue } from '../lib/digger/api';

  // Live-updating "duration played" for whichever entry is currently playing —
  // history.ts only updates playedMs on pause/track-change, so tick a local
  // counter to keep the display moving while a track plays. 1Hz is plenty for
  // a duration readout and has no perf-loop implications (own setInterval,
  // unrelated to the render loop — see CLAUDE.md's RAF actual-change-check rule).
  let now = $state(Date.now());
  const tick = setInterval(() => { now = Date.now(); }, 1000);
  onDestroy(() => clearInterval(tick));

  let addedIds = $state(new Set<string>());

  async function reAddToQueue(entry: HistoryEntry) {
    if (entry.diggerTrackId === null) return;
    try {
      await addToQueue(entry.diggerTrackId);
      addedIds = new Set(addedIds).add(entry.id);
      setTimeout(() => {
        addedIds = new Set([...addedIds].filter((id) => id !== entry.id));
      }, 1500);
    } catch (e) {
      console.error('re-add to queue failed', e);
    }
  }

  function label(entry: HistoryEntry): string {
    return entry.artist ? `${entry.title} — ${entry.artist}` : entry.title;
  }

  function formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = (totalSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function formatTime(epochMs: number): string {
    return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function playedMs(entry: HistoryEntry): number {
    void now; // reactive dependency to force a re-render each tick
    return entry.playedMs + liveElapsedMs(entry.deckId);
  }
</script>

<div class="history-panel">
  <div class="history-header">
    <span class="history-title">Session History</span>
  </div>

  <div class="history-list">
    {#if $history.length === 0}
      <div class="list-hint">Nothing played yet this session</div>
    {:else}
      {#each $history as entry (entry.id)}
        <div class="history-row">
          <span class="history-deck">{entry.deckId.replace('deck-', 'D')}</span>
          <div class="history-info">
            <span class="track-label" title={label(entry)}>{label(entry)}</span>
            <span class="history-meta">{formatTime(entry.startedAt)} · played {formatDuration(playedMs(entry))}</span>
          </div>
          <button
            class="requeue-btn"
            class:done={addedIds.has(entry.id)}
            disabled={entry.diggerTrackId === null}
            onclick={() => reAddToQueue(entry)}
            title={entry.diggerTrackId === null ? 'Not from Digger — cannot re-queue' : 'Re-add to Digger queue'}
          >{addedIds.has(entry.id) ? '✓' : '+Q'}</button>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .history-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: #1a1a1a;
    border-bottom: 1px solid #333;
    padding: 6px 10px;
    font-size: 12px;
    color: #ccc;
  }

  .history-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    flex-shrink: 0;
  }

  .history-title {
    font-weight: bold;
    color: #aaa;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex: 1;
  }

  .history-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .list-hint {
    color: #555;
    font-size: 11px;
    padding: 4px 0;
  }

  .history-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
    border-bottom: 1px solid #222;
  }

  .history-deck {
    color: #666;
    font-size: 10px;
    flex-shrink: 0;
    min-width: 16px;
  }

  .history-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .track-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .history-meta {
    color: #666;
    font-size: 10px;
  }

  .requeue-btn {
    background: #1e3a2a;
    border: 1px solid #2a5a3a;
    color: #5dbe8a;
    padding: 1px 6px;
    font-size: 10px;
    cursor: pointer;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .requeue-btn:hover:not(:disabled) { background: #2a5040; }
  .requeue-btn:disabled { opacity: 0.35; cursor: default; }
  .requeue-btn.done { color: #8ad; border-color: #446; background: #1e2a3a; }
</style>
