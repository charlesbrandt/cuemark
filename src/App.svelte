<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { session, addDeck, updateDeck } from "./lib/state/session";
  import { startMidiListener } from "./lib/midi/handler";
  import { Compositor } from "./lib/renderer/compositor";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { registerVideoEl, unregisterVideoEl } from "./lib/renderer/seekBus";
  import DeckCard from "./components/DeckCard.svelte";
  import Crossfader from "./components/Crossfader.svelte";
  import type { Deck } from "./lib/state/types";

  let midiUnlisten: (() => void) | undefined;
  let canvas: HTMLCanvasElement;
  let compositor: Compositor | undefined;
  // Hidden <video> elements keyed by deck id; lives outside Svelte reactivity
  const videoEls = new Map<string, HTMLVideoElement>();
  let rafId: number;

  onMount(async () => {
    midiUnlisten = await startMidiListener();
    compositor = new Compositor(canvas);
    rafId = requestAnimationFrame(frame);
  });

  onDestroy(() => {
    midiUnlisten?.();
    cancelAnimationFrame(rafId);
    for (const [id, v] of videoEls) { v.pause(); v.remove(); unregisterVideoEl(id); }
    videoEls.clear();
  });

  // Keep compositor FBOs and video elements in sync with the deck list
  $effect(() => {
    if (!compositor) return;
    const decks = $session.decks;
    compositor.syncDecks(decks.map((d) => d.id));
    syncVideoElements(decks);
  });

  function syncVideoElements(decks: Deck[]) {
    // Remove elements for decks that are gone or no longer have a video source
    for (const [id, v] of videoEls) {
      const deck = decks.find((d) => d.id === id);
      if (!deck || deck.source?.type !== "video") {
        v.pause();
        v.remove();
        unregisterVideoEl(id);
        videoEls.delete(id);
      }
    }

    for (const deck of decks) {
      if (deck.source?.type !== "video") continue;
      const filePath = deck.source.filePath;
      const src = convertFileSrc(filePath);

      let v = videoEls.get(deck.id);
      if (!v) {
        v = document.createElement("video");
        v.style.cssText = "position:fixed;top:-9999px;width:1px;height:1px;pointer-events:none";
        v.crossOrigin = "anonymous";
        document.body.appendChild(v);
        registerVideoEl(deck.id, v);
        videoEls.set(deck.id, v);
      }

      // Update loadedmetadata handler each sync so it captures current filePath
      const deckId = deck.id;
      v.onloadedmetadata = () => {
        const s = get(session).decks.find((d) => d.id === deckId)?.source;
        if (s?.type === "video" && s.filePath === filePath) {
          updateDeck(deckId, { source: { type: "video", filePath, duration: v!.duration } });
        }
      };

      if (v.src !== src) {
        v.src = src;
        v.load();
      }

      v.loop = deck.loop;
      v.volume = deck.volume;
      // playbackRate must be ≥ 0.0625 in most browsers
      v.playbackRate = Math.max(0.0625, deck.playbackRate);

      if (deck.playing && v.paused) {
        v.play().catch(() => {});
      } else if (!deck.playing && !v.paused) {
        v.pause();
      }
    }
  }

  // RAF render loop: upload video frames → composite
  function frame() {
    if (compositor) {
      const { decks } = get(session);
      for (const deck of decks) {
        if (deck.source?.type !== "video") continue;
        const v = videoEls.get(deck.id);
        const fbo = compositor.getFBO(deck.id);
        if (v && fbo) fbo.uploadVideoFrame(v);
      }
      compositor.composite(decks);
    }
    rafId = requestAnimationFrame(frame);
  }
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

  <canvas
    bind:this={canvas}
    width={1920}
    height={1080}
    class="preview-canvas"
  ></canvas>

  <div class="decks" style="--deck-count: {$session.decks.length}">
    {#each $session.decks as deck (deck.id)}
      <DeckCard {deck} />
    {/each}
  </div>

  <Crossfader mapping={$session.crossfaderMapping} decks={$session.decks} />
</div>
