import { debugLog } from '../debugLog';
import {
  OUTPUT_CHANNEL,
  type OutputDeckFrame,
  type OutputMessage,
} from './outputProtocol';

const channel = new BroadcastChannel(OUTPUT_CHANNEL);

/** Where a deck's current frame comes from — the two video backends App.svelte supports. */
export type DeckFrameSource =
  | { kind: 'codec'; frame: VideoFrame }
  | { kind: 'video'; el: HTMLVideoElement };

export interface OutputPostState {
  /** Back-to-front render order. `source: null` = unchanged this tick, send no bitmap. */
  decks: Array<{ id: string; opacity: number; source: DeckFrameSource | null }>;
  vizSrc: string | null;
  vizOpacity: number;
  vizUniforms: Record<string, number>;
  time: number;
  analysis: { bass: number; mid: number; high: number };
}

// One in-flight send at a time. createImageBitmap + the cross-process postMessage clone
// aren't free, especially with several decks — without this guard a rAF tick that outpaces
// the previous send queues up an unbounded backlog of pending bitmaps, saturating the main
// thread until the whole UI stalls. (The main thread has little headroom here to begin
// with; see Bug E in docs/design/output-noise-and-track-reload-silence.md.)
let inFlight = false;

// The bitmaps sent on the previous postFrame(), still unclosed. See the close-deferral
// rationale in postFrame() below.
let previousBitmaps: ImageBitmap[] = [];

let lastVizSrc: string | null = null;
let vizSrcSent = false;

// Set when the output window announces itself, and when a send is skipped while sources
// were pending. App.svelte consumes this via takeResendRequest() and clears its
// per-deck "last uploaded" trackers, which makes the next tick re-send every deck.
let resendAll = false;

channel.onmessage = (e: MessageEvent<OutputMessage>) => {
  if (e.data?.kind === 'hello') {
    resendAll = true;
    vizSrcSent = false;
    debugLog('[outputBus] output window connected — re-sending shader and all deck frames');
  }
};

/**
 * True once if the output window needs a full re-send. The caller must respond by
 * forgetting which frames it has already sent, so that every deck counts as changed on the
 * next tick — including paused ones, which would otherwise never produce a new frame.
 */
export function takeResendRequest(): boolean {
  const r = resendAll;
  resendAll = false;
  return r;
}

// Per-deck scratch canvases. Neither a <video> element nor a VideoFrame is shipped
// directly: drawImage() onto a 2D canvas is the exact primitive DeckCard's preview already
// relies on for both source kinds, 2D-canvas capture is known-good here, and — decisively —
// a canvas is the only source type whose orientation can be controlled (see BITMAP_OPTS).
const scratches = new Map<string, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }>();

function scratchFor(id: string, w: number, h: number) {
  let s = scratches.get(id);
  if (!s) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    s = { canvas, ctx };
    scratches.set(id, s);
  }
  if (s.canvas.width !== w || s.canvas.height !== h) {
    s.canvas.width = w;
    s.canvas.height = h;
    // Reassigning width/height resets 2D context state — re-apply it, per CLAUDE.md's
    // canvas-sizing rule.
    s.ctx.imageSmoothingEnabled = true;
    s.ctx.imageSmoothingQuality = 'high';
  }
  return s;
}

/** Drop a deck's scratch canvas when the deck goes away. */
export function releaseDeck(id: string): void {
  scratches.delete(id);
}

// `imageOrientation: 'flipY'` rather than UNPACK_FLIP_Y_WEBGL on the receiving end.
// A canvas/VideoFrame row 0 is the top; a GL texture row 0 is the bottom, so the flip has
// to happen somewhere — but `gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, true)` is **silently
// ignored for ImageBitmap sources** on this build: it raises no GL error and returns
// unflipped pixels (measured, scripts/probes/imagebitmap_upload_probe.py). Copying
// fbo.ts's existing canvas/VideoFrame upload pattern would therefore have put the whole
// projector output upside down with nothing to explain why — which has already happened
// once on this project, see uploadVideoFrameFromCodec()'s doc comment.
//
// ⚠️ **These options only take effect for a *canvas* source.** For a `VideoFrame` source
// `imageOrientation` is silently ignored too — no throw, no warning, unflipped pixels,
// identical under llvmpipe and on hardware, so it is a WebKit-level bug rather than a
// driver one. That is why every path below routes through a scratch canvas instead of
// handing a VideoFrame to createImageBitmap: the canvas is the only source type whose
// orientation this engine actually honors. Shipping codec frames directly cost one copy
// less and put the projector upside down while both DeckCard previews stayed upright
// (2026-08-03). Re-run `scripts/probes/imagebitmap_upload_probe.py` — the `orient/*` cases
// — before reintroducing any direct-from-VideoFrame shortcut here.
const BITMAP_OPTS: ImageBitmapOptions = { imageOrientation: 'flipY' };

function bitmapFor(id: string, source: DeckFrameSource): Promise<ImageBitmap> | null {
  // Both source kinds land in the same scratch canvas. drawImage() is synchronous, so a
  // codec frame cannot be closed out from under it mid-copy the way an async
  // createImageBitmap(frame) could — no clone()/refcount dance is needed.
  let w: number, h: number;
  if (source.kind === 'codec') {
    w = source.frame.displayWidth;
    h = source.frame.displayHeight;
  } else {
    const v = source.el;
    if (v.readyState < 2 || v.videoWidth === 0 || v.videoHeight === 0) return null;
    w = v.videoWidth;
    h = v.videoHeight;
  }
  if (!w || !h) return null;

  const { canvas, ctx } = scratchFor(id, w, h);
  try {
    ctx.drawImage(source.kind === 'codec' ? source.frame : source.el, 0, 0, w, h);
  } catch {
    // A VideoFrame closed before this tick drew it (CodecPlayer keeps only the 2 most
    // recent and drops them on shift/seek/loopWrap/destroy) throws here; so does
    // WebKitGTK for a cross-origin video without crossOrigin="anonymous" (App.svelte sets
    // it) and for tracks with no video data. Either way the next tick re-sends.
    return null;
  }
  return createImageBitmap(canvas, BITMAP_OPTS);
}

/**
 * Ship this tick's compositor inputs to the output window, which does the actual
 * compositing (see outputProtocol.ts for why). Fire-and-forget; dropped ticks are fine —
 * the output window keeps showing the last frame it got, and a drop schedules a re-send.
 */
export function postFrame(state: OutputPostState): void {
  // The shader source is large and changes rarely — never put it on the per-frame path.
  if (!vizSrcSent || state.vizSrc !== lastVizSrc) {
    lastVizSrc = state.vizSrc;
    vizSrcSent = true;
    channel.postMessage({ kind: 'viz', src: state.vizSrc });
  }

  if (inFlight) {
    // Don't silently lose a frame the caller has already marked as sent: if any deck had a
    // new frame this tick, ask for a full re-send. Without this a deck that changes once
    // and then pauses (the last frame before a pause, a seek while paused) could be
    // dropped here and never re-offered, leaving the output stuck on a stale frame.
    if (state.decks.some((d) => d.source !== null)) resendAll = true;
    return;
  }
  inFlight = true;

  const ids: string[] = [];
  const pending: Promise<ImageBitmap>[] = [];
  for (const d of state.decks) {
    if (!d.source) continue;
    const p = bitmapFor(d.id, d.source);
    if (p) {
      ids.push(d.id);
      pending.push(p);
    }
  }

  Promise.all(pending)
    .then((bitmaps) => {
      const byId = new Map<string, ImageBitmap>();
      bitmaps.forEach((b, i) => byId.set(ids[i], b));
      const decks: OutputDeckFrame[] = state.decks.map((d) => ({
        id: d.id,
        opacity: d.opacity,
        bitmap: byId.get(d.id) ?? null,
      }));

      channel.postMessage({
        kind: 'frame',
        decks,
        vizOpacity: state.vizOpacity,
        vizUniforms: state.vizUniforms,
        time: state.time,
        analysis: state.analysis,
      });

      // Close the *previous* tick's bitmaps rather than this tick's, one frame late.
      //
      // Closing immediately after postMessage() should be safe per spec (the structured
      // clone happens synchronously before postMessage returns), but WebKitGTK's
      // BroadcastChannel here is genuinely cross-*process* — each window is its own
      // WebKitWebProcess — and this codebase has a long history of WebKitGTK not honoring
      // spec guarantees at process boundaries (see CLAUDE.md: custom URI schemes, direct
      // video->texImage2D, VA-API DMA-BUF). Deferring by one frame keeps release
      // deterministic (at most two ticks' worth of bitmaps live at once, never a GC-timing
      // question) while giving the cross-process copy a whole frame of slack instead of
      // zero. Not closing at all is not an option: these are multi-megabyte allocations
      // produced at up to 60fps, in the same process as the render loop.
      for (const b of previousBitmaps) b.close();
      previousBitmaps = bitmaps;
    })
    .catch((e) => {
      // A rejected createImageBitmap (closed VideoFrame, tainted canvas) must not wedge the
      // guard or kill the send loop.
      debugLog(`[outputBus] frame send failed: ${e instanceof Error ? e.message : String(e)}`);
      resendAll = true;
    })
    .finally(() => {
      inFlight = false;
    });
}
