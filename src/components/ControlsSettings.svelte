<script lang="ts">
  /**
   * DJ-behavior and UI settings split out of AudioSettings.svelte (see todo.md) — everything
   * here is either not audio-routing (Display, Compact controls) or a DJ-behavior timing/feel
   * knob (Tempo/Jog/Platter, Auto Mix/Auto Preload) rather than a device/routing setting.
   */
  import { tempoRange, scratchMode, jogSecondsPerRev, scrubInertiaMs, SCRUB_INERTIA_MAX_MS } from "../lib/audio/audioSettings";
  import { fontScale } from "../lib/settings/displaySettings";
  import { autoMixThresholdSec, crossfadeDurationMs, autoPreloadThresholdSec, autoMixSyncEnabled, autoMixDriftBackSec } from "../lib/digger/autoMix";
  import { session, setCompactControls } from "../lib/state/session";
</script>

<div class="controls-settings">
  <span class="settings-title">Controls</span>

  <div class="settings-row">
    <span class="row-label">Tempo</span>
    <select bind:value={$tempoRange}>
      <option value={4}>±4%</option>
      <option value={6}>±6%</option>
      <option value={8}>±8%</option>
      <option value={10}>±10%</option>
      <option value={16}>±16%</option>
      <option value={20}>±20%</option>
      <option value={50}>±50%</option>
      <option value={100}>±100%</option>
    </select>
    <span class="hint-inline">fader &amp; slider range</span>
  </div>

  <div class="settings-row">
    <span class="row-label">Jog</span>
    <select bind:value={$scratchMode}>
      <option value="shuttle">Shuttle</option>
      <option value="vinyl">Vinyl</option>
    </select>
    <span class="hint-inline">
      {$scratchMode === "vinyl" ? "slow, precise — decays to a stop" : "fast ff/rev — free-runs at speed"}
    </span>
  </div>

  {#if $scratchMode === "vinyl"}
    <!--
      A/B by ear. The faithful 1.8s/rev (33 1/3 rpm) is inaudible at the 3-8 rpm a hand
      actually uses to hunt for a beat on a small wheel — see jogSecondsPerRev's doc comment
      and docs/design/slow-jog-audio-inaudible.md §6. Both readouts are shown because the
      trade is the whole point: pitch goes up and positioning gets coarser together.
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
      <span class="jog-scale-value">{$jogSecondsPerRev.toFixed(1)}s/rev</span>
      <button type="button" class="font-scale-reset" onclick={() => jogSecondsPerRev.set(1.8)}>
        Vinyl
      </button>
      <span class="hint-inline">
        1.0&times; at {(60 / $jogSecondsPerRev).toFixed(0)} rpm &middot;
        a slow 6 rpm turn &rarr; {(6 * $jogSecondsPerRev / 60).toFixed(2)}&times;
        {#if 6 * $jogSecondsPerRev / 60 < 0.35}(likely too low to hear){/if}
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
    <span class="jog-scale-value">
      {$scrubInertiaMs === 0 ? "off" : `${$scrubInertiaMs}ms`}
    </span>
    <button type="button" class="font-scale-reset" onclick={() => scrubInertiaMs.set(40)}>
      Reset
    </button>
    <span class="hint-inline">
      {#if $scrubInertiaMs === 0}
        no smoothing &mdash; each MIDI detent lands as its own pitch step
      {:else}
        smooths the jog's detent steps &middot; cursor trails the hand by
        {(3 * $scrubInertiaMs + 60).toFixed(0)}ms
        {#if $scrubInertiaMs >= 70}(fluid, but sluggish to steer){/if}
      {/if}
    </span>
  </div>
  <!--
    ⚠️ Not a fader-style control: this changes how the deck *feels*, so it is meant to be
    moved while scratching. The value rides along with every scratch_to call rather than
    being pushed on change, so it takes effect mid-gesture with no extra IPC.
  -->

  <!--
    Auto DJ (docs/design/auto-dj-transitions.md) — only takes effect once the Auto button
    (DiggerQueue.svelte) is on. Both numbers here are *floors/fallbacks* since phase 5: a
    track pair carrying Digger mix-in/mix-out markers derives its own fade length and its
    own (earlier) trigger point from them, and these values apply when it doesn't.
  -->
  <div class="settings-row">
    <span class="row-label">Auto Mix</span>
    <input
      type="range"
      min="3"
      max="45"
      step="1"
      bind:value={$autoMixThresholdSec}
    />
    <span class="jog-scale-value">{$autoMixThresholdSec}s min lead</span>
    <input
      type="range"
      min="1"
      max="15"
      step="0.5"
      value={$crossfadeDurationMs / 1000}
      oninput={(e) => crossfadeDurationMs.set(+e.currentTarget.value * 1000)}
    />
    <span class="jog-scale-value">{($crossfadeDurationMs / 1000).toFixed(1)}s fade</span>
    <button
      type="button"
      class="font-scale-reset"
      onclick={() => { autoMixThresholdSec.set(15); crossfadeDurationMs.set(6000); }}
    >Reset</button>
    <span class="hint-inline">
      when Auto DJ is on, starts crossfading to the other crossfader-mapped deck at least this
      far from the end (earlier if the tracks' own mix markers ask for a longer blend) — only
      if it's already loaded. The fade length applies to tracks with no marker data
    </span>
  </div>

  <div class="settings-row">
    <span class="row-label"></span>
    <label class="device-check">
      <input type="checkbox" bind:checked={$autoMixSyncEnabled} />
      Beatmatch before mixing
    </label>
    <span class="hint-inline">
      when on, rate-locks the incoming deck to the main beat and aligns its phase before the
      crossfade starts (needs bpm detected/set on both decks) — off cuts at native tempo
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
      <input
        type="range"
        min="0"
        max="60"
        step="5"
        bind:value={$autoMixDriftBackSec}
      />
      <span class="jog-scale-value">
        {$autoMixDriftBackSec === 0 ? "off" : `${$autoMixDriftBackSec}s drift`}
      </span>
      <button
        type="button"
        class="font-scale-reset"
        onclick={() => autoMixDriftBackSec.set(20)}
      >Reset</button>
      <span class="hint-inline">
        {#if $autoMixDriftBackSec === 0}
          the beatmatched deck keeps its locked tempo &mdash; each transition's reference
          then builds on the last one's
        {:else}
          after the fade, eases the incoming deck back to its own native tempo over this
          long, so the next transition matches against a real bpm &mdash; any manual tempo
          input cancels it
        {/if}
      </span>
    </div>
  {/if}

  <div class="settings-row">
    <span class="row-label">Auto Preload</span>
    <input
      type="range"
      min="20"
      max="120"
      step="5"
      bind:value={$autoPreloadThresholdSec}
    />
    <span class="jog-scale-value">{$autoPreloadThresholdSec}s before end</span>
    <button
      type="button"
      class="font-scale-reset"
      onclick={() => autoPreloadThresholdSec.set(45)}
    >Reset</button>
    <span class="hint-inline">
      when Auto DJ is on and the other crossfader-mapped deck is empty, auto-loads (but
      doesn't play) the next queued track this far from the end — keep this above Auto Mix's
      threshold so the load has time to finish first
    </span>
  </div>

  <div class="settings-row">
    <span class="row-label">Display</span>
    <input
      type="range"
      min="0.8"
      max="1.5"
      step="0.05"
      bind:value={$fontScale}
    />
    <span class="font-scale-value">{Math.round($fontScale * 100)}%</span>
    <button type="button" class="font-scale-reset" onclick={() => fontScale.set(1.0)}>Reset</button>
    <span class="hint-inline">UI text size</span>
  </div>

  <div class="settings-row">
    <span class="row-label"></span>
    <label class="device-check">
      <!-- Inverted 2026-08-30 with the default flip: the sliders are the opt-in now, so
           the checkbox reads as "show them" rather than "compact away". Same field. -->
      <input
        type="checkbox"
        checked={!$session.compactControls}
        onchange={(e) => setCompactControls(!e.currentTarget.checked)}
      />
      Mixer sliders
    </label>
    <span class="hint-inline">
      shows each deck's opacity/volume/rate + EQ + filter sliders under the marker panel —
      off by default, since a MIDI controller drives those and the sliders cost the space
      the mix-zone panel now uses
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

  .hint-inline {
    color: color-mix(in srgb, var(--text) 40%, transparent);
    font-style: italic;
  }

  .device-check {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--text);
    cursor: pointer;
    white-space: nowrap;
  }

  .device-check input[type="checkbox"] {
    accent-color: var(--accent-deck);
    cursor: pointer;
  }

  select {
    font-family: var(--font-body);
    background-color: var(--surface2);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: calc(12px * var(--font-scale));
    padding: 5px 24px 5px 8px;
    cursor: pointer;
    max-width: 220px;
  }

  select:focus {
    outline: none;
    border-color: var(--accent-deck);
  }

  .font-scale-value {
    color: var(--text);
    font-variant-numeric: tabular-nums;
    min-width: 34px;
  }

  .jog-scale-value {
    color: var(--text);
    font-variant-numeric: tabular-nums;
    min-width: 58px;
  }

  .font-scale-reset {
    font-family: var(--font-body);
    font-size: calc(11px * var(--font-scale));
    background: var(--surface2);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 3px 8px;
    cursor: pointer;
  }
  .font-scale-reset:hover {
    border-color: var(--accent-deck);
    color: var(--accent-deck);
  }
</style>
