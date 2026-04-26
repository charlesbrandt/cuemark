<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { session, addDeck } from "./lib/state/session";
  import { startMidiListener } from "./lib/midi/handler";
  import DeckCard from "./components/DeckCard.svelte";
  import Crossfader from "./components/Crossfader.svelte";

  let midiUnlisten: (() => void) | undefined;

  onMount(async () => {
    midiUnlisten = await startMidiListener();
  });

  onDestroy(() => {
    midiUnlisten?.();
  });
</script>

<div class="app">
  <header class="toolbar">
    <span class="logo">CUEMARK</span>
    <button class="add-deck" onclick={addDeck}>+ Deck</button>
    <span class="bpm">{$session.bpm ? `${$session.bpm} BPM` : "—"}</span>
    <label class="master-vol">
      Master
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={$session.masterVolume}
        oninput={(e) =>
          session.update((s) => ({ ...s, masterVolume: +e.currentTarget.value }))}
      />
      <span>{$session.masterVolume.toFixed(2)}</span>
    </label>
  </header>

  <div class="decks" style="--deck-count: {$session.decks.length}">
    {#each $session.decks as deck (deck.id)}
      <DeckCard {deck} />
    {/each}
  </div>

  <Crossfader mapping={$session.crossfaderMapping} decks={$session.decks} />
</div>
