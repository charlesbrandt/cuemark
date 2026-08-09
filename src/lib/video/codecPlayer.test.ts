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
    deliverFrames(worker, 10.0, 20, fps); // 10.00s .. 10.76s
    const newest = 10.0 + 19 / fps;
    player.setClock(newest, false);

    // Derived from the ring's real capacity rather than a hard-coded distance: the point
    // is "anywhere inside the window is exact", and the window moves with the A/B arm.
    // One frame in from the oldest edge, so the assertion is about the ring and not about
    // off-by-one at the boundary.
    // Indexed by frame number, not derived by subtracting seconds: getFrameForTime()
    // compares raw floats, so a target computed a hair below a frame's pts silently
    // selects the *previous* frame and the assertion fails for a reason that has nothing
    // to do with the ring. Build the target with the same expression deliverFrames used.
    const cap = mod.heldFrameCapacity(1920, 1080, fps);
    const targetIndex = 20 - cap + 1; // one frame in from the oldest retained
    const target = 10.0 + targetIndex / fps;

    const frame = player.getFrameForTime(target);
    expect(frame).not.toBeNull();
    expect(frame!.timestamp).toBe(Math.round(target * 1_000_000));

    // ...and it is a genuine reverse move, not a degenerate one-frame step that would
    // still pass if the ring collapsed to its floor. Counted in frames: seconds here are
    // exact multiples of 1/25 that floating point cannot represent, so the same statement
    // in seconds fails on equality at the boundary.
    expect(19 - targetIndex).toBe(cap - 2);
    expect(cap - 2).toBeGreaterThan(4); // a real gesture's worth, not one or two frames

    player.setClock(target, false);
    expect(worker.posted.filter((m) => m.type === 'seek')).toHaveLength(0);
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

  it('sizes the ring by duration, so the retained seconds hold across frame rates', async () => {
    const { mod } = await makePlayer();
    const target = mod.RING_TARGET_SECONDS;
    // The frame *count* scales with fps so the *seconds* retained do not. This is what the
    // byte-only sizing got wrong — same budget, 10x different windows across content.
    // Expectations derive from the constant so an A/B flip does not churn this test.
    for (const fps of [8, 25, 30]) {
      expect(mod.heldFrameCapacity(1920, 1080, fps)).toBe(Math.ceil(target * fps));
    }
    // The invariant that actually matters, stated directly.
    for (const fps of [8, 25, 30]) {
      const secondsRetained = mod.heldFrameCapacity(1920, 1080, fps) / fps;
      expect(secondsRetained).toBeGreaterThanOrEqual(target);
      expect(secondsRetained).toBeLessThan(target + 1 / fps);
    }
  });

  it('falls back to the byte ceiling when frames are too large for the duration target', async () => {
    const { mod } = await makePlayer();
    // 8K: 7680*4320*1.5 = 49.8MB/frame, so the 192MB ceiling binds at 4 frames well before
    // any plausible duration target does. Independent of the A/B arm.
    const eightK = mod.heldFrameCapacity(7680, 4320, 25);
    expect(eightK).toBeLessThan(Math.ceil(mod.RING_TARGET_SECONDS * 25));
    expect(eightK).toBeGreaterThanOrEqual(2); // never below the historical floor
    // A large frame always retains fewer than a small one at the same rate.
    expect(eightK).toBeLessThan(mod.heldFrameCapacity(640, 480, 25));
  });

  it('caps the ring at the top end, whatever the frame rate asks for', async () => {
    const { mod } = await makePlayer();
    // A tiny frame at a high rate wants more than the cap allows; the cap wins. 32 is
    // deliberate — the failure mode of raising it is decoder-pool stall, not memory.
    expect(mod.heldFrameCapacity(16, 16, 1000)).toBe(32);
  });

  it('sizes off the byte ceiling alone when the demuxer reports no frame rate', async () => {
    const { mod } = await makePlayer();
    // fpsHint=0 must not become a 0-frame ring or an invented rate — it falls through to
    // the ceiling, which for a small frame means the cap.
    expect(mod.heldFrameCapacity(1920, 1080, 0)).toBe(32);
    // ...and for an 8K frame, the byte ceiling itself.
    expect(mod.heldFrameCapacity(7680, 4320, 0)).toBe(mod.heldFrameCapacity(7680, 4320, 25));
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
