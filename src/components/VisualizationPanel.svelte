<script lang="ts">
  import { session, setVisualization, setVisualizationOpacity, setVisualizationParams, setVizAudioSource } from "../lib/state/session";
  import { BUILTIN_ISF } from "../lib/renderer/isf/builtins";
  import { diskPlugins, vizErrors, vizWarnings, vizFallback, refreshPluginList, mediaUrl, pluginName, activeInputs } from "../lib/viz/vizPlugins";
  import { fallbackNote } from "../lib/viz/vizHealth";
  import { describeInputs, colorToHex, hexToColor, type SliderAxis } from "../lib/viz/vizParamControls";

  let controls = $derived(describeInputs($activeInputs));
  let params = $derived($session.visualization?.params ?? {});

  const numParam = (name: string, def: number): number => {
    const v = params[name];
    return typeof v === "number" ? v : def;
  };
  const pairParam = (name: string, axes: [SliderAxis, SliderAxis]): number[] => {
    const v = params[name];
    return Array.isArray(v) && v.length >= 2 ? v : [axes[0].default, axes[1].default];
  };
  const colorParam = (name: string, def: number[]): number[] => {
    const v = params[name];
    return Array.isArray(v) && v.length >= 3 ? v : def;
  };
  function fire(name: string) {
    setVisualizationParams({ [name]: true });
    setTimeout(() => setVisualizationParams({ [name]: false }), 100);
  }

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

  // Matches the app's `deck-<n>` ids; falls back to list position for any other id.
  function deckNumber(id: string, index: number): number {
    const m = id.match(/^deck-(\d+)$/);
    return m ? parseInt(m[1], 10) : index + 1;
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

  {#if selectedId && $vizFallback && $vizFallback.requestedId === selectedId}
    <div class="viz-warning">{fallbackNote($vizFallback, pluginName)}</div>
  {/if}
  {#if selectedId && $vizWarnings[selectedId]}
    <div class="viz-warning">Warning: {selectedId} {$vizWarnings[selectedId]}</div>
  {/if}

  {#if selectedId}
    {#each controls as c (c.name)}
      <div class="settings-row">
        <span class="row-label" title={c.name}>{c.label}</span>
        {#if c.kind === "slider"}
          {@const v = numParam(c.name, c.axis.default)}
          <input type="range" min={c.axis.min} max={c.axis.max} step={c.axis.step} value={v}
            oninput={(e) => setVisualizationParams({ [c.name]: +e.currentTarget.value })} />
          <span class="opacity-val">{v.toFixed(2)}</span>
        {:else if c.kind === "point2d"}
          {@const pv = pairParam(c.name, c.axes)}
          {#each [0, 1] as i}
            <input type="range" min={c.axes[i].min} max={c.axes[i].max} step={c.axes[i].step} value={pv[i]}
              oninput={(e) => {
                const next = [...pv];
                next[i] = +e.currentTarget.value;
                setVisualizationParams({ [c.name]: next });
              }} />
            <span class="opacity-val">{pv[i].toFixed(2)}</span>
          {/each}
        {:else if c.kind === "toggle"}
          <input type="checkbox"
            checked={typeof params[c.name] === "boolean" ? (params[c.name] as boolean) : c.default}
            onchange={(e) => setVisualizationParams({ [c.name]: e.currentTarget.checked })} />
        {:else if c.kind === "select"}
          <select value={numParam(c.name, c.default)}
            onchange={(e) => setVisualizationParams({ [c.name]: +e.currentTarget.value })}>
            {#each c.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
          </select>
        {:else if c.kind === "color"}
          {@const col = colorParam(c.name, c.default)}
          <input type="color" value={colorToHex(col)}
            oninput={(e) => setVisualizationParams({ [c.name]: hexToColor(e.currentTarget.value, col) })} />
        {:else if c.kind === "button"}
          <button class="viz-btn" onclick={() => fire(c.name)}>Trigger</button>
        {/if}
      </div>
    {/each}
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

  <div class="settings-row">
    <span class="row-label">Audio</span>
    <select
      class="source-select"
      value={$session.vizAudioSource ?? 'mix'}
      title="Analysis is pre-EQ: a bass kill won't show in the visual."
      onchange={(e) => setVizAudioSource(e.currentTarget.value)}
    >
      <option value="mix">Mix</option>
      <option value="cue">Cue</option>
      {#each $session.decks as d, i (d.id)}
        <option value={`deck:${d.id}`}>Deck {deckNumber(d.id, i)}</option>
      {/each}
    </select>
    <span class="source-hint">Analysis is pre-EQ: a bass kill won't show in the visual.</span>
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

  .viz-warning {
    color: #e0a040;
    font-size: calc(11px * var(--font-scale));
  }

  .opacity-val {
    min-width: 32px;
    color: color-mix(in srgb, var(--text) 55%, transparent);
    font-variant-numeric: tabular-nums;
  }

  .source-select {
    background: var(--bg, transparent);
    color: var(--text);
    border: 1px solid var(--divider);
    border-radius: 4px;
    padding: 2px 6px;
    font: inherit;
  }

  .source-hint {
    color: color-mix(in srgb, var(--text) 45%, transparent);
    font-size: calc(10px * var(--font-scale));
  }
</style>
