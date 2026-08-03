/**
 * outputProtocol.ts — the message contract between the control window (sender,
 * `outputBus.ts`) and the output window (receiver, `output.ts`).
 *
 * ## Why frames and not a composited image
 *
 * Until 2026-08-03 the control window composited everything and shipped a single
 * `createImageBitmap()` snapshot of its WebGL canvas. That cannot work on this machine:
 * **all GPU→CPU readback from WebGL is broken in the Mesa `crocus` driver**, so every
 * snapshot arrived correctly-sized and fully transparent, with nothing raising
 * (`docs/upstream/webgl-canvas-readback-broken.md`).
 *
 * So the compositor moved to the output window, which only ever *displays* WebGL — a path
 * that works fine. What crosses the process boundary now is the compositor's *inputs*:
 * one `ImageBitmap` per deck whose frame actually changed, plus the small amount of state
 * needed to blend them. Nothing is ever read back out of a GPU surface.
 *
 * Three facts this design rests on, all probe-verified on this machine
 * (`scripts/probes/imagebitmap_upload_probe.py`, `webgl_readback_variants_probe.py`):
 *
 * 1. `createImageBitmap(VideoFrame)` returns real pixels. WebCodecs decodes in software
 *    into system memory, so decoded frames never touch the broken readback path.
 * 2. Cross-process `ImageBitmap` transfer over `BroadcastChannel` works — it always did,
 *    which is why the old output window received correctly-sized *empty* frames.
 * 3. WebGL *display* in a second webview works; only readback is broken.
 *
 * ## Shape of the traffic
 *
 * `viz` is sent only when the shader source changes — it is a large string and has no
 * business on a per-frame path. `frame` is sent once per composited tick, and carries a
 * bitmap only for decks that actually produced a new frame; `bitmap: null` means "reuse
 * what you already have in that deck's FBO". A paused deck therefore costs nothing per
 * frame while still remaining on screen.
 */

export const OUTPUT_CHANNEL = 'cuemark-output';

export interface OutputDeckFrame {
  id: string;
  /** Compositor blend weight, 0–1. Deck order in the array is back-to-front render order. */
  opacity: number;
  /** New frame for this deck, or null to keep whatever its FBO already holds. */
  bitmap: ImageBitmap | null;
}

export interface OutputFrameMessage {
  kind: 'frame';
  decks: OutputDeckFrame[];
  vizOpacity: number;
  vizUniforms: Record<string, number>;
  /** Seconds, for the visualization's `u_time`. */
  time: number;
  analysis: { bass: number; mid: number; high: number };
}

/** Sent on change only — `fragmentSrc` is far too big for the per-frame path. */
export interface OutputVizMessage {
  kind: 'viz';
  src: string | null;
}

/**
 * Sent by the output window when it loads. The control window only ships frames for decks
 * that *changed*, so a window that opens mid-set — or is reloaded by the freeze-watchdog —
 * would otherwise stay black until every deck happened to produce a new frame, which for a
 * paused deck is never. This asks the sender to re-send the shader and all deck frames once.
 */
export interface OutputHelloMessage {
  kind: 'hello';
}

export type OutputMessage = OutputFrameMessage | OutputVizMessage | OutputHelloMessage;
