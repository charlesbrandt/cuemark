<script lang="ts">
  import { setCrossfader, setCrossfaderTargets, setCrossfaderMapping } from "../lib/state/session";
  import type { Deck, CrossfaderTarget } from "../lib/state/types";

  let {
    mapping,
    decks,
    crossfaderValue,
    crossfaderTargets,
  }: {
    mapping: { left: string; right: string };
    decks: Deck[];
    crossfaderValue: number;
    crossfaderTargets: CrossfaderTarget[];
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
  <label class="cf-target">
    <input
      type="checkbox"
      checked={crossfaderTargets.includes("volume")}
      onchange={() => toggleTarget("volume")}
    /> Audio
  </label>
</div>

<style>
  .cf-select {
    background: #222;
    color: #ccc;
    border: 1px solid #444;
    border-radius: 3px;
    padding: 2px 4px;
    font-size: 0.8rem;
  }
</style>
