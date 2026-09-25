<script lang="ts">
  import { session, setVisualization, setVisualizationOpacity } from "../lib/state/session";
  import { BUILTIN_ISF } from "../lib/renderer/isf/builtins";
  import { diskPlugins, vizErrors, refreshPluginList, mediaUrl } from "../lib/viz/vizPlugins";

  let visualization = $derived($session.visualization);
  let selectedId = $derived(visualization?.pluginId ?? null);
  let refreshing = $state(false);

  // Thumbnail URLs resolve asynchronously (the media server port is fetched once).
  let thumbs = $state<Record<string, string>>({});
  $effect(() => {
    for (const p of $diskPlugins) {
      if (p.thumbnailPath && !thumbs[p.id]) {
        const id = p.id;
        mediaUrl(p.thumbnailPath).then((u) => { thumbs = { ...thumbs, [id]: u }; });
      }
    }
  });

  function select(pluginId: string | null) {
    setVisualization(pluginId === null ? null : { pluginId, params: {} });
  }

  async function refresh() {
    refreshing = true;
    try { await refreshPluginList(); } finally { refreshing = false; }
  }
</script>

<div class="visualization-panel">
  <span class="settings-title">Visualization</span>

  <div class="settings-row">
    <button
      class="viz-btn"
      class:viz-active={selectedId === null}
      onclick={() => select(null)}
    >None</button>
    {#each BUILTIN_ISF as p (p.id)}
      <button
        class="viz-btn"
        class:viz-active={selectedId === p.id}
        class:viz-broken={!!$vizErrors[p.id]}
        title={$vizErrors[p.id] ?? ""}
        onclick={() => select(p.id)}
      >{p.name}{#if $vizErrors[p.id]} ⚠{/if}</button>
    {/each}
  </div>

  <div class="settings-row">
    <span class="row-label">Plugins</span>
    {#each $diskPlugins as p (p.id)}
      {@const err = $vizErrors[p.id] ?? p.error}
      <button
        class="viz-btn"
        class:viz-active={selectedId === p.id}
        class:viz-broken={!!err}
        title={err ?? [p.description, p.credit].filter(Boolean).join(" — ")}
        onclick={() => select(p.id)}
      >
        {#if thumbs[p.id]}<img class="viz-thumb" src={thumbs[p.id]} alt="" />{/if}
        {p.name}{#if err} ⚠{/if}
      </button>
    {:else}
      <span class="hint" title="~/.local/share/com.cuemark.app/visualizations/">
        None found. Drop ISF (.fs) files in the app's visualizations folder.
      </span>
    {/each}
    <button class="viz-btn" onclick={refresh} disabled={refreshing}>
      {refreshing ? "…" : "Rescan"}
    </button>
  </div>

  {#if selectedId && ($vizErrors[selectedId] ?? $diskPlugins.find((p) => p.id === selectedId)?.error)}
    <div class="viz-error">{$vizErrors[selectedId] ?? $diskPlugins.find((p) => p.id === selectedId)?.error}</div>
  {/if}

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
    font-size: calc(12px * var(--font-scale));
    color: var(--text);
    flex-shrink: 0;
  }

  .settings-title {
    font-family: var(--font-heading);
    font-weight: 800;
    color: #7ec8e3;
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
    min-width: 50px;
  }

  .viz-btn {
    font-family: var(--font-heading);
    font-weight: 600;
    padding: 5px 10px;
    font-size: calc(11px * var(--font-scale));
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

  .viz-btn.viz-broken {
    border-color: #e04040;
  }

  .viz-thumb {
    width: 24px;
    height: 14px;
    object-fit: cover;
    vertical-align: middle;
    margin-right: 4px;
    border-radius: 2px;
  }

  .hint {
    color: color-mix(in srgb, var(--text) 45%, transparent);
  }

  .viz-error {
    color: #e04040;
    font-family: monospace;
    font-size: calc(11px * var(--font-scale));
    white-space: pre-wrap;
    max-height: 6em;
    overflow: auto;
  }

  .opacity-val {
    min-width: 32px;
    color: color-mix(in srgb, var(--text) 55%, transparent);
    font-variant-numeric: tabular-nums;
  }
</style>
