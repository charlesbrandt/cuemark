import { invoke } from '@tauri-apps/api/core';
import { debugLog } from './lib/debugLog';

const channel = new BroadcastChannel('cuemark-output');
const canvas = document.getElementById('output') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = 'high';

// JS-driven sizing via ResizeObserver, not a one-shot window.innerWidth/innerHeight
// read + 'resize' listener — see CLAUDE.md's canvas-sizing gotcha. Right after this
// window is force-reloaded by the freeze-watchdog (tier2/tier3 recovery), GTK can
// still be settling the recreated window's layout when this script's top level runs;
// a one-shot read can undersize the canvas buffer with no further 'resize' event ever
// firing to correct it, leaving stale/uninitialized backing-store pixels visible as
// noise at the edges. ResizeObserver reports the actual settled size whenever it
// changes, including immediately on observe().
function resize(width: number, height: number) {
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  // CLAUDE.md's canvas-sizing rule: the element's *layout* size must be set from JS too,
  // never left to scoped CSS. output.html sizes this canvas with `width:100vw;height:100vh`,
  // which is exactly the pattern that rule forbids — WebKitGTK does not reliably apply it.
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  debugLog(
    `[output] resize: width=${width} height=${height} dpr=${devicePixelRatio} -> canvas=${canvas.width}x${canvas.height}`,
  );
}

// Bug A note for anyone re-instrumenting here: a geometry probe (window/body/canvasRect/
// client/buffer sizes plus a centre-pixel getImageData) was added during that investigation
// and removed as settled. It reported `canvasRect=1280.0x673.0@0.0,0.0` against a
// `win=1280x673` — the canvas covers this window exactly — and a centre pixel of
// `rgba(0,0,0,0)` while the compositor was clearing to opaque black. Neither number was
// wrong and neither was the bug: the corruption was upstream, in the compositor's own WebGL
// canvas in the *control* window. Re-adding probes on this side is very unlikely to help.
new ResizeObserver((entries) => {
  const { width, height } = entries[0].contentRect;
  resize(width, height);
}).observe(document.body);

let lastFrameAt = performance.now();
let loggedFirstFrame = false;
let frameCount = 0;
channel.onmessage = (e: MessageEvent<{ frame: ImageBitmap }>) => {
  const { frame } = e.data;
  lastFrameAt = performance.now();
  frameCount++;
  if (!loggedFirstFrame || frameCount % 120 === 0) {
    loggedFirstFrame = true;
    debugLog(
      `[output] frame #${frameCount}: bitmap=${frame.width}x${frame.height} canvas=${canvas.width}x${canvas.height}`,
    );
  }
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
