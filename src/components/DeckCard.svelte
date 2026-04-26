<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { updateDeck, removeDeck } from "../lib/state/session";
  import type { Deck } from "../lib/state/types";

  let { deck }: { deck: Deck } = $props();

  async function loadVideo() {
    const file = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "webm", "mkv", "mov", "avi", "ogv"] }],
    });
    if (typeof file === "string") {
      updateDeck(deck.id, { source: { type: "video", filePath: file, duration: 0 }, playing: false });
    }
  }

  function formatDuration(s: number): string {
    if (!s) return "--:--";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  }
</script>

<div class="deck-card" class:playing={deck.playing}>
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
        onclick={() => updateDeck(deck.id, { cuePoint: 0, playing: false })}
        title="Return to cue"
      >
        ⏮
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
