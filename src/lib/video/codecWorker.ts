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
import { annexBToAvc, buildAvcDescription, findSpsAndPps, parseAuFrames, splitAnnexBNals, type Au } from "./h264";

interface InitMsg {
  type: "init";
  deckId: string;
  port: number;
  codec: string;
  auCount: number;
  keyframes: { auIndex: number; ptsUs: number }[];
  fpsHint: number;
}
interface ClockMsg { type: "clock"; contentPos: number; playing: boolean }
interface SeekMsg { type: "seek"; target: number }
interface LoopMsg { type: "loop"; inPos: number; outPos: number }
interface LoopClearMsg { type: "loopClear" }
interface LoopWrapMsg { type: "loopWrap" }
interface DestroyMsg { type: "destroy" }
type InMsg = InitMsg | ClockMsg | SeekMsg | LoopMsg | LoopClearMsg | LoopWrapMsg | DestroyMsg;

const FETCH_BATCH = 90; // ~3s at 30fps; encoded AUs are cheap (~1MB/s/deck, see design doc)
const QUEUE_HIGH_WATER = 8;
const LOOP_PREFETCH_FRAMES = 6;
const LOOP_LOOKAHEAD_SECONDS = 1.5;

let deckId = "";
let port = 0;
let codec = "";
let auCount = 0;
let keyframes: { auIndex: number; ptsUs: number }[] = [];
let fpsHint = 30;
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
      // clock. Skipped while paused or for the very first AU, so a frame is ready the
      // instant playback starts / right after init.
      if (playing && nextFeedIndex > 0 && au.ptsUs / 1_000_000 - clockPos > aheadSeconds()) break;
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
  decoder?.close();
  decoder = null;
  loopDecoder?.close();
  loopDecoder = null;
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
    case "destroy":
      teardown();
      break;
  }
};
