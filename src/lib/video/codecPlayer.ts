/**
 * codecPlayer.ts — main-thread half of the WebCodecs video path
 * (docs/design/webcodecs-video-path.md phase 2). One instance per codec-path deck:
 * spawns codecWorker.ts, holds the <=2 most recently transferred VideoFrames, and
 * exposes getFrameForTime() for App.svelte's render loop and DeckCard's preview canvas.
 *
 * Rate changes need nothing here: the audio clock (contentPos, fed via setClock) already
 * advances at the deck's rate — there's no v.playbackRate-equivalent on this path.
 */

export interface DemuxInfo {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  fpsHint: number;
  auCount: number;
  keyframes: { auIndex: number; ptsUs: number }[];
  duration: number;
}

const HELD_FRAMES = 2;
// Mirrors App.svelte's contentPosTracker seek-detection heuristic (a delta this large
// between consecutive clock updates is not real playback advancing, it's a seek/restart).
const BACKWARD_JUMP_SECONDS = 0.5;

export class CodecPlayer {
  private worker: Worker;
  private frames: VideoFrame[] = []; // kept pts-ascending
  private lastClockPos = 0;
  private destroyed = false;

  constructor(readonly deckId: string, port: number, demux: DemuxInfo) {
    this.worker = new Worker(new URL("./codecWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent) => this.handleMessage(e.data);
    this.worker.postMessage({
      type: "init",
      deckId,
      port,
      codec: demux.codec,
      auCount: demux.auCount,
      keyframes: demux.keyframes,
      fpsHint: demux.fpsHint,
    });
  }

  private handleMessage(msg: { type: string; frame?: VideoFrame; message?: string }) {
    if (msg.type === "frame" && msg.frame) {
      if (this.destroyed) { msg.frame.close(); return; }
      this.frames.push(msg.frame);
      this.frames.sort((a, b) => a.timestamp - b.timestamp);
      while (this.frames.length > HELD_FRAMES) this.frames.shift()!.close();
    } else if (msg.type === "error") {
      console.error(`[codecPlayer:${this.deckId}] worker error:`, msg.message);
    }
  }

  /** Largest-pts held frame with pts <= t (seconds). Never assumes CFR — VFR-safe. */
  getFrameForTime(t: number): VideoFrame | null {
    const targetUs = t * 1_000_000;
    let best: VideoFrame | null = null;
    for (const f of this.frames) {
      if (f.timestamp <= targetUs && (!best || f.timestamp > best.timestamp)) best = f;
    }
    // Before the first frame's pts (e.g. right after a forward seek, still filling): show
    // the earliest held frame rather than nothing, same "don't leave a black hole" spirit
    // as uploadVideoFrame's readyState guard on the legacy path.
    return best ?? this.frames[0] ?? null;
  }

  /** Call at most once per rAF — mirrors audioSync.ts's throttling discipline. */
  setClock(contentPos: number, playing: boolean): void {
    if (this.destroyed) return;
    if (contentPos < this.lastClockPos - BACKWARD_JUMP_SECONDS) {
      // A seek/restart landed without going through seek() explicitly (e.g. the Rust
      // EOS-then-replay-from-zero path) — treat it exactly like an explicit seek.
      this.seek(contentPos);
      return;
    }
    this.lastClockPos = contentPos;
    this.worker.postMessage({ type: "clock", contentPos, playing });
  }

  seek(target: number): void {
    if (this.destroyed) return;
    this.lastClockPos = target;
    for (const f of this.frames) f.close();
    this.frames = [];
    this.worker.postMessage({ type: "seek", target });
  }

  setLoop(bounds: { inPos: number; outPos: number } | null): void {
    if (this.destroyed) return;
    if (bounds) this.worker.postMessage({ type: "loop", inPos: bounds.inPos, outPos: bounds.outPos });
    else this.worker.postMessage({ type: "loopClear" });
  }

  /**
   * Called when the deck's custom loop (loopIn/loopOut) wraps — i.e. the position-poll
   * in App.svelte's frame() sees contentPos reach loopOut, the codec-path equivalent of
   * the legacy path's `v.ontimeupdate` loop-back. Swaps to the worker's pre-decoded loop
   * buffer (if primed) with no seek. `loopInPos` is applied to lastClockPos immediately so
   * the *next* setClock() call doesn't also see this as a backward jump and double-seek.
   */
  notifyLoopWrap(loopInPos: number): void {
    if (this.destroyed) return;
    this.lastClockPos = loopInPos;
    for (const f of this.frames) f.close();
    this.frames = [];
    this.worker.postMessage({ type: "loopWrap" });
  }

  destroy(): void {
    this.destroyed = true;
    for (const f of this.frames) f.close();
    this.frames = [];
    this.worker.postMessage({ type: "destroy" });
    this.worker.terminate();
  }
}
