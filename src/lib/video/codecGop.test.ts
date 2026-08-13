/**
 * GOP selection for the scrub frame-fill. Small surface, but its rules have failure modes
 * that are invisible at runtime — see codecGop.ts's doc comment.
 */
import { describe, expect, it } from 'vitest';
import { gopContaining, isRefusal, type GopSelection } from './codecGop';

/** ~10s GOPs at 25fps, i.e. the shape measured in this library. */
const KEYFRAMES = [
  { auIndex: 0, ptsUs: 0 },
  { auIndex: 250, ptsUs: 10_000_000 },
  { auIndex: 500, ptsUs: 20_000_000 },
  { auIndex: 750, ptsUs: 30_000_000 },
];
const AU_COUNT = 1000;
const DURATION = 40_000_000;
const MAX = 600;

function sel(atUs: number): GopSelection {
  const r = gopContaining(KEYFRAMES, AU_COUNT, DURATION, atUs, MAX);
  if (isRefusal(r)) throw new Error(`unexpected refusal: ${r.refused}`);
  return r;
}

describe('gopContaining', () => {
  it('picks the GOP the position is inside, bounded by the next keyframe', () => {
    expect(sel(25_000_000)).toEqual({
      startAu: 500, endAu: 750, startPtsUs: 20_000_000, endPtsUs: 30_000_000,
    });
  });

  it('a position exactly on a keyframe selects that keyframe’s own GOP', () => {
    // The `<=` here is the opposite of the old reverse-only selector's `<`, and it is what
    // makes the same call usable for forward travel: arriving at a keyframe boundary going
    // forward must fetch the GOP ahead, not the one just left.
    expect(sel(20_000_000).startPtsUs).toBe(20_000_000);
    expect(sel(0).startPtsUs).toBe(0);
  });

  it('covers the whole track with no gap and no overlap', () => {
    // Every position must resolve to exactly one GOP whose span contains it — the property
    // the main thread's "have I already fetched this?" check relies on to stop re-requesting.
    for (let t = 0; t < DURATION; t += 250_000) {
      const g = sel(t);
      expect(g.startPtsUs).toBeLessThanOrEqual(t);
      expect(g.endPtsUs).toBeGreaterThan(t);
    }
  });

  it('walks backward GOP by GOP, strictly descending, then refuses at the start', () => {
    // A sustained reverse gesture is this sequence: probe just below the GOP you are in.
    // Each step must strictly descend, or the gesture stalls on a GOP it already has.
    let probe = 35_000_000;
    const visited: number[] = [];
    for (;;) {
      const r = gopContaining(KEYFRAMES, AU_COUNT, DURATION, probe, MAX);
      if (isRefusal(r)) {
        expect(r.refused).toBe('before-first-keyframe');
        break;
      }
      expect(r.startPtsUs).toBeLessThanOrEqual(probe);
      visited.push(r.startPtsUs);
      probe = r.startPtsUs - 1; // just below this GOP, the way the probe point moves
    }
    expect(visited).toEqual([30_000_000, 20_000_000, 10_000_000, 0]);
  });

  it('walks forward GOP by GOP', () => {
    // The direction that was structurally unserved before 2026-08-13.
    let probe = 5_000_000;
    const visited: number[] = [];
    for (let i = 0; i < 4; i++) {
      const g = sel(probe);
      visited.push(g.startPtsUs);
      probe = g.endPtsUs;
    }
    expect(visited).toEqual([0, 10_000_000, 20_000_000, 30_000_000]);
  });

  it('uses auCount and the duration as the end of the final GOP', () => {
    expect(sel(35_000_000)).toEqual({
      startAu: 750, endAu: AU_COUNT, startPtsUs: 30_000_000, endPtsUs: DURATION,
    });
  });

  it('gives the final GOP a positive span even with a bogus duration', () => {
    // Duration comes from the demuxer and a zero would make the subsample step degenerate.
    const g = gopContaining(KEYFRAMES, AU_COUNT, 0, 35_000_000, MAX);
    expect(isRefusal(g)).toBe(false);
    if (!isRefusal(g)) expect(g.endPtsUs).toBeGreaterThan(g.startPtsUs);
  });

  it('refuses a GOP longer than the cap rather than decoding it slowly', () => {
    // A single-keyframe encode: the whole file is one GOP, so reaching a frame inside it
    // means decoding the entire track in software. Declining is the only affordable answer.
    const r = gopContaining([{ auIndex: 0, ptsUs: 0 }], 9000, 360_000_000, 100_000_000, MAX);
    expect(isRefusal(r) && r.refused).toBe('gop-too-long(9000)');
  });

  it('refuses below the first keyframe, and a file with none at all', () => {
    expect(isRefusal(gopContaining(KEYFRAMES, AU_COUNT, DURATION, -1, MAX)) &&
      (gopContaining(KEYFRAMES, AU_COUNT, DURATION, -1, MAX) as { refused: string }).refused)
      .toBe('before-first-keyframe');
    const none = gopContaining([], AU_COUNT, DURATION, 5_000_000, MAX);
    expect(isRefusal(none) && none.refused).toBe('no-keyframes');
  });
});
