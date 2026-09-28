<script lang="ts">
  /**
   * Display settings — just the UI font-scale slider, split out of ControlsSettings.svelte
   * (docs/design/viz-panel-and-settings-restyle.md phase 3). Sparse by design: this is the
   * one remaining display-density setting, the queue sidebar width being a drag handle, not
   * a settings-panel control. Restyled to the phase-1 visual language (VisualizationPanel.svelte)
   * to match ControlsSettings.svelte/AutoDjSettings.svelte.
   */
  import { fontScale } from "../lib/settings/displaySettings";
</script>

<div class="display-settings">
  <span class="settings-title">Display</span>

  <div class="settings-row">
    <span class="row-label">Text size</span>
    <input type="range" min="0.8" max="1.5" step="0.05" bind:value={$fontScale} />
    <span class="value-mono">{Math.round($fontScale * 100)}%</span>
    <button type="button" class="reset-btn" onclick={() => fontScale.set(1.0)}>Reset</button>
    <span class="source-hint" title="UI text size">UI text size</span>
  </div>
</div>

<style>
  .display-settings {
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
