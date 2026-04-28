<script lang="ts">
  import { setCrossfader, setCrossfaderTargets } from "../lib/state/session";
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

  const leftDeck = $derived(decks.find((d) => d.id === mapping.left));
  const rightDeck = $derived(decks.find((d) => d.id === mapping.right));

  function toggleTarget(target: CrossfaderTarget) {
    if (crossfaderTargets.includes(target)) {
      setCrossfaderTargets(crossfaderTargets.filter((t) => t !== target));
    } else {
      setCrossfaderTargets([...crossfaderTargets, target]);
    }
  }
</script>

<div class="crossfader-bar">
  <span class="cf-label left">{leftDeck?.id ?? "—"}</span>
  <input
    class="crossfader"
    type="range"
    min="0"
    max="1"
    step="0.001"
    value={crossfaderValue}
    oninput={(e) => setCrossfader(+e.currentTarget.value)}
  />
  <span class="cf-label right">{rightDeck?.id ?? "—"}</span>
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
