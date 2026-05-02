<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { session, updateDeck, removeDeck, setMasterBpm } from "../lib/state/session";
  import { seekDeck, getDeckTime, getVideoEl } from "../lib/renderer/seekBus";
  import type { Deck } from "../lib/state/types";

  let { deck }: { deck: Deck } = $props();
  let masterBpm = $derived($session.bpm);
  let isDragOver = $state(false);
  let previewCanvas = $state<HTMLCanvasElement | null>(null);
  let currentTime = $state(0);
  let videoDuration = $state(0);

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
        currentTime = video.currentTime;
        if (video.duration && isFinite(video.duration)) videoDuration = video.duration;
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

  {#if deck.source?.type === "video" && videoDuration > 0}
    <div class="time-display">
      <span class="time-elapsed">{formatDuration(currentTime)}</span>
      <span class="time-remaining">-{formatDuration(videoDuration - currentTime)}</span>
    </div>
  {/if}

  <div class="bpm-row">
    <span class="bpm-value">
      {#if deck.bpm !== null}
        {deck.bpm} BPM
      {:else}
        — BPM
      {/if}
    </span>
    <button
      class="bpm-btn"
      class:active={masterBpm !== null && deck.bpm !== null && masterBpm === deck.bpm}
      onclick={() => deck.bpm !== null && setMasterBpm(deck.bpm)}
      disabled={deck.bpm === null}
      title="Set this deck as the master BPM reference"
    >
      Master
    </button>
    <button
      class="bpm-btn"
      onclick={() => {
        if (deck.bpm !== null && masterBpm !== null) {
          updateDeck(deck.id, { playbackRate: masterBpm / deck.bpm });
        }
      }}
      disabled={deck.bpm === null || masterBpm === null}
      title={masterBpm !== null && deck.bpm !== null
        ? `Sync to master: set rate to ${(masterBpm / deck.bpm).toFixed(3)}×`
        : 'Sync requires both deck BPM and master BPM'}
    >
      Sync
    </button>
  </div>

  <div class="loop-row">
    <button
      class="loop-pt-btn"
      onclick={() => {
        const t = getDeckTime(deck.id);
        if (t !== null) {
          updateDeck(deck.id, { loopIn: t });
        }
      }}
      title="Set loop-in point at current position"
      disabled={!deck.source}
    >
      IN{deck.loopIn !== null ? ` ${formatDuration(deck.loopIn)}` : ''}
    </button>
    <button
      class="loop-pt-btn"
      onclick={() => {
        const t = getDeckTime(deck.id);
        if (t !== null) {
          updateDeck(deck.id, { loopOut: t });
        }
      }}
      title="Set loop-out point at current position"
      disabled={!deck.source}
    >
      OUT{deck.loopOut !== null ? ` ${formatDuration(deck.loopOut)}` : ''}
    </button>
    {#each [0.5, 1, 2, 4, 8] as bars}
      {@const barSec = masterBpm !== null ? (bars * 4 * 60) / masterBpm : null}
      <button
        class="bar-btn"
        onclick={() => {
          if (barSec === null) return;
          const inTime = deck.loopIn ?? getDeckTime(deck.id) ?? 0;
          updateDeck(deck.id, { loopIn: inTime, loopOut: inTime + barSec, loop: true });
        }}
        disabled={barSec === null || !deck.source}
        title={barSec !== null
          ? `Loop ${bars === 0.5 ? '½' : bars} bar${bars !== 1 ? 's' : ''} (${barSec.toFixed(2)}s)`
          : 'Set master BPM first'}
      >
        {bars === 0.5 ? '½' : bars}
      </button>
    {/each}
    <button
      class="loop-pt-btn clear-btn"
      onclick={() => updateDeck(deck.id, { loopIn: null, loopOut: null })}
      disabled={deck.loopIn === null && deck.loopOut === null}
      title="Clear loop points"
    >
      ✕
    </button>
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
  .bpm-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 4px;
    font-size: 11px;
  }

  .bpm-value {
    flex: 1;
    color: #aaa;
    font-variant-numeric: tabular-nums;
    min-width: 60px;
  }

  .bpm-btn {
    padding: 2px 6px;
    font-size: 10px;
    background: #1a1a1a;
    border: 1px solid #444;
    border-radius: 3px;
    color: #888;
    cursor: pointer;
  }

  .bpm-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .bpm-btn:not(:disabled):hover {
    border-color: #666;
    color: #ccc;
  }

  .bpm-btn.active {
    border-color: #f5a623;
    color: #f5a623;
  }

  .loop-row {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 3px 4px;
    flex-wrap: wrap;
  }

  .loop-pt-btn {
    padding: 2px 5px;
    font-size: 9px;
    background: #1a1a1a;
    border: 1px solid #444;
    border-radius: 3px;
    color: #888;
    cursor: pointer;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .loop-pt-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .loop-pt-btn:not(:disabled):hover {
    border-color: #666;
    color: #ccc;
  }

  .bar-btn {
    padding: 2px 5px;
    font-size: 10px;
    background: #131a13;
    border: 1px solid #2d4a2d;
    border-radius: 3px;
    color: #5a9a5a;
    cursor: pointer;
    min-width: 22px;
  }

  .bar-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .bar-btn:not(:disabled):hover {
    border-color: #4caf50;
    color: #4caf50;
  }

  .clear-btn {
    margin-left: auto;
    border-color: #5a2020;
    color: #a05050;
  }

  .clear-btn:not(:disabled):hover {
    border-color: #e04040;
    color: #e04040;
  }

  .time-display {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    padding: 2px 4px;
    color: #aaa;
  }

  .time-elapsed {
    color: #ddd;
  }

  .time-remaining {
    color: #888;
  }

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
