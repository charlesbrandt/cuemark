/**
 * instance.ts — `MilkdropInstance`: one sandboxed iframe running Butterchurn.
 *
 * Lives in the output window. It is the Milkdrop counterpart of `IsfInstance`, but it is not
 * drawn *by* the compositor: the iframe is stacked above the compositor canvas and the browser
 * composites it, with the plugin opacity applied as CSS `opacity` (Butterchurn's canvas is
 * opaque, so whole-layer opacity is the only blend there is). See `frameShell.ts` for the
 * sandbox reasoning and the message protocol.
 *
 * Cost when unused: nothing. This module is only reached through a dynamic import from
 * `output.ts`, and Butterchurn's source is a second lazy `?raw` import made on the first
 * preset. `destroy()` removes the iframe, which frees its WebGL context.
 */
import { FRAME_SHELL_HTML } from './frameShell';

/** Drawing buffer of the Milkdrop canvas. CSS scales it to the window, like the compositor's. */
export const MILKDROP_BUFFER = { width: 1280, height: 720 } as const;
/** A frame that has not reported `ready` this long after creation is reported as failed. */
const READY_TIMEOUT_MS = 15000;
/** Butterchurn render time above this (median) is flagged in the log (~8 ms projector budget). */
export const SLOW_RENDER_MS = 8;

export type MilkdropErrorStage = 'compile' | 'runtime';

export interface MilkdropCallbacks {
  /** A preset (id) failed to load, or the frame died. */
  onError(presetId: string | null, stage: MilkdropErrorStage, message: string): void;
  /** A preset loaded cleanly. */
  onPresetOk(presetId: string): void;
  /** Every ~5 s while rendering. */
  onStats(s: { id: string | null; frames: number; recv: number; renderP50: number | null; renderP95: number | null }): void;
}

let butterchurnSource: Promise<string> | null = null;
/** Butterchurn's minified UMD source, fetched once per session, never before it is needed. */
function loadButterchurnSource(): Promise<string> {
  butterchurnSource ??= import('butterchurn/lib/butterchurn.min.js?raw').then((m) => m.default as string);
  return butterchurnSource;
}

export class MilkdropInstance {
  private frame: HTMLIFrameElement;
  private ready = false;
  private destroyed = false;
  private shellUp = false;
  private pending: { id: string; preset: string; blend: number } | null = null;
  private opacity = 1;
  private active = true;
  /** True once a preset has loaded: before that the frame is a black canvas and stays invisible. */
  private shown = false;
  private readyTimer: ReturnType<typeof setTimeout>;
  private onMessage: (e: MessageEvent) => void;

  constructor(host: HTMLElement, private cb: MilkdropCallbacks) {
    const f = document.createElement('iframe');
    // allow-scripts and nothing else: no allow-same-origin, so the frame's origin is opaque.
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('aria-hidden', 'true');
    f.tabIndex = -1;
    f.style.cssText =
      'position:fixed;left:0;top:0;width:100vw;height:100vh;border:0;background:#000;pointer-events:none;opacity:0';
    f.srcdoc = FRAME_SHELL_HTML;
    this.frame = f;

    this.onMessage = (e) => {
      if (e.source !== this.frame.contentWindow) return; // only our own frame
      const d = e.data ?? {};
      switch (d.type) {
        case 'shell':
          this.shellUp = true;
          this.bootstrap();
          break;
        case 'ready':
          this.ready = true;
          clearTimeout(this.readyTimer);
          if (this.pending) {
            const p = this.pending;
            this.pending = null;
            this.post({ type: 'preset', id: p.id, preset: p.preset, blend: p.blend });
          }
          break;
        case 'presetOk':
          this.shown = true;
          this.frame.style.opacity = String(this.opacity);
          this.cb.onPresetOk(d.id);
          break;
        case 'error':
          this.cb.onError(d.id ?? null, d.stage === 'compile' ? 'compile' : 'runtime', String(d.message));
          break;
        case 'stats':
          this.cb.onStats(d);
          break;
      }
    };
    window.addEventListener('message', this.onMessage);
    this.readyTimer = setTimeout(() => {
      if (!this.ready && !this.destroyed) this.cb.onError(null, 'runtime', `Milkdrop frame not ready after ${READY_TIMEOUT_MS / 1000}s`);
    }, READY_TIMEOUT_MS);
    host.appendChild(f);
  }

  private post(msg: unknown, transfer: Transferable[] = []) {
    this.frame.contentWindow?.postMessage(msg, '*', transfer);
  }

  private async bootstrap() {
    try {
      const lib = await loadButterchurnSource();
      if (this.destroyed) return;
      this.post({ type: 'init', lib, width: MILKDROP_BUFFER.width, height: MILKDROP_BUFFER.height });
    } catch (e) {
      this.cb.onError(null, 'runtime', `could not load butterchurn: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Load a preset (JSON text). Cross-fades from the current one over `blendSeconds`. */
  loadPreset(id: string, presetJson: string, blendSeconds: number) {
    if (this.destroyed) return;
    if (!this.ready) {
      this.pending = { id, preset: presetJson, blend: 0 }; // nothing to blend from yet
      return;
    }
    this.post({ type: 'preset', id, preset: presetJson, blend: Math.max(0, blendSeconds) });
  }

  /** Whole-layer opacity. At 0 the frame also stops rendering, so a hidden layer costs no GPU. */
  setOpacity(o: number) {
    this.opacity = o;
    const on = o > 0;
    if (on !== this.active) {
      this.active = on;
      this.post({ type: 'active', on });
    }
    if (this.shown) this.frame.style.opacity = String(o);
  }

  /** Forward one PCM frame (`mono[1024]|left[1024]|right[1024]`, 128 = silence). */
  pushPcm(pcm: Uint8Array | undefined) {
    if (!pcm || !this.ready || !this.active || pcm.length < 3072) return;
    const a = pcm.slice(0, 1024), b = pcm.slice(1024, 2048), c = pcm.slice(2048, 3072);
    this.post({ type: 'pcm', a, b, c }, [a.buffer, b.buffer, c.buffer]);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.readyTimer);
    window.removeEventListener('message', this.onMessage);
    this.frame.remove(); // dropping the frame frees its WebGL context and the preset's functions
  }

  /** For probes: is the frame element in the DOM. */
  get element(): HTMLIFrameElement {
    return this.frame;
  }
  get isShellUp(): boolean {
    return this.shellUp;
  }
}
