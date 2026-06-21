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
    gap: 6px;
    padding: 8px 16px;
    background: #161616;
    border-top: 2px solid #7ec8e3;
    border-bottom: 1px solid #2a2a2a;
    font-size: 11px;
    color: #999;
    flex-shrink: 0;
  }

  .settings-title {
    color: #7ec8e3;
    letter-spacing: 0.08em;
    font-size: 10px;
    text-transform: uppercase;
  }

  .settings-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .row-label {
    color: #888;
    flex-shrink: 0;
    min-width: 50px;
  }

  .viz-btn {
    padding: 3px 8px;
    font-size: 11px;
    background: #1a1a1a;
    border: 1px solid #444;
    border-radius: 3px;
    color: #888;
    cursor: pointer;
  }

  .viz-btn:hover {
    border-color: #666;
    color: #ccc;
  }

  .viz-btn.viz-active {
    border-color: #7ec8e3;
    color: #7ec8e3;
  }

  .opacity-val {
    min-width: 30px;
    color: #777;
    font-variant-numeric: tabular-nums;
  }
</style>
