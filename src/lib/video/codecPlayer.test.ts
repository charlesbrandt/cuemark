/**
 * Coverage for CodecPlayer's retained frame ring (docs/design/waveform-scrub.md,
 * "Reverse scrub video").
 *
 * The point of the ring is that decode is forward-only and this library's GOPs are ~250
 * frames, so re-decoding to reach an earlier frame costs ~125 frames of 1080p software
 * decode — enough to starve the audio threads, which is exactly how the previous attempt
 * at reverse-scrub video regressed live. Retaining recent frames buys backward motion for
 * zero decode. So what these tests pin is (a) a backward move finds a real earlier frame
 * rather than falling back to a stale one, (b) the ring stays inside its byte budget, and
 * (c) evicted frames are closed — an unclosed VideoFrame holds a decoder buffer and will
 * stall decode, which is the failure mode this change could plausibly introduce.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../debugLog', () => ({ debugLog: vi.fn() }));

class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  posted: Record<string, unknown>[] = [];
  postMessage(msg: Record<string, unknown>) {
    this.posted.push(msg);
  }
  terminate() {}
}

let lastWorker: MockWorker;

/** Stand-in for a decoded VideoFrame — only timestamp/close() are exercised here. */
function fakeFrame(ptsSeconds: number) {
  return {
    timestamp: Math.round(ptsSeconds * 1_000_000),
    displayWidth: 1920,
    displayHeight: 1080,
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'Worker',
    class extends MockWorker {
      constructor(..._args: unknown[]) {
        super();
        lastWorker = this;
      }
    },
  );
  vi.stubGlobal('localStorage', { getItem: () => null });
});

/** localStorage stub serving a fixed set of cuemark:* keys. */
function stubSettings(settings: Record<string, string>) {
  vi.stubGlobal('localStorage', { getItem: (k: string) => settings[k] ?? null });
}

async function makePlayer(opts: { width?: number; height?: number; fps?: number } = {}) {
  vi.resetModules();
  const mod = await import('./codecPlayer');
  const player = new mod.CodecPlayer('deck-0', 1234, {
    codec: 'avc1.640028',
    codedWidth: opts.width ?? 1920,
    codedHeight: opts.height ?? 1080,
    fpsHint: opts.fps ?? 25,
    auCount: 7000,
    keyframes: [],
    duration: 280,
  });
  return { player, worker: lastWorker, mod };
}

/** Deliver `count` decoded frames starting at `fromSeconds`, one per 1/fps. */
function deliverFrames(worker: MockWorker, fromSeconds: number, count: number, fps = 25) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    const f = fakeFrame(fromSeconds + i / fps);
    frames.push(f);
    worker.onmessage!({ data: { type: 'frame', frame: f } } as MessageEvent);
  }
  return frames;
}

describe('CodecPlayer frame ring', () => {
  it('a backward move within the retained window is served exactly, with no seek', async () => {
    const { player, worker, mod } = await makePlayer();
    const fps = 25;
    // Deliver more than the ring holds, so eviction has run and the window is full.
    const cap = mod.heldFrameCapacity(1920, 1080);
    const delivered = cap + 5;
    deliverFrames(worker, 10.0, delivered, fps);
    const newest = 10.0 + (delivered - 1) / fps;
    player.setClock(newest, false);

    // Walk back the way a gesture does — a step per rAF, each far under
    // BACKWARD_JUMP_SECONDS — rather than one jump the width of the ring. That distinction
    // matters now that the ring (1.28s at 1080p/25) is *wider* than the 0.5s jump
    // threshold: a single leap to the oldest edge trips setClock's seek heuristic by
    // design, and the far end of the ring is reachable precisely because a real scrub
    // arrives as many small steps (docs/design/waveform-scrub.md).
    //
    // Indexed by frame number, not derived by subtracting seconds: getFrameForTime()
    // compares raw floats, so a target computed a hair below a frame's pts silently
    // selects the *previous* frame and the assertion fails for a reason that has nothing
    // to do with the ring. Build the target with the same expression deliverFrames used.
    const oldestIndex = delivered - cap;
    for (let i = delivered - 2; i >= oldestIndex + 1; i--) {
      const target = 10.0 + i / fps;
      const frame = player.getFrameForTime(target);
      expect(frame).not.toBeNull();
      expect(frame!.timestamp).toBe(Math.round(target * 1_000_000));
      player.setClock(target, false);
    }

    // No decode was asked for anywhere in that gesture — the whole point of the ring.
    expect(worker.posted.filter((m) => m.type === 'seek')).toHaveLength(0);
    // ...and it was a genuine reverse move, not a degenerate one-frame step that would
    // still pass if the ring collapsed to its floor.
    expect(cap - 2).toBeGreaterThan(4);
  });

  it('the old 2-frame ring could not have served that move', async () => {
    // Pins what this change fixes, using the override to reproduce the old behaviour: with
    // only the newest 2 frames retained, the same backward move falls back to a frame that
    // is *ahead* of the requested time — i.e. the picture does not go backward at all.
    vi.stubGlobal('localStorage', { getItem: () => '2' });
    const { player, worker } = await makePlayer();
    deliverFrames(worker, 10.0, 20);
    expect(player.getFrameForTime(10.36)!.timestamp).toBeGreaterThan(Math.round(10.36 * 1_000_000));
  });

  it('evicts oldest-first and closes every evicted frame', async () => {
    const { worker } = await makePlayer();
    const frames = deliverFrames(worker, 0, 60); // more than any ring size
    const closed = frames.filter((f) => f.closed);
    const live = frames.filter((f) => !f.closed);
    expect(closed.length).toBeGreaterThan(0);
    // What survives is the most recent window — the oldest are the ones closed.
    expect(live[0].timestamp).toBeGreaterThan(closed[closed.length - 1].timestamp);
    // Nothing is both retained and closed.
    expect(closed.length + live.length).toBe(60);
  });

  it('sizes the ring by bytes, so cheap frames keep the long window they can afford', async () => {
    const { mod } = await makePlayer();
    // The regression this pins (codec-frame-cache.md §5a): a duration target took the
    // window *away* from sub-4K content, which is most of the library — 720p went from 32
    // frames to 9. Cheap frames must reach the cap.
    expect(mod.heldFrameCapacity(1280, 720)).toBe(32);
    expect(mod.heldFrameCapacity(1920, 1080)).toBe(32);
    // ...and expensive ones must still get a usable window rather than collapsing to the
    // floor: the user's real 3840x2026 file at ~11.1MB/frame is what the 48MB budget gave
    // 4 frames (0.16s) and drove this whole investigation.
    const fourK = mod.heldFrameCapacity(3840, 2026);
    expect(fourK).toBe(17);
    expect(fourK / 25).toBeGreaterThan(0.5); // over half a second of reverse scrub at 25fps
  });

  it('the byte ceiling binds hardest on the largest frames, never below the floor', async () => {
    const { mod } = await makePlayer();
    // 8K: 7680*4320*1.5 = 49.8MB/frame, so 192MB buys 4.
    const eightK = mod.heldFrameCapacity(7680, 4320);
    expect(eightK).toBeGreaterThanOrEqual(2); // never below the historical floor
    expect(eightK).toBeLessThan(mod.heldFrameCapacity(3840, 2026));
    // Monotonic in frame size — the only variable the sizing has.
    expect(mod.heldFrameCapacity(3840, 2026)).toBeLessThan(mod.heldFrameCapacity(640, 480));
    // Absurdly large frames still yield a ring, not zero.
    expect(mod.heldFrameCapacity(30000, 30000)).toBe(2);
  });

  it('caps the ring at the top end, however cheap the frames are', async () => {
    const { mod } = await makePlayer();
    // A tiny frame could afford thousands; the cap wins. 32 is deliberate — the failure
    // mode of raising it is decoder-pool stall, not memory growth.
    expect(mod.heldFrameCapacity(16, 16)).toBe(32);
  });

  it('ignores the demuxer frame rate entirely, including a missing one', async () => {
    const { mod } = await makePlayer({ fps: 0 });
    // fpsHint plays no part in sizing any more, so a stream the demuxer could not
    // characterise sizes exactly like one it could — no invented rate, no 0-frame ring.
    // (fpsHint is still used for the seconds figure in the construction log line.)
    expect(mod.heldFrameCapacity(1920, 1080)).toBe(32);
    expect(mod.heldFrameCapacity(7680, 4320)).toBeGreaterThanOrEqual(2);
  });

  it('destroy() closes the whole ring', async () => {
    const { player, worker } = await makePlayer();
    const frames = deliverFrames(worker, 5.0, 8);
    player.destroy();
    expect(frames.every((f) => f.closed)).toBe(true);
  });

  it('forward playback still gets the newest frame at or before the clock', async () => {
    const { player, worker } = await makePlayer();
    deliverFrames(worker, 3.0, 10);
    const frame = player.getFrameForTime(3.28);
    expect(frame!.timestamp).toBe(Math.round(3.28 * 1_000_000));
    // and never a frame from the future
    expect(player.getFrameForTime(3.2)!.timestamp).toBeLessThanOrEqual(Math.round(3.2 * 1_000_000));
  });

  it('a real backward jump past the threshold still seeks (and clears the ring)', async () => {
    const { player, worker } = await makePlayer();
    const frames = deliverFrames(worker, 10.0, 10);
    player.setClock(10.36, false);
    player.setClock(2.0, false); // loop-back / restart, far outside the ring
    expect(worker.posted.filter((m) => m.type === 'seek')).toHaveLength(1);
    expect(frames.every((f) => f.closed)).toBe(true);
  });

  it('a backward clock does not evict the ring', async () => {
    // Pins codec-frame-cache.md §2.4: the worker's decode-ahead gate stops feeding as the
    // clock retreats, which is *why* the ring survives a reverse gesture. Nothing on this
    // side may close a retained frame on a backward clock either — the ring is the only
    // thing serving the gesture, and losing it is silent.
    const { player, worker } = await makePlayer();
    const frames = deliverFrames(worker, 10.0, 40);
    const live = frames.filter((f) => !f.closed);
    for (let t = 11.5; t >= 10.9; t -= 0.04) player.setClock(t, false);
    expect(live.every((f) => !f.closed)).toBe(true);
  });
});

/**
 * Scrub GOP fill (docs/design/codec-frame-cache.md §3). What matters here is *when* a fill
 * is asked for — the decode it triggers is the expensive thing this whole area is organised
 * around — that it serves **both directions**, and that the frames it returns are not
 * immediately thrown away by the ring's own eviction.
 *
 * Three of these pin defects found on the first live run (2026-08-13) rather than
 * hypotheticals: forward travel inside a gesture being unserved, the request loop that ran
 * 179 fills in 22 seconds, and the in-flight flag latching so that fills stopped forever.
 */
describe('CodecPlayer scrub GOP fill', () => {
  const fps = 25;
  /** GOP layout the fakes agree on: 10s GOPs, matching this library's real files. */
  const GOP = 10;

  async function scrubbingPlayer(opts: { width?: number; height?: number } = {}) {
    const made = await makePlayer(opts);
    const cap = made.mod.heldFrameCapacity(opts.width ?? 1920, opts.height ?? 1080);
    deliverFrames(made.worker, 100.0, cap + 5, fps);
    const newest = 100.0 + (cap + 4) / fps;
    // Twice: the first call carries the whole 0 -> 100s jump as "travel", which is not a
    // gesture. The second establishes a resting clock with zero travel, which is the state
    // a real deck is in when a hand touches it.
    made.player.setClock(newest, false);
    made.player.setClock(newest, false);
    made.worker.posted.length = 0;
    return { ...made, cap, newest };
  }

  /** Step the clock to `to`, the way a real gesture arrives — many small steps. */
  function scrubTo(player: { setClock(t: number, p: boolean): void }, from: number, to: number) {
    const step = (to < from ? -1 : 1) / fps;
    const done = (t: number) => (to < from ? t <= to : t >= to);
    for (let t = from; !done(t); t += step) player.setClock(t, false);
    player.setClock(to, false);
  }

  function fills(worker: MockWorker) {
    return worker.posted.filter((m) => m.type === 'fillGop');
  }

  /** Reply as the worker does when a fill produced nothing. */
  function replyRefused(worker: MockWorker, atUs: number, reason: string) {
    worker.onmessage!({
      data: { type: 'fillDone', atUs, kept: 0, fed: 0, ms: 1, reason },
    } as MessageEvent);
  }

  /**
   * Serve a request the way the worker does: decode the GOP containing `atUs` and return an
   * evenly-spaced subsample of it, with the GOP's real bounds.
   */
  function serveFill(worker: MockWorker, atUs: number, count: number) {
    const startSec = Math.floor(atUs / 1e6 / GOP) * GOP;
    const frames = [];
    for (let i = 0; i < count; i++) {
      const f = fakeFrame(startSec + (i * GOP) / count);
      frames.push(f);
      worker.onmessage!({ data: { type: 'fillFrame', frame: f } } as MessageEvent);
    }
    worker.onmessage!({
      data: {
        type: 'fillDone', atUs, kept: count, fed: 250, ms: 300,
        startPtsUs: startSec * 1e6, endPtsUs: (startSec + GOP) * 1e6,
      },
    } as MessageEvent);
    return frames;
  }

  /** Answer every outstanding request, as a live worker would, up to `rounds` times. */
  function runGesture(
    player: { setClock(t: number, p: boolean): void },
    worker: MockWorker,
    from: number, to: number, perGop: number,
  ) {
    const step = (to < from ? -1 : 1) / fps;
    const done = (t: number) => (to < from ? t <= to : t >= to);
    let served = 0;
    for (let t = from; !done(t); t += step) {
      player.setClock(t, false);
      const pending = fills(worker).length;
      if (pending > served) { serveFill(worker, fills(worker)[served].atUs as number, perGop); served++; }
    }
    return served;
  }

  it('asks for nothing for a flick shorter than the trigger', async () => {
    // The probe lead is wider than the ring, so any *armed* reverse motion costs a GOP.
    // FILL_TRIGGER_SECONDS is what keeps a short flick free; the ring covers it anyway.
    const { player, worker, newest } = await scrubbingPlayer();
    scrubTo(player, newest, newest - 0.2);
    expect(fills(worker)).toHaveLength(0);
  });

  it('asks for nothing when forward travel is inside the ring', async () => {
    // The primary decoder's gate opens as the clock advances into it, so it feeds itself.
    // Requesting a fill here would spend a GOP of decode on every ordinary forward scrub.
    const { player, worker, cap, newest } = await scrubbingPlayer();
    scrubTo(player, newest, 100.0 + 6 / fps);   // back inside the ring
    worker.posted.length = 0;
    scrubTo(player, 100.0 + 6 / fps, newest);   // and forward again within it
    expect(fills(worker)).toHaveLength(0);
    expect(cap).toBe(32);
  });

  it('asks once as a REVERSE gesture approaches the edge of what is held', async () => {
    const { player, worker, newest } = await scrubbingPlayer();
    scrubTo(player, newest, 100.2);
    const asks = fills(worker);
    expect(asks).toHaveLength(1);
    // Probed ahead of the gesture, in its direction of travel — not at the current position.
    expect(asks[0].atUs).toBeLessThan(100.2 * 1e6);
    expect(asks[0].capacity).toBe(32); // half of MAX_FILL_FRAMES, so two GOPs coexist
  });

  it('asks as a FORWARD gesture leaves what is held', async () => {
    // 🔴 The defect the first live run found. The primary decoder covers forward-from-parked
    // and does not move during a gesture, so a reverse-only fill left this direction frozen
    // — live: "whichever direction I scrub first works and the other sticks".
    const { player, worker, newest } = await scrubbingPlayer();
    scrubTo(player, newest, 98.0);               // reverse well out of the ring
    serveFill(worker, fills(worker)[0].atUs as number, 32);
    const reverseAsk = fills(worker)[0].atUs as number;
    const before = fills(worker).length;

    // Turn around. The ring is parked up at ~101s and the primary can only reach us by
    // decoding every frame in between, which a moving hand outruns — so this must be filled.
    const served = runGesture(player, worker, 98.0, 115.0, 32);
    const asks = fills(worker);
    expect(asks.length).toBeGreaterThan(before);
    expect(served).toBeGreaterThan(0);
    // Requests moved *forward*, past the parked ring, rather than further back.
    const forwardAsks = asks.slice(before).map((m) => m.atUs as number);
    expect(Math.max(...forwardAsks)).toBeGreaterThan(reverseAsk);
    expect(Math.max(...forwardAsks)).toBeGreaterThan(102 * 1e6);
  });

  it('never asks while the deck is playing', async () => {
    // Reverse motion on a *playing* deck is a rate/seek artefact, and this is sustained
    // software decode — the one thing it must not contend with is live audio.
    const { player, worker, newest } = await scrubbingPlayer();
    for (let t = newest; t >= 100.2; t -= 1 / fps) player.setClock(t, true);
    expect(fills(worker)).toHaveLength(0);
  });

  it('does not re-request a GOP it already holds', async () => {
    // 🔴 The 179-fills-in-22-seconds loop. The old trigger asked whenever the clock was
    // within a lead of the coverage floor, so a lead wider than the collection could hold
    // re-requested forever. Coverage, not distance, is the question now.
    const { player, worker, newest } = await scrubbingPlayer();
    const served = runGesture(player, worker, newest, 100.2 - 3 * GOP, 32);
    // ~3 GOPs of travel: a handful of fills, not one per rAF tick.
    expect(served).toBeGreaterThan(0);
    expect(fills(worker).length).toBeLessThanOrEqual(6);
  });

  it('recovers if a request is never answered', async () => {
    // 🔴 The latch. `fillInFlight` was a boolean cleared only by the reply, so one lost reply
    // disabled the feature for the deck's life — 179 fills, then zero for 54 seconds, with
    // nothing in the log saying so. Never gate a repeating request on a reply that may not
    // come.
    vi.useFakeTimers();
    try {
      const { player, worker, newest } = await scrubbingPlayer();
      scrubTo(player, newest, 100.2);
      expect(fills(worker)).toHaveLength(1); // ...and no reply is ever delivered
      scrubTo(player, 100.2, 100.1);
      expect(fills(worker)).toHaveLength(1); // still suppressed, correctly
      vi.advanceTimersByTime(5000);
      scrubTo(player, 100.1, 100.0);
      expect(fills(worker).length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off after a refusal but does not latch it', async () => {
    vi.useFakeTimers();
    try {
      const { player, worker, newest } = await scrubbingPlayer();
      scrubTo(player, newest, 100.2);
      replyRefused(worker, fills(worker)[0].atUs as number, 'gop-too-long(9000)');
      scrubTo(player, 100.2, 100.15);
      expect(fills(worker)).toHaveLength(1); // inside the cooldown
      vi.advanceTimersByTime(2000);
      scrubTo(player, 100.15, 100.1);
      expect(fills(worker).length).toBeGreaterThan(1); // cooldown expired, tries again
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves filled frames past the ring, and the ring does not evict them', async () => {
    const { player, worker, newest } = await scrubbingPlayer();
    const oldest = 100.0 + 5 / fps;
    scrubTo(player, newest, oldest);

    // Before the fill lands, the gesture is frozen on the oldest retained frame — the bug
    // being fixed, asserted so the fix cannot be mistaken for a no-op.
    expect(player.getFrameForTime(oldest - 2.0)!.timestamp).toBe(Math.round(oldest * 1_000_000));

    const filled = serveFill(worker, (oldest - 1.5) * 1e6, 32); // GOP [90,100)
    // Every one survived: the ring's oldest-first eviction would have taken all of them.
    expect(filled.every((f) => !f.closed)).toBe(true);

    const seen = new Set<number>();
    for (let t = 99.9; t >= 90.5; t -= 0.5) {
      const frame = player.getFrameForTime(t)!;
      expect(frame.timestamp).toBeLessThanOrEqual(Math.round(t * 1_000_000));
      seen.add(frame.timestamp);
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  it('evicts against the direction of travel, keeping what the gesture is heading into', async () => {
    // 🔴 Plain furthest-from-the-clock eviction discards the newly-filled GOP as fast as it
    // arrives, because a gesture crossing a boundary is still nearer the GOP it is leaving.
    const { player, worker, newest, mod } = await scrubbingPlayer();
    const total = mod.fillFrameCapacity(1920, 1080);
    scrubTo(player, newest, 100.2);
    const leaving = serveFill(worker, 100_200_000, total); // GOP [100,110)
    scrubTo(player, 100.2, 99.9);                          // cross into the GOP below
    const heading = serveFill(worker, 99_900_000, total);  // GOP [90,100)

    const keptHeading = heading.filter((f) => !f.closed).length;
    const keptLeaving = leaving.filter((f) => !f.closed).length;
    expect(keptHeading + keptLeaving).toBe(total);
    // The direction of travel wins: symmetric eviction would keep the leaving side, since
    // the clock at 99.9 sits right against it.
    expect(keptHeading).toBeGreaterThan(keptLeaving);
  });

  it('drops a stale fill once the deck has played far away from it', async () => {
    const { player, worker, newest } = await scrubbingPlayer();
    scrubTo(player, newest, 100.2);
    const filled = serveFill(worker, 100_200_000, 32);
    for (let t = 100.2; t < 160; t += 0.2) player.setClock(t, true);
    expect(filled.every((f) => f.closed)).toBe(true);
  });

  it('the kill switch turns the whole thing off', async () => {
    stubSettings({ 'cuemark:codecReverseBackfill': '0' });
    const { player, worker, newest } = await scrubbingPlayer();
    scrubTo(player, newest, 100.2);
    expect(fills(worker)).toHaveLength(0);
  });

  it('sizes the fill by bytes, capped, and always leaves room for two GOPs', async () => {
    const { mod } = await makePlayer();
    expect(mod.fillFrameCapacity(1280, 720)).toBe(64); // cap binds; bytes would allow 145
    expect(mod.fillFrameCapacity(1920, 1080)).toBe(64);
    expect(mod.fillFrameCapacity(3840, 2026)).toBe(17);
    // Never below two, so a fill always has somewhere to put a keyframe.
    expect(mod.fillFrameCapacity(30000, 30000)).toBeGreaterThanOrEqual(2);
  });

  it('seek and loop-wrap drop the fill along with the ring', async () => {
    for (const act of ['seek', 'loopWrap'] as const) {
      const { player, worker, newest } = await scrubbingPlayer();
      scrubTo(player, newest, 100.2);
      const filled = serveFill(worker, 100_200_000, 32);
      if (act === 'seek') player.seek(220);
      else player.notifyLoopWrap(220);
      expect(filled.every((f) => f.closed)).toBe(true);
    }
  });

  it('destroy() closes the fill too', async () => {
    const { player, worker, newest } = await scrubbingPlayer();
    scrubTo(player, newest, 100.2);
    const filled = serveFill(worker, 100_200_000, 32);
    player.destroy();
    expect(filled.every((f) => f.closed)).toBe(true);
  });
});

/**
 * The settle seek (codec-frame-cache.md §3 tier 3). The GOP fill makes this load bearing:
 * the primary decoder does not move during a gesture, so without a settle a gesture that
 * travelled 30s would show nothing new for 30s after play is pressed.
 */
describe('CodecPlayer.settleAfterScrub', () => {
  const fps = 25;

  it('does nothing when the gesture ended inside the ring', async () => {
    const { player, worker, mod } = await makePlayer();
    const cap = mod.heldFrameCapacity(1920, 1080);
    const frames = deliverFrames(worker, 10.0, cap, fps);
    player.setClock(10.0 + (cap - 1) / fps, false);
    player.settleAfterScrub(10.0 + (cap - 3) / fps);
    expect(worker.posted.filter((m) => m.type === 'seek')).toHaveLength(0);
    expect(frames.every((f) => f.closed)).toBe(false);
  });

  it('re-anchors the decoder when the gesture ended below the ring', async () => {
    const { player, worker } = await makePlayer();
    const frames = deliverFrames(worker, 100.0, 10, fps);
    player.setClock(100.3, false);
    player.settleAfterScrub(99.0);
    const seeks = worker.posted.filter((m) => m.type === 'seek');
    expect(seeks).toHaveLength(1);
    expect(seeks[0].target).toBe(99.0);
    expect(frames.every((f) => f.closed)).toBe(true);
  });

  it('re-anchors when the gesture ended ABOVE the ring too', async () => {
    // Forward travel parks the ring behind the gesture just as reverse parks it ahead.
    const { player, worker } = await makePlayer();
    deliverFrames(worker, 100.0, 10, fps);
    player.setClock(100.3, false);
    player.settleAfterScrub(140.0);
    const seeks = worker.posted.filter((m) => m.type === 'seek');
    expect(seeks).toHaveLength(1);
    expect(seeks[0].target).toBe(140.0);
  });

  it('keeps the filled frames, which are what covers the settle gap', async () => {
    const { player, worker } = await makePlayer();
    deliverFrames(worker, 100.0, 10, fps);
    player.setClock(100.3, false);
    const filled = [fakeFrame(98.5), fakeFrame(99.0)];
    for (const f of filled) {
      worker.onmessage!({ data: { type: 'fillFrame', frame: f } } as MessageEvent);
    }
    player.settleAfterScrub(99.0);
    expect(filled.every((f) => !f.closed)).toBe(true);
    // ...and there is still a picture to show while the seek's own output is in flight.
    expect(player.getFrameForTime(99.0)!.timestamp).toBe(Math.round(99.0 * 1_000_000));
  });
});

/**
 * The `[frame-cache]` instrument, tested because it has been wrong twice and both times it
 * argued the feature was healthy while the user watched it fail. An instrument that cannot
 * fail its own test is not evidence.
 */
describe('CodecPlayer frame-cache instrument', () => {
  const fps = 25;

  /** Capture the lines emitted at gesture end. */
  async function statsFor(
    body: (player: {
      getFrameForTime(t: number): { timestamp: number } | null;
      setClock(t: number, p: boolean): void;
      noteScrubEnded(): void;
    }, worker: MockWorker) => void,
  ) {
    const { debugLog } = await import('../debugLog');
    (debugLog as unknown as { mockClear(): void }).mockClear();
    const { player, worker } = await makePlayer();
    body(player, worker);
    player.noteScrubEnded();
    const calls = (debugLog as unknown as { mock: { calls: string[][] } }).mock.calls;
    return calls.map((c) => c[0]).find((l) => l.includes('[frame-cache')) ?? '';
  }

  it('does not count a stall when the picture is genuinely advancing', async () => {
    const line = await statsFor((player, worker) => {
      deliverFrames(worker, 10.0, 30, fps);
      for (let i = 0; i < 20; i++) player.getFrameForTime(10.0 + i / fps);
    });
    expect(line).toContain('stuck=0');
  });

  it('counts a real stall, and reports the run length', async () => {
    const line = await statsFor((player, worker) => {
      deliverFrames(worker, 10.0, 4, fps);
      // Walk far past everything held: every request now returns the same last frame.
      for (let i = 0; i < 30; i++) player.getFrameForTime(20.0 + i / 60);
    });
    expect(line).not.toContain('stuck=0');
    expect(line).toMatch(/worst run (2[0-9]|3[0-9])/);
  });

  it('a second consumer asking for the same instant does not break the run counter', async () => {
    // 🔴 The defect live run 2 exposed. getFrameForTime is called twice per tick — the render
    // loop and DeckCard's preview — and treating the duplicate as "not frozen" reset the run
    // on every other call, making a run of 2 structurally impossible. It reported `run 1`
    // through a 44-second gesture, which is why this is a test and not a comment.
    const line = await statsFor((player, worker) => {
      deliverFrames(worker, 10.0, 4, fps);
      for (let i = 0; i < 30; i++) {
        const t = 20.0 + i / 60;
        player.getFrameForTime(t); // render loop
        player.getFrameForTime(t); // DeckCard preview, same instant
      }
    });
    expect(line).not.toContain('stuck=0');
    expect(line).not.toContain('worst run 1');
  });

  it('ordinary 60fps-over-25fps redraws are frozen but never stuck', async () => {
    // ~58% of ticks legitimately repeat a frame. If that read as a stall the instrument would
    // cry wolf on every healthy gesture — the opposite failure to live run 1's, equally bad.
    const line = await statsFor((player, worker) => {
      deliverFrames(worker, 10.0, 60, fps);
      // Only inside the retained window — the ring holds the newest 32 of those 60, so
      // anything below 11.12s is a real stall and would (correctly) register as one.
      for (let i = 0; i < 60; i++) player.getFrameForTime(11.2 + i / 60);
    });
    expect(line).toContain('stuck=0');
    expect(line).not.toContain('frozen=0');
  });

  it('always reports the fill line, including when nothing ran', async () => {
    // Suppressing it at zero made "requested and refused" and "never requested at all"
    // indistinguishable on live run 1, and that difference was the latch bug.
    const { debugLog } = await import('../debugLog');
    (debugLog as unknown as { mockClear(): void }).mockClear();
    const { player, worker } = await makePlayer();
    deliverFrames(worker, 10.0, 10, fps);
    player.getFrameForTime(10.1);
    player.noteScrubEnded();
    const lines = (debugLog as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]);
    expect(lines.some((l) => l.includes('fills req=0 done=0'))).toBe(true);
  });
});
