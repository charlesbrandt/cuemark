<script lang="ts">
  /**
   * Auto DJ settings — Auto Mix threshold/crossfade/preview-tail, Beatmatch + drift-back,
   * and Auto Preload — split out of ControlsSettings.svelte
   * (docs/design/viz-panel-and-settings-restyle.md phase 3). Content and behavior are
   * unchanged from the pre-split file (see `git show b983590:src/components/ControlsSettings.svelte`);
   * this is a restyle to the phase-1 visual language (VisualizationPanel.svelte) — segmented/pill
   * controls, large mono readouts, and short `.source-hint` lines with the full detail moved to
   * `title`, same pattern as ControlsSettings.svelte.
   */
  import {
    autoMixThresholdSec,
    crossfadeDurationMs,
    autoPreloadThresholdSec,
    autoMixSyncEnabled,
    autoMixDriftBackSec,
    previewTailSec,
  } from "../lib/digger/autoMix";

  // Read-only "last minute of a track" strip — purely derived from the three settings above,
  // no new store. Track-end is anchored at the right edge; everything else is negative offset
  // from it. 15% headroom past the largest of the three so its own marker isn't flush with the
  // left edge.
  let preloadSec = $derived($autoPreloadThresholdSec);
  let mixStartSec = $derived($autoMixThresholdSec);
  let fadeSec = $derived($crossfadeDurationMs / 1000);
  let totalSec = $derived(Math.max(preloadSec, mixStartSec, fadeSec) * 1.15);

  // % from the left edge for an offset of `sec` before track end.
  function leftPct(sec: number, total: number): number {
    return ((total - sec) / total) * 100;
  }
</script>

<div class="autodj-settings">
  <span class="settings-title">Auto DJ</span>

  <div class="strip-row">
    <div
      class="strip"
      title={`last ${totalSec.toFixed(0)}s of a track (not to scale beyond this panel)`}
    >
      <div
        class="strip-fade"
        style={`left: ${leftPct(fadeSec, totalSec)}%; width: ${100 - leftPct(fadeSec, totalSec)}%;`}
        title={`Fade: crossfade runs over the last ${fadeSec.toFixed(1)}s`}
      ></div>
      <div
        class="strip-tick strip-tick-mix"
        style={`left: ${leftPct(mixStartSec, totalSec)}%;`}
        title={`Mix start: crossfade begins at least ${mixStartSec}s before the end`}
      >
        <span class="strip-label">Mix start</span>
      </div>
      <div
        class="strip-tick strip-tick-preload"
        style={`left: ${leftPct(preloadSec, totalSec)}%;`}
        title={`Preload: next track loads ${preloadSec}s before the end`}
      >
        <span class="strip-label">Preload</span>
      </div>
      <div class="strip-end" title="track end">
        <span class="strip-label strip-label-end">End</span>
      </div>
    </div>
  </div>

  <!--
    Auto DJ (docs/design/auto-dj-transitions.md) — only takes effect once the Auto button
    (DiggerQueue.svelte) is on. Both numbers here are *floors/fallbacks* since phase 5: a
    track pair carrying Digger mix-in/mix-out markers derives its own fade length and its
    own (earlier) trigger point from them, and these values apply when it doesn't.
  -->
  <div class="settings-row">
    <span class="row-label">Auto Mix</span>
    <input type="range" min="3" max="45" step="1" bind:value={$autoMixThresholdSec} />
    <span class="value-mono">{$autoMixThresholdSec}s lead</span>
    <input
      type="range"
      min="1"
      max="15"
      step="0.5"
      value={$crossfadeDurationMs / 1000}
      oninput={(e) => crossfadeDurationMs.set(+e.currentTarget.value * 1000)}
    />
    <span class="value-mono">{($crossfadeDurationMs / 1000).toFixed(1)}s fade</span>
    <input type="range" min="3" max="30" step="1" bind:value={$previewTailSec} />
    <span class="value-mono">{$previewTailSec}s tail</span>
    <button
      type="button"
      class="reset-btn"
      onclick={() => {
        autoMixThresholdSec.set(15);
        crossfadeDurationMs.set(6000);
        previewTailSec.set(8);
      }}
    >
      Reset
    </button>
    <span
      class="source-hint"
      title="when Auto DJ is on, starts crossfading to the other crossfader-mapped deck at least this far from the end (earlier if the tracks' own mix markers ask for a longer blend) — only if it's already loaded. The fade length applies to tracks with no marker data. The preview tail is how long the incoming track keeps playing after a Preview's fade finishes, before the fader and deck are put back — Auto DJ won't start a real transition while a preview is still running, so keep it short during a set"
    >
      min lead / fade length / preview-tail hold
    </span>
  </div>

  <div class="settings-row">
    <span class="row-label"></span>
    <button
      type="button"
      class="switch"
      class:on={$autoMixSyncEnabled}
      aria-pressed={$autoMixSyncEnabled}
      onclick={() => autoMixSyncEnabled.set(!$autoMixSyncEnabled)}
    >
      {$autoMixSyncEnabled ? "ON" : "OFF"}
    </button>
    <span class="row-label">Beatmatch</span>
    <span
      class="source-hint"
      title="when on, rate-locks the incoming deck to the main beat and aligns its phase before the crossfade starts (needs bpm detected/set on both decks) — off cuts at native tempo"
    >
      rate-lock + phase align before mixing
    </span>
  </div>

  <!--
    Only reachable with Beatmatch on — nothing else imposes a rate, so the control is
    hidden rather than shown as a no-op. Phase 5: without it, each transition's tempo
    reference is the previous transition's already-adjusted rate, which compounds over a
    set ("locked at some strange tempos over time").
  -->
  {#if $autoMixSyncEnabled}
    <div class="settings-row">
      <span class="row-label"></span>
      <input type="range" min="0" max="60" step="5" bind:value={$autoMixDriftBackSec} />
      <span class="value-mono">
        {$autoMixDriftBackSec === 0 ? "off" : `${$autoMixDriftBackSec}s drift`}
      </span>
      <button type="button" class="reset-btn" onclick={() => autoMixDriftBackSec.set(20)}>
        Reset
      </button>
      <span
        class="source-hint"
        title={$autoMixDriftBackSec === 0
          ? "the beatmatched deck keeps its locked tempo — each transition's reference then builds on the last one's"
          : "after the fade, eases the incoming deck back to its own native tempo over this long, so the next transition matches against a real bpm — any manual tempo input cancels it"}
      >
        {$autoMixDriftBackSec === 0
          ? "keeps locked tempo across transitions"
          : "eases back to native tempo after the fade"}
      </span>
    </div>
  {/if}

  <div class="settings-row">
    <span class="row-label">Preload</span>
    <input type="range" min="20" max="120" step="5" bind:value={$autoPreloadThresholdSec} />
    <span class="value-mono">{$autoPreloadThresholdSec}s before end</span>
    <button type="button" class="reset-btn" onclick={() => autoPreloadThresholdSec.set(45)}>
      Reset
    </button>
    <span
      class="source-hint"
      title="when Auto DJ is on and the other crossfader-mapped deck is empty, auto-loads (but doesn't play) the next queued track this far from the end — keep this above Auto Mix's threshold so the load has time to finish first"
    >
      auto-load lead time — keep above Auto Mix's lead
    </span>
  </div>
</div>

<style>
  .autodj-settings {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 20px;
    background: var(--surface);
    border-top: 2px solid var(--accent-deck);
    border-bottom: 1px solid var(--divider);
    font-size: calc(12px * var(--font-scale));
    color: var(--text);
    flex-shrink: 0;
  }

  .settings-title {
    font-family: var(--font-heading);
    font-weight: 800;
    color: var(--accent-deck);
    letter-spacing: 0.08em;
    font-size: calc(10px * var(--font-scale));
    text-transform: uppercase;
  }

  .settings-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .row-label {
    font-family: var(--font-heading);
    color: color-mix(in srgb, var(--text) 55%, transparent);
    flex-shrink: 0;
    min-width: 32px;
  }

  .source-hint {
    color: color-mix(in srgb, var(--text) 45%, transparent);
    font-size: calc(11px * var(--font-scale));
  }

  /* Pill switch — matches ControlsSettings.svelte's Mixer-sliders switch */

  .switch {
    height: 26px;
    padding: 0 12px;
    border-radius: 13px;
    font-size: calc(10px * var(--font-scale));
    font-weight: 800;
    letter-spacing: 0.08em;
    border: 1px solid var(--divider);
    background: transparent;
    color: color-mix(in srgb, var(--text) 55%, transparent);
    cursor: pointer;
  }

  .switch.on {
    border-color: var(--accent-deck);
    background: var(--accent-deck);
    color: #10131f;
  }

  .value-mono {
    color: var(--text);
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    font-size: calc(15px * var(--font-scale));
    min-width: 58px;
  }

  .reset-btn {
    font-family: var(--font-body);
    font-size: calc(11px * var(--font-scale));
    background: var(--surface2);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 3px 8px;
    cursor: pointer;
  }
  .reset-btn:hover {
    border-color: var(--accent-deck);
    color: var(--accent-deck);
  }

  /* "Last minute of a track" strip — read-only, derived from the settings below, no store
     of its own. Track end is the right edge; markers sit at their negative-offset percentage
     of the strip's total represented duration (see leftPct() in the script). */

  .strip-row {
    display: flex;
    padding-bottom: 4px;
  }

  .strip {
    position: relative;
    width: 100%;
    height: 44px;
    background: var(--surface2);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    overflow: visible;
  }

  .strip-fade {
    position: absolute;
    top: 0;
    bottom: 0;
    background: color-mix(in srgb, var(--accent-deck) 22%, transparent);
    border-left: 1px dashed color-mix(in srgb, var(--accent-deck) 60%, transparent);
  }

  .strip-tick {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 0;
    border-left: 2px solid color-mix(in srgb, var(--text) 55%, transparent);
  }

  .strip-tick-mix {
    border-left-color: var(--accent-deck);
  }

  .strip-tick-preload {
    border-left-color: color-mix(in srgb, var(--text) 70%, transparent);
  }

  .strip-end {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 0;
    border-left: 2px solid var(--text);
  }

  .strip-label {
    position: absolute;
    top: 2px;
    left: 4px;
    font-size: calc(9px * var(--font-scale));
    font-family: var(--font-heading);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--text) 60%, transparent);
    white-space: nowrap;
  }

  .strip-label-end {
    left: auto;
    right: 4px;
  }
</style>
