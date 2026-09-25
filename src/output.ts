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
import { parseIsf, IsfError } from './lib/renderer/isf/parser';
import {
  OUTPUT_CHANNEL,
  OUTPUT_ALIVE_INTERVAL_MS,
  type OutputMessage,
  type OutputVizErrorMessage,
  type VizPluginPayload,
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

// A maximize/un-maximize transition on WebKitGTK can deliver a transient, wrong
// contentRect to the ResizeObserver callback below (live-hit 2026-08-28: maximizing this
// window onto an external monitor left the video squished into the top of the window,
// stretched into a too-short CSS box). Once the transition settles, WebKitGTK considers the
// observed element's size unchanged from that stale reading, so no further genuine 'resize'
// entry ever arrives to correct it — same class of bug as WaveformCanvas.svelte's
// WAVEFORM_HEIGHT_PX (a mount mid-resize catching an un-settled default), referenced there
// as "the full-window skew on un-maximize — tracked separately" but never actually written
// up until now. Guard against it by polling document.body's real layout rect across rAFs
// until it stops moving, then correcting the CSS size if it ends up differing from what the
// observer reported.
let settleToken = 0;
function settleResize(observedWidth: number, observedHeight: number) {
  const token = ++settleToken;
  let last: { width: number; height: number } | null = null;
  let stableFrames = 0;
  let attempts = 0;
  const MAX_ATTEMPTS = 30; // ~500ms at 60fps — generous for a window-manager transition
  function tick() {
    if (token !== settleToken) return; // superseded by a newer resize/settle pass
    const rect = document.body.getBoundingClientRect();
    const moved = !last || Math.abs(rect.width - last.width) >= 0.5 || Math.abs(rect.height - last.height) >= 0.5;
    stableFrames = moved ? 0 : stableFrames + 1;
    last = { width: rect.width, height: rect.height };
    attempts++;
    if (stableFrames >= 2 || attempts >= MAX_ATTEMPTS) {
      if (Math.abs(rect.width - observedWidth) > 1 || Math.abs(rect.height - observedHeight) > 1) {
        debugLog(
          `[output] resize settle correction: observed=${observedWidth}x${observedHeight} settled=${rect.width}x${rect.height} attempts=${attempts}`,
        );
        resize(rect.width, rect.height);
      }
      return;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

new ResizeObserver((entries) => {
  const { width, height } = entries[0].contentRect;
  resize(width, height);
  settleResize(width, height);
}).observe(document.body);

// Fullscreen toggling (the F-key handler below) is its own window-manager transition and
// gets the same treatment — re-measure and correct once GTK has settled, rather than trusting
// whatever the ResizeObserver happened to catch mid-transition.
document.addEventListener('fullscreenchange', () => {
  const rect = document.body.getBoundingClientRect();
  resize(rect.width, rect.height);
  settleResize(rect.width, rect.height);
});

// The active plugin, or null. `vizLoadedAt` is its TIME origin: ISF's TIME counts from when
// the shader was loaded, and a small TIME keeps `sin(TIME*k)` precise in float32.
let vizPluginId: string | null = null;
let vizLoadedAt = 0;
let vizLastTime = 0;
let vizFrameIndex = 0;

function loadVisualization(plugin: VizPluginPayload | null) {
  vizPluginId = null;
  try {
    // Parse before touching the compositor, so a header error leaves nothing half-built.
    const parsed = plugin ? parseIsf(plugin.source, plugin.vertexSource) : null;
    compositor.setVisualization(parsed, plugin ? `viz/${plugin.id}` : 'viz');
  } catch (e) {
    compositor.setVisualization(null, 'viz');
    const stage: OutputVizErrorMessage['stage'] = e instanceof IsfError ? e.stage : 'runtime';
    const message = e instanceof Error ? e.message : String(e);
    debugLog(`[output] visualization ${plugin!.id} failed (${stage}): ${message}`);
    channel.postMessage({ kind: 'vizError', pluginId: plugin!.id, stage, message });
    return;
  }
  if (!plugin) {
    debugLog('[output] visualization cleared');
    return;
  }
  vizPluginId = plugin.id;
  vizLoadedAt = performance.now();
  vizLastTime = 0;
  vizFrameIndex = 0;
  debugLog(`[output] visualization ${plugin.id} loaded (${plugin.source.length} chars)`);
  channel.postMessage({ kind: 'vizOk', pluginId: plugin.id });
}

function isfDate(): [number, number, number, number] {
  const d = new Date();
  const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), secs];
}

let lastFrameAt = performance.now();
let frameCount = 0;
let loggedFirstUpload = false;

channel.onmessage = (e: MessageEvent<OutputMessage>) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.kind === 'viz') {
    loadVisualization(msg.plugin);
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

  if (vizPluginId && msg.vizOpacity > 0) {
    const time = (performance.now() - vizLoadedAt) / 1000;
    try {
      compositor.renderVisualization({
        time,
        timeDelta: time - vizLastTime,
        frameIndex: vizFrameIndex++,
        date: isfDate(),
        params: msg.vizParams,
        bindings: msg.bindings,
      });
    } catch (e) {
      // Drop the plugin rather than throw on every frame: an exception here would otherwise
      // repeat at 60fps and take the deck composite below down with it.
      const message = e instanceof Error ? e.message : String(e);
      debugLog(`[output] visualization ${vizPluginId} render failed: ${message}`);
      channel.postMessage({ kind: 'vizError', pluginId: vizPluginId, stage: 'runtime', message });
      compositor.setVisualization(null, 'viz');
      vizPluginId = null;
    }
    vizLastTime = time;
  }
  compositor.composite(msg.decks, vizPluginId ? msg.vizOpacity : 0);

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
