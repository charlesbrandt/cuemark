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
// ⚠️ Sized by a **byte budget alone**, deliberately, and *not* by a target number of
// seconds (settled 2026-08-09 evening after three measured arms — codec-frame-cache.md
// §5a). The history is worth keeping because the obvious-looking fix was tried and made
// things worse on most of the library:
//
//   content            48MB budget      0.75s target     0.35s target    192MB budget
//   3840x2026 @25      4 / 0.16s        17 / 0.68s       9  / 0.36s      17 / 0.68s
//   1280x720  @25      32 / 1.28s       19 / 0.76s       9  / 0.36s      32 / 1.28s
//
// The original 48MB budget's real fault was being too small for 4K (0.16s served no
// gesture at all and the feature read as "not working" live), not being expressed in
// bytes. A duration target fixed 4K and simultaneously *took the window away from cheap
// frames*, which the byte budget had been handing out for free — a 3.5x regression on
// sub-4K content, i.e. most of the library. Raising the ceiling to 192MB fixes 4K without
// that cost: strictly better than either duration arm on both content types, with one
// constant instead of two.
//
// Known and accepted: frame rate is ignored, so a 6fps file gets a very long window and a
// 60fps file a short one. That window is free either way — the ring costs no decode, only
// retained buffers — which is what made byte-only sizing defensible to begin with. If a
// high-frame-rate file ever *does* scrub short, the answer is a duration **floor** on top
// of this, never a target that can shrink a window the ceiling would have allowed.
//
// Per *deck*, so budget for it twice on a two-deck set.
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

// --- Scrub GOP fill ----------------------------------------------------------------------
//
// The ring above buys 0.68–1.28s of travel around the primary decoder for zero decode. Past
// that edge `getFrameForTime()` used to freeze on the nearest retained frame for the rest of
// the gesture, however far the hand kept going — the open item in todo.md and
// docs/design/codec-frame-cache.md §3.
//
// This is the second, *earned* window: when the gesture leaves what is held, the worker
// decodes the GOP the gesture is *in* on its own decoder and hands back an evenly-spaced
// subsample. It is not free — ~250 frames of software decode — but it is paid **once per
// GOP of coverage** rather than once per scrub step, which is the whole difference between
// this and the approach reverted on 2026-08-09 as a live audio regression. It runs only
// while the deck is paused, and is abandonable within one `await`.
//
// ⚠️ **It is deliberately not direction-specific**, changed 2026-08-13 after the first live
// run. Built reverse-only, it fixed reverse and left *forward* motion inside a gesture
// frozen, because the primary decoder covers exactly one direction (forward from where it is
// parked) and does not move during a gesture. Live that presented as "whichever direction I
// scrub first works and the other sticks" — in both orders. Asking for "the GOP I am in"
// serves both from one mechanism.
//
// Sized like the ring and for the same reason (codec-frame-cache.md §6): a byte ceiling,
// reported in the consumer's units. Note this is a *second* budget — a deck can hold up to
// FRAME_RING_BYTES + FILL_RING_BYTES of decoded frames.
const FILL_RING_BYTES = 192 * 1024 * 1024;
// Higher than the ring's 32 because these frames are spread across GOPs rather than
// consecutive, and **at least two GOPs must coexist**: a gesture crossing a GOP boundary
// otherwise evicts the GOP it is about to need in order to store the one it just left. That
// exact interaction produced 179 fills in one 22s gesture on the first live run — 257s of
// content decoded to cover 13.7s of travel. Frames come from the fill decoder's own pool,
// not the primary's, which is why this can exceed MAX_HELD_FRAMES.
const MAX_FILL_FRAMES = 64;
/** Frames requested per GOP. Half the total, so two GOPs always fit — see MAX_FILL_FRAMES. */
const fillPerGop = (total: number) => Math.max(2, Math.floor(total / 2));
const FILL_OVERRIDE_KEY = "cuemark:codecBackfillRing";
// Kill switch, given this feature's history — set to "0" to get the pre-2026-08-13
// behaviour (ring only, freeze at its edge) with no rebuild.
const FILL_ENABLED_KEY = "cuemark:codecReverseBackfill";
// Travel (in either direction) before a fill is considered. Deliberately larger than "enough
// to not be jitter": the probe lead below is wider than the ring, so *any* armed reverse
// motion costs a GOP decode, and a flick shorter than this should cost nothing at all. The
// ring covers it either way.
const FILL_TRIGGER_SECONDS = 0.35;
// How far ahead of the gesture, in its direction of travel, to probe for coverage — the head
// start the decode gets.
//
// It cannot be much shorter, and the reason is not obvious: a GOP decodes from its keyframe
// *forward*, so during reverse travel the frames nearest the gesture are produced **last**.
// Entering a GOP the instant it was requested means scrubbing into the part that has not
// been decoded yet. ~250 frames at this machine's software decode rate is over a second, so
// the lead has to cover that.
//
// It is *not* a distance the fill has to hold — the trigger asks "is the probe point
// covered", not "is the floor far enough away", which is what stopped the re-request loop
// that a lead wider than the retained window used to cause.
const FILL_PROBE_LEAD_SECONDS = 1.5;
// A held frame this far below the probe point still counts as covering it. Roughly one GOP
// subsample interval — beyond this the picture is visibly stuck.
const FILL_COVERAGE_GAP_SECONDS = 0.6;
// Filled frames further than this from the clock are dropped. Without it a deck that
// scrubbed once and then played forward for an hour keeps a GOP's worth of frames (and the
// decoder buffers behind them) pinned for nothing.
const FILL_KEEP_SECONDS = 30;
// 🔴 A request is considered abandoned after this long with no reply, and another may be
// sent. The worker replies on every path *by construction*, but this is the belt to that
// braces: on the first live run the in-flight flag latched and reverse fill was dead for the
// rest of the deck's life — 179 fills, then zero for 54 seconds, with nothing in the log
// saying so. **Never gate a repeating request on a boolean cleared only by a reply.**
const FILL_REQUEST_TIMEOUT_MS = 4000;
// Cooldown after a refusal, instead of latching the refused position permanently. Self
// clearing for the same reason as above: a sticky latch turns one transient refusal into a
// dead feature, and cannot be distinguished from "working but never needed".
const FILL_REFUSAL_COOLDOWN_MS = 1500;
// Consecutive requests on the same frame before it counts as a *visible* stall. The rAF loop
// runs at ~60fps and this library's content is 25fps, so runs of 1–2 are ordinary redraws of
// a frame that has not changed yet; 8 ticks is ~130ms, three frame periods, and cannot be
// anything but stuck. Measured 2026-08-13: a healthy 44s gesture repeats ~59% of its ticks.
const FROZEN_STUCK_TICKS = 8;

/**
 * Frames to retain for `w`×`h`: as many as fit in `FRAME_RING_BYTES`, within the bounds
 * and honouring the override. No frame-rate term — see the note above the constants.
 */
export function heldFrameCapacity(
  w: number,
  h: number,
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
  return Math.min(MAX_HELD_FRAMES, Math.max(MIN_HELD_FRAMES, byCeiling));
}

/**
 * Total filled frames to retain across all GOPs. Same shape as `heldFrameCapacity`,
 * separate budget — see the note above the constants for why the two are not one number.
 */
export function fillFrameCapacity(
  w: number,
  h: number,
  override?: number | null,
): number {
  if (override !== undefined && override !== null && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  const bytesPerFrame = Math.max(1, w * h * 1.5);
  const byCeiling = Math.floor(FILL_RING_BYTES / bytesPerFrame);
  return Math.min(MAX_FILL_FRAMES, Math.max(2, byCeiling));
}

function readSetting(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null; // localStorage can throw (disabled/partitioned); never block deck load on it
  }
}

function ringOverride(): number | null {
  const raw = readSetting(RING_OVERRIDE_KEY);
  return raw === null ? null : Number(raw);
}

function fillOverride(): number | null {
  const raw = readSetting(FILL_OVERRIDE_KEY);
  return raw === null ? null : Number(raw);
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

/**
 * Per-gesture cache counters, emitted in one burst at gesture end.
 *
 * This is the instrument `docs/design/codec-frame-cache.md` §2.2 says to build before
 * tuning anything else here: without it, "is the retained window the right size" is
 * unanswerable from a log, and it went unanswered for a full session while a 0.16s ring
 * shipped and read as "not working". `hit` vs `stale` is whether requests were served or
 * fell off the end; `reach` vs `held` is whether the window is too small or wasted.
 */
interface CacheStats {
  t0: number;
  req: number;
  /** served from the live ring */
  hitRing: number;
  /** served from a filled GOP — the frames this feature exists to produce */
  hitFill: number;
  /** older than everything held */
  stale: number;
  /**
   * Requests where the position moved but the frame served did not.
   *
   * 🔴 This counter exists because live run 1 reported `hit=100% stale=0` for a gesture the
   * user watched stick. `stale` only means "older than everything held"; returning the same
   * frame 300 ticks running is a hit by that definition. A hit-rate that reads perfect
   * during a freeze is worse than no instrument at all — it actively argues the feature is
   * working.
   *
   * ⚠️ **A high `frozen` is normal and is not the signal.** The rAF loop runs at ~60fps and
   * this content is 25fps, so ~58% of ticks legitimately redraw the frame they already
   * drew. `stuck` is the number to read.
   */
  frozen: number;
  /** runs of `FROZEN_STUCK_TICKS`+ — i.e. long enough to *see*. This is the freeze signal. */
  stuck: number;
  /** longest unbroken run of frozen requests, in ticks */
  worstRun: number;
  /** travel between the extremes of position requested this episode, seconds */
  reach: number;
  minReqUs: number;
  maxReqUs: number;
  /** requests sent to the worker, which is not the same as fills that ran */
  fillsRequested: number;
  fills: number;
  fillFrames: number;
  fillFedAus: number;
  fillMs: number;
  reasons: string[];
}

function newStats(): CacheStats {
  return {
    t0: performance.now(), req: 0, hitRing: 0, hitFill: 0, stale: 0,
    frozen: 0, stuck: 0, worstRun: 0,
    reach: 0, minReqUs: Number.POSITIVE_INFINITY, maxReqUs: Number.NEGATIVE_INFINITY,
    fillsRequested: 0, fills: 0, fillFrames: 0, fillFedAus: 0, fillMs: 0, reasons: [],
  };
}

/** A GOP the worker has decoded for us, as reported back on `fillDone`. */
interface FilledGop {
  startUs: number;
  endUs: number;
}

export class CodecPlayer {
  private worker: Worker;
  private frames: VideoFrame[] = []; // kept pts-ascending
  /**
   * Frames from filled GOPs, pts-ascending. Deliberately a *separate* collection from
   * `frames`: they sit outside the ring's window by construction, so the ring's
   * oldest-first eviction would throw them away the instant they arrived.
   */
  private fillFrames: VideoFrame[] = [];
  private lastClockPos = 0;
  private destroyed = false;
  private loggedFirstFrame = false;
  private readonly maxHeldFrames: number;
  private readonly maxFillFrames: number;
  private readonly fillEnabled: boolean;
  /** Signed travel since the last direction change — magnitude arms a fill, sign aims it. */
  private travel = 0;
  /**
   * When the outstanding request was sent, or null. A timestamp rather than a boolean so a
   * reply that never arrives cannot disable the feature permanently — see
   * FILL_REQUEST_TIMEOUT_MS.
   */
  private fillSentAtMs: number | null = null;
  /** Self-clearing backoff after a refusal, instead of a permanent latch. */
  private fillCooldownUntilMs = 0;
  /** GOPs the worker has decoded for us, so the same one is never requested twice. */
  private filledGops: FilledGop[] = [];
  /** Last frame handed to a consumer — never evicted while it may still be on screen. */
  private lastServed: VideoFrame | null = null;
  private lastRequestUs = Number.NaN;
  private frozenRun = 0;
  private stats = newStats();
  /** Demuxed coded dimensions — DeckCard's resolution readout reads these directly. */
  readonly codedWidth: number;
  readonly codedHeight: number;

  constructor(readonly deckId: string, port: number, demux: DemuxInfo) {
    this.codedWidth = demux.codedWidth;
    this.codedHeight = demux.codedHeight;
    this.maxHeldFrames = heldFrameCapacity(
      demux.codedWidth,
      demux.codedHeight,
      ringOverride(),
    );
    this.fillEnabled = readSetting(FILL_ENABLED_KEY) !== "0";
    this.maxFillFrames = this.fillEnabled
      ? fillFrameCapacity(demux.codedWidth, demux.codedHeight, fillOverride())
      : 0;
    // The seconds figure is the point of this line: bytes are what the ring is billed in,
    // seconds are what a gesture spends, and a wrong window is only obvious in seconds.
    debugLog(
      `[codecPlayer:${deckId}] frame ring: ${this.maxHeldFrames} frames ` +
      `(${demux.codedWidth}x${demux.codedHeight}, ~${(demux.codedWidth * demux.codedHeight * 1.5 * this.maxHeldFrames / 1048576).toFixed(1)}MB, ` +
      `~${demux.fpsHint > 0 ? (this.maxHeldFrames / demux.fpsHint).toFixed(2) : "?"}s of reverse scrub)`,
    );
    // Reported separately, and in frames-per-GOP rather than seconds, because that is the
    // unit this window is spent in: it covers whole GOPs, and what varies is how smooth
    // that coverage is.
    debugLog(
      `[codecPlayer:${deckId}] scrub gop fill: ` +
      (this.fillEnabled
        ? `${fillPerGop(this.maxFillFrames)} frames/GOP, ${this.maxFillFrames} retained ` +
          `(~${(demux.codedWidth * demux.codedHeight * 1.5 * this.maxFillFrames / 1048576).toFixed(1)}MB, ` +
          `~${(fillPerGop(this.maxFillFrames) / 10).toFixed(1)}fps across a 10s GOP)`
        : `disabled (${FILL_ENABLED_KEY}=0)`),
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
      durationUs: Math.round(demux.duration * 1_000_000),
    });
  }

  private handleMessage(msg: {
    type: string; frame?: VideoFrame; message?: string;
    kept?: number; fed?: number; ms?: number; reason?: string;
    atUs?: number; startPtsUs?: number; endPtsUs?: number;
  }) {
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
    } else if (msg.type === "fillFrame" && msg.frame) {
      if (this.destroyed || !this.fillEnabled) { msg.frame.close(); return; }
      this.fillFrames.push(msg.frame);
      this.fillFrames.sort((a, b) => a.timestamp - b.timestamp);
      this.evictFill();
    } else if (msg.type === "fillDone") {
      this.fillSentAtMs = null;
      this.stats.fills++;
      this.stats.fillFrames += Math.max(0, msg.kept ?? 0);
      this.stats.fillFedAus += msg.fed ?? 0;
      this.stats.fillMs += msg.ms ?? 0;
      if (msg.reason && msg.reason !== "ok") this.stats.reasons.push(msg.reason);
      if ((msg.kept ?? 0) > 0 && msg.startPtsUs !== undefined && msg.endPtsUs !== undefined) {
        // Remember the GOP so the trigger never asks for it again while we still hold part
        // of it. This — not a lead/capacity balance — is what stops the re-request loop
        // that ran 179 fills in one gesture on the first live run.
        this.filledGops.push({ startUs: msg.startPtsUs, endUs: msg.endPtsUs });
      } else {
        // A short self-clearing backoff, never a permanent latch: a sticky refusal turns one
        // transient into a dead feature that reads identically to "working but never needed".
        this.fillCooldownUntilMs = performance.now() + FILL_REFUSAL_COOLDOWN_MS;
      }
    } else if (msg.type === "error") {
      debugLog(`[codecPlayer:${this.deckId}] worker error: ${msg.message}`);
      console.error(`[codecPlayer:${this.deckId}] worker error:`, msg.message);
    }
  }

  /**
   * Is there a held frame close enough at or below `atUs` to show there?
   *
   * "At or below" because that is exactly what `getFrameForTime` will pick. A frame *above*
   * the position is not coverage, however near — it is the future.
   */
  private coveredAt(atUs: number): boolean {
    const floor = atUs - FILL_COVERAGE_GAP_SECONDS * 1_000_000;
    for (const f of this.frames) if (f.timestamp <= atUs && f.timestamp >= floor) return true;
    for (const f of this.fillFrames) if (f.timestamp <= atUs && f.timestamp >= floor) return true;
    return false;
  }

  /** Forget GOPs we no longer hold a single frame from — they may be requested again. */
  private pruneFilledGops(): void {
    this.filledGops = this.filledGops.filter((g) =>
      this.fillFrames.some((f) => f.timestamp >= g.startUs && f.timestamp < g.endUs));
  }

  /**
   * Drop filled frames once over capacity, **against the direction of travel first**.
   *
   * Plain furthest-from-the-clock was the first attempt and it is wrong in the one case that
   * matters: a gesture crossing into a newly-filled GOP is, by definition, still nearer the
   * GOP it is leaving, so symmetric eviction discards the frames it is heading into as fast
   * as they arrive. Frames on the travel side are scored as if they were `TRAVEL_BIAS` times
   * nearer, so the side being left goes first.
   */
  private evictFill(): void {
    const TRAVEL_BIAS = 4;
    const clockUs = this.lastClockPos * 1_000_000;
    const dir = this.travel < 0 ? -1 : this.travel > 0 ? 1 : 0;
    while (this.fillFrames.length > this.maxFillFrames) {
      let worst = -1;
      let worstScore = -1;
      for (let i = 0; i < this.fillFrames.length; i++) {
        const f = this.fillFrames[i];
        if (f === this.lastServed) continue; // may still be on screen this tick
        const delta = f.timestamp - clockUs;
        const ahead = dir !== 0 && Math.sign(delta) === dir;
        const score = Math.abs(delta) / (ahead ? TRAVEL_BIAS : 1);
        if (score > worstScore) { worstScore = score; worst = i; }
      }
      if (worst < 0) break;
      this.fillFrames.splice(worst, 1)[0].close();
    }
    this.pruneFilledGops();
  }

  /** Largest-pts held frame with pts <= t (seconds). Never assumes CFR — VFR-safe. */
  getFrameForTime(t: number): VideoFrame | null {
    const targetUs = t * 1_000_000;
    let best: VideoFrame | null = null;
    let fromRing = false;
    for (const f of this.frames) {
      if (f.timestamp <= targetUs && (!best || f.timestamp > best.timestamp)) { best = f; fromRing = true; }
    }
    // Filled GOPs sit outside the ring's window, in either direction, and are searched with
    // the same "largest pts at or before t" rule rather than as a fallback — so the boundary
    // between the two collections needs no special case.
    for (const f of this.fillFrames) {
      if (f.timestamp <= targetUs && (!best || f.timestamp > best.timestamp)) { best = f; fromRing = false; }
    }

    const s = this.stats;
    s.req++;
    if (best) {
      if (fromRing) s.hitRing++;
      else s.hitFill++;
    } else {
      s.stale++;
    }
    if (targetUs < s.minReqUs) s.minReqUs = targetUs;
    if (targetUs > s.maxReqUs) s.maxReqUs = targetUs;
    if (s.maxReqUs > s.minReqUs) s.reach = (s.maxReqUs - s.minReqUs) / 1_000_000;

    // Before everything held — right after a forward seek while still filling, or a gesture
    // that has outrun the fill — show the nearest held frame rather than nothing, same
    // "don't leave a black hole" spirit as uploadVideoFrame's readyState guard on the legacy
    // path.
    const served = best ?? this.fillFrames[0] ?? this.frames[0] ?? null;
    // The frozen check: the position moved but the picture did not. See CacheStats.frozen.
    //
    // ⚠️ Gated on the position having actually changed, and **the run counter is not touched
    // otherwise**. `getFrameForTime` is called twice per tick — once by App.svelte's render
    // loop, once by DeckCard's preview — with the same `t`. Treating the duplicate as
    // "not frozen" reset the run on every other call, which made a run of 2 structurally
    // impossible to record and reported `run 1` through a 44-second gesture. An instrument
    // with two callers has to count ticks, not calls.
    if (targetUs !== this.lastRequestUs) {
      if (served && served === this.lastServed) {
        s.frozen++;
        this.frozenRun++;
        if (this.frozenRun > s.worstRun) s.worstRun = this.frozenRun;
        if (this.frozenRun === FROZEN_STUCK_TICKS) s.stuck++; // once per run, at the crossing
      } else {
        this.frozenRun = 0;
      }
      this.lastRequestUs = targetUs;
    }
    this.lastServed = served;
    return served;
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
    // Signed and direction-resetting: the magnitude arms a fill, the sign aims it. Reset on
    // reversal rather than accumulated, so a gesture that turns around arms again promptly
    // — the case that was broken outright when this only tracked backward travel.
    const delta = contentPos - this.lastClockPos;
    if (delta !== 0) {
      this.travel = Math.sign(delta) === Math.sign(this.travel) ? this.travel + delta : delta;
    }
    this.lastClockPos = contentPos;
    this.worker.postMessage({ type: "clock", contentPos, playing });
    this.pruneDistantFill(contentPos);
    this.maybeRequestFill(contentPos, playing);
  }

  /** Let go of a filled GOP the deck has since played far away from. */
  private pruneDistantFill(contentPos: number): void {
    if (this.fillFrames.length === 0) return;
    const clockUs = contentPos * 1_000_000;
    const keepUs = FILL_KEEP_SECONDS * 1_000_000;
    let dropped = false;
    for (let i = this.fillFrames.length - 1; i >= 0; i--) {
      const f = this.fillFrames[i];
      if (f !== this.lastServed && Math.abs(f.timestamp - clockUs) > keepUs) {
        this.fillFrames.splice(i, 1);
        f.close();
        dropped = true;
      }
    }
    if (dropped) this.pruneFilledGops();
  }

  /**
   * Ask the worker for the GOP the gesture is heading into, when nothing held covers it.
   *
   * The probe point — `contentPos` projected forward by the lead, **in whichever direction
   * the gesture is moving** — is the whole design. Asking "is where I am about to be
   * covered" rather than "is the region below the ring exhausted" is what makes this serve
   * forward and reverse from one mechanism, and what stops it re-requesting: a GOP already
   * fetched and still partly held covers its own span, so the trigger goes quiet by itself.
   *
   * The remaining clauses each prevent decode the gesture will not use: `playing`, because a
   * playing deck's audio must never contend with this; `travel`, so poll jitter cannot arm
   * it; the in-flight and cooldown checks, so one request is made rather than one per rAF —
   * both time-bounded so neither can wedge the feature permanently.
   */
  private maybeRequestFill(contentPos: number, playing: boolean): void {
    if (!this.fillEnabled || this.destroyed || playing) return;
    if (Math.abs(this.travel) < FILL_TRIGGER_SECONDS) return;
    const now = performance.now();
    if (this.fillSentAtMs !== null && now - this.fillSentAtMs < FILL_REQUEST_TIMEOUT_MS) return;
    if (now < this.fillCooldownUntilMs) return;

    const dir = this.travel < 0 ? -1 : 1;
    const posUs = contentPos * 1_000_000;

    // Forward travel while the ring is still around the gesture needs nothing from us: the
    // primary decoder's decode-ahead gate opens as the clock advances into it and it feeds
    // itself. Only reverse travel is something it structurally cannot do — and forward
    // travel *away* from a parked ring, where it can only catch up by decoding every frame
    // in between (~200 frames per 8s of travel here), which a moving hand outruns.
    const ringLo = this.frames[0]?.timestamp;
    const ringHi = this.frames[this.frames.length - 1]?.timestamp;
    const gapUs = FILL_COVERAGE_GAP_SECONDS * 1_000_000;
    const primaryFollowing =
      ringLo !== undefined && ringHi !== undefined &&
      posUs >= ringLo - gapUs && posUs <= ringHi + gapUs;
    if (dir > 0 && primaryFollowing) return;

    const probeUs = Math.max(0, posUs + dir * FILL_PROBE_LEAD_SECONDS * 1_000_000);
    if (this.coveredAt(probeUs)) return;
    if (this.filledGops.some((g) => probeUs >= g.startUs && probeUs < g.endUs)) return;

    this.fillSentAtMs = now;
    this.stats.fillsRequested++;
    this.worker.postMessage({
      type: "fillGop",
      atUs: probeUs,
      capacity: fillPerGop(this.maxFillFrames),
    });
  }

  seek(target: number): void {
    if (this.destroyed) return;
    this.lastClockPos = target;
    this.resetFillState();
    this.dropAllFrames();
    this.worker.postMessage({ type: "seek", target });
  }

  /** Every guard here is time- or content-derived, so this is only ever an optimisation. */
  private resetFillState(): void {
    this.travel = 0;
    this.fillSentAtMs = null;
    this.fillCooldownUntilMs = 0;
    this.filledGops = [];
  }

  /**
   * Settle the picture after a scrub gesture ends. Tier 3 of
   * docs/design/codec-frame-cache.md §3 — one exact seek, deliberately *outside* the
   * gesture, where its ~125 frames of decode cannot starve the scratch servo.
   *
   * Required by the GOP fill rather than merely nice: the primary decoder does not move
   * during a gesture (its decode-ahead gate stops it), so it is left sitting wherever the
   * gesture began. While a gesture could only travel the ring's 1.28s, resuming playback
   * froze the picture for an unnoticeable moment. With the fill a gesture can travel tens of
   * seconds, and pressing play would then show nothing new until the clock climbed all the
   * way back — a far worse bug than the one this feature fixes.
   *
   * No-ops when the gesture ended inside the live ring, which is the common short-scrub
   * case: the decoder is already within reach there and a seek would buy nothing.
   */
  settleAfterScrub(pos: number): void {
    if (this.destroyed) return;
    const oldest = this.frames[0];
    const newest = this.frames[this.frames.length - 1];
    this.emitCacheStats();
    this.resetFillState();
    this.lastClockPos = pos;
    const posUs = pos * 1_000_000;
    if (oldest && newest && posUs >= oldest.timestamp && posUs <= newest.timestamp) return;
    // Only the live ring is dropped. The filled frames are exactly what covers the gap until
    // the seek's first output arrives, and they are the region the deck now sits in.
    for (const f of this.frames) f.close();
    this.frames = [];
    this.worker.postMessage({ type: "seek", target: pos });
  }

  /** Gesture ended with no settle needed (silent path, or a press that never moved). */
  noteScrubEnded(): void {
    if (this.destroyed) return;
    this.emitCacheStats();
    this.travel = 0;
  }

  private emitCacheStats(): void {
    const s = this.stats;
    this.stats = newStats();
    this.frozenRun = 0;
    if (s.req === 0) return;
    const dur = (performance.now() - s.t0) / 1000;
    const hits = s.hitRing + s.hitFill;
    // ⚠️ `stuck` leads deliberately. `hit` reads 100% during a completely stuck picture —
    // not a hypothetical, it is what live run 1 reported while the user watched it stick.
    // See CacheStats.frozen for why `frozen` alone is not the signal either.
    debugLog(
      `[frame-cache/${this.deckId}] ${dur.toFixed(1)}s | ` +
      `stuck=${s.stuck} (worst run ${s.worstRun}) frozen=${s.frozen} | req=${s.req} ` +
      `hit=${hits} (${Math.round((hits / s.req) * 100)}%) ` +
      `ring=${s.hitRing} fill=${s.hitFill} stale=${s.stale} | ` +
      `travelled ${s.reach.toFixed(2)}s`,
    );
    // Emitted unconditionally, including all-zero. Suppressing it when nothing ran hid the
    // single most diagnostic case on the first live run: "requested and refused" and "never
    // requested at all" looked identical, and the difference was the whole bug.
    debugLog(
      `[frame-cache/${this.deckId}] fills req=${s.fillsRequested} done=${s.fills} ` +
      `frames=${s.fillFrames} aus=${s.fillFedAus} decode=${s.fillMs}ms held=${this.fillFrames.length}` +
      (s.reasons.length ? ` reasons: ${[...new Set(s.reasons)].join(",")}` : ""),
    );
  }

  private dropAllFrames(): void {
    for (const f of this.frames) f.close();
    this.frames = [];
    for (const f of this.fillFrames) f.close();
    this.fillFrames = [];
    this.lastServed = null;
    this.filledGops = [];
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
    this.resetFillState();
    this.dropAllFrames();
    this.worker.postMessage({ type: "loopWrap" });
  }

  destroy(): void {
    this.destroyed = true;
    this.dropAllFrames();
    this.worker.postMessage({ type: "destroy" });
    this.worker.terminate();
  }
}
