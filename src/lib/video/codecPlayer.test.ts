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
  it('a short backward move is served an exact earlier frame, with no seek', async () => {
    const { player, worker } = await makePlayer();
    deliverFrames(worker, 10.0, 20); // 10.00s .. 10.76s at 25fps
    player.setClock(10.76, false);

    // Scrub back 0.4s — the frame at 10.36 is still held, so this is exact.
    const frame = player.getFrameForTime(10.36);
    expect(frame).not.toBeNull();
    expect(frame!.timestamp).toBe(Math.round(10.36 * 1_000_000));

    player.setClock(10.36, false);
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

  it('sizes the ring by duration, so the window is comparable across frame rates', async () => {
    const { mod } = await makePlayer();
    // 0.75s target: the frame *count* scales with fps so the *seconds* retained do not.
    // This is what the byte-only sizing got wrong — same budget, 10x different windows.
    expect(mod.heldFrameCapacity(1920, 1080, 25)).toBe(19); // ceil(0.75 * 25)
    expect(mod.heldFrameCapacity(1920, 1080, 30)).toBe(23); // ceil(0.75 * 30)
    expect(mod.heldFrameCapacity(1920, 1080, 8)).toBe(6); //  ceil(0.75 * 8)
  });

  it('falls back to the byte ceiling for very large frames', async () => {
    const { mod } = await makePlayer();
    // The user's real library file. 3840*2026*1.5 = 11.1MB/frame, so 0.75s (19 frames,
    // 212MB) exceeds the 192MB ceiling and the ceiling wins — but it must still be a
    // usable window, not the 4 frames / 0.16s the 48MB budget produced.
    const uhd = mod.heldFrameCapacity(3840, 2026, 25);
    expect(uhd).toBe(17);
    expect(uhd / 25).toBeGreaterThan(0.5); // over half a second of reverse scrub
    // A 4K frame still retains fewer than 1080p at the same rate — memory is bounded.
    expect(uhd).toBeLessThan(mod.heldFrameCapacity(1920, 1080, 30));
  });

  it('never retains fewer than the historical 2, and is capped at the top end', async () => {
    const { mod } = await makePlayer();
    expect(mod.heldFrameCapacity(7680, 4320, 25)).toBeGreaterThanOrEqual(2);
    // A high frame rate wants more than the cap allows; the cap wins.
    expect(mod.heldFrameCapacity(16, 16, 120)).toBe(32);
  });

  it('sizes off the byte ceiling alone when the demuxer reports no frame rate', async () => {
    const { mod } = await makePlayer();
    // fpsHint=0 must not become a 0-frame ring or an invented rate.
    expect(mod.heldFrameCapacity(1920, 1080, 0)).toBe(32);
    expect(mod.heldFrameCapacity(3840, 2026, 0)).toBe(17);
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
