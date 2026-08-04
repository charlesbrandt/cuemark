<script lang="ts">
  import {
    setCrossfader,
    setCrossfaderTargets,
    setCrossfaderMapping,
    setCrossfaderAudioCurve,
    setCrossfaderVisualCurve,
  } from "../lib/state/session";
  import type { Deck, CrossfaderTarget, CrossfaderCurve } from "../lib/state/types";

  let {
    mapping,
    decks,
    crossfaderValue,
    crossfaderTargets,
    audioCurve,
    visualCurve,
  }: {
    mapping: { left: string; right: string };
    decks: Deck[];
    crossfaderValue: number;
    crossfaderTargets: CrossfaderTarget[];
    audioCurve: CrossfaderCurve;
    visualCurve: CrossfaderCurve;
  } = $props();

  function toggleTarget(target: CrossfaderTarget) {
    if (crossfaderTargets.includes(target)) {
      setCrossfaderTargets(crossfaderTargets.filter((t) => t !== target));
    } else {
      setCrossfaderTargets([...crossfaderTargets, target]);
    }
  }
</script>

<div class="crossfader-bar">
  <select
    class="cf-select"
    value={mapping.left}
    onchange={(e) => setCrossfaderMapping(e.currentTarget.value, mapping.right)}
  >
    {#each decks as deck (deck.id)}
      <option value={deck.id}>{deck.id}</option>
    {/each}
  </select>
  <input
    class="crossfader"
    type="range"
    min="0"
    max="1"
    step="0.001"
    value={crossfaderValue}
    oninput={(e) => setCrossfader(+e.currentTarget.value)}
  />
  <select
    class="cf-select"
    value={mapping.right}
    onchange={(e) => setCrossfaderMapping(mapping.left, e.currentTarget.value)}
  >
    {#each decks as deck (deck.id)}
      <option value={deck.id}>{deck.id}</option>
    {/each}
  </select>

  <label class="cf-target">
    <input
      type="checkbox"
      checked={crossfaderTargets.includes("opacity")}
      onchange={() => toggleTarget("opacity")}
    /> Visual
  </label>
  <select
    class="cf-select"
    value={visualCurve}
    onchange={(e) => setCrossfaderVisualCurve(e.currentTarget.value as CrossfaderCurve)}
  >
    <option value="linear">Linear</option>
    <option value="equal-power">Equal Power</option>
    <option value="cut">Cut</option>
  </select>

  <label class="cf-target">
    <input
      type="checkbox"
      checked={crossfaderTargets.includes("volume")}
      onchange={() => toggleTarget("volume")}
    /> Audio
  </label>
  <select
    class="cf-select"
    value={audioCurve}
    onchange={(e) => setCrossfaderAudioCurve(e.currentTarget.value as CrossfaderCurve)}
  >
    <option value="linear">Linear</option>
    <option value="equal-power">Equal Power</option>
    <option value="cut">Cut</option>
  </select>
</div>

<style>
  .cf-select {
    font-family: var(--font-body);
    background-color: var(--surface2);
    color: var(--text);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    padding: 6px 24px 6px 8px;
    font-size: 12px;
    font-weight: 700;
  }
  .cf-select:focus { outline: none; border-color: var(--accent); }

  .cf-target {
    display: flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 11px;
    color: var(--text);
    white-space: nowrap;
  }
  .cf-target input[type="checkbox"] { accent-color: var(--accent); cursor: pointer; }
</style>
