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
 * `viz` is sent only when the plugin changes — its source is a large string and has no
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
  /** User parameter values for the active plugin, by ISF input NAME. */
  vizParams: Record<string, number | number[] | boolean>;
  /** Values for every `CUEMARK_BIND` name (bass, mid, high, …), refreshed each frame. */
  bindings: Record<string, number>;
  /**
   * Control-window clock, seconds. Not used as the shader's TIME any more: the output
   * window counts TIME from when the plugin was loaded, as ISF hosts do, which also keeps it
   * small enough for float precision (`performance.now()/1000` after hours of uptime makes
   * `sin(TIME*k)` visibly step).
   */
  time: number;
  analysis: { bass: number; mid: number; high: number };
}

/** What the output window needs to build a plugin. */
export interface VizPluginPayload {
  id: string;
  format: 'isf';
  /** ISF fragment shader, header included. */
  source: string;
  /** Optional ISF vertex shader (`<name>.vs`). */
  vertexSource?: string;
  /** Asset file name → URL the output window can fetch. Unused until image inputs land. */
  assets: Record<string, string>;
}

/** Sent on change only — plugin source is far too big for the per-frame path. */
export interface OutputVizMessage {
  kind: 'viz';
  plugin: VizPluginPayload | null;
}

/**
 * Output → control: the active plugin failed to build. The output window is the only place
 * a shader is compiled, so without this a broken plugin is just a silently black layer.
 * It is also `debugLog`ged on the output side so it reaches cuemark.log.
 */
export interface OutputVizErrorMessage {
  kind: 'vizError';
  pluginId: string;
  stage: 'parse' | 'compile' | 'link' | 'unsupported' | 'runtime';
  message: string;
}

/** Output → control: the active plugin built cleanly (clears a stale error badge). */
export interface OutputVizOkMessage {
  kind: 'vizOk';
  pluginId: string;
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

/**
 * Liveness beacon from the output window, sent every `OUTPUT_ALIVE_INTERVAL_MS`.
 *
 * Building a deck frame is expensive — a full-resolution `drawImage` plus a
 * `createImageBitmap` per changed deck, at up to 60fps — and until 2026-08-03 the sender
 * paid all of it unconditionally, including when no output window existed at all. The
 * control window's render loop measured 17fps with a single deck playing and the output
 * window *closed*, so that waste is real and on the critical path.
 *
 * A beacon rather than a goodbye message: a window that crashes, is killed by the
 * freeze-watchdog, or is closed by the window manager never gets to say goodbye, and the
 * failure mode of believing a dead window is alive is permanent wasted work. This way the
 * sender's belief decays on its own, and any 'hello'/'alive' revives it within one
 * interval. Erring toward "still listening" for a couple of seconds after a close costs
 * nothing; erring the other way would freeze the projector mid-set.
 */
export interface OutputAliveMessage {
  kind: 'alive';
}

/** How often the output window beacons. */
export const OUTPUT_ALIVE_INTERVAL_MS = 1000;
/** Sender treats the output window as gone after this long without a beacon. */
export const OUTPUT_ALIVE_TIMEOUT_MS = 3000;

export type OutputMessage =
  | OutputFrameMessage
  | OutputVizMessage
  | OutputVizErrorMessage
  | OutputVizOkMessage
  | OutputHelloMessage
  | OutputAliveMessage;
