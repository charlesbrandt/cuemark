<script lang="ts">
  import { session, setVisualization, setVisualizationOpacity } from "../lib/state/session";
  import { BUILT_IN_SHADERS } from "../lib/renderer/shaders";

  let visualization = $derived($session.visualization);
</script>

<div class="visualization-panel">
  <span class="settings-title">Visualization</span>

  <div class="settings-row">
    <button
      class="viz-btn"
      class:viz-active={visualization === null}
      onclick={() => setVisualization(null)}
    >None</button>
    {#each BUILT_IN_SHADERS as shader}
      <button
        class="viz-btn"
        class:viz-active={visualization?.name === shader.name}
        onclick={() => setVisualization({ fragmentSrc: shader.src, uniforms: {}, name: shader.name })}
      >{shader.name}</button>
    {/each}
  </div>

  <div class="settings-row">
    <span class="row-label">Opacity</span>
    <input
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={$session.visualizationOpacity}
      oninput={(e) => setVisualizationOpacity(+e.currentTarget.value)}
    />
    <span class="opacity-val">{$session.visualizationOpacity.toFixed(2)}</span>
  </div>
</div>

<style>
  .visualization-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 20px;
    background: var(--surface);
    border-top: 2px solid #7ec8e3;
    border-bottom: 1px solid var(--divider);
    font-size: 12px;
    color: var(--text);
    flex-shrink: 0;
  }

  .settings-title {
    font-family: var(--font-heading);
    font-weight: 800;
    color: #7ec8e3;
    letter-spacing: 0.08em;
    font-size: 10px;
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
    min-width: 50px;
  }

  .viz-btn {
    font-family: var(--font-heading);
    font-weight: 600;
    padding: 5px 10px;
    font-size: 11px;
    background: var(--surface2);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: color-mix(in srgb, var(--text) 55%, transparent);
    cursor: pointer;
  }

  .viz-btn:hover {
    border-color: #7ec8e3;
    color: #7ec8e3;
  }

  .viz-btn.viz-active {
    background: #7ec8e3;
    border-color: #7ec8e3;
    color: #0b1c22;
  }

  .opacity-val {
    min-width: 32px;
    color: color-mix(in srgb, var(--text) 55%, transparent);
    font-variant-numeric: tabular-nums;
  }
</style>
