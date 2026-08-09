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
});
