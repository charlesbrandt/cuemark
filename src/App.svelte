<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { session, addDeck, updateDeck } from "./lib/state/session";
  import { startMidiListener } from "./lib/midi/handler";
  import { Compositor } from "./lib/renderer/compositor";
  import { AudioAnalyzer } from "./lib/audio/analyzer";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { registerVideoEl, unregisterVideoEl } from "./lib/renderer/seekBus";
  import { postFrame } from "./lib/renderer/outputBus";
  import DeckCard from "./components/DeckCard.svelte";
  import Crossfader from "./components/Crossfader.svelte";
  import type { Deck } from "./lib/state/types";

  function openOutputWindow() {
    invoke('open_output_window').catch(console.error);
  }

  let midiUnlisten: (() => void) | undefined;
  let dragDropUnlisten: (() => void) | undefined;
  let canvas: HTMLCanvasElement;
  let compositor = $state<Compositor | undefined>(undefined);
  // Hidden <video> elements keyed by deck id; lives outside Svelte reactivity
  const videoEls = new Map<string, HTMLVideoElement>();
  // Per-deck Web Audio gain nodes; created when a video element is connected
  const deckGains = new Map<string, GainNode>();
  let analyzer: AudioAnalyzer;
  let rafId: number;

  // Sync master volume to the audio graph whenever it changes
  $effect(() => {
    analyzer?.setMasterVolume($session.masterVolume);
  });

  onMount(async () => {
    analyzer = new AudioAnalyzer();
    midiUnlisten = await startMidiListener();
    compositor = new Compositor(canvas);
    rafId = requestAnimationFrame(frame);

    // Tauri intercepts OS file-drop before it reaches the DOM, so DataTransfer is
    // empty in the HTML5 drop event. Use the Tauri webview API for actual paths.
    dragDropUnlisten = await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return;
      const { paths, position } = event.payload;
      if (!paths.length) return;
      const el = document.elementFromPoint(position.x, position.y);
      const card = el?.closest<HTMLElement>('[data-deck-id]');
      if (card?.dataset.deckId) {
        updateDeck(card.dataset.deckId, {
          source: { type: 'video', filePath: paths[0], duration: 0 },
          playing: false,
        });
      }
    });
  });

  onDestroy(() => {
    midiUnlisten?.();
    dragDropUnlisten?.();
    cancelAnimationFrame(rafId);
    for (const [id, v] of videoEls) { v.pause(); v.remove(); unregisterVideoEl(id); }
    videoEls.clear();
    for (const g of deckGains.values()) g.disconnect();
    deckGains.clear();
  });

  // Keep compositor FBOs and video elements in sync with the deck list
  $effect(() => {
    const decks = $session.decks; // read before early-return so Svelte always tracks it
    console.log('[effect] running, compositor ready:', !!compositor);
    if (!compositor) return;
    compositor.syncDecks(decks.map((d) => d.id));
    syncVideoElements(decks);
  });

  function syncVideoElements(decks: Deck[]) {
    console.log('[syncVideoElements]', decks.map(d => `${d.id}=${d.source?.type ?? 'null'}`));
    // Remove elements for decks that are gone or no longer have a video source
    for (const [id, v] of videoEls) {
      const deck = decks.find((d) => d.id === id);
      if (!deck || deck.source?.type !== "video") {
        v.pause();
        v.remove();
        unregisterVideoEl(id);
        videoEls.delete(id);
        deckGains.get(id)?.disconnect();
        deckGains.delete(id);
      }
    }

    for (const deck of decks) {
      if (deck.source?.type !== "video") continue;
      const filePath = deck.source.filePath;
      // Dev: serve via Vite HTTP middleware so GStreamer's souphttpsrc can reach it.
      // Prod: use the Rust media:// custom scheme (bundled app, no Vite server).
      const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
      const src = import.meta.env.DEV
        ? '/media' + encodedPath
        : 'media://localhost' + encodedPath;

      let v = videoEls.get(deck.id);
      if (!v) {
        console.log(`[${deck.id}] creating video element`);
        v = document.createElement("video");
        v.style.cssText = "position:fixed;top:-9999px;width:1px;height:1px;pointer-events:none";
        // no crossOrigin needed: /media/... is same-origin in dev
        document.body.appendChild(v);
        registerVideoEl(deck.id, v);
        videoEls.set(deck.id, v);
        // Connect to Web Audio; gain node drives per-deck volume from here on
        const gain = analyzer.connectMediaElement(v);
        deckGains.set(deck.id, gain);
        v.volume = 1.0; // element volume fixed at unity; GainNode handles level
      }

      // Update event handlers each sync so they capture the current filePath / deckId
      const deckId = deck.id;
      v.onloadedmetadata = () => {
        console.log(`[${deckId}] loadedmetadata fired, duration:`, v!.duration);
        const s = get(session).decks.find((d) => d.id === deckId)?.source;
        if (s?.type === "video" && s.filePath === filePath) {
          updateDeck(deckId, { source: { type: "video", filePath, duration: v!.duration } });
        }
      };
      // Retry play if the user clicked play before the video had loaded enough data
      v.oncanplay = () => {
        console.log(`[${deckId}] canplay fired`);
        const d = get(session).decks.find((d) => d.id === deckId);
        if (d?.playing && v!.paused) v!.play().catch(console.error);
      };
      v.onerror = () => console.error(`[${deckId}] video error: code=${v!.error?.code} message=${v!.error?.message} src=${v!.src}`);
      v.onstalled = () => console.warn(`[${deckId}] stalled (networkState=${v!.networkState})`);

      if (v.getAttribute('src') !== src) {
        console.log(`[${deck.id}] setting src:`, src);
        v.src = src;
        v.load();
        // Report state after a short delay so we can see if the network request started
        setTimeout(() => {
          console.log(`[${deck.id}] state@500ms: readyState=${v!.readyState} networkState=${v!.networkState} error=${v!.error?.code ?? 'none'} src=${v!.src}`);
        }, 500);
      }

      v.loop = deck.loop;
      const g = deckGains.get(deck.id);
      if (g) g.gain.value = deck.volume;
      // playbackRate must be ≥ 0.0625 in most browsers
      v.playbackRate = Math.max(0.0625, deck.playbackRate);

      if (deck.playing && v.paused) {
        analyzer.resume();
        v.play().catch(console.error);
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
      postFrame(canvas);
    }
    rafId = requestAnimationFrame(frame);
  }
</script>

<div class="app">
  <header class="toolbar">
    <span class="logo">CUEMARK</span>
    <button class="add-deck" onclick={addDeck}>+ Deck</button>
    <button class="output-btn" onclick={openOutputWindow}>Output Window</button>
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

  <Crossfader
    mapping={$session.crossfaderMapping}
    decks={$session.decks}
    crossfaderValue={$session.crossfaderValue}
    crossfaderTargets={$session.crossfaderTargets}
  />
</div>
