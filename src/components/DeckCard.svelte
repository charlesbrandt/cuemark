<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { session, updateDeck, removeDeck, setMasterBpm } from "../lib/state/session";
  import { seekDeck, getDeckTime, getPhase, getVideoEl, getCodecPlayer, quantizeToGrid } from "../lib/renderer/seekBus";
  import { nudgePhaseToMaster } from "../lib/audio/phaseNudge";
  import { tempoRange } from "../lib/audio/audioSettings";
  import { gridSave } from "../lib/audio/pipeline";
  import { pushMarker, setTrackBpm } from "../lib/digger/api";
  import { markGridSaved } from "../lib/audio/gridSource";
  import { videoPathOverrides, videoPathDefault, setVideoPathOverride, resolveVideoPath } from "../lib/video/videoPathSettings";
  import type { Deck } from "../lib/state/types";

  let { deck }: { deck: Deck } = $props();
  let masterBpm = $derived($session.bpm);
  let resolvedVideoPath = $derived(resolveVideoPath(deck.id, $videoPathOverrides, $videoPathDefault));
  let isDragOver = $state(false);
  let previewCanvas = $state<HTMLCanvasElement | null>(null);
  let currentTime = $state(0);
  let videoDuration = $state(0);
  let phase = $state<number | null>(null);

  $effect(() => {
    if (!previewCanvas || deck.source?.type !== "video") return;
    const canvas = previewCanvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // Keep canvas buffer sized to its actual rendered pixels so it isn't upscaled blurry.
    // deck-preview has width:100% + aspect-ratio:16/9 in global CSS; observe the canvas
    // itself and use entry.contentRect (the CSS-laid-out size) rather than a sync
    // getBoundingClientRect() call, which would fire before aspect-ratio resolves.
    const dpr = window.devicePixelRatio || 1;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          canvas.width = Math.round(width * dpr);
          canvas.height = Math.round(height * dpr);
          canvas.style.width = width + 'px';
          canvas.style.height = height + 'px';
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
        }
      }
    });
    ro.observe(canvas);

    // drawImage here is full-resolution and runs alongside the main compositor's own
    // texture upload — skip it while paused and the frame hasn't moved (idle CPU sink
    // otherwise). lastDrawnTime still catches a seek made while paused.
    let lastDrawnTime = -1;
    let lastDrawnPts = -1;
    let rafId: number;
    function draw() {
      const video = getVideoEl(deck.id);
      const codec = getCodecPlayer(deck.id);
      if (video && video.readyState >= 2) {
        if (video.currentTime !== lastDrawnTime) {
          lastDrawnTime = video.currentTime;
          // Audio-only files (e.g. .mp3) loaded into a 'video' deck have videoWidth/Height
          // of 0 — no video track. WebKitGTK throws SecurityError from drawImage() in this
          // case (rather than silently no-op'ing like Chrome), which would otherwise abort
          // this rAF loop permanently on the next throw. Skip the draw and guard the call.
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            try {
              ctx!.drawImage(video, 0, 0, canvas.width, canvas.height);
            } catch (e) {
              console.error(`[${deck.id}] preview drawImage failed:`, e);
            }
          }
        }
        currentTime = video.currentTime;
        if (video.duration && isFinite(video.duration)) videoDuration = video.duration;
      } else if (codec) {
        // Codec-path deck: no <video> element to read from — pick the current frame from
        // the same audio clock the compositor's FBO upload uses, and drawImage() it (2D
        // canvas accepts a VideoFrame directly, no scratch-canvas detour needed here).
        const t = getDeckTime(deck.id);
        if (t !== null) {
          currentTime = t;
          const frame = codec.getFrameForTime(t);
          if (frame && frame.timestamp !== lastDrawnPts) {
            lastDrawnPts = frame.timestamp;
            try {
              ctx!.drawImage(frame, 0, 0, canvas.width, canvas.height);
            } catch (e) {
              console.error(`[${deck.id}] preview drawImage (codec) failed:`, e);
            }
          }
        }
        if (deck.source?.type === "video" && deck.source.duration) videoDuration = deck.source.duration;
      }
      phase = getPhase(deck.id);
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
      // diggerTrackId/diggerFileId must be cleared here — neither is reset elsewhere, so
      // loading a local file over a deck that previously held a Digger track would
      // otherwise leave marker pushes (SET BEAT, cue, hot cues) silently writing to the
      // old track, and the old fileId as a stale remote-fetch fallback for this new path.
      updateDeck(deck.id, { source: { type: "video", filePath: file, duration: 0 }, playing: false, diggerTrackId: null, diggerFileId: null });
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
    <span class="deck-header-left">
      <span class="deck-id">{deck.id}</span>
      {#if deck.source?.type === "video"}
        <button
          class="video-path-btn"
          class:webcodecs={resolvedVideoPath === "webcodecs"}
          onclick={() => setVideoPathOverride(deck.id, resolvedVideoPath === "webcodecs" ? "legacy" : "webcodecs")}
          title="Video decode path for this deck — click to switch. Falls back to legacy automatically if the file isn't H.264 (docs/design/webcodecs-video-path.md)."
        >
          {resolvedVideoPath === "webcodecs" ? "CODEC" : "LEGACY"}
        </button>
      {/if}
    </span>
    <button class="remove-btn" onclick={() => removeDeck(deck.id)} aria-label="Remove deck">
      ×
    </button>
  </div>

  <div class="gain-row" title="Pre-fader trim — boost quiet tracks above 1.0 (max 4.0 ≈ +12 dB)">
    <span>Gain</span>
    <input
      type="range"
      min="0"
      max="4"
      step="0.01"
      value={deck.gain}
      oninput={(e) => updateDeck(deck.id, { gain: +e.currentTarget.value })}
    />
    <strong>{deck.gain.toFixed(2)}</strong>
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
    {:else}
      <div class="preview-placeholder empty">— no source —</div>
    {/if}
    <div class="source-btns">
      <button class="load-btn" onclick={loadVideo}>Video</button>
    </div>
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
    <button
      class:active={deck.cueEnabled}
      onclick={() => updateDeck(deck.id, { cueEnabled: !deck.cueEnabled })}
      title="Send to headphones"
    >
      🎧
    </button>
    {#if deck.source?.type === "video"}
      <button
        onclick={() => { seekDeck(deck.id, deck.cuePoint); updateDeck(deck.id, { playing: false }); }}
        title="Return to cue ({formatDuration(deck.cuePoint)})"
      >
        ⏮
      </button>
      <button
        onclick={() => {
          const t = getDeckTime(deck.id);
          if (t === null) return;
          updateDeck(deck.id, { cuePoint: t });
          if (deck.diggerTrackId !== null) {
            pushMarker(deck.diggerTrackId, Math.round(t * 1000), 'cue').catch(console.error);
          }
        }}
        title="Set cue point at current position"
      >
        SET
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
        {deck.bpm.toFixed(1)} <span class="bpm-effective" title="Current BPM at {deck.playbackRate.toFixed(2)}× rate">→ {(deck.bpm * deck.playbackRate).toFixed(1)}</span> BPM
      {:else}
        — BPM
      {/if}
    </span>
    <button
      class="bpm-btn"
      class:active={masterBpm !== null && deck.bpm !== null && Math.abs(masterBpm - deck.bpm * deck.playbackRate) < 0.01}
      onclick={() => deck.bpm !== null && setMasterBpm(deck.bpm * deck.playbackRate)}
      disabled={deck.bpm === null}
      title="Set this deck's current playing tempo as the main beat reference"
    >
      Main Beat
    </button>
    <button
      class="bpm-btn"
      onclick={() => {
        if (deck.bpm !== null && masterBpm !== null) {
          updateDeck(deck.id, { playbackRate: masterBpm / deck.bpm });
          // Wait for WebKit's video-pipeline rebuild (triggered by the playbackRate
          // write above) to settle before seeking — see CLAUDE.md "Rate-then-seek ordering".
          setTimeout(() => nudgePhaseToMaster(deck.id), 200);
        }
      }}
      disabled={deck.bpm === null || masterBpm === null}
      title={masterBpm !== null && deck.bpm !== null
        ? `Sync to main beat: set rate to ${(masterBpm / deck.bpm).toFixed(3)}× and align beat phase`
        : 'Sync requires both deck BPM and a main beat reference'}
    >
      Sync
    </button>
    <button
      class="bpm-btn"
      onclick={() => {
        const t = getDeckTime(deck.id);
        if (t !== null) {
          updateDeck(deck.id, { downbeat: t });
          if (deck.bpm !== null && deck.source?.type === 'video') {
            gridSave(deck.source.filePath, deck.bpm, t).catch(console.error);
            markGridSaved(deck.id, deck.source.filePath);
            if (deck.diggerTrackId !== null) {
              // Best-effort — Digger being unreachable shouldn't block the local save.
              pushMarker(deck.diggerTrackId, Math.round(t * 1000), 'downbeat').catch(console.error);
              setTrackBpm(deck.diggerTrackId, deck.bpm).catch(console.error);
            }
          }
        }
      }}
      disabled={!deck.source}
      title="Stamp current position as beat 1 (downbeat anchor for phase tracking)"
    >
      SET BEAT
    </button>
    <button
      class="bpm-btn"
      onclick={() => nudgePhaseToMaster(deck.id)}
      disabled={deck.downbeat === null || deck.bpm === null}
      title={deck.playing
        ? 'Nudge phase toward reference deck (±15% rate spike, auto-reverts)'
        : 'Seek to in-phase position relative to reference deck'}
    >
      NUDGE
    </button>
    {#if deck.downbeat !== null}
      <span class="downbeat-indicator" title="Downbeat anchor: {formatDuration(deck.downbeat)}">
        ♩{formatDuration(deck.downbeat)}
      </span>
      <button
        class="downbeat-clear"
        onclick={() => updateDeck(deck.id, { downbeat: null })}
        title="Clear downbeat"
      >✕</button>
    {/if}
    {#if phase !== null}
      <span class="phase-display" title="Beat phase (0.0 = on beat, 0.5 = halfway between beats)">
        φ{phase.toFixed(2)}
      </span>
    {/if}
  </div>

  <div class="loop-row">
    <button
      class="loop-pt-btn"
      onclick={() => {
        const t = getDeckTime(deck.id);
        if (t !== null) {
          updateDeck(deck.id, { loopIn: quantizeToGrid(deck.id, t) });
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
          updateDeck(deck.id, { loopOut: quantizeToGrid(deck.id, t) });
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
          const inTime = deck.loopIn ?? quantizeToGrid(deck.id, getDeckTime(deck.id) ?? 0);
          updateDeck(deck.id, { loopIn: inTime, loopOut: inTime + barSec, loop: true });
        }}
        disabled={barSec === null || !deck.source}
        title={barSec !== null
          ? `Loop ${bars === 0.5 ? '½' : bars} bar${bars !== 1 ? 's' : ''} (${barSec.toFixed(2)}s)`
          : 'Set a main beat reference first'}
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
            seekDeck(deck.id, quantizeToGrid(deck.id, t));
          } else {
            const now = getDeckTime(deck.id);
            if (now !== null) {
              const quantized = quantizeToGrid(deck.id, now);
              const cues = [...deck.hotCues];
              cues[i] = quantized;
              updateDeck(deck.id, { hotCues: cues });
              if (deck.diggerTrackId !== null) {
                pushMarker(deck.diggerTrackId, Math.round(quantized * 1000), 'hot_cue', `Hot cue ${i + 1}`).catch(console.error);
              }
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
    <label title="Post-fader level — driven by crossfader">
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
      <span>Rate <strong>{deck.playbackRate.toFixed(3)}×</strong></span>
      <input
        type="range"
        min={1 - $tempoRange / 100}
        max={1 + $tempoRange / 100}
        step="0.001"
        value={deck.playbackRate}
        oninput={(e) => updateDeck(deck.id, { playbackRate: +e.currentTarget.value })}
      />
    </label>
  </div>

  <div class="eq-row">
    <label title="Low shelf ±12 dB @ 250 Hz">
      <span>Lo <strong class:eq-active={deck.eq.low !== 0}>{deck.eq.low >= 0 ? '+' : ''}{deck.eq.low.toFixed(0)}</strong></span>
      <input type="range" min="-12" max="12" step="0.5" value={deck.eq.low}
        oninput={(e) => updateDeck(deck.id, { eq: { ...deck.eq, low: +e.currentTarget.value } })} />
    </label>
    <label title="Mid peak ±12 dB @ 1 kHz">
      <span>Mid <strong class:eq-active={deck.eq.mid !== 0}>{deck.eq.mid >= 0 ? '+' : ''}{deck.eq.mid.toFixed(0)}</strong></span>
      <input type="range" min="-12" max="12" step="0.5" value={deck.eq.mid}
        oninput={(e) => updateDeck(deck.id, { eq: { ...deck.eq, mid: +e.currentTarget.value } })} />
    </label>
    <label title="High shelf ±12 dB @ 4 kHz">
      <span>Hi <strong class:eq-active={deck.eq.high !== 0}>{deck.eq.high >= 0 ? '+' : ''}{deck.eq.high.toFixed(0)}</strong></span>
      <input type="range" min="-12" max="12" step="0.5" value={deck.eq.high}
        oninput={(e) => updateDeck(deck.id, { eq: { ...deck.eq, high: +e.currentTarget.value } })} />
    </label>
    <button
      class="eq-reset"
      onclick={() => updateDeck(deck.id, { eq: { low: 0, mid: 0, high: 0 } })}
      title="Reset EQ"
      disabled={deck.eq.low === 0 && deck.eq.mid === 0 && deck.eq.high === 0}
    >↺</button>
  </div>
</div>

<style>
  .source-btns {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .eq-active { color: #f5a623; }

  .gain-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 4px;
    font-size: 11px;
    color: #aaa;
  }

  .gain-row span {
    min-width: 28px;
  }

  .gain-row input[type="range"] {
    flex: 1;
    height: 14px;
  }

  .gain-row strong {
    min-width: 30px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: #ccc;
  }

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

  .bpm-effective {
    color: #f5a623;
    font-variant-numeric: tabular-nums;
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

  .downbeat-indicator {
    font-size: 10px;
    color: #7ec8e3;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .downbeat-clear {
    padding: 1px 4px;
    font-size: 9px;
    background: none;
    border: 1px solid #444;
    border-radius: 3px;
    color: #666;
    cursor: pointer;
    line-height: 1;
  }

  .downbeat-clear:hover {
    border-color: #888;
    color: #ccc;
  }

  .phase-display {
    font-size: 10px;
    color: #a8e6a3;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    min-width: 36px;
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
