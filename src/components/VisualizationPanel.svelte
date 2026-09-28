<script lang="ts">
  import { session, setVisualization, setVisualizationOpacity, setVisualizationEnabled, setVisualizationParams, setVizAudioSource } from "../lib/state/session";
  import { BUILTIN_ISF } from "../lib/renderer/isf/builtins";
  import { diskPlugins, vizErrors, vizWarnings, vizFallback, refreshPluginList, mediaUrl, pluginName, activeInputs, isMilkdropId, DEFAULT_VIZ_ID } from "../lib/viz/vizPlugins";
  import { cycleConfig, CYCLE_OFF, CYCLE_SECONDS, CYCLE_BARS, DEFAULT_BLEND_SECONDS } from "../lib/viz/vizCycle";
  import { fallbackNote } from "../lib/viz/vizHealth";
  import { describeInputs, colorToHex, hexToColor, type SliderAxis } from "../lib/viz/vizParamControls";
  import {
    buildVizPickerItems, groupPickerItems, filterPickerItems, stepSelection, thumbGradient,
    type PickerFilter, type PickerItem,
  } from "../lib/viz/vizPicker";
  import { vizFavorites, toggleVizFavorite } from "../lib/viz/vizFavorites";

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
  let isfPlugins = $derived($diskPlugins.filter((p) => p.format !== "milkdrop"));
  let milkdropPresets = $derived($diskPlugins.filter((p) => p.format === "milkdrop"));
  let milkdropActive = $derived(isMilkdropId(selectedId));
  let cycle = $derived(cycleConfig(params));
  let blendTime = $derived(numParam("blendTime", DEFAULT_BLEND_SECONDS));
  let refreshing = $state(false);
  let selectedError = $derived(
    selectedId ? ($vizErrors[selectedId] ?? $diskPlugins.find((p) => p.id === selectedId)?.error) : null,
  );

  // Layer: on/off distinct from opacity, and distinct from which plugin is selected.
  // `Session.visualizationEnabled` (phase 2, docs/design/viz-panel-and-settings-restyle.md)
  // persists both the pluginId and the opacity while off — toggling no longer nulls
  // `visualization` the way it did in phase 1.
  let live = $derived($session.visualizationEnabled && visualization !== null);
  function toggleLive() {
    if (live) {
      setVisualizationEnabled(false);
    } else {
      if (!visualization) setVisualization({ pluginId: DEFAULT_VIZ_ID, params: {} });
      setVisualizationEnabled(true);
    }
  }
  const quickPcts = [0, 25, 50, 75, 100];
  function setOpacityPct(pct: number) {
    setVisualizationOpacity(pct / 100);
  }

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
    if (pluginId !== null) setVisualizationEnabled(true);
  }

  // Moving between two Milkdrop presets keeps the blend/cycle params; every other transition —
  // into or out of Milkdrop, or any ISF/built-in pick — resets params to {}.
  function selectViz(id: string | null) {
    if (id !== null && isMilkdropId(id) && milkdropActive) {
      setVisualization({ pluginId: id, params: { ...params } });
      setVisualizationEnabled(true);
    } else {
      select(id);
    }
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

  // ── Source picker ─────────────────────────────────────────────────────────────────────────
  let open = $state(false);
  let filter = $state<PickerFilter>("all");
  let query = $state("");
  let pickerEl: HTMLDivElement | undefined = $state();

  let favSet = $derived(new Set($vizFavorites));
  let allItems = $derived(buildVizPickerItems(BUILTIN_ISF, isfPlugins, milkdropPresets, $vizErrors));
  let visibleItems = $derived(filterPickerItems(allItems, filter, favSet, query));
  let groups = $derived(groupPickerItems(visibleItems));
  let selItem = $derived(allItems.find((i) => i.id === selectedId) ?? null);

  const filterChips: [PickerFilter, string][] = [
    ["all", "All"], ["Milkdrop", "Milkdrop"], ["Shaders (ISF)", "Shaders"], ["favorites", "★ Favorites"],
  ];

  function thumbStyle(item: { id: string; thumbnailPath?: string | null } | null): string {
    if (!item) return "background: #282b31;";
    const url = item.thumbnailPath ? thumbs[item.id] : undefined;
    return url
      ? `background-image: url("${url}"); background-size: cover; background-position: center;`
      : `background: ${thumbGradient(item.id)};`;
  }

  function kindLabel(item: PickerItem | null): string {
    if (!item) return "";
    if (item.group === "Milkdrop") return "Milkdrop";
    return item.builtin ? "Shader · built-in" : "Shader";
  }

  function pick(id: string) {
    selectViz(id);
    open = false;
    query = "";
  }
  function step(delta: 1 | -1) {
    const next = stepSelection(visibleItems, selectedId, delta);
    if (next !== null) pick(next);
  }
  function resetParams() {
    if (selectedId) select(selectedId);
  }

  $effect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (pickerEl && !pickerEl.contains(e.target as Node)) open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") open = false;
    };
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKey, true);
    };
  });
</script>

<div class="visualization-panel">
  <div class="viz-header">
    <div class="viz-header-text">
      <span class="settings-title">Visualization</span>
      <span class="source-hint">Global layer over all decks</span>
    </div>
    <button class="viz-btn" onclick={refresh} disabled={refreshing} title="Rescan plugin folder">
      {refreshing ? "…" : "Rescan"}
    </button>
  </div>

  <div class="viz-grid">
    <!-- LAYER: global, never plugin-specific -->
    <div class="viz-col viz-col-layer">
      <div class="viz-col-head">
        <span class="row-label">Layer</span>
        <button class="on-air" class:live onclick={toggleLive} aria-pressed={live}>
          {live ? "ON AIR" : "OFF"}
        </button>
      </div>
      <div class="opacity-readout">
        <span class="opacity-big num">{Math.round($session.visualizationOpacity * 100)}</span>
        <span class="opacity-pct">%</span>
      </div>
      <label for="viz-opacity" class="sr-only">Opacity</label>
      <input
        id="viz-opacity"
        type="range"
        min="0"
        max="100"
        step="1"
        value={Math.round($session.visualizationOpacity * 100)}
        oninput={(e) => setOpacityPct(+e.currentTarget.value)}
        class="opacity-slider"
      />
      <div class="quick-row">
        {#each quickPcts as pct (pct)}
          <button
            class="quick-btn"
            class:active={Math.round($session.visualizationOpacity * 100) === pct}
            onclick={() => setOpacityPct(pct)}
          >{pct}</button>
        {/each}
      </div>
      <span class="source-hint">The same for every visualizer. Also on the toolbar and MIDI.</span>
    </div>

    <!-- SOURCE: one picker for everything -->
    <div class="viz-col viz-col-source" bind:this={pickerEl}>
      <span class="row-label">Source</span>
      <div class="picker-trigger-row">
        <button
          class="picker-trigger"
          class:open
          class:viz-broken={!!selectedError}
          aria-expanded={open}
          aria-haspopup="listbox"
          title={selectedError ?? ""}
          onclick={() => (open = !open)}
        >
          <span class="picker-thumb" style={thumbStyle(selItem)}></span>
          <span class="picker-trigger-text">
            <span class="picker-name">{selItem ? selItem.name : "None — pick a visualization"}</span>
            {#if selItem}<span class="picker-kind">{kindLabel(selItem)}</span>{/if}
          </span>
          <svg class="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>
        </button>
        <button class="viz-icon-btn" onclick={() => step(-1)} aria-label="Previous visualization">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"></path></svg>
        </button>
        <button class="viz-icon-btn" onclick={() => step(1)} aria-label="Next visualization">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"></path></svg>
        </button>
      </div>

      {#if open}
        <div class="picker-popover" role="listbox" aria-label="Visualizations">
          <div class="picker-search-row">
            <label for="viz-search" class="sr-only">Search visualizations</label>
            <input
              id="viz-search"
              type="search"
              placeholder={`Search ${allItems.length} visualizations…`}
              bind:value={query}
              class="picker-search"
            />
          </div>
          <div class="filter-row">
            {#each filterChips as [key, label] (key)}
              <button class="filter-chip" class:active={filter === key} onclick={() => (filter = key)}>{label}</button>
            {/each}
          </div>
          <div class="picker-list">
            {#each groups as g (g.label)}
              <div class="picker-group-label">{g.label}</div>
              {#each g.items as it (it.id)}
                {@const fav = favSet.has(it.id)}
                <div class="picker-row" class:selected={it.id === selectedId}>
                  <button role="option" aria-selected={it.id === selectedId} class="picker-option" onclick={() => pick(it.id)}>
                    <span class="picker-thumb small" style={thumbStyle(it)}></span>
                    <span class="picker-option-name">{it.name}{it.broken ? " ⚠" : ""}</span>
                    {#if it.builtin}<span class="builtin-tag">built-in</span>{/if}
                  </button>
                  <button
                    class="star-btn"
                    class:fav
                    aria-label="Favorite"
                    aria-pressed={fav}
                    onclick={() => toggleVizFavorite(it.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill={fav ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"></path></svg>
                  </button>
                </div>
              {/each}
            {/each}
            {#if !groups.length}
              <div class="hint picker-empty">No matches.</div>
            {/if}
          </div>
        </div>
      {/if}

      {#if !isfPlugins.length}
        <span class="hint" title="~/.local/share/com.cuemark.app/visualizations/">
          No plugins found. Drop ISF (.fs) files in the app's visualizations folder.
        </span>
      {/if}
      {#if !milkdropPresets.length}
        <span class="hint" title="~/.local/share/com.cuemark.app/visualizations/milkdrop/">
          No Milkdrop presets found. Drop converted Butterchurn preset .json files in the milkdrop/ subfolder.
        </span>
      {/if}

      <div class="settings-row reacts-row">
        <label for="viz-audio" class="row-label">Reacts to</label>
        <select
          id="viz-audio"
          class="source-select"
          value={$session.vizAudioSource ?? 'mix'}
          onchange={(e) => setVizAudioSource(e.currentTarget.value)}
        >
          <option value="mix">Mix</option>
          <option value="cue">Cue</option>
          {#each $session.decks as d, i (d.id)}
            <option value={`deck:${d.id}`}>Deck {deckNumber(d.id, i)}</option>
          {/each}
        </select>
      </div>
      <span class="source-hint">Analysis is pre-EQ: a bass kill won't show in the visual.</span>
    </div>

    <!-- SETTINGS: only what belongs to the selected visualizer -->
    <div class="viz-col viz-col-settings">
      <div class="viz-col-head">
        <span class="row-label">{selItem ? `${kindLabel(selItem)} settings` : "Settings"}</span>
        {#if selectedId}<button class="viz-btn viz-btn-small" onclick={resetParams}>Reset</button>{/if}
      </div>

      {#if milkdropActive}
        <div class="settings-row">
          <span class="row-label" title="Cross-fade from the previous preset">Blend</span>
          <input type="range" min="0" max="10" step="0.5" value={blendTime}
            oninput={(e) => setVisualizationParams({ blendTime: +e.currentTarget.value })} />
          <span class="opacity-val">{blendTime.toFixed(1)}s</span>
        </div>
        <div class="settings-row">
          <span class="row-label" title="Screensaver: switch to the next preset on a timer, or every N bars when the dominant deck has a beat grid (falls back to the seconds interval without one)">Cycle</span>
          <select class="source-select" value={cycle.mode}
            onchange={(e) => setVisualizationParams({ cycleMode: +e.currentTarget.value })}>
            <option value={CYCLE_OFF}>Off</option>
            <option value={CYCLE_SECONDS}>Every N seconds</option>
            <option value={CYCLE_BARS}>Every N bars</option>
          </select>
          {#if cycle.mode === CYCLE_BARS}
            <input type="range" min="1" max="64" step="1" value={cycle.bars}
              oninput={(e) => setVisualizationParams({ cycleBars: +e.currentTarget.value })} />
            <span class="opacity-val">{cycle.bars} bars</span>
          {/if}
          {#if cycle.mode !== CYCLE_OFF}
            {#if cycle.mode === CYCLE_BARS}<span class="source-hint">no grid, then</span>{/if}
            <input type="range" min="5" max="300" step="5" value={cycle.seconds}
              oninput={(e) => setVisualizationParams({ cycleSeconds: +e.currentTarget.value })} />
            <span class="opacity-val">{cycle.seconds}s</span>
            <label class="source-hint"><input type="checkbox"
              checked={numParam("cycleShuffle", 0) >= 0.5}
              onchange={(e) => setVisualizationParams({ cycleShuffle: e.currentTarget.checked ? 1 : 0 })} /> shuffle</label>
          {/if}
        </div>
      {/if}

      {#if selectedError}
        <div class="viz-error">{selectedError}</div>
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
    </div>
  </div>
</div>

<style>
  .visualization-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 20px;
    background: var(--surface);
    border-top: 2px solid #7ec8e3;
    border-bottom: 1px solid var(--divider);
    font-size: calc(12px * var(--font-scale));
    color: var(--text);
    flex-shrink: 0;
  }

  .viz-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .viz-header-text {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  .settings-title {
    font-family: var(--font-heading);
    font-weight: 800;
    color: #7ec8e3;
    letter-spacing: 0.08em;
    font-size: calc(10px * var(--font-scale));
    text-transform: uppercase;
  }

  .viz-grid {
    display: flex;
    align-items: flex-start;
    gap: 20px;
    flex-wrap: wrap;
  }

  .viz-col {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .viz-col-layer {
    flex: 0 0 200px;
    padding-right: 20px;
    border-right: 1px solid var(--divider);
  }

  .viz-col-source {
    flex: 1 1 320px;
    min-width: 260px;
    position: relative;
  }

  .viz-col-settings {
    flex: 1 1 260px;
    min-width: 220px;
    padding-left: 20px;
    border-left: 1px solid var(--divider);
  }

  .viz-col-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .settings-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .reacts-row {
    margin-top: 4px;
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

  .viz-btn-small {
    padding: 3px 8px;
    font-size: calc(10px * var(--font-scale));
  }

  .viz-icon-btn {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--surface2);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: color-mix(in srgb, var(--text) 55%, transparent);
    cursor: pointer;
  }

  .viz-icon-btn:hover {
    border-color: #7ec8e3;
    color: #7ec8e3;
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

  /* Layer column */

  .on-air {
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

  .on-air.live {
    border-color: #7ec8e3;
    background: #7ec8e3;
    color: #10222a;
  }

  .opacity-readout {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .opacity-big {
    font-size: calc(32px * var(--font-scale));
    line-height: 1;
    color: var(--text);
  }

  .opacity-pct {
    font-size: calc(13px * var(--font-scale));
    color: color-mix(in srgb, var(--text) 55%, transparent);
  }

  .opacity-slider {
    width: 100%;
    margin: 0;
    accent-color: #7ec8e3;
  }

  .quick-row {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 4px;
  }

  .quick-btn {
    height: 26px;
    border-radius: 5px;
    font-size: calc(11px * var(--font-scale));
    font-weight: 700;
    border: 1px solid var(--divider);
    background: var(--surface2);
    color: color-mix(in srgb, var(--text) 55%, transparent);
    cursor: pointer;
  }

  .quick-btn.active {
    border-color: #7ec8e3;
    background: color-mix(in srgb, #7ec8e3 16%, transparent);
    color: #7ec8e3;
  }

  /* Source picker */

  .picker-trigger-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .picker-trigger {
    flex-grow: 1;
    min-width: 0;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 10px 0 6px;
    border-radius: 6px;
    border: 1px solid var(--divider);
    background: var(--bg, transparent);
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }

  .picker-trigger.open,
  .picker-trigger:hover {
    border-color: #7ec8e3;
  }

  .picker-trigger.viz-broken {
    border-color: #e04040;
  }

  .picker-thumb {
    width: 44px;
    height: 30px;
    border-radius: 4px;
    flex-shrink: 0;
    border: 1px solid var(--divider);
  }

  .picker-thumb.small {
    width: 32px;
    height: 20px;
  }

  .picker-trigger-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex-grow: 1;
  }

  .picker-name {
    font-weight: 700;
    font-size: calc(12px * var(--font-scale));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .picker-kind {
    font-size: calc(10px * var(--font-scale));
    color: color-mix(in srgb, var(--text) 45%, transparent);
  }

  .chevron {
    flex-shrink: 0;
    color: color-mix(in srgb, var(--text) 45%, transparent);
  }

  .picker-popover {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 20;
    background: var(--surface2);
    border: 1px solid color-mix(in srgb, #7ec8e3 50%, transparent);
    border-radius: 8px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .picker-search {
    width: 100%;
    box-sizing: border-box;
    height: 30px;
    background: var(--bg, transparent);
    color: var(--text);
    border: 1px solid var(--divider);
    border-radius: 5px;
    padding: 0 8px;
    font: inherit;
    font-size: calc(12px * var(--font-scale));
  }

  .filter-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .filter-chip {
    height: 26px;
    padding: 0 10px;
    border-radius: 5px;
    font-size: calc(11px * var(--font-scale));
    font-weight: 700;
    border: 1px solid var(--divider);
    background: var(--surface);
    color: color-mix(in srgb, var(--text) 55%, transparent);
    cursor: pointer;
  }

  .filter-chip.active {
    border-color: #7ec8e3;
    background: color-mix(in srgb, #7ec8e3 16%, transparent);
    color: #7ec8e3;
  }

  .picker-list {
    max-height: 280px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .picker-group-label {
    font-size: calc(9px * var(--font-scale));
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--text) 45%, transparent);
    padding: 8px 6px 3px;
  }

  .picker-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 3px 3px 5px;
    border-radius: 5px;
  }

  .picker-row.selected {
    background: color-mix(in srgb, #7ec8e3 16%, transparent);
  }

  .picker-option {
    flex-grow: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: 0;
    color: inherit;
    padding: 4px 2px;
    text-align: left;
    font-size: calc(12px * var(--font-scale));
    font-weight: 600;
    cursor: pointer;
  }

  .picker-option-name {
    flex-grow: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .builtin-tag {
    font-size: calc(9px * var(--font-scale));
    color: color-mix(in srgb, var(--text) 40%, transparent);
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  .star-btn {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: 0;
    color: color-mix(in srgb, var(--text) 40%, transparent);
    cursor: pointer;
  }

  .star-btn.fav {
    color: #ffd23f;
  }

  .picker-empty {
    padding: 6px;
  }

  .sr-only {
    position: absolute;
    left: -9999px;
  }
</style>
