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

<style>
  .history-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    font-size: 12px;
    color: var(--text);
  }

  .list-hint {
    color: color-mix(in srgb, var(--text) 40%, transparent);
    font-size: 11px;
    padding: 4px 0;
  }

  .history-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 0;
    border-bottom: 1px solid var(--divider);
  }

  .history-deck {
    color: color-mix(in srgb, var(--text) 45%, transparent);
    font-family: var(--font-heading);
    font-size: 10px;
    font-weight: 700;
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
    color: color-mix(in srgb, var(--text) 40%, transparent);
    font-size: 10px;
  }

  .requeue-btn {
    background: var(--accent-soft);
    border: 1px solid transparent;
    color: var(--accent);
    padding: 2px 7px;
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 10px;
    cursor: pointer;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }
  .requeue-btn:hover:not(:disabled) { filter: brightness(1.15); }
  .requeue-btn:disabled { opacity: 0.35; cursor: default; }
  .requeue-btn.done { color: var(--text); background: var(--surface2); }
</style>
