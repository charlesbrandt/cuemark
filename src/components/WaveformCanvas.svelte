<script lang="ts">
  import { analyzeFile, COLOR_UPCOMING, COLOR_PLAYED } from '../lib/audio/waveform';
  import { seekDeck, getDeckTime, quantizeToGrid, scratchingDecks } from '../lib/renderer/seekBus';
  import { getDiggerFileUrl } from '../lib/digger/api';
  import { recordAuxLoop } from '../lib/audio/pollStats';
  import { suppressWaveformDraw } from '../lib/audio/perfArm';
  import type { Deck } from '../lib/state/types';

  let {
    deck,
    onAnalyzed,
  }: {
    deck: Deck;
    // Fired once per track load when analysis completes. gridOffset is a
    // beat-level anchor (a beat lies at gridOffset + k·60/bpm), or null when
    // the beat-grid fit failed and bpm is the integer fallback estimate.
    onAnalyzed?: (result: { bpm: number | null; gridOffset: number | null }) => void;
  } = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let peaks = $state<Float32Array | null>(null);
  let loading = $state(false);
  let analyzedPath = $state<string | null>(null);
  let zoom = $state(false);
  let zoomSeconds = $state(16);

  // Playhead is pinned 25% from left in zoom mode so both decks align at the same X
  const ZOOM_LEAD_RATIO = 0.25;
  const HOT_COLORS = ['#00e8ff', '#ffcc00', '#ff44cc', '#44ff88'];
  const PLAYHEAD_COLOR = '#7c8cff'; // matches --accent-deck (app.css)

  // Pre-rasterized overview bars, one offscreen canvas per colour scheme.
  //
  // drawOverview() used to walk every peak (11,583 on a 6:26 track) with a fillStyle
  // change and a fillRect per bar, on *every* frame — 13-15ms of JS per draw at a 2496px
  // canvas, 8-9% of main-thread wall time per playing deck, plus an unmeasurable amount of
  // canvas paint after the JS returns. The bars are static for a given (peaks, canvas size,
  // gain), so rasterize them once and blit per frame; the played/upcoming colour split
  // becomes two source-rect blits either side of the playhead. A/B'd to <=1ms per draw and
  // 0% busy (docs/design/control-window-frame-budget.md §4) — note that this bought only
  // ~1fps, because a half-vsync rAF throttle sits behind it. It is kept for the tail: gap
  // p90 47ms -> 34ms, max 187ms -> 47ms.
  //
  // Deliberately a plain `let`, not `$state`: this is a derived cache written from inside
  // the drawing path, and making it reactive would re-enter the effect that draws it.
  type OverviewCache = {
    peaks: Float32Array;
    w: number;
    h: number;
    gainKey: number;
    upcoming: HTMLCanvasElement;
    played: HTMLCanvasElement;
  };
  let overviewCache: OverviewCache | null = null;

  $effect(() => {
    if (deck.source?.type !== 'video') {
      peaks = null;
      analyzedPath = null;
      loading = false;
      return;
    }
    const filePath = deck.source.filePath;
    if (filePath === analyzedPath) return;
    peaks = null;
    analyzedPath = filePath;
    loading = true;
    const fallbackUrl = deck.diggerFileId != null ? getDiggerFileUrl(deck.diggerFileId) : undefined;
    analyzeFile(filePath, fallbackUrl).then((result) => {
      if (analyzedPath === filePath) {
        peaks = result.peaks;
        loading = false;
        onAnalyzed?.({ bpm: result.bpm, gridOffset: result.gridOffset });
      }
    }).catch((err) => {
      console.warn('[waveform] analysis failed:', err);
      if (analyzedPath === filePath) loading = false;
    });
  });

  // Keep canvas pixel buffer sized to its CSS layout size × DPR.
  //
  // Implemented as a use: action rather than a $effect so that:
  //   1. The ResizeObserver is stable across track loads (not torn down on source changes)
  //   2. No reactive-dependency tricks are needed — the action parameter drives update()
  //   3. No svelte-check false positives about unused variables
  //
  // The action observes the WRAPPER div (the canvas's parentElement), not the canvas itself —
  // the canvas intrinsic width defaults to 300px before JS sets it, so observing the canvas
  // would return 300 on the first callback before flex layout resolves.
  // Inline styles (style.width/height) are always used instead of CSS width:100% because
  // WebKitGTK does not reliably apply scoped CSS width to canvas elements inside flex children.
  function autoSize(node: HTMLCanvasElement, _filePath: string | null | undefined) {
    const wrapper = node.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    // Read CSS height once at setup. The waveform canvas height is fixed by CSS
    // (height: 72px). We must NOT set node.style.height inside the ResizeObserver
    // callback because the wrapper height is derived from the canvas height —
    // setting it would resize the wrapper, firing the observer again → infinite loop.
    const cssH = parseFloat(getComputedStyle(node).height) || 72;
    let rafId = 0;

    function resize() {
      const w = wrapper.getBoundingClientRect().width;
      if (w > 0) {
        node.width = Math.round(w * dpr);
        node.height = Math.round(cssH * dpr);
        node.style.width = w + 'px';
        // Must set inline style.height: WebKitGTK uses the canvas.height *attribute*
        // (buffer size = cssH * dpr) for CSS layout when no inline style is present,
        // making the canvas render at dpr× its intended height. The inline style wins.
        node.style.height = cssH + 'px';
      }
    }

    // RAF-debounced: calling resize() synchronously inside a ResizeObserver callback
    // triggers "ResizeObserver loop completed with undelivered notifications" because
    // the DOM mutation can fire another ResizeObserver entry before the loop finishes.
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(resize);
    });
    ro.observe(wrapper);
    resize(); // sync call for immediate initial sizing

    return {
      update(_: string | null | undefined) {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(resize);
      },
      destroy() {
        ro.disconnect();
        cancelAnimationFrame(rafId);
      },
    };
  }

  // Only the playhead needs continuous redraws, and only while the deck is actually
  // advancing. Reading deck.playing here means this effect re-runs (and redraws once)
  // on every other reactive change too — zoom toggle, peaks arriving, cue edits, etc. —
  // without needing a 60fps loop to pick those up while paused/idle.
  // Also redraws during scratch: scratch runs entirely with deck.playing=false (see
  // handler.ts), so without $scratchingDecks the playhead would sit frozen even though
  // getDeckTime() is moving (App.svelte's position poll now covers scratch too).
  $effect(() => {
    if (!canvas) return;
    const c = canvas;
    draw(c);
    if (!deck.playing && !$scratchingDecks.has(deck.id)) return;
    let rafId: number;
    let lastDrawnTime = getDeckTime(deck.id) ?? 0;
    // drawOverview() redraws every peak (thousands of bars) unconditionally; at 60fps
    // that's ~500k fillRect+fillStyle calls/sec, easily pegging the WebKit main thread.
    // A paused deck being scratched can move the playhead by a fraction of a pixel per
    // frame (slow jog = rate ~0.02), so most of those redraws are wasted: skip whenever
    // the playhead hasn't advanced by at least one device pixel since the last drawn
    // frame. This effect itself was also re-running at MIDI-tick rate (not just 60fps)
    // until 2026-07-23 — see setScratching()'s doc comment in seekBus.ts for the actual
    // root cause (a Svelte store-equality gotcha), and docs/design/pcm-buffer-playback.md
    // for the full investigation.
    function loop() {
      // Timed into [aux-loop]: shares the rAF turn with App.svelte's frame() but is not
      // counted by frame-dur — see recordAuxLoop's doc comment. The one-device-pixel guard
      // below makes the redraw rate depend on zoom and track length, so `drew` is reported
      // separately from `n`: in zoom mode the playhead clears a pixel far more often.
      const t0 = performance.now();
      let drew = false;
      const t = getDeckTime(deck.id) ?? 0;
      const w = c.width || 1;
      const span = zoom ? zoomSeconds : (deck.source?.type === 'video' ? deck.source.duration : 1);
      const pxPerSec = w / Math.max(span, 0.001);
      // suppressWaveformDraw() is the `noWaveDraw` A/B arm (off in every ordinary run —
      // perfArm.ts). §5 of the frame-budget doc showed the whole rAF throttle sits behind
      // setDeckAudioTime(), but suppressing that froze *every* clock consumer at once; this
      // arm keeps the clock publishing and removes only this redraw, so the waveform can be
      // confirmed as the cost rather than merely implied. The guard is still evaluated and
      // lastDrawnTime still advances, so returning to baseline resumes mid-track instead of
      // firing one catch-up redraw that would land in the next arm's window.
      if (Math.abs(t - lastDrawnTime) * pxPerSec >= 1) {
        if (!suppressWaveformDraw()) {
          draw(c);
          drew = true;
        }
        lastDrawnTime = t;
      }
      // Canvas dimensions are in the bucket label because bar count scales with width and
      // was an uncontrolled variable across earlier measurement runs — the same file in the
      // same mode read 12-14fps once and 21.8-23.4fps later, and nothing in the log said why.
      recordAuxLoop(
        `waveform${zoom ? '/zoom' : ''}/${deck.id}@${c.width}x${c.height}`,
        performance.now() - t0,
        drew,
      );
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  });

  function draw(c: HTMLCanvasElement) {
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const W = c.width;
    const H = c.height;
    if (W === 0 || H === 0) return;
    const mid = H / 2;

    ctx.fillStyle = '#080d18';
    ctx.fillRect(0, 0, W, H);

    const hasSource = deck.source?.type === 'video';
    const duration = deck.source?.type === 'video' ? deck.source.duration : 0;
    const currentTime = getDeckTime(deck.id) ?? 0;

    if (!hasSource) {
      const dpr = window.devicePixelRatio || 1;
      ctx.fillStyle = '#2a2a2a';
      ctx.font = `${Math.round(11 * dpr)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('— no source —', W / 2, mid);
      return;
    }

    // Duration arrives asynchronously from the <video> element's loadedmetadata event,
    // after this deck's source/playing state may already be set. Drawing with a stale
    // duration of 0 would put the playhead at the far right (currentTime / fallback),
    // which then snaps back once the real duration lands — skip drawing until it's known.
    if (!duration) {
      const dpr = window.devicePixelRatio || 1;
      ctx.fillStyle = '#333';
      ctx.font = `${Math.round(11 * dpr)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('loading…', W / 2, mid);
      return;
    }

    if (!peaks) {
      const dpr = window.devicePixelRatio || 1;
      ctx.fillStyle = '#333';
      ctx.font = `${Math.round(11 * dpr)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(loading ? 'analyzing…' : '—', W / 2, mid);
    } else if (zoom) {
      drawZoom(ctx, W, H, mid, currentTime, duration);
    } else {
      drawOverview(ctx, W, H, currentTime, duration);
    }

    // Depth gradient: darken top and bottom edges
    const depthGrad = ctx.createLinearGradient(0, 0, 0, H);
    depthGrad.addColorStop(0,   'rgba(0,0,0,0.4)');
    depthGrad.addColorStop(0.3, 'rgba(0,0,0,0)');
    depthGrad.addColorStop(0.7, 'rgba(0,0,0,0)');
    depthGrad.addColorStop(1,   'rgba(0,0,0,0.4)');
    ctx.fillStyle = depthGrad;
    ctx.fillRect(0, 0, W, H);

    // Center line
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(W, mid);
    ctx.stroke();
  }

  /**
   * Build (or reuse) the two static bar layers for the overview.
   *
   * `deck.gain` scales both bar height and colour, so it belongs in the key — but it is a
   * MIDI-driven continuous control, and keying on the raw float would rebuild on every
   * 14-bit tick of a knob sweep. Quantizing to 1/100 caps a sweep at 100 rebuilds (never
   * worse than the every-frame redraw this replaces) and is visually indistinguishable.
   */
  function rasterizeOverview(W: number, H: number): OverviewCache {
    const p = peaks!;
    const gainKey = Math.round(deck.gain * 100) / 100;
    const cached = overviewCache;
    if (cached && cached.peaks === p && cached.w === W && cached.h === H && cached.gainKey === gainKey) {
      return cached;
    }

    // Reuse the canvas objects when only the gain changed; assigning width/height also
    // clears them, which is the cheapest way to discard the previous raster.
    const upcoming = cached?.upcoming ?? document.createElement('canvas');
    const played = cached?.played ?? document.createElement('canvas');
    const mid = H / 2;
    const barW = W / p.length;

    for (const [layer, lut] of [[upcoming, COLOR_UPCOMING], [played, COLOR_PLAYED]] as const) {
      layer.width = W;
      layer.height = H;
      const lctx = layer.getContext('2d');
      if (!lctx) continue;
      for (let i = 0; i < p.length; i++) {
        const amp = p[i] * gainKey;
        const h = Math.max(1, amp * mid * 0.92);
        lctx.fillStyle = lut[Math.min(255, Math.floor(amp * 255))];
        lctx.fillRect(Math.floor(i * barW), mid - h, Math.max(1, Math.ceil(barW)), h * 2);
      }
    }

    overviewCache = { peaks: p, w: W, h: H, gainKey, upcoming, played };
    return overviewCache;
  }

  function drawOverview(
    ctx: CanvasRenderingContext2D,
    W: number, H: number,
    currentTime: number, duration: number
  ) {
    const { upcoming, played } = rasterizeOverview(W, H);
    const playheadX = (currentTime / duration) * W;

    // Split on an integer boundary — a fractional source rect makes drawImage resample,
    // which both costs more and softens the bars by a pixel.
    const split = Math.max(0, Math.min(W, Math.round(playheadX)));
    if (split > 0) ctx.drawImage(played, 0, 0, split, H, 0, 0, split, H);
    if (split < W) ctx.drawImage(upcoming, split, 0, W - split, H, split, 0, W - split, H);

    drawMarkers(ctx, W, H, (t) => (t / duration) * W);

    ctx.strokeStyle = PLAYHEAD_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, H);
    ctx.stroke();
  }

  function drawZoom(
    ctx: CanvasRenderingContext2D,
    W: number, H: number, mid: number,
    currentTime: number, duration: number
  ) {
    const p = peaks!;
    // zoomSeconds is a REAL-TIME (wall-clock) window width shared across decks so two
    // decks synced to the same effective BPM (nativeBpm * playbackRate) show the same
    // pixel-per-beat spacing and their grids visually line up — content advances at
    // `playbackRate` content-seconds per real second (see rate-position-drift.md), so
    // the actual content-time span shown must be scaled by rate, not left at zoomSeconds
    // directly. At rate 1.0 this is a no-op (contentSpan === zoomSeconds).
    const contentSpan = zoomSeconds * Math.max(0.01, deck.playbackRate);
    const leadSecs = contentSpan * ZOOM_LEAD_RATIO;
    const timeStart = currentTime - leadSecs;
    const timeEnd = timeStart + contentSpan;
    const playheadX = ZOOM_LEAD_RATIO * W;

    // Shade out-of-bounds (before track start / after track end)
    if (timeStart < 0) {
      ctx.fillStyle = '#040609';
      ctx.fillRect(0, 0, Math.min(W, (-timeStart / contentSpan) * W), H);
    }
    if (timeEnd > duration) {
      const x = Math.max(0, ((duration - timeStart) / contentSpan) * W);
      ctx.fillStyle = '#040609';
      ctx.fillRect(x, 0, W - x, H);
    }

    const peakDuration = duration / p.length;
    const firstIdx = Math.max(0, Math.floor((Math.max(0, timeStart) / duration) * p.length));
    const lastIdx = Math.min(p.length - 1, Math.ceil((Math.min(duration, timeEnd) / duration) * p.length));
    const barW = (peakDuration / contentSpan) * W;

    for (let i = firstIdx; i <= lastIdx; i++) {
      const t = (i / p.length) * duration;
      const x = ((t - timeStart) / contentSpan) * W;
      const amp = p[i] * deck.gain;
      const h = Math.max(1, amp * mid * 0.92);
      const colorIdx = Math.min(255, Math.floor(amp * 255));
      ctx.fillStyle = t < currentTime ? COLOR_PLAYED[colorIdx] : COLOR_UPCOMING[colorIdx];
      ctx.fillRect(Math.floor(x), mid - h, Math.max(1, Math.ceil(barW)), h * 2);
    }

    if (deck.bpm !== null && deck.downbeat !== null) {
      drawBeatGrid(ctx, W, mid, timeStart, timeEnd, contentSpan, deck.bpm, deck.downbeat);
    } else {
      // Tick marks every second (longer ticks every 4s)
      ctx.lineWidth = 1;
      const firstTick = Math.ceil(Math.max(0, timeStart));
      const lastTick = Math.floor(Math.min(duration, timeEnd));
      for (let t = firstTick; t <= lastTick; t++) {
        const x = ((t - timeStart) / contentSpan) * W;
        const tickH = t % 4 === 0 ? mid * 0.35 : mid * 0.15;
        ctx.strokeStyle = t % 4 === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(x, mid - tickH);
        ctx.lineTo(x, mid + tickH);
        ctx.stroke();
      }
    }

    drawMarkers(ctx, W, H, (t) => ((t - timeStart) / contentSpan) * W);

    // Playhead pinned at fixed position
    ctx.strokeStyle = PLAYHEAD_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, H);
    ctx.stroke();
  }

  function drawBeatGrid(
    ctx: CanvasRenderingContext2D,
    W: number, mid: number,
    timeStart: number, timeEnd: number, span: number,
    bpm: number, downbeat: number
  ) {
    const H = mid * 2;
    const period = 60 / bpm;
    const kStart = Math.ceil((timeStart - downbeat) / period);
    const kEnd = Math.floor((timeEnd - downbeat) / period);

    let normalPath: number[] = [];
    let accentPath: number[] = [];

    for (let k = kStart; k <= kEnd; k++) {
      const t = downbeat + k * period;
      const x = ((t - timeStart) / span) * W;
      // k can be negative (downbeat is just one reference beat, not beat 0) —
      // JS's % keeps the sign of the dividend, so -4 % 4 === -0, not 0.
      const isAccent = ((k % 4) + 4) % 4 === 0;
      (isAccent ? accentPath : normalPath).push(x);
    }

    // Full-height, magenta: the waveform's own amplitude gradient (waveform.ts) runs
    // blue -> cyan -> green -> yellow -> orange, so magenta is the one hue guaranteed
    // never to appear in a bar and get lost against a loud (orange) peak.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,0,220,0.45)';
    ctx.beginPath();
    for (const x of normalPath) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    ctx.stroke();

    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,0,220,0.85)';
    ctx.beginPath();
    for (const x of accentPath) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    ctx.stroke();
  }

  function drawMarkers(
    ctx: CanvasRenderingContext2D,
    W: number, H: number,
    timeToX: (t: number) => number
  ) {
    // Loop region highlight
    if (deck.loopIn !== null && deck.loopOut !== null && deck.loop) {
      const lx1 = timeToX(deck.loopIn);
      const lx2 = timeToX(deck.loopOut);
      const lLeft = Math.min(lx1, lx2);
      const lRight = Math.max(lx1, lx2);
      if (lRight > 0 && lLeft < W) {
        ctx.fillStyle = 'rgba(0, 200, 80, 0.18)';
        ctx.fillRect(Math.max(0, lLeft), 0, Math.min(W, lRight) - Math.max(0, lLeft), H);
        ctx.strokeStyle = 'rgba(0, 220, 100, 0.7)';
        ctx.lineWidth = 1;
        if (lx1 >= -1 && lx1 <= W + 1) {
          ctx.beginPath(); ctx.moveTo(lx1, 0); ctx.lineTo(lx1, H); ctx.stroke();
        }
        if (lx2 >= -1 && lx2 <= W + 1) {
          ctx.beginPath(); ctx.moveTo(lx2, 0); ctx.lineTo(lx2, H); ctx.stroke();
        }
      }
    }

    // Cue point (white)
    const cueX = Math.round(timeToX(deck.cuePoint));
    if (cueX >= -4 && cueX <= W + 4) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(cueX, 0); ctx.lineTo(cueX, H); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.moveTo(cueX - 4, 0); ctx.lineTo(cueX + 4, 0); ctx.lineTo(cueX, 7); ctx.closePath(); ctx.fill();
    }

    // Hot cues
    for (let i = 0; i < deck.hotCues.length; i++) {
      const hx = Math.round(timeToX(deck.hotCues[i]));
      if (hx < -4 || hx > W + 4) continue;
      const color = HOT_COLORS[i % HOT_COLORS.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(hx - 4, 0); ctx.lineTo(hx + 4, 0); ctx.lineTo(hx, 7); ctx.closePath(); ctx.fill();
    }
  }

  function handleClick(e: MouseEvent) {
    if (!canvas || deck.source?.type !== 'video') return;
    const rect = canvas.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const duration = deck.source.duration || 0;

    if (zoom) {
      const currentTime = getDeckTime(deck.id) ?? 0;
      // Must match drawZoom's contentSpan scaling or clicks land off from what's drawn.
      const contentSpan = zoomSeconds * Math.max(0.01, deck.playbackRate);
      const timeStart = currentTime - contentSpan * ZOOM_LEAD_RATIO;
      const t = timeStart + ratio * contentSpan;
      seekDeck(deck.id, Math.max(0, Math.min(duration, quantizeToGrid(deck.id, t))));
    } else {
      seekDeck(deck.id, Math.max(0, Math.min(duration, quantizeToGrid(deck.id, ratio * duration))));
    }
  }

  function handleWheel(e: WheelEvent) {
    if (!zoom) return;
    e.preventDefault();
    // Scroll up = zoom in (fewer seconds visible), scroll down = zoom out
    zoomSeconds = Math.max(4, Math.min(32, zoomSeconds + (e.deltaY > 0 ? 2 : -2)));
  }
</script>

<div class="waveform-wrap">
  <canvas
    use:autoSize={deck.source?.type === 'video' ? deck.source.filePath : null}
    bind:this={canvas}
    class="waveform-canvas"
    onclick={handleClick}
    onwheel={handleWheel}
  ></canvas>
  <button
    class="zoom-toggle"
    class:active={zoom}
    onclick={() => (zoom = !zoom)}
    title={zoom
      ? `Zoom ${zoomSeconds}s — scroll to adjust, click for overview`
      : 'Click to zoom in (scroll to adjust window size)'}
  >
    {zoom ? `${zoomSeconds}s` : 'OVR'}
  </button>
</div>

<style>
  .waveform-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  .waveform-canvas {
    display: block;
    /* width is always set via c.style.width in resize() — do not put width:100% here.
       WebKitGTK does not reliably apply scoped CSS width to canvas elements inside
       flex children, causing the canvas to render at 300px default width.
       height:72px is a pre-JS fallback only; resize() overwrites it via c.style.height. */
    height: 72px;
    cursor: crosshair;
    background: var(--surface2, #282b31);
  }
  .zoom-toggle {
    position: absolute;
    top: 4px;
    right: 5px;
    padding: 2px 6px;
    background: rgba(23, 24, 28, 0.75);
    border: 1px solid var(--divider, rgba(240, 241, 244, 0.1));
    color: rgba(240, 241, 244, 0.55);
    font-family: var(--font-heading, sans-serif);
    font-weight: 700;
    font-size: 9px;
    cursor: pointer;
    border-radius: var(--radius-sm, 6px);
    letter-spacing: 0.05em;
    line-height: 1.6;
  }
  .zoom-toggle:hover {
    border-color: var(--accent-deck, #7c8cff);
    color: #fff;
  }
  .zoom-toggle.active {
    border-color: var(--accent-deck, #7c8cff);
    color: var(--accent-deck, #7c8cff);
  }
</style>
