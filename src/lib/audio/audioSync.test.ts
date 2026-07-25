/**
 * Regression coverage for the contentPos-drift bug: the waveform/video position
 * appeared to run ahead of the real audio position whenever tempo/pitch was being
 * actively adjusted. Root cause was App.svelte's position integration using a single
 * instantaneous rate snapshot (the rate at IPC-resolution time) applied to an entire
 * wall-clock polling interval (~140-190ms, per the IPC latency baseline) — during
 * active MIDI tempo changes the rate can move several times within that interval, so
 * "latest known rate applied to the whole span" systematically over/undershoots.
 *
 * `averageRateOverWindow` fixes this by returning the time-weighted average of
 * whatever rates were actually recorded (via `syncRate`) inside [fromMs, toMs].
 * These tests exercise that function directly — deterministic, no Tauri/app needed.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./pipeline', () => ({
  audioSetRate: vi.fn().mockResolvedValue(undefined),
  audioSetGain: vi.fn().mockResolvedValue(undefined),
  audioSetVolume: vi.fn().mockResolvedValue(undefined),
}));

import { syncRate, averageRateOverWindow, clearDeckAudioSync } from './audioSync';

// syncRate ignores changes within 0.005 of the last applied rate, so tests use a
// fresh deck id per case (state is module-level) and space rate values apart.
let deckCounter = 0;
function freshDeckId(): string {
  return `test-deck-${deckCounter++}`;
}

// Busy-waits (not setTimeout — needs sub-ms precision the event loop can't offer)
// until performance.now() reaches `target`, so a subsequent syncRate() call is
// timestamped at a precisely known offset for these tests.
function busyWaitUntil(target: number): void {
  while (performance.now() < target) { /* spin */ }
}

describe('averageRateOverWindow', () => {
  it('falls back to currentRate when the deck has no rate history', () => {
    const deckId = freshDeckId();
    expect(averageRateOverWindow(deckId, 0, 100, 1.5)).toBe(1.5);
  });

  it('falls back to currentRate when toMs <= fromMs', () => {
    const deckId = freshDeckId();
    syncRate(deckId, 2.0);
    expect(averageRateOverWindow(deckId, 100, 100, 1.0)).toBe(1.0);
    expect(averageRateOverWindow(deckId, 100, 50, 1.0)).toBe(1.0);
  });

  it('returns a constant rate unchanged when nothing varies inside the window', () => {
    const deckId = freshDeckId();
    syncRate(deckId, 1.25);
    // 10ms margin before the window starts guarantees this change is treated as
    // "already in effect at window start", not as landing inside the window.
    const windowStart = performance.now() + 10;
    const rate = averageRateOverWindow(deckId, windowStart, windowStart + 10, 1.25);
    expect(rate).toBeCloseTo(1.25, 6);
  });

  it('time-weights a single mid-window rate change instead of using only the latest value', () => {
    const deckId = freshDeckId();
    syncRate(deckId, 1.0); // baseline, recorded well before the window below

    const t0 = performance.now() + 10; // margin so the 1.0 baseline is safely "before start"
    busyWaitUntil(t0);

    // Simulate: deck plays at 1.0x, then a fader push mid-poll-interval bumps it to 2.0x.
    // A poll interval [t0, t0+100] where the change lands at t0+40 should read as
    // 40ms @ 1.0x + 60ms @ 2.0x = (40*1.0 + 60*2.0) / 100 = 1.6x average — NOT 2.0x,
    // which is what the old "latest snapshot" code would have used for the whole span.
    busyWaitUntil(t0 + 40);
    syncRate(deckId, 2.0);

    const rate = averageRateOverWindow(deckId, t0, t0 + 100, 2.0);
    expect(rate).toBeGreaterThan(1.0);
    expect(rate).toBeLessThan(2.0);
    expect(rate).toBeCloseTo(1.6, 1);
  });

  it('averages several rapid rate changes inside one window (MIDI-burst shape)', () => {
    const deckId = freshDeckId();
    syncRate(deckId, 1.0); // baseline, recorded well before the window below

    const t0 = performance.now() + 10;
    busyWaitUntil(t0);

    // Four evenly-spaced steps up to 4.0x within a single ~40ms polling window —
    // representative of a fast MIDI tempo-fader sweep landing inside one IPC round trip.
    const steps = [1.5, 2.0, 3.0, 4.0];
    const stepMs = 10;
    for (let i = 0; i < steps.length; i++) {
      busyWaitUntil(t0 + (i + 1) * stepMs);
      syncRate(deckId, steps[i]);
    }

    const windowEnd = t0 + steps.length * stepMs;
    const rate = averageRateOverWindow(deckId, t0, windowEnd, steps[steps.length - 1]);
    // The naive "latest snapshot" approach would have returned 4.0 for the whole
    // window; the true time-weighted average of a monotonically increasing ramp
    // must sit strictly below the final value and above the initial one.
    expect(rate).toBeGreaterThan(1.0);
    expect(rate).toBeLessThan(4.0);
  });

  it('uses the rate in effect at window start when no change lands inside the window', () => {
    const deckId = freshDeckId();
    syncRate(deckId, 0.75);
    const windowStart = performance.now() + 10;
    const windowEnd = windowStart + 50;
    // No changes recorded inside [windowStart, windowEnd] — should return the rate
    // that was already in effect (0.75), not the passed-in currentRate fallback.
    const rate = averageRateOverWindow(deckId, windowStart, windowEnd, 999);
    expect(rate).toBeCloseTo(0.75, 6);
  });

  it('clearDeckAudioSync resets rate history so a later window has no memory of a removed deck', () => {
    const deckId = freshDeckId();
    syncRate(deckId, 3.0);
    clearDeckAudioSync(deckId);
    expect(averageRateOverWindow(deckId, 0, 100, 1.0)).toBe(1.0);
  });
});
