import { invoke } from '@tauri-apps/api/core';

const channel = new BroadcastChannel('cuemark-output');
const canvas = document.getElementById('output') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = 'high';

function resize() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}
resize();
window.addEventListener('resize', resize);

let lastFrameAt = performance.now();
channel.onmessage = (e: MessageEvent<{ frame: ImageBitmap }>) => {
  const { frame } = e.data;
  lastFrameAt = performance.now();
  ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  frame.close();
};

// Freeze-watchdog heartbeat (docs/design/freeze-watchdog.md phase 1: observe + log only,
// no recovery yet). This window has no rAF loop of its own — frames arrive via the
// BroadcastChannel from the main window's compositor — so "lastRafMs" here is reused to
// mean "time since the last composited frame arrived", the closest analog of main's
// rAF-staleness signal for detecting this window's own JS main thread going silent.
setInterval(() => {
  invoke('watchdog_heartbeat', {
    window: 'output',
    stats: { lastRafMs: Math.round(performance.now() - lastFrameAt), decks: [] },
  }).catch(() => {});
}, 1000);

document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
  // Esc to exit fullscreen is handled natively by browsers; this is a fallback.
  if (e.key === 'Escape' && document.fullscreenElement) {
    document.exitFullscreen();
  }
});
