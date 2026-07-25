/**
 * codecWorker.ts — owns the VideoDecoder + AU fetch/decode-ahead loop for one codec-path
 * deck (docs/design/webcodecs-video-path.md phase 2). Runs in a Worker (spawned by
 * codecPlayer.ts) so decode never blocks the main thread. One instance per deck.
 *
 * Always avc mode (`description` built from the first keyframe's SPS/PPS, chunks
 * re-muxed from Annex-B to length-prefixed) — annexb-without-description is confirmed
 * dead on this app's real hardware decode config, see h264.ts's doc comment and
 * docs/design/webcodecs-video-path.md "Phase 1 results". Do not attempt it here.
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
async function pump() {
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
      decoder.decode(new EncodedVideoChunk({
        type: au.key ? "key" : "delta",
        timestamp: au.ptsUs,
        duration: au.durUs,
        data: annexBToAvc(au.data),
      }));
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
    loopDecoder.decode(new EncodedVideoChunk({
      type: au.key ? "key" : "delta",
      timestamp: au.ptsUs,
      duration: au.durUs,
      data: annexBToAvc(au.data),
    }));
    loopFeedIndex++;
  }
}

async function maybeStartLoopPrefetch() {
  if (!loopBounds || !playing || loopPrefetchStarted || !description) return;
  if (clockPos < loopBounds.outPos - LOOP_LOOKAHEAD_SECONDS) return;
  loopPrefetchStarted = true;
  loopIsNowPrimary = false;
  loopFramesReady = [];
  loopDecoder = makeLoopDecoder();
  loopDecoder.configure({ codec, description });
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
  if (!decoder || !description) return;
  eos = false;
  decoder.reset();
  decoder.configure({ codec, description });
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

  const firstAu = await ensureAuFetched(0);
  if (!firstAu) { post({ type: "error", message: "failed to fetch first AU for init" }); return; }
  const { sps, pps } = findSpsAndPps(splitAnnexBNals(firstAu.data));
  if (!sps || !pps) {
    post({ type: "error", message: "no SPS/PPS in first AU; cannot build avc description" });
    return;
  }
  description = buildAvcDescription(sps.bytes, pps.bytes);
  decoder = makeDecoder();
  decoder.configure({ codec, description });
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
