<script lang="ts">
  import { analyzeFile, COLOR_UPCOMING, COLOR_PLAYED } from '../lib/audio/waveform';
  import { seekDeck, getDeckTime } from '../lib/renderer/seekBus';
  import type { Deck } from '../lib/state/types';

  let {
    deck,
    onBpmDetected,
  }: {
    deck: Deck;
    onBpmDetected?: (bpm: number | null) => void;
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
    analyzeFile(filePath).then((result) => {
      if (analyzedPath === filePath) {
        peaks = result.peaks;
        loading = false;
        onBpmDetected?.(result.bpm);
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
        // height is CSS-controlled — do not touch node.style.height
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

  $effect(() => {
    if (!canvas) return;
    const c = canvas;
    let rafId: number;
    function loop() { draw(c); rafId = requestAnimationFrame(loop); }
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
    const duration = deck.source?.type === 'video' ? (deck.source.duration || 1) : 1;
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
      drawOverview(ctx, W, H, mid, currentTime, duration);
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

  function drawOverview(
    ctx: CanvasRenderingContext2D,
    W: number, H: number, mid: number,
    currentTime: number, duration: number
  ) {
    const p = peaks!;
    const playheadX = (currentTime / duration) * W;
    const barW = W / p.length;

    for (let i = 0; i < p.length; i++) {
      const x = i * barW;
      const amp = p[i] * deck.gain;
      const h = Math.max(1, amp * mid * 0.92);
      const colorIdx = Math.min(255, Math.floor(amp * 255));
      ctx.fillStyle = x < playheadX ? COLOR_PLAYED[colorIdx] : COLOR_UPCOMING[colorIdx];
      ctx.fillRect(Math.floor(x), mid - h, Math.max(1, Math.ceil(barW)), h * 2);
    }

    drawMarkers(ctx, W, H, (t) => (t / duration) * W);

    ctx.strokeStyle = '#e04040';
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
    const leadSecs = zoomSeconds * ZOOM_LEAD_RATIO;
    const timeStart = currentTime - leadSecs;
    const timeEnd = timeStart + zoomSeconds;
    const playheadX = ZOOM_LEAD_RATIO * W;

    // Shade out-of-bounds (before track start / after track end)
    if (timeStart < 0) {
      ctx.fillStyle = '#040609';
      ctx.fillRect(0, 0, Math.min(W, (-timeStart / zoomSeconds) * W), H);
    }
    if (timeEnd > duration) {
      const x = Math.max(0, ((duration - timeStart) / zoomSeconds) * W);
      ctx.fillStyle = '#040609';
      ctx.fillRect(x, 0, W - x, H);
    }

    const peakDuration = duration / p.length;
    const firstIdx = Math.max(0, Math.floor((Math.max(0, timeStart) / duration) * p.length));
    const lastIdx = Math.min(p.length - 1, Math.ceil((Math.min(duration, timeEnd) / duration) * p.length));
    const barW = (peakDuration / zoomSeconds) * W;

    for (let i = firstIdx; i <= lastIdx; i++) {
      const t = (i / p.length) * duration;
      const x = ((t - timeStart) / zoomSeconds) * W;
      const amp = p[i] * deck.gain;
      const h = Math.max(1, amp * mid * 0.92);
      const colorIdx = Math.min(255, Math.floor(amp * 255));
      ctx.fillStyle = t < currentTime ? COLOR_PLAYED[colorIdx] : COLOR_UPCOMING[colorIdx];
      ctx.fillRect(Math.floor(x), mid - h, Math.max(1, Math.ceil(barW)), h * 2);
    }

    // Tick marks every second (longer ticks every 4s)
    ctx.lineWidth = 1;
    const firstTick = Math.ceil(Math.max(0, timeStart));
    const lastTick = Math.floor(Math.min(duration, timeEnd));
    for (let t = firstTick; t <= lastTick; t++) {
      const x = ((t - timeStart) / zoomSeconds) * W;
      const tickH = t % 4 === 0 ? mid * 0.35 : mid * 0.15;
      ctx.strokeStyle = t % 4 === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(x, mid - tickH);
      ctx.lineTo(x, mid + tickH);
      ctx.stroke();
    }

    drawMarkers(ctx, W, H, (t) => ((t - timeStart) / zoomSeconds) * W);

    // Playhead pinned at fixed position
    ctx.strokeStyle = '#e04040';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, H);
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
      const timeStart = currentTime - zoomSeconds * ZOOM_LEAD_RATIO;
      const t = timeStart + ratio * zoomSeconds;
      seekDeck(deck.id, Math.max(0, Math.min(duration, t)));
    } else {
      seekDeck(deck.id, ratio * duration);
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
    background: #080d18;
  }
  .zoom-toggle {
    position: absolute;
    top: 3px;
    right: 4px;
    padding: 1px 5px;
    background: rgba(0, 0, 0, 0.65);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.5);
    font-size: 9px;
    font-family: monospace;
    cursor: pointer;
    border-radius: 2px;
    letter-spacing: 0.05em;
    line-height: 1.6;
  }
  .zoom-toggle:hover {
    border-color: rgba(255, 255, 255, 0.35);
    color: #fff;
  }
  .zoom-toggle.active {
    border-color: #00aadd;
    color: #00aadd;
  }
</style>
