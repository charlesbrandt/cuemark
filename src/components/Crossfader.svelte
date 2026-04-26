<script lang="ts">
  import { setCrossfader } from "../lib/state/session";
  import type { Deck } from "../lib/state/types";

  let {
    mapping,
    decks,
  }: {
    mapping: { left: string; right: string };
    decks: Deck[];
  } = $props();

  const leftDeck = $derived(decks.find((d) => d.id === mapping.left));
  const rightDeck = $derived(decks.find((d) => d.id === mapping.right));
  // Crossfader position: 0 = full left, 1 = full right.
  // Derived from the right deck's opacity so hardware and UI stay in sync.
  const position = $derived(rightDeck?.opacity ?? 0.5);
</script>

<div class="crossfader-bar">
  <span class="cf-label left">{leftDeck?.id ?? "—"}</span>
  <input
    class="crossfader"
    type="range"
    min="0"
    max="1"
    step="0.001"
    value={position}
    oninput={(e) => setCrossfader(+e.currentTarget.value)}
  />
  <span class="cf-label right">{rightDeck?.id ?? "—"}</span>
</div>
