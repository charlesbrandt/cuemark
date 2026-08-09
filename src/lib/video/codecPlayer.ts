/**
 * codecPlayer.ts — main-thread half of the WebCodecs video path
 * (docs/design/webcodecs-video-path.md phase 2). One instance per codec-path deck:
 * spawns codecWorker.ts, retains a short ring of the most recently transferred
 * VideoFrames, and exposes getFrameForTime() for App.svelte's render loop and DeckCard's
 * preview canvas.
 *
 * Rate changes need nothing here: the audio clock (contentPos, fed via setClock) already
 * advances at the deck's rate — there's no v.playbackRate-equivalent on this path.
 */
import { debugLog } from "../debugLog";

export interface DemuxInfo {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  fpsHint: number;
  auCount: number;
  keyframes: { auIndex: number; ptsUs: number }[];
  duration: number;
}

// Why retain more than the 2 this used to keep: decode is forward-only (a frame earlier
// than the decoder's position can only be reached by resetting and re-decoding from the
// nearest keyframe, and this library's GOPs are ~250 frames — see
// docs/design/waveform-scrub.md), so the *only* affordable way to show an earlier frame
// during a reverse scrub is to still have it. Frames arrive pts-ascending and eviction is
// oldest-first, so the ring is exactly the recent past a backward gesture moves into.
// This costs no decode work at all; it is purely "stop closing frames so eagerly".
//
// ⚠️ Sized by **duration first, bytes second** (changed 2026-08-09 after live evidence).
// The original sizing was a pure byte budget, which gets the units wrong: what a reverse
// gesture consumes is *seconds of content*, and frames-per-second varies independently of
// bytes-per-frame. A 48MB budget bought 16 frames at 1080p — but 4 frames on the user's
// real 3840x2026 library file, i.e. 0.16s, short enough that the ring served essentially
// no gesture at all and the fix read as "not working" live. It also ignored frame rate
// entirely, so a 6fps file got 2.7s and a 60fps file 0.27s from the identical budget.
// Target the window in seconds and keep bytes as the ceiling, not the control variable.
//
// 🔬 **A/B arm in progress (2026-08-09 evening) — 0.35 is a test value, not a settled one.**
// The 0.75 arm gave 17 frames at 4K and drew a user report of audio gating out during a
// reverse jog. Measured mechanism under suspicion: presenting a frame from a 3840x2026
// source costs **54-77ms of main thread** in DeckCard's preview draw
// (`[aux-loop] preview/deck-0 … dur max=77.0 | busy 14%`), and a wider ring means *more*
// distinct frames presented per reverse gesture — ~4 on the old 4-frame ring against ~17
// here, i.e. roughly 1.2s of added main-thread blocking spread through the gesture. That
// is the same starvation shape as the legacy drawImage finding in CLAUDE.md.
//
// This arm halves the frame count (17 -> 9 at 4K/25fps) with everything else identical.
// Read the verdict off `[aux-loop] preview/deck-N drew=… dur max=…` across the two arms
// **together with** whether the audio symptom tracks — the servo telemetry already showed
// `arrived 0% snaps=0` on the 0.75 arm, so scratch-tel alone will not adjudicate this.
// If audio recovers here, per-frame presentation cost is the real ceiling at 4K and a
// wider ring is the wrong direction on that content regardless of how cheap the frames
// were to retain. See docs/design/codec-frame-cache.md.
// Exported so tests derive their expectations from it rather than hard-coding the arm's
// numbers — otherwise every A/B flip churns unrelated assertions and invites someone to
// "fix" a test by pasting in whatever the code now returns.
export const RING_TARGET_SECONDS = 0.35;
// Ceiling, hit only by very large frames. 4K at ~11.1MB/frame lands here rather than on
// the duration target. Per *deck*, so budget for it twice on a two-deck set.
const FRAME_RING_BYTES = 192 * 1024 * 1024;
const MIN_HELD_FRAMES = 2; // the historical value — never retain less than this
// Deliberately conservative: a VideoFrame pins a decoder buffer until close() and
// VideoDecoder recycles from a bounded pool, so the failure mode of raising this is
// decode stalling outright, not memory growth. See waveform-scrub.md.
const MAX_HELD_FRAMES = 32;
// localStorage override for live A/B without a rebuild: an HMR edit to this module
// invalidates App.svelte and remounts it, which tears the deck down and pauses playback
// (CLAUDE.md, "Dev server lifecycle"), making edit-driven tuning of this number expensive.
const RING_OVERRIDE_KEY = "cuemark:codecFrameRing";

/**
 * Frames to retain for `w`×`h` at `fps`: enough for `RING_TARGET_SECONDS` of reverse
 * travel, less if that would exceed the byte ceiling, honouring the override and bounds.
 *
 * `fps` is `DemuxInfo.fpsHint` and may be 0/absent for a stream the demuxer could not
 * characterise — fall back to the byte ceiling alone there rather than inventing a rate.
 */
export function heldFrameCapacity(
  w: number,
  h: number,
  fps: number,
  override?: number | null,
): number {
  if (override !== undefined && override !== null && Number.isFinite(override) && override >= MIN_HELD_FRAMES) {
    return Math.floor(override);
  }
  // I420/NV12 — 1.5 bytes per pixel. An estimate is fine: this only sizes a budget, and
  // VideoFrame.allocationSize() is not worth trusting on this WebKitGTK for a value that
  // would then have to be recomputed per frame anyway.
  const bytesPerFrame = Math.max(1, w * h * 1.5);
  const byCeiling = Math.floor(FRAME_RING_BYTES / bytesPerFrame);
  const byDuration =
    Number.isFinite(fps) && fps > 0 ? Math.ceil(RING_TARGET_SECONDS * fps) : Infinity;
  const wanted = Math.min(byDuration, byCeiling);
  return Math.min(MAX_HELD_FRAMES, Math.max(MIN_HELD_FRAMES, wanted));
}

function ringOverride(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(RING_OVERRIDE_KEY);
    return raw === null || raw === undefined ? null : Number(raw);
  } catch {
    return null; // localStorage can throw (disabled/partitioned); never block deck load on it
  }
}

// Mirrors App.svelte's contentPosTracker seek-detection heuristic (a delta this large
// between consecutive clock updates is not real playback advancing, it's a seek/restart).
//
// ⚠️ Do NOT lower this to try to make reverse scrub track more finely, and do not make the
// anchor below accumulate backward travel so that it fires within a gesture. Both were
// tried together on 2026-08-09 and are a live *audio* regression — each seek re-decodes
// ~125 frames of 1080p in software (no VA-API on this machine), which starves the main
// thread and the GStreamer audio threads until the scratch servo goes silent. The frame
// ring above is the affordable way to serve backward motion. See
// docs/design/waveform-scrub.md, "Reverse scrub video".
const BACKWARD_JUMP_SECONDS = 0.5;

export class CodecPlayer {
  private worker: Worker;
  private frames: VideoFrame[] = []; // kept pts-ascending
  private lastClockPos = 0;
  private destroyed = false;
  private loggedFirstFrame = false;
  private readonly maxHeldFrames: number;

  constructor(readonly deckId: string, port: number, demux: DemuxInfo) {
    this.maxHeldFrames = heldFrameCapacity(
      demux.codedWidth,
      demux.codedHeight,
      demux.fpsHint,
      ringOverride(),
    );
    debugLog(
      `[codecPlayer:${deckId}] frame ring: ${this.maxHeldFrames} frames ` +
      `(${demux.codedWidth}x${demux.codedHeight}, ~${(demux.codedWidth * demux.codedHeight * 1.5 * this.maxHeldFrames / 1048576).toFixed(1)}MB, ` +
      `~${demux.fpsHint > 0 ? (this.maxHeldFrames / demux.fpsHint).toFixed(2) : "?"}s of reverse scrub)`,
    );
    this.worker = new Worker(new URL("./codecWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent) => this.handleMessage(e.data);
    // Worker construction failures / uncaught synchronous throws at the worker's top level
    // (e.g. a module import error) fire here — otherwise these vanish with no signal at all
    // on this app's headless/no-devtools launch path. Does NOT catch async unhandled
    // rejections (codecWorker.ts's own `unhandledrejection` listener covers those) — see
    // docs/design/webcodecs-video-not-rendering.md.
    this.worker.onerror = (e) => {
      debugLog(`[codecPlayer:${deckId}] worker.onerror: ${e.message} (${e.filename}:${e.lineno})`);
      console.error(`[codecPlayer:${deckId}] worker.onerror:`, e);
    };
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
      if (!this.loggedFirstFrame) {
        this.loggedFirstFrame = true;
        debugLog(`[codecPlayer:${this.deckId}] first decoded frame: pts=${msg.frame.timestamp} ` +
          `${msg.frame.displayWidth}x${msg.frame.displayHeight}`);
      }
      this.frames.push(msg.frame);
      this.frames.sort((a, b) => a.timestamp - b.timestamp);
      // Oldest-first eviction: frames arrive pts-ascending, so what survives is the most
      // recent window — which is what a backward scrub reaches into. Evicted frames must
      // be close()d or the decoder's buffer pool leaks.
      while (this.frames.length > this.maxHeldFrames) this.frames.shift()!.close();
    } else if (msg.type === "error") {
      debugLog(`[codecPlayer:${this.deckId}] worker error: ${msg.message}`);
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
    // Before the earliest held frame's pts — right after a forward seek while still
    // filling, or a backward scrub that has travelled past the whole ring — show the
    // earliest held frame rather than nothing, same "don't leave a black hole" spirit as
    // uploadVideoFrame's readyState guard on the legacy path. Staleness here is bounded by
    // the ring's duration, and it is the ring growing that shrinks how often this is hit
    // at all during a reverse gesture.
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
