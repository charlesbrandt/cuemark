<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { session, updateDeck, removeDeck, setMasterDeck } from "../lib/state/session";
  import { seekDeck, getDeckTime, getPhase, getVideoEl, getCodecPlayer, quantizeToGrid } from "../lib/renderer/seekBus";
  import { nudgePhaseToMaster } from "../lib/audio/phaseNudge";
  import { tempoRange } from "../lib/audio/audioSettings";
  import { gridSave } from "../lib/audio/pipeline";
  import { pushMarker, setTrackBpm } from "../lib/digger/api";
  import { markGridSaved } from "../lib/audio/gridSource";
  import { recordAuxLoop } from "../lib/audio/pollStats";
  import { suppressPhaseText, suppressTimestampText } from "../lib/audio/perfArm";
  import { videoPathOverrides, videoPathDefault, setVideoPathOverride, resolveVideoPath } from "../lib/video/videoPathSettings";
  import type { Deck } from "../lib/state/types";

  let { deck }: { deck: Deck } = $props();
  let masterBpm = $derived($session.bpm);
  let masterDeckId = $derived($session.masterDeckId);
  let resolvedVideoPath = $derived(resolveVideoPath(deck.id, $videoPathOverrides, $videoPathDefault));
  let isDragOver = $state(false);
  let previewCanvas = $state<HTMLCanvasElement | null>(null);
  let currentTime = $state(0);
  let videoDuration = $state(0);
  let phase = $state<number | null>(null);

  // Reset the transport readout whenever the loaded file changes. Both values are written
  // only from the preview rAF loop, and that loop legitimately has nothing to say for some
  // sources (audio-only files) or has not run yet (mid-load) — so without an explicit reset
  // they persist across a load and display the previous track's numbers. Keyed on filePath
  // rather than on the source object: a re-render with an equivalent source must not clear
  // a perfectly good clock reading.
  let lastSourcePath: string | null = null;
  $effect(() => {
    const path = deck.source?.type === "video" ? deck.source.filePath : null;
    if (path === lastSourcePath) return;
    lastSourcePath = path;
    currentTime = 0;
    lastPublishedSec = -1;
    lastPhasePublishedAt = 0;
    videoDuration = deck.source?.type === "video" ? (deck.source.duration ?? 0) : 0;
  });

  // ── Text publication rate limits ────────────────────────────────────────────
  // These two `$state` writes were the control window's frame budget, measured rather
  // than guessed: suppressing them (and nothing else) took a playing deck from ~21fps to
  // a flat 62fps and WebKitWebProcess from ~47% to ~18% CPU, while deleting the entire
  // waveform redraw — the prime suspect for three sessions — moved neither.
  // See docs/design/control-window-frame-budget.md §6.
  //
  // The waste was rate, not content: the preview rAF loop ran at ~60Hz and both spans
  // render at far coarser resolution, so ~59 of every 60 mutations dirtied the deck card
  // for no visible change. Publish only when the *rendered* value changes.

  /** Whole seconds already published — `formatDuration()` is `m:ss`. */
  let lastPublishedSec = -1;
  /** `performance.now()` of the last φ publish. */
  let lastPhasePublishedAt = 0;
  /**
   * φ renders two decimals and genuinely changes every frame, so unlike the timestamp it
   * cannot be gated on the rendered string alone — it needs a rate cap.
   *
   * **This constant is a CPU dial, and a steep one.** §7 priced a deck-card text mutation at
   * ~20ms of `WebKitWebProcess` CPU, so every extra Hz of φ costs roughly 2 points of a core
   * — 10Hz measured ~21 points against the same run with φ suppressed. 5Hz is still ahead of
   * what anyone reads off a two-decimal number while beatmatching. Raising it back toward
   * per-frame is the single easiest way to undo this whole investigation.
   */
  const PHASE_PUBLISH_MS = 200;

  function publishTime(t: number) {
    const sec = Math.floor(t);
    if (sec === lastPublishedSec) return;
    lastPublishedSec = sec;
    currentTime = t;
  }

  function publishPhase(now: number) {
    if (now - lastPhasePublishedAt < PHASE_PUBLISH_MS) return;
    lastPhasePublishedAt = now;
    const p = getPhase(deck.id);
    // A null↔number transition adds or removes the span itself, so it always publishes;
    // otherwise only a change visible at two decimals does.
    if (p === null || phase === null) {
      if (p !== phase) phase = p;
    } else if (Math.round(p * 100) !== Math.round(phase * 100)) {
      phase = p;
    }
  }

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
      // Timed into [aux-loop]: this loop runs in the same rAF turn as App.svelte's frame()
      // but is not counted by frame-dur — see recordAuxLoop's doc comment.
      const t0 = performance.now();
      let drew = false;
      // A/B gates, off in every ordinary run (perfArm.ts). currentTime and phase are read
      // only by the elapsed/remaining/φ spans, so gating the writes removes the text
      // mutation and the style/layout it forces, while leaving the preview drawImage and the
      // audio clock itself untouched. Suppressing both is what identified this as the whole
      // frame budget (§6); the rate limits above then bought the frame rate back but not the
      // CPU (§7), so the two are now gated *separately* — φ at 10Hz against the timestamp's
      // ~1Hz is what distinguishes a per-mutation cost from a per-rate one.
      const publishTimeText = !suppressTimestampText();
      const publishPhaseText = !suppressPhaseText();
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
              drew = true;
            } catch (e) {
              console.error(`[${deck.id}] preview drawImage failed:`, e);
            }
          }
        }
        if (publishTimeText) publishTime(video.currentTime);
        if (video.duration && isFinite(video.duration)) videoDuration = video.duration;
      } else if (codec) {
        // Codec-path deck: no <video> element to read from — pick the current frame from
        // the same audio clock the compositor's FBO upload uses, and drawImage() it (2D
        // canvas accepts a VideoFrame directly, no scratch-canvas detour needed here).
        const t = getDeckTime(deck.id);
        if (t !== null) {
          if (publishTimeText) publishTime(t);
          const frame = codec.getFrameForTime(t);
          if (frame && frame.timestamp !== lastDrawnPts) {
            lastDrawnPts = frame.timestamp;
            try {
              ctx!.drawImage(frame, 0, 0, canvas.width, canvas.height);
              drew = true;
            } catch (e) {
              console.error(`[${deck.id}] preview drawImage (codec) failed:`, e);
            }
          }
        }
        if (deck.source?.type === "video" && deck.source.duration) videoDuration = deck.source.duration;
      } else {
        // Neither a usable <video> element nor a codec player. This is the audio-only case:
        // a file with no video track (.wav/.mp3) fails codec demux ("timed out waiting for
        // parsebin to expose a video stream"), falls back to the legacy <video> path, and
        // that element never reaches readyState 2 because there is nothing to decode.
        //
        // Without this branch neither of the two above runs, so currentTime/videoDuration
        // silently keep the *previous* track's values — a loaded audio file displayed the
        // last video's elapsed time and duration, frozen, while audio played normally
        // (2026-08-03). Audio is the master clock anyway, so read it directly.
        const t = getDeckTime(deck.id);
        if (t !== null && publishTimeText) publishTime(t);
        if (deck.source?.type === "video" && deck.source.duration) videoDuration = deck.source.duration;
      }
      if (publishPhaseText) publishPhase(t0);
      recordAuxLoop(`preview/${deck.id}`, performance.now() - t0, drew);
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
    {#if deck.source?.type === "video"}
      <span class="deck-title" title={deck.source.filePath.split("/").pop()}>{deck.source.filePath.split("/").pop()}</span>
    {/if}
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
    {@const posPct = Math.min(100, (currentTime / videoDuration) * 100)}
    <div class="position-bar" title="{formatDuration(currentTime)} / {formatDuration(videoDuration)}">
      <div class="position-fill" style="width: {posPct}%"></div>
      <div class="position-playhead" style="left: {posPct}%"></div>
    </div>
  {/if}

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
      class:active={masterDeckId === deck.id}
      onclick={() => setMasterDeck(deck.id)}
      disabled={deck.bpm === null}
      title="Set this deck as the main beat reference (tracks its tempo live, including pitch changes)"
    >
      Main Beat
    </button>
    <button
      class="bpm-btn"
      onclick={() => {
        if (deck.bpm !== null && masterBpm !== null) {
          updateDeck(deck.id, { playbackRate: masterBpm / deck.bpm, syncLocked: false });
          // Wait for WebKit's video-pipeline rebuild (triggered by the playbackRate
          // write above) to settle before seeking — see CLAUDE.md "Rate-then-seek ordering".
          setTimeout(() => nudgePhaseToMaster(deck.id), 200);
        }
      }}
      disabled={deck.bpm === null || masterBpm === null}
      title={masterBpm !== null && deck.bpm !== null
        ? `Sync to main beat once: set rate to ${(masterBpm / deck.bpm).toFixed(3)}× and align beat phase`
        : 'Sync requires both deck BPM and a main beat reference'}
    >
      Sync
    </button>
    <button
      class="bpm-btn"
      class:active={deck.syncLocked}
      onclick={() => {
        if (deck.syncLocked) {
          updateDeck(deck.id, { syncLocked: false });
        } else if (deck.bpm !== null && masterBpm !== null) {
          updateDeck(deck.id, { syncLocked: true, playbackRate: masterBpm / deck.bpm });
          setTimeout(() => nudgePhaseToMaster(deck.id), 200);
        }
      }}
      disabled={masterDeckId === deck.id || deck.bpm === null || masterBpm === null}
      title={masterDeckId === deck.id
        ? 'This deck is the main beat reference'
        : deck.syncLocked
          ? 'Locked to main beat — rate follows it live; click to unlock'
          : 'Lock rate to main beat: keeps following it live (pitch changes, master reassignment), not just a one-time snap'}
    >
      {deck.syncLocked ? '🔒 Lock' : 'Lock'}
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
        oninput={(e) => updateDeck(deck.id, { playbackRate: +e.currentTarget.value, syncLocked: false })}
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

  .eq-active { color: var(--accent); }

  .position-bar {
    position: relative;
    height: 4px;
    background: var(--surface2);
    border-radius: 2px;
    width: 100%;
    flex-shrink: 0;
  }

  .position-fill {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    border-radius: 2px;
    background: var(--accent);
  }

  .position-playhead {
    position: absolute;
    top: -3px;
    height: 10px;
    width: 2px;
    background: var(--text);
    transform: translateX(-1px);
  }

  .gain-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 4px;
    font-family: var(--font-heading);
    font-size: 10px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--text) 45%, transparent);
  }

  .gain-row span {
    min-width: 32px;
  }

  .gain-row input[type="range"] {
    flex: 1;
    height: 14px;
    accent-color: var(--accent);
  }

  .gain-row strong {
    min-width: 32px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    text-transform: none;
    letter-spacing: normal;
    color: var(--text);
  }

  .bpm-row {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 4px;
    font-size: 11px;
    flex-wrap: wrap;
  }

  .bpm-value {
    flex: 1;
    color: color-mix(in srgb, var(--text) 70%, transparent);
    font-variant-numeric: tabular-nums;
    min-width: 60px;
  }

  .bpm-effective {
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  .bpm-btn {
    font-family: var(--font-heading);
    font-weight: 600;
    padding: 5px 8px;
    font-size: 10px;
    background: var(--surface2);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: color-mix(in srgb, var(--text) 55%, transparent);
    cursor: pointer;
  }

  .bpm-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .bpm-btn:not(:disabled):hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .bpm-btn.active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
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
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: color-mix(in srgb, var(--text) 40%, transparent);
    cursor: pointer;
    line-height: 1;
  }

  .downbeat-clear:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /*
   * φ is the most expensive readout in the app: each mutation of this span costs ~20ms of
   * WebKitWebProcess CPU (§7), so its publish rate — not its styling — is the only lever
   * that has ever moved the number. Two plausible CSS fixes were measured and both failed,
   * which is why this rule looks ordinary:
   *
   *   - `contain: layout style paint` + a fixed width (so the box can never resize and
   *     dirty the flex line): **no effect**, 41–44% CPU either way.
   *   - `will-change: transform` to promote the span to its own compositing layer:
   *     **worse**, 46–55%. The extra layer costs more than the damage it avoids.
   *
   * Do not re-try either without reading §7 first. The cost is not this element's paint.
   */
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
    gap: 2px;
    padding: 3px;
    flex-wrap: wrap;
    background: var(--surface2);
    border-radius: var(--radius);
  }

  .loop-pt-btn {
    font-family: var(--font-heading);
    font-weight: 700;
    padding: 4px 7px;
    font-size: 9px;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: color-mix(in srgb, var(--text) 55%, transparent);
    cursor: pointer;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .loop-pt-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .loop-pt-btn:not(:disabled):hover {
    color: var(--text);
    background: var(--surface);
  }

  .bar-btn {
    font-family: var(--font-heading);
    font-weight: 700;
    padding: 4px 7px;
    font-size: 10px;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: color-mix(in srgb, var(--text) 55%, transparent);
    cursor: pointer;
    min-width: 22px;
  }

  .bar-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .bar-btn:not(:disabled):hover {
    color: var(--accent);
    background: var(--surface);
  }

  .clear-btn {
    margin-left: auto;
    color: color-mix(in srgb, var(--text) 35%, transparent);
  }

  .clear-btn:not(:disabled):hover {
    color: var(--accent-nav);
    background: var(--surface);
  }

  .time-display {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    padding: 2px 4px;
    color: color-mix(in srgb, var(--text) 65%, transparent);
  }

  .time-elapsed {
    color: var(--text);
  }

  .time-remaining {
    color: color-mix(in srgb, var(--text) 55%, transparent);
  }

  .hot-cues {
    display: flex;
    gap: 2px;
    margin: 6px 0 2px;
    padding: 3px;
    background: var(--surface2);
    border-radius: var(--radius);
  }

  .hot-cue-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 5px 2px;
    font-size: 11px;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: color-mix(in srgb, var(--text) 55%, transparent);
    cursor: pointer;
    min-height: 36px;
    line-height: 1.2;
  }

  .hot-cue-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .hot-cue-btn.set {
    background: var(--accent);
    color: var(--on-accent);
  }

  .hot-cue-btn.set:hover {
    filter: brightness(1.1);
  }

  .hot-cue-btn:not(.set):not(:disabled):hover {
    background: var(--surface);
    color: var(--text);
  }

  .hc-num {
    font-family: var(--font-heading);
    font-weight: 800;
    font-size: 13px;
  }

  .hc-time {
    font-size: 9px;
    opacity: 0.85;
  }
</style>
