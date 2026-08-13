/**
 * codecWorker.ts — owns the VideoDecoder + AU fetch/decode-ahead loop for one codec-path
 * deck (docs/design/webcodecs-video-path.md phase 2). Runs in a Worker (spawned by
 * codecPlayer.ts) so decode never blocks the main thread. One instance per deck.
 *
 * **H.264 is always avc mode** (`description` built from the first keyframe's SPS/PPS,
 * chunks re-muxed from Annex-B to length-prefixed) — annexb-without-description is
 * confirmed dead on this app's real hardware decode config, see h264.ts's doc comment
 * and docs/design/webcodecs-video-path.md "Phase 1 results". Do not attempt it here.
 *
 * **VP9 (phase 7) is the opposite and equally non-negotiable**: no `description`, and the
 * AU bytes go to `decode()` untouched. `vp9parse`'s super-frame-aligned buffers already
 * are what WebCodecs wants, and there is no parameter-set NAL concept to hoist out of
 * them. `needsAvcRemux` is the single switch; everything else on this path is codec-blind.
 */
import { gopContaining, isRefusal } from "./codecGop";
import { annexBToAvc, buildAvcDescription, findSpsAndPps, parseAuFrames, splitAnnexBNals, type Au } from "./h264";

interface InitMsg {
  type: "init";
  deckId: string;
  port: number;
  codec: string;
  auCount: number;
  keyframes: { auIndex: number; ptsUs: number }[];
  fpsHint: number;
  /** Track duration in µs — the high edge of the final GOP, which has no next keyframe. */
  durationUs: number;
}
interface ClockMsg { type: "clock"; contentPos: number; playing: boolean }
interface SeekMsg { type: "seek"; target: number }
interface LoopMsg { type: "loop"; inPos: number; outPos: number }
interface LoopClearMsg { type: "loopClear" }
interface LoopWrapMsg { type: "loopWrap" }
interface FillGopMsg { type: "fillGop"; atUs: number; capacity: number }
interface DestroyMsg { type: "destroy" }
type InMsg =
  | InitMsg | ClockMsg | SeekMsg | LoopMsg | LoopClearMsg | LoopWrapMsg | FillGopMsg | DestroyMsg;

const FETCH_BATCH = 90; // ~3s at 30fps; encoded AUs are cheap (~1MB/s/deck, see design doc)
const QUEUE_HIGH_WATER = 8;
const LOOP_PREFETCH_FRAMES = 6;
const LOOP_LOOKAHEAD_SECONDS = 1.5;

// --- Scrub GOP fill (docs/design/codec-frame-cache.md §3) --------------------------------
//
// Refuse a GOP longer than this many AUs. Every fill decodes its whole GOP from the keyframe
// forward — that is the only way to reach any frame inside it — so the GOP length *is* the
// CPU bill. This library's GOPs are ~250 frames (keyframe intervals of 8.34s and 10.0s
// measured), so 600 passes every real file and still refuses a pathological single-keyframe
// encode outright rather than spending minutes of decode on it. A refusal is reported, not
// silent.
const FILL_MAX_GOP_AUS = 600;
// Pause between feed attempts once the decoder's queue is full. This is the whole throttle:
// it caps how hard one fill can drive a core, and it yields to the worker's message queue so
// a seek/destroy arriving mid-fill is acted on within a few ms rather than after the GOP.
const FILL_PACE_MS = 4;
// 🔴 Hard ceilings on how long one fill may wait, because **a fill that never finishes is a
// fill that never replies, and codecPlayer.ts cannot request another until it does.** The
// first live run (2026-08-13) ended with backfill silently dead for the rest of the deck's
// life — 179 fills in one gesture, then zero for the next 54 seconds — and an unbounded wait
// on a decoder that had stopped draining is the leading candidate. `VideoDecoder` recycles
// from a bounded pool and this app now pins up to 96 frames across two collections, so
// "the decoder stops draining" is a state that really can occur. Both waits below are
// bounded, and both report the timeout rather than hanging.
const FILL_QUEUE_WAIT_MS = 1500;
const FILL_FLUSH_WAIT_MS = 1500;
// AU pts are in decode order, which is not presentation order once B-frames are involved,
// so a strict "stop feeding at the GOP's last AU" can cut off a frame that presents just
// inside it. A third of a second of slack costs a handful of AUs.
const FILL_PTS_SLACK_US = 333_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let deckId = "";
let port = 0;
let codec = "";
let auCount = 0;
let keyframes: { auIndex: number; ptsUs: number }[] = [];
let fpsHint = 30;
let durationUs = 0;
let description: Uint8Array | null = null;
// True only for `avc1.*`. Decides both "build a description from SPS/PPS at init" and
// "re-mux every AU Annex-B -> length-prefixed before decode()". VP9 does neither.
let needsAvcRemux = true;

/** The decoder config for the current codec — `description` is H.264-only (see module doc). */
function decoderConfig(): VideoDecoderConfig {
  return description ? { codec, description } : { codec };
}

/**
 * The bytes for one AU as `decode()` wants them. H.264 needs the Annex-B -> avc re-mux;
 * every other codec on this path is already framed correctly by its GStreamer parser.
 */
function chunkData(au: Au): Uint8Array {
  return needsAvcRemux ? annexBToAvc(au.data) : au.data;
}

let decoder: VideoDecoder | null = null;
let nextFeedIndex = 0;
let eos = false;
// Set on init/seek/loop-wrap fallback; drop decoded output whose pts is still before the
// target (decode must start from the nearest keyframe <= target, which is usually earlier).
let dropBeforeUs: number | null = null;

let clockPos = 0;
let playing = false;

// AUs fetched so far, sparse (only what's been requested); values are the parsed AU.
const auCache = new Map<number, Au>();
let fetchInFlight: Promise<void> | null = null;

// Loop pre-decode: a second decoder fed from loopIn's keyframe, primed with
// LOOP_PREFETCH_FRAMES frames before the primary clock reaches loopOut, so the swap at
// wraparound needs no seek (no mechanism-A trigger, no stall) for the common case.
interface LoopBounds { inPos: number; outPos: number }
let loopBounds: LoopBounds | null = null;
let loopDecoder: VideoDecoder | null = null;
let loopFeedIndex = -1;
let loopFramesReady: VideoFrame[] = [];
let loopPrefetchStarted = false;
// Flips true the instant handleLoopWrap() promotes loopDecoder to primary — its output
// callback (fixed at construction) checks this to switch from "buffer for later" to
// "behave like the primary decoder" without needing a new VideoDecoder instance.
let loopIsNowPrimary = false;

// Scrub GOP fill: a *third* decoder that decodes the GOP a scrub gesture is currently in
// and keeps an evenly-spaced subsample of it, so a gesture that has travelled away from
// what the primary decoder covers keeps getting pictures instead of freezing.
//
// Why a separate decoder rather than reusing the primary: the primary's position is what
// makes forward playback resumable without a seek, and its already-transferred frames are
// the ring itself. Resetting it mid-gesture is precisely the change that was built and
// reverted on 2026-08-09 as a live audio regression.
//
// Why one whole GOP at a time: reaching *any* frame inside a GOP costs decoding from its
// keyframe, so a 1s slice and the full 10s GOP cost the same. Amortising over the whole GOP
// turns ~250 frames of decode per scrub step (the reverted design) into ~250 frames per GOP
// of coverage.
//
// ⚠️ Why this is not direction-specific (changed 2026-08-13 after the first live run): the
// primary decoder covers exactly one direction — forward from wherever it is parked — and
// during a gesture it does not move at all. A reverse-only fill therefore left whichever
// direction the primary did *not* cover permanently frozen, which live presented as "the
// first direction I scrub in works and the other sticks", in both orders.
let fillDecoder: VideoDecoder | null = null;
// Bumped by every seek/loop-wrap/destroy and by each new request. A run whose generation no
// longer matches drops its output and stops feeding — this is what makes an in-flight fill
// abandonable within one `await` rather than at the end of its GOP.
let fillGen = 0;
let fillRunning = false;
// Region and subsampling state for the run currently owning the decoder's output callback
// (the callback is fixed at construction, so it reads these rather than a closure).
let fillEndUs = 0;
let fillKeepNextUs = 0;
let fillStepUs = 0;
let fillCapacity = 0;
let fillKept = 0;

function post(msg: unknown, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

// configure() throws synchronously on an invalid config (bad codec string, malformed
// description, decoder already closed, …). Every call site below used to call it bare —
// a synchronous throw inside handleInit/handleSeek/maybeStartLoopPrefetch (all async
// functions invoked fire-and-forget from self.onmessage) becomes an unhandled rejection
// in the Worker with no `self.onerror` handler registered, so it never reaches
// codecPlayer.ts's `error` message handling and never prints anywhere — the decoder
// then just sits in a non-"configured" state forever and pump()'s state guards silently
// stop feeding it. See docs/design/webcodecs-video-not-rendering.md.
function configureDecoder(d: VideoDecoder, config: VideoDecoderConfig, context: string): boolean {
  try {
    d.configure(config);
    warnedNeverConfigured = false; // re-arm the pump() one-shot for the next failure, if any
    return true;
  } catch (e) {
    post({ type: "error", message: `${context}: configure() threw: ${e}` });
    return false;
  }
}

async function fetchAus(from: number, count: number): Promise<Au[]> {
  const res = await fetch(
    `http://127.0.0.1:${port}/demux/${encodeURIComponent(deckId)}/aus?from=${from}&count=${count}`,
  );
  if (!res.ok) throw new Error(`AU fetch failed: ${res.status}`);
  return parseAuFrames(new Uint8Array(await res.arrayBuffer()));
}

function keyframeAuIndexAtOrBefore(targetSecs: number): number {
  let idx = 0;
  for (const kf of keyframes) {
    if (kf.ptsUs / 1_000_000 <= targetSecs) idx = kf.auIndex;
    else break;
  }
  return idx;
}

async function ensureAuFetched(index: number): Promise<Au | undefined> {
  if (auCache.has(index)) return auCache.get(index);
  if (index >= auCount) return undefined;
  if (fetchInFlight) await fetchInFlight;
  if (auCache.has(index)) return auCache.get(index);
  const p = (async () => {
    try {
      const aus = await fetchAus(index, FETCH_BATCH);
      for (let i = 0; i < aus.length; i++) auCache.set(index + i, aus[i]);
    } catch (e) {
      post({ type: "error", message: String(e) });
    }
  })();
  fetchInFlight = p;
  await p;
  fetchInFlight = null;
  return auCache.get(index);
}

function aheadSeconds(): number {
  return 5 / (fpsHint > 0 ? fpsHint : 30); // ~5 frames of decode-ahead, per the design doc's N=4-6
}

function handlePrimaryFrameOutput(frame: VideoFrame) {
  if (dropBeforeUs !== null) {
    if (frame.timestamp < dropBeforeUs) { frame.close(); return; }
    dropBeforeUs = null;
  }
  post({ type: "frame", frame }, [frame]);
}

function makeDecoder(): VideoDecoder {
  return new VideoDecoder({
    output: handlePrimaryFrameOutput,
    error: (e) => post({ type: "error", message: String(e) }),
  });
}

function makeLoopDecoder(): VideoDecoder {
  return new VideoDecoder({
    output: (frame) => {
      if (loopIsNowPrimary) { handlePrimaryFrameOutput(frame); return; }
      if (!loopBounds || frame.timestamp < Math.round(loopBounds.inPos * 1_000_000)) { frame.close(); return; }
      if (loopFramesReady.length >= LOOP_PREFETCH_FRAMES) { frame.close(); return; }
      loopFramesReady.push(frame);
    },
    error: (e) => post({ type: "error", message: `loop decoder: ${e}` }),
  });
}

function makeFillDecoder(): VideoDecoder {
  return new VideoDecoder({
    output: (frame) => {
      // Everything here is a drop-and-close path except the last branch. A fill decodes far
      // more frames than it keeps by construction (the whole GOP, of which an evenly-spaced
      // subsample is retained), so closing promptly is what keeps this off the buffer pool.
      if (!fillRunning || fillKept >= fillCapacity) { frame.close(); return; }
      if (frame.timestamp >= fillEndUs) { frame.close(); return; }
      if (frame.timestamp < fillKeepNextUs) { frame.close(); return; }
      fillKeepNextUs = frame.timestamp + fillStepUs;
      fillKept++;
      post({ type: "fillFrame", frame }, [frame]);
    },
    error: (e) => post({ type: "error", message: `fill decoder: ${e}` }),
  });
}

/** Abandon any in-flight fill. Cheap and idempotent; safe to call on every seek. */
function cancelFill() {
  fillGen++;
  fillRunning = false;
}

/**
 * Wait for `test()` with a deadline. Returns false on timeout.
 *
 * The deadline is the point: see FILL_QUEUE_WAIT_MS. An unbounded wait here means no
 * `fillDone` reply, and no reply means codecPlayer.ts never requests another fill for the
 * life of the deck — silently, with the only symptom being the freeze this feature exists
 * to remove.
 */
async function waitUntil(test: () => boolean, deadlineMs: number): Promise<boolean> {
  const until = performance.now() + deadlineMs;
  while (!test()) {
    if (performance.now() >= until) return false;
    await sleep(FILL_PACE_MS);
  }
  return true;
}

/**
 * Decode the GOP containing `atUs` and hand back up to `capacity` frames spread evenly
 * across it. The first output kept is always the keyframe itself, so a run cancelled early
 * or with room for only one frame still delivers *something* rather than nothing.
 */
async function handleFillGop(atUs: number, capacity: number) {
  // ⚠️ Every path out of this function must post `fillDone` — including the timeout paths
  // below. codecPlayer.ts will not request another fill until it sees a reply, so a silent
  // return disables the whole feature for the deck's lifetime, with the only symptom being
  // the freeze it exists to remove. That is not hypothetical: it is what the first live run
  // did (2026-08-13), 179 fills in one gesture and then zero for the next 54 seconds.
  const t0 = performance.now();
  let fed = 0;
  const reply = (reason: string, kept: number, startPtsUs = 0, endPtsUs = 0) =>
    post({
      type: "fillDone", atUs, startPtsUs, endPtsUs, kept, fed,
      ms: Math.round(performance.now() - t0), reason,
    });

  // A fill is only ever requested for a paused deck (codecPlayer.ts gates it), but re-check:
  // this is sustained software decode, and the one thing it must never compete with is a
  // deck that is actually playing audio.
  if (fillRunning) return reply("already-running", 0);
  if (playing) return reply("playing", 0);
  if (!codec || !decoder) return reply("not-initialised", 0);
  if (capacity < 1) return reply("no-capacity", 0);

  const gop = gopContaining(keyframes, auCount, durationUs, atUs, FILL_MAX_GOP_AUS);
  if (isRefusal(gop)) return reply(gop.refused, 0);
  const { startAu, endAu, startPtsUs, endPtsUs } = gop;

  const gen = ++fillGen;
  fillRunning = true;
  fillEndUs = endPtsUs;
  fillCapacity = capacity;
  fillKept = 0;
  fillKeepNextUs = startPtsUs; // always keep the keyframe
  fillStepUs = Math.max(1, Math.floor((endPtsUs - startPtsUs) / capacity));

  let reason = "ok";
  try {
    if (!fillDecoder) fillDecoder = makeFillDecoder();
    // reset() before every run: the previous run left the decoder mid-GOP, and the next AU
    // fed here is a keyframe from somewhere else entirely. Frames already transferred to the
    // main thread are owned there and are not affected.
    if (fillDecoder.state === "configured") fillDecoder.reset();
    if (!configureDecoder(fillDecoder, decoderConfig(), "fill")) {
      fillDecoder = null;
      reason = "configure-failed";
      return;
    }
    for (let i = startAu; i < endAu; i++) {
      if (gen !== fillGen) { reason = "cancelled"; break; }
      if (fillKept >= capacity) { reason = "capacity"; break; }
      let au = auCache.get(i);
      if (!au) au = await ensureAuFetched(i);
      if (gen !== fillGen) { reason = "cancelled"; break; }
      if (!au) { reason = "fetch-failed"; break; }
      if (au.ptsUs >= endPtsUs + FILL_PTS_SLACK_US) { reason = "reached-end"; break; }
      // Backpressure *and* throttle in one wait — see FILL_PACE_MS. Feeding faster than the
      // decoder drains buys nothing (the frames are subsampled anyway) and is exactly how
      // this would starve the audio threads. Bounded: a decoder that has stopped draining
      // must end the run, not hang it.
      const drained = await waitUntil(
        () => gen !== fillGen || !fillDecoder || fillDecoder.state !== "configured" ||
              fillDecoder.decodeQueueSize < QUEUE_HIGH_WATER,
        FILL_QUEUE_WAIT_MS,
      );
      if (!drained) { reason = "queue-stalled"; break; }
      if (gen !== fillGen) { reason = "cancelled"; break; }
      if (!fillDecoder || fillDecoder.state !== "configured") { reason = "decoder-gone"; break; }
      // Same empty-AU guard as pump() — an AU with no VCL NALs decodes to zero bytes and an
      // empty chunk closes the decoder permanently.
      const data = chunkData(au);
      if (data.length > 0) {
        fillDecoder.decode(new EncodedVideoChunk({
          type: au.key ? "key" : "delta",
          timestamp: au.ptsUs,
          duration: au.durUs,
          data,
        }));
        fed++;
      }
    }
    // Without this the tail of the GOP sits in the decoder until the next run resets it
    // away. Raced against a deadline for the same reason the queue wait is bounded — and
    // deliberately *not* awaited past it: a flush that never settles must not hold the run.
    if (gen === fillGen && fillDecoder?.state === "configured") {
      const flushed = await Promise.race([
        fillDecoder.flush().then(() => true).catch(() => true),
        sleep(FILL_FLUSH_WAIT_MS).then(() => false),
      ]);
      if (!flushed && reason === "ok") reason = "flush-timeout";
    }
  } finally {
    // Only this run's own counter is meaningful: a cancellation means a newer run has
    // already taken the shared output state over, so report -1 rather than its numbers.
    const kept = gen === fillGen ? fillKept : -1;
    if (gen === fillGen) fillRunning = false;
    reply(reason, kept, startPtsUs, endPtsUs);
  }
}

let pumping = false;
let warnedNeverConfigured = false;
async function pump() {
  if (decoder && decoder.state !== "configured" && !warnedNeverConfigured) {
    // decoder exists but isn't "configured" — either configure() failed (now caught and
    // reported separately by configureDecoder()) or it's between reset()/close() and a
    // fresh configure(). This guard would otherwise stall every frame with nothing logged;
    // one-shot so a legitimate transient (teardown, in-flight reconfigure) doesn't spam.
    warnedNeverConfigured = true;
    post({ type: "error", message: `pump(): decoder.state=${decoder.state}, not feeding` });
  }
  if (pumping || !decoder || decoder.state !== "configured" || eos) return;
  pumping = true;
  try {
    while (true) {
      if (nextFeedIndex >= auCount) { eos = true; break; }
      if (decoder.decodeQueueSize >= QUEUE_HIGH_WATER) break;
      let au = auCache.get(nextFeedIndex);
      if (!au) {
        au = await ensureAuFetched(nextFeedIndex);
        if (!au) break; // fetch failed; next clock/init call will retry
      }
      // Decode-ahead gate: only keep decoding while within aheadSeconds() of the audio
      // clock. Skipped for the very first AU, so a frame is ready the instant playback
      // starts / right after init.
      //
      // ⚠️ This used to be gated on `playing` as well, which made a *paused* deck decode
      // with no clock bound at all — the only limit was decodeQueueSize, and pump() is
      // re-entered on every `clock` message. That was harmless while nothing drove the
      // clock on a paused deck, and became the "video jumps ahead dramatically" bug the
      // moment scrubbing did (a paused scratch polls position at rAF rate; see the
      // scratch branch in App.svelte's frame()). nextFeedIndex simply ran away through
      // the file, and since CodecPlayer holds only HELD_FRAMES=2 newest frames,
      // getFrameForTime() found nothing at or before the scrub position and fell back to
      // frames[0] — a frame from wherever the decoder had got to, seconds ahead.
      // Bounding on the clock in both states is also what makes a paused deck stop
      // decoding at all, which is what it should have been doing.
      //
      // ⚠️ Load-bearing for the retained frame ring in *both* directions
      // (docs/design/codec-frame-cache.md §2.4). A retreating clock makes this gate fire
      // immediately, which is why the primary decoder goes quiet during a reverse gesture
      // and stops overwriting the ring — and why the backfill decoder below has the core
      // more or less to itself while it runs. Loosening this gate would silently evict the
      // ring mid-gesture and put two decoders in contention at the same time. Covered by
      // codecPlayer.test.ts's "a backward clock does not evict the ring".
      if (nextFeedIndex > 0 && au.ptsUs / 1_000_000 - clockPos > aheadSeconds()) break;
      // decoder can be reset/closed by a concurrent seek/loop-wrap/destroy message while
      // this loop was suspended on the ensureAuFetched() await above (worker messages only
      // run between awaits, but that's exactly where this checks back in) — re-check state
      // right before the call instead of trusting the entry guard at the top of pump().
      if (!decoder || decoder.state !== "configured") break;
      const data = chunkData(au);
      // Some access units carry only non-VCL NALs (seen live: AUD + SEI, no slice at
      // all — docs/design/webcodecs-video-not-rendering.md) — annexBToAvc's slice-only
      // filter (type 1/5) then yields zero bytes. Feeding VideoDecoder.decode() an empty
      // chunk throws "EncodingError: Empty frame" and *closes the decoder*, permanently
      // killing this deck. There's no picture to decode here, so just skip it — advance
      // past it like any other AU without calling decode(). (H.264-specific in practice,
      // but the guard is codec-blind and an empty AU is never decodable on any codec.)
      if (data.length > 0) {
        decoder.decode(new EncodedVideoChunk({
          type: au.key ? "key" : "delta",
          timestamp: au.ptsUs,
          duration: au.durUs,
          data,
        }));
      }
      nextFeedIndex++;
    }
  } finally {
    pumping = false;
  }
}

async function feedLoopFrames() {
  if (!loopDecoder) return;
  while (loopFramesReady.length < LOOP_PREFETCH_FRAMES && loopFeedIndex < auCount) {
    let au = auCache.get(loopFeedIndex);
    if (!au) au = await ensureAuFetched(loopFeedIndex);
    if (!au) break;
    // Same reasoning as pump()'s state re-check: loopClear/destroy/a second loop-wrap can
    // close loopDecoder (or null it out) while this loop was suspended on the await above.
    if (!loopDecoder || loopDecoder.state !== "configured") break;
    // See the identical guard + comment in pump() — an AU with no VCL NALs (e.g.
    // AUD+SEI-only) must not be fed to decode() as an empty chunk.
    const data = chunkData(au);
    if (data.length > 0) {
      loopDecoder.decode(new EncodedVideoChunk({
        type: au.key ? "key" : "delta",
        timestamp: au.ptsUs,
        duration: au.durUs,
        data,
      }));
    }
    loopFeedIndex++;
  }
}

async function maybeStartLoopPrefetch() {
  // No `!description` guard: it is null by design on the codecs that don't use one
  // (VP9). `codec` being set is what "init has run" actually means on every path.
  if (!loopBounds || !playing || loopPrefetchStarted || !codec) return;
  if (clockPos < loopBounds.outPos - LOOP_LOOKAHEAD_SECONDS) return;
  loopPrefetchStarted = true;
  loopIsNowPrimary = false;
  loopFramesReady = [];
  loopDecoder = makeLoopDecoder();
  if (!configureDecoder(loopDecoder, decoderConfig(), "loop decoder")) {
    loopDecoder = null;
    loopPrefetchStarted = false;
    return;
  }
  loopFeedIndex = keyframeAuIndexAtOrBefore(loopBounds.inPos);
  await feedLoopFrames();
}

function handleLoopWrap() {
  if (!loopBounds) return;
  cancelFill(); // the main thread clears both rings here too — see handleSeek()
  if (loopDecoder && loopFramesReady.length > 0) {
    // Common case: the prefetch had time to run. Swap the primed decoder in as primary —
    // no seek, no re-decode from a keyframe, no mechanism-A-shaped trigger.
    for (const f of loopFramesReady) post({ type: "frame", frame: f }, [f]);
    loopFramesReady = [];
    loopIsNowPrimary = true;
    decoder?.close();
    decoder = loopDecoder;
    nextFeedIndex = loopFeedIndex;
    loopDecoder = null;
    eos = false;
    dropBeforeUs = null;
  } else {
    // Prefetch didn't have time (short loop, or the clock jumped straight past outPos in
    // one poll) — fall back to a normal seek to loopIn. Costs one keyframe catch-up.
    handleSeek(loopBounds.inPos);
  }
  loopPrefetchStarted = false;
  clockPos = loopBounds.inPos;
  pump();
}

function handleSeek(target: number) {
  // Same reasoning as maybeStartLoopPrefetch(): `description` is legitimately null on VP9.
  if (!decoder) return;
  // The main thread drops both rings on a seek, so anything a running backfill is about to
  // deliver belongs to a region that no longer exists. Abandoning it also frees the core
  // for the ~125 frames this seek is about to spend.
  cancelFill();
  eos = false;
  decoder.reset();
  if (!configureDecoder(decoder, decoderConfig(), "seek")) return;
  nextFeedIndex = keyframeAuIndexAtOrBefore(target);
  dropBeforeUs = Math.round(target * 1_000_000);
  clockPos = target;
  pump();
}

async function handleInit(msg: InitMsg) {
  deckId = msg.deckId;
  port = msg.port;
  codec = msg.codec;
  auCount = msg.auCount;
  keyframes = msg.keyframes;
  fpsHint = msg.fpsHint;
  durationUs = msg.durationUs;
  needsAvcRemux = codec.startsWith("avc1");
  description = null;

  if (needsAvcRemux) {
    const firstAu = await ensureAuFetched(0);
    if (!firstAu) { post({ type: "error", message: "failed to fetch first AU for init" }); return; }
    const { sps, pps } = findSpsAndPps(splitAnnexBNals(firstAu.data));
    if (!sps || !pps) {
      post({ type: "error", message: "no SPS/PPS in first AU; cannot build avc description" });
      return;
    }
    description = buildAvcDescription(sps.bytes, pps.bytes);
  }
  decoder = makeDecoder();
  if (!configureDecoder(decoder, decoderConfig(), "init")) { decoder = null; return; }
  pump();
}

function teardown() {
  loopBounds = null;
  cancelFill();
  decoder?.close();
  decoder = null;
  loopDecoder?.close();
  loopDecoder = null;
  fillDecoder?.close();
  fillDecoder = null;
  for (const f of loopFramesReady) f.close();
  loopFramesReady = [];
}

// General safety net: an uncaught throw inside any of the fire-and-forget async handlers
// below (handleInit/pump/feedLoopFrames/maybeStartLoopPrefetch, all invoked without being
// awaited from self.onmessage) becomes an unhandled promise rejection, not a synchronous
// error — `self.onerror`/the Worker's own onerror handler does NOT catch these. Without
// this listener such a throw vanishes with zero signal anywhere. Every specific throw site
// found so far (configure()) is now caught explicitly via configureDecoder(); this is the
// catch-all for whatever the next one turns out to be.
self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  post({ type: "error", message: `unhandled rejection: ${e.reason}` });
});

self.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      handleInit(msg);
      break;
    case "clock":
      clockPos = msg.contentPos;
      playing = msg.playing;
      maybeStartLoopPrefetch();
      pump();
      break;
    case "seek":
      handleSeek(msg.target);
      break;
    case "loop":
      loopBounds = { inPos: msg.inPos, outPos: msg.outPos };
      break;
    case "loopClear":
      loopBounds = null;
      loopPrefetchStarted = false;
      loopDecoder?.close();
      loopDecoder = null;
      for (const f of loopFramesReady) f.close();
      loopFramesReady = [];
      break;
    case "loopWrap":
      handleLoopWrap();
      break;
    case "fillGop":
      handleFillGop(msg.atUs, msg.capacity);
      break;
    case "destroy":
      teardown();
      break;
  }
};
