import { describe, it, expect } from 'vitest';
import {
  cycleConfig, newCycleState, stepCycle, nextPresetId, tickAutoCycle, resetAutoCycle,
  CYCLE_OFF, CYCLE_SECONDS, CYCLE_BARS,
} from './vizCycle';

const cfg = (mode: number, seconds = 30, bars = 2) => ({ mode, seconds, bars });

describe('cycleConfig', () => {
  it('defaults to off with sane intervals, ignores junk', () => {
    expect(cycleConfig(undefined)).toEqual({ mode: CYCLE_OFF, seconds: 30, bars: 8 });
    expect(cycleConfig({ cycleMode: 1, cycleSeconds: -5, cycleBars: 0.2 })).toEqual({ mode: 1, seconds: 1, bars: 1 });
    expect(cycleConfig({ cycleMode: NaN as unknown as number }).mode).toBe(0);
  });
});

describe('stepCycle', () => {
  it('off never advances', () => {
    expect(stepCycle(newCycleState(0), 1e9, cfg(CYCLE_OFF), null, false)).toBe(false);
  });
  it('seconds mode advances after N seconds, not before', () => {
    const st = newCycleState(1000);
    expect(stepCycle(st, 30999, cfg(CYCLE_SECONDS), null, false)).toBe(false);
    expect(stepCycle(st, 31000, cfg(CYCLE_SECONDS), null, false)).toBe(true);
  });
  it('bars mode counts beat wraps and fires on the wrap tick', () => {
    const st = newCycleState(0);
    const beat = (phase: number) => ({ phase, bpm: 120 });
    let fired = -1;
    let t = 0;
    // 2 bars = 8 beats; 10 ticks per beat
    for (let beatN = 0; beatN < 12 && fired < 0; beatN++) {
      for (let k = 0; k < 10; k++) {
        t += 50;
        if (stepCycle(st, t, cfg(CYCLE_BARS, 30, 2), beat(k / 10), true)) { fired = beatN * 10 + k; break; }
      }
    }
    // First tick has no previous phase; wraps happen at k=0 of beats 1..8, the 8th wrap is beat 8.
    expect(fired).toBe(8 * 10);
    expect(fired % 10).toBe(0); // on the wrap tick, i.e. on a beat
  });
  it('bars mode without a grid falls back to seconds', () => {
    const st = newCycleState(0);
    expect(stepCycle(st, 10000, cfg(CYCLE_BARS, 30, 2), null, true)).toBe(false);
    expect(stepCycle(st, 30000, cfg(CYCLE_BARS, 30, 2), null, true)).toBe(true);
    const st2 = newCycleState(0);
    expect(stepCycle(st2, 30000, cfg(CYCLE_BARS, 30, 2), { phase: 0.3, bpm: 0 }, true)).toBe(true); // bpm 0 = no grid
    const st3 = newCycleState(0);
    expect(stepCycle(st3, 30000, cfg(CYCLE_BARS, 30, 2), { phase: 0.3, bpm: 120 }, false)).toBe(true); // paused = frozen phase
  });
  it('with a grid, bars mode does not fire on elapsed time alone', () => {
    const st = newCycleState(0);
    expect(stepCycle(st, 999999, cfg(CYCLE_BARS, 30, 2), { phase: 0.5, bpm: 120 }, true)).toBe(false);
  });
});

describe('nextPresetId', () => {
  const ids = ['a', 'b', 'c'];
  it('walks in order and wraps', () => {
    expect(nextPresetId(ids, 'a', false)).toBe('b');
    expect(nextPresetId(ids, 'c', false)).toBe('a');
    expect(nextPresetId(ids, 'zzz', false)).toBe('a');
  });
  it('shuffle never returns the current one', () => {
    for (const r of [0, 0.5, 0.999]) expect(nextPresetId(ids, 'b', true, () => r)).not.toBe('b');
  });
  it('handles empty and single lists', () => {
    expect(nextPresetId([], 'a', false)).toBeNull();
    expect(nextPresetId(['a'], 'a', false)).toBeNull();
    expect(nextPresetId(['a'], 'x', false)).toBe('a');
  });
});

describe('tickAutoCycle', () => {
  it('a manual selection change restarts the interval', () => {
    resetAutoCycle();
    const p = { cycleMode: 1, cycleSeconds: 10 };
    const ids = ['a', 'b'];
    expect(tickAutoCycle(0, 'a', p, null, false, ids)).toBeNull();
    expect(tickAutoCycle(9000, 'b', p, null, false, ids)).toBeNull(); // user picked b at 9s
    expect(tickAutoCycle(18999, 'b', p, null, false, ids)).toBeNull();
    expect(tickAutoCycle(19000, 'b', p, null, false, ids)).toBe('a');
  });
});
