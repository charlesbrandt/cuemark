<script lang="ts">
  import { analyzeFile } from '../lib/audio/waveform';
  import { seekDeck, getDeckTime } from '../lib/renderer/seekBus';
  import type { Deck } from '../lib/state/types';

  let { deck }: { deck: Deck } = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let peaks = $state<Float32Array | null>(null);
  let loading = $state(false);
  let analyzedPath = $state<string | null>(null);

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
    analyzeFile(filePath).then((p) => {
      if (analyzedPath === filePath) { peaks = p; loading = false; }
    }).catch((err) => {
      console.warn('[waveform] analysis failed:', err);
      if (analyzedPath === filePath) loading = false;
    });
  });

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

    ctx.fillStyle = '#0c0c0c';
    ctx.fillRect(0, 0, W, H);

    // Center line
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

    if (deck.source?.type !== 'video') {
      ctx.fillStyle = '#2a2a2a';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('— no source —', W / 2, H / 2);
      return;
    }

    const duration = deck.source.duration || 1;
    const mid = H / 2;
    const currentTime = getDeckTime(deck.id) ?? 0;
    const playheadX = (currentTime / duration) * W;

    if (!peaks) {
      ctx.fillStyle = '#333';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(loading ? 'analyzing…' : '—', W / 2, H / 2);
    } else {
      const barW = W / peaks.length;
      for (let i = 0; i < peaks.length; i++) {
        const x = i * barW;
        const barX = Math.floor(x);
        const h = Math.max(1, peaks[i] * mid * 0.95);
        // Played region: brighter; upcoming: dimmer
        ctx.fillStyle = x < playheadX ? '#4a7aaa' : '#243a5a';
        ctx.fillRect(barX, mid - h, Math.max(1, Math.ceil(barW)), h * 2);
      }
    }

    // Cue point marker (white)
    const cueX = Math.round((deck.cuePoint / duration) * W);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cueX, 0); ctx.lineTo(cueX, H); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.moveTo(cueX - 4, 0); ctx.lineTo(cueX + 4, 0); ctx.lineTo(cueX, 7); ctx.closePath(); ctx.fill();

    // Hot cue markers
    for (let i = 0; i < deck.hotCues.length; i++) {
      const hx = Math.round((deck.hotCues[i] / duration) * W);
      const color = HOT_COLORS[i % HOT_COLORS.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(hx - 4, 0); ctx.lineTo(hx + 4, 0); ctx.lineTo(hx, 7); ctx.closePath(); ctx.fill();
    }

    // Playhead (red)
    ctx.strokeStyle = '#e04040';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(playheadX, 0); ctx.lineTo(playheadX, H); ctx.stroke();
  }

  function handleClick(e: MouseEvent) {
    if (!canvas || deck.source?.type !== 'video') return;
    const rect = canvas.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    seekDeck(deck.id, ratio * (deck.source.duration || 0));
  }
</script>

<canvas
  bind:this={canvas}
  class="waveform-canvas"
  width="800"
  height="72"
  onclick={handleClick}
></canvas>
