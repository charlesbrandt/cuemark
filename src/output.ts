/**
 * output.ts — the output (projector) window.
 *
 * Since 2026-08-03 this window **is** the compositor. It receives per-deck frames as
 * `ImageBitmap`s from the control window and blends them itself with WebGL, rather than
 * receiving an already-composited snapshot. The reason is not architectural taste: on this
 * machine all GPU→CPU readback from WebGL is broken in the Mesa `crocus` driver, so the
 * control window physically cannot snapshot its own compositor canvas — every capture came
 * back correctly-sized and fully transparent, with nothing raising. WebGL *display* works
 * fine, so compositing on this side never needs to read anything back.
 *
 * See `lib/renderer/outputProtocol.ts` for the message contract and the probe evidence,
 * and `docs/design/output-noise-and-track-reload-silence.md` (Bug A) for the history.
 */
import { invoke } from '@tauri-apps/api/core';
import { debugLog } from './lib/debugLog';
import { Compositor } from './lib/renderer/compositor';
import {
  OUTPUT_CHANNEL,
  OUTPUT_ALIVE_INTERVAL_MS,
  type OutputMessage,
} from './lib/renderer/outputProtocol';

const channel = new BroadcastChannel(OUTPUT_CHANNEL);
const canvas = document.getElementById('output') as HTMLCanvasElement;
const noSignal = document.getElementById('nosignal') as HTMLDivElement;

// The drawing buffer is fixed at the output resolution set by the canvas width/height
// attributes in output.html; CSS only scales it to the window. Keeping it fixed means deck
// FBOs are allocated once and never reallocated on a window resize, and the projector gets
// the same pixels regardless of how big this window happens to be.
const compositor = new Compositor(canvas, 'output-compositor');

// Paint once, immediately. A WebGL canvas that has never been drawn to displays
// uninitialised surface memory on this build — that was the entire "output window renders
// random-noise static" symptom, when the old 2D canvas was never written because every
// incoming bitmap was transparent. An empty compositor clears to opaque black, so drawing
// once up front guarantees this window is never showing garbage, even before any deck loads.
compositor.composite([], 0);

// JS-driven layout sizing via ResizeObserver, not a one-shot window.innerWidth/innerHeight
// read + 'resize' listener — see CLAUDE.md's canvas-sizing gotcha. Right after this window
// is force-reloaded by the freeze-watchdog (tier2/tier3 recovery), GTK can still be settling
// the recreated window's layout when this script's top level runs, and a one-shot read can
// mis-size it with no further 'resize' event ever firing to correct it. Only the CSS size is
// touched here; the drawing buffer is deliberately fixed (see above).
function resize(width: number, height: number) {
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  debugLog(`[output] resize: css=${width}x${height} dpr=${devicePixelRatio} buffer=${canvas.width}x${canvas.height}`);
}
new ResizeObserver((entries) => {
  const { width, height } = entries[0].contentRect;
  resize(width, height);
}).observe(document.body);

let vizSrc: string | null = null;
let lastFrameAt = performance.now();
let frameCount = 0;
let loggedFirstUpload = false;

channel.onmessage = (e: MessageEvent<OutputMessage>) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.kind === 'viz') {
    vizSrc = msg.src;
    debugLog(`[output] visualization ${msg.src ? `set (${msg.src.length} chars)` : 'cleared'}`);
    return;
  }
  if (msg.kind !== 'frame') return;

  lastFrameAt = performance.now();
  frameCount++;

  // Allocate/free FBOs as decks come and go. Cheap and idempotent when unchanged.
  compositor.syncDecks(msg.decks.map((d) => d.id));

  let uploaded = 0;
  for (const d of msg.decks) {
    if (!d.bitmap) continue; // unchanged this tick — the FBO already holds its last frame
    const fbo = compositor.getFBO(d.id);
    if (fbo) {
      fbo.uploadImageBitmap(d.bitmap);
      uploaded++;
    }
    // These bitmaps are this process's own clones of the sender's; the sender closes its
    // originals on its own schedule. Not closing here would leak multiple megabytes per
    // frame into the process that also runs this window's GL.
    d.bitmap.close();
  }

  if (vizSrc && msg.vizOpacity > 0) {
    compositor.renderVisualization(vizSrc, msg.vizUniforms, msg.time, msg.analysis);
  }
  compositor.composite(msg.decks, vizSrc ? msg.vizOpacity : 0);

  if (frameCount === 1) {
    noSignal.style.display = 'none';
    debugLog(`[output] first frame: decks=${msg.decks.length} uploaded=${uploaded} buffer=${canvas.width}x${canvas.height}`);
  } else if (frameCount % 600 === 0) {
    debugLog(`[output] frame #${frameCount}: decks=${msg.decks.length} uploaded=${uploaded}`);
  }
  // "Frames are arriving" and "deck pixels are arriving" are different claims, and the
  // first was historically mistaken for the second (Bug A's "the JS data path is provably
  // healthy" — which was true, and irrelevant, while the screen showed garbage). A frame
  // message with no bitmaps is normal (nothing changed this tick), so log the first one
  // that actually carries deck pixels, separately and once.
  if (uploaded > 0 && !loggedFirstUpload) {
    loggedFirstUpload = true;
    debugLog(`[output] first deck pixels uploaded at frame #${frameCount} (${uploaded} deck(s))`);
  }
};

// Ask the control window for a full re-send. Without this, a window opened mid-set — or
// reloaded by the freeze-watchdog — would stay black until every deck happened to produce a
// new frame, which for a paused deck never happens: the sender only ships decks that changed.
channel.postMessage({ kind: 'hello' });
debugLog('[output] ready — requested full re-send from control window');

// Liveness beacon — the sender skips all frame construction when nobody is listening.
// See OutputAliveMessage for why this is a beacon and not a goodbye on unload.
setInterval(() => channel.postMessage({ kind: 'alive' }), OUTPUT_ALIVE_INTERVAL_MS);

// Freeze-watchdog heartbeat (docs/design/freeze-watchdog.md). This window has no rAF loop of
// its own — it renders on message arrival — so "lastRafMs" here means "time since the last
// frame message", the closest analog of main's rAF-staleness signal for detecting this
// window's JS main thread going silent.
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
