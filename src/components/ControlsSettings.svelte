<script lang="ts">
  /**
   * DJ-behavior and UI settings split out of AudioSettings.svelte (see todo.md) — everything
   * here is a hands-on-the-hardware feel knob (Tempo/Jog/Platter) or a display-density toggle
   * (Mixer sliders) rather than a device/routing setting. Auto Mix/Auto Preload live in
   * AutoDjSettings.svelte and Display's font scale lives in DisplaySettings.svelte —
   * docs/design/viz-panel-and-settings-restyle.md phase 3 split this file into three tabs.
   *
   * Restyled to the phase-1 visual language (VisualizationPanel.svelte): segmented buttons
   * for the Tempo/Jog selects, a pill switch for Mixer sliders, large mono readouts beside
   * the sliders, and short `.source-hint` lines with the overflow detail moved to `title`.
   * Pure restyle — every store/setter below calls exactly what it called before the split.
   */
  import { tempoRange, scratchMode, jogSecondsPerRev, scrubInertiaMs, SCRUB_INERTIA_MAX_MS } from "../lib/audio/audioSettings";
  import { session, setCompactControls } from "../lib/state/session";

  const tempoOptions = [4, 6, 8, 10, 16, 20, 50, 100];
</script>

<div class="controls-settings">
  <span class="settings-title">Controls</span>

  <div class="settings-row">
    <span class="row-label">Tempo</span>
    <div class="seg-row">
      {#each tempoOptions as pct (pct)}
        <button type="button" class="seg-btn" class:active={$tempoRange === pct} onclick={() => tempoRange.set(pct)}>
          &plusmn;{pct}%
        </button>
      {/each}
    </div>
    <span class="source-hint">fader &amp; slider range</span>
  </div>

  <div class="settings-row">
    <span class="row-label">Jog</span>
    <div class="seg-row">
      <button type="button" class="seg-btn" class:active={$scratchMode === "shuttle"} onclick={() => scratchMode.set("shuttle")}>Shuttle</button>
      <button type="button" class="seg-btn" class:active={$scratchMode === "vinyl"} onclick={() => scratchMode.set("vinyl")}>Vinyl</button>
    </div>
    <span class="source-hint">
      {$scratchMode === "vinyl" ? "slow, precise — decays to a stop" : "fast ff/rev — free-runs at speed"}
    </span>
  </div>

  {#if $scratchMode === "vinyl"}
    <!--
      A/B by ear. The faithful 1.8s/rev (33 1/3 rpm) is inaudible at the 3-8 rpm a hand
      actually uses to hunt for a beat on a small wheel — see jogSecondsPerRev's doc comment
      and docs/design/slow-jog-audio-inaudible.md §6. Both readouts are shown because the
      trade is the whole point: pitch goes up and positioning gets coarser together — see
      the title tooltip for the exact numbers.
    -->
    <div class="settings-row">
      <span class="row-label">Jog scale</span>
      <input
        type="range"
        min="0.2"
        max="3.6"
        step="0.1"
        bind:value={$jogSecondsPerRev}
      />
      <span class="value-mono">{$jogSecondsPerRev.toFixed(1)}s/rev</span>
      <button type="button" class="reset-btn" onclick={() => jogSecondsPerRev.set(1.8)}>
        Vinyl
      </button>
      <span
        class="source-hint"
        title={`1.0x at ${(60 / $jogSecondsPerRev).toFixed(0)} rpm — a slow 6rpm turn -> ${(6 * $jogSecondsPerRev / 60).toFixed(2)}x${6 * $jogSecondsPerRev / 60 < 0.35 ? " (likely too low to hear)" : ""}`}
      >
        1.0&times; at {(60 / $jogSecondsPerRev).toFixed(0)} rpm
        {#if 6 * $jogSecondsPerRev / 60 < 0.35}&middot; a slow turn may be too quiet to hear{/if}
      </span>
    </div>
  {/if}

  <!--
    Deliberately *outside* the vinyl-only block: the waveform drag runs the same position-mode
    scratch path and gets the same platter, whatever the jog wheel is set to. Only shuttle-mode
    jog is unaffected, and that is a jog setting rather than a scrub one.

    Tuned by ear, so the hint reports the trade in the two units it is actually made in — how
    far behind the hand the cursor sits, and whether the detent-by-detent jitter is still
    audible. See scrubInertiaMs's doc comment for the measured table behind these bands.
  -->
  <div class="settings-row">
    <span class="row-label">Platter</span>
    <input
      type="range"
      min="0"
      max={SCRUB_INERTIA_MAX_MS}
      step="5"
      bind:value={$scrubInertiaMs}
    />
    <span class="value-mono">
      {$scrubInertiaMs === 0 ? "off" : `${$scrubInertiaMs}ms`}
    </span>
    <button type="button" class="reset-btn" onclick={() => scrubInertiaMs.set(40)}>
      Reset
    </button>
    <span
      class="source-hint"
      title={$scrubInertiaMs === 0
        ? "no smoothing — each MIDI detent lands as its own pitch step"
        : `smooths the jog's detent steps — cursor trails the hand by ${(3 * $scrubInertiaMs + 60).toFixed(0)}ms${$scrubInertiaMs >= 70 ? " (fluid, but sluggish to steer)" : ""}`}
    >
      {#if $scrubInertiaMs === 0}
        no smoothing on the jog's detents
      {:else}
        cursor trails the hand by {(3 * $scrubInertiaMs + 60).toFixed(0)}ms
      {/if}
    </span>
  </div>
  <!--
    ⚠️ Not a fader-style control: this changes how the deck *feels*, so it is meant to be
    moved while scratching. The value rides along with every scratch_to call rather than
    being pushed on change, so it takes effect mid-gesture with no extra IPC.
  -->

  <div class="settings-row">
    <span class="row-label"></span>
    <button
      type="button"
      class="switch"
      class:on={!$session.compactControls}
      aria-pressed={!$session.compactControls}
      onclick={() => setCompactControls(!$session.compactControls)}
    >
      {!$session.compactControls ? "SHOWN" : "HIDDEN"}
    </button>
    <span class="row-label">Mixer sliders</span>
    <span
      class="source-hint"
      title="shows each deck's opacity/volume/rate + EQ + filter sliders under the marker panel"
    >
      opacity/volume/rate + EQ + filter, under the marker panel — off by default, since a
      MIDI controller drives those and the space now goes to the mix-zone panel
    </span>
  </div>

</div>

<style>
  .controls-settings {
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

  /* Segmented buttons — replaces the Tempo/Jog-mode <select>s */

  .seg-row {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .seg-btn {
    font-family: var(--font-body);
    height: 26px;
    padding: 0 10px;
    border-radius: 5px;
    font-size: calc(11px * var(--font-scale));
    font-weight: 700;
    border: 1px solid var(--divider);
    background: var(--surface2);
    color: color-mix(in srgb, var(--text) 55%, transparent);
    cursor: pointer;
  }

  .seg-btn:hover {
    border-color: var(--accent-deck);
    color: var(--accent-deck);
  }

  .seg-btn.active {
    border-color: var(--accent-deck);
    background: color-mix(in srgb, var(--accent-deck) 16%, transparent);
    color: var(--accent-deck);
  }

  /* Pill switch — replaces on/off checkboxes */

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

  /* Large mono value beside a slider */

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
</style>
