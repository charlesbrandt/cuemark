<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { updateDeck, removeDeck } from "../lib/state/session";
  import { seekDeck, getDeckTime } from "../lib/renderer/seekBus";
  import type { Deck } from "../lib/state/types";

  let { deck }: { deck: Deck } = $props();
  let isDragOver = $state(false);

  async function loadVideo() {
    const file = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "webm", "mkv", "mov", "avi", "ogv"] }],
    });
    if (typeof file === "string") {
      updateDeck(deck.id, { source: { type: "video", filePath: file, duration: 0 }, playing: false });
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    isDragOver = true;
  }

  function handleDragLeave(e: DragEvent) {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      isDragOver = false;
    }
  }

  // File path extraction happens in App.svelte via onDragDropEvent (Tauri intercepts
  // the native drop before HTML5 DataTransfer is populated). This handler just clears
  // the visual state.
  function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragOver = false;
  }

  function formatDuration(s: number): string {
    if (!s) return "--:--";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  }
</script>

<div
  class="deck-card"
  class:playing={deck.playing}
  class:drag-over={isDragOver}
  role="region"
  aria-label={deck.id}
  data-deck-id={deck.id}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  <div class="deck-header">
    <span class="deck-id">{deck.id}</span>
    <button class="remove-btn" onclick={() => removeDeck(deck.id)} aria-label="Remove deck">
      ×
    </button>
  </div>

  <div class="preview">
    {#if deck.source?.type === "video"}
      <span class="source-label">{deck.source.filePath.split("/").pop()}</span>
      <span class="duration">{formatDuration(deck.source.duration)}</span>
    {:else if deck.source?.type === "shader"}
      <span class="source-label">✦ shader</span>
    {:else}
      <span class="source-label empty">— no source —</span>
    {/if}
    <button class="load-btn" onclick={loadVideo}>Load Video</button>
  </div>

  <div class="transport">
    <button
      class="play-btn"
      onclick={() => updateDeck(deck.id, { playing: !deck.playing })}
      disabled={!deck.source}
    >
      {deck.playing ? "⏸" : "▶"}
    </button>
    <button
      class:active={deck.loop}
      onclick={() => updateDeck(deck.id, { loop: !deck.loop })}
      title="Toggle loop"
    >
      ⟲
    </button>
    {#if deck.source?.type === "video"}
      <button
        onclick={() => { seekDeck(deck.id, deck.cuePoint); updateDeck(deck.id, { playing: false }); }}
        title="Return to cue ({formatDuration(deck.cuePoint)})"
      >
        ⏮
      </button>
      <button
        onclick={() => { const t = getDeckTime(deck.id); if (t !== null) updateDeck(deck.id, { cuePoint: t }); }}
        title="Set cue point at current position"
      >
        Cue
      </button>
    {/if}
  </div>

  <div class="sliders">
    <label>
      <span>Opacity <strong>{deck.opacity.toFixed(2)}</strong></span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={deck.opacity}
        oninput={(e) => updateDeck(deck.id, { opacity: +e.currentTarget.value })}
      />
    </label>
    <label>
      <span>Volume <strong>{deck.volume.toFixed(2)}</strong></span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={deck.volume}
        oninput={(e) => updateDeck(deck.id, { volume: +e.currentTarget.value })}
      />
    </label>
    <label>
      <span>Rate <strong>{deck.playbackRate.toFixed(2)}×</strong></span>
      <input
        type="range"
        min="0.25"
        max="4"
        step="0.01"
        value={deck.playbackRate}
        oninput={(e) => updateDeck(deck.id, { playbackRate: +e.currentTarget.value })}
      />
    </label>
  </div>
</div>
