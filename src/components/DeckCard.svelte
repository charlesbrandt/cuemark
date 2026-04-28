<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { updateDeck, removeDeck } from "../lib/state/session";
  import { seekDeck, getDeckTime, getVideoEl } from "../lib/renderer/seekBus";
  import type { Deck } from "../lib/state/types";

  let { deck }: { deck: Deck } = $props();
  let isDragOver = $state(false);
  let previewCanvas = $state<HTMLCanvasElement | null>(null);

  $effect(() => {
    if (!previewCanvas || deck.source?.type !== "video") return;
    const canvas = previewCanvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // Keep canvas buffer sized to its actual rendered pixels so it isn't upscaled blurry.
    const dpr = window.devicePixelRatio || 1;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
      }
    });
    ro.observe(canvas);

    let rafId: number;
    function draw() {
      const video = getVideoEl(deck.id);
      if (video && video.readyState >= 2) {
        ctx!.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      rafId = requestAnimationFrame(draw);
    }
    rafId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  });

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
      <canvas
        bind:this={previewCanvas}
        class="deck-preview"
        title={deck.source.filePath.split("/").pop()}
      ></canvas>
      <span class="source-meta">
        <span class="source-label">{deck.source.filePath.split("/").pop()}</span>
        <span class="duration">{formatDuration(deck.source.duration)}</span>
      </span>
    {:else if deck.source?.type === "shader"}
      <div class="preview-placeholder">✦ shader</div>
    {:else}
      <div class="preview-placeholder empty">— no source —</div>
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

  <div class="hot-cues">
    {#each [0, 1, 2, 3] as i}
      {@const t = deck.hotCues[i]}
      {@const isSet = t !== undefined && !isNaN(t)}
      <button
        class="hot-cue-btn"
        class:set={isSet}
        onclick={(e) => {
          if (isSet && !e.shiftKey) {
            seekDeck(deck.id, t);
          } else {
            const now = getDeckTime(deck.id);
            if (now !== null) {
              const cues = [...deck.hotCues];
              cues[i] = now;
              updateDeck(deck.id, { hotCues: cues });
            }
          }
        }}
        oncontextmenu={(e) => {
          e.preventDefault();
          if (isSet) {
            const cues = [...deck.hotCues];
            cues[i] = NaN;
            updateDeck(deck.id, { hotCues: cues });
          }
        }}
        title={isSet ? `Hot cue ${i + 1}: ${formatDuration(t)} — shift+click to move, right-click to clear` : `Set hot cue ${i + 1} at current position`}
        disabled={!deck.source}
      >
        <span class="hc-num">{i + 1}</span>
        {#if isSet}
          <span class="hc-time">{formatDuration(t)}</span>
        {/if}
      </button>
    {/each}
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
        min="0.5"
        max="1.5"
        step="0.01"
        value={deck.playbackRate}
        oninput={(e) => updateDeck(deck.id, { playbackRate: +e.currentTarget.value })}
      />
    </label>
  </div>
</div>

<style>
  .hot-cues {
    display: flex;
    gap: 4px;
    margin: 6px 0 2px;
  }

  .hot-cue-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 4px 2px;
    font-size: 11px;
    background: #222;
    border: 1px solid #444;
    border-radius: 4px;
    color: #888;
    cursor: pointer;
    min-height: 36px;
    line-height: 1.2;
  }

  .hot-cue-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .hot-cue-btn.set {
    background: #1a3a1a;
    border-color: #4caf50;
    color: #4caf50;
  }

  .hot-cue-btn.set:hover {
    background: #1e4d1e;
  }

  .hot-cue-btn:not(.set):not(:disabled):hover {
    border-color: #666;
    color: #ccc;
  }

  .hc-num {
    font-weight: bold;
    font-size: 13px;
  }

  .hc-time {
    font-size: 9px;
    opacity: 0.85;
  }
</style>
