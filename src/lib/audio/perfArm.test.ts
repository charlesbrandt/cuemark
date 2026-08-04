/**
 * Coverage for the frame-budget A/B sweep harness.
 *
 * Worth testing because every wrong number in `docs/design/control-window-frame-budget.md`
 * §5 came from a *harness* fault rather than a measurement fault — a keyboard switch whose
 * handler belonged to a destroyed component, and a "baseline" measured against a wedged
 * pipeline that never advanced. Both produced clean, plausible, entirely fictional windows.
 * These tests pin the two properties that make a run trustworthy: an arm advances only
 * while the clock is really moving, and the sequence returns to baseline so drift is visible.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Fresh module instance with the sweep enabled, since `enabled` is read at load time. */
async function loadSweep(enabled: boolean) {
  vi.resetModules();
  vi.stubEnv('VITE_PERF_SWEEP', enabled ? '1' : '');
  return import('./perfArm');
}

/** Drive `advanceSweep` across `ms` of wall clock with the clock moving, one tick per 16ms. */
function play(
  mod: Awaited<ReturnType<typeof loadSweep>>,
  now: { t: number },
  ms: number,
  clock: { sec: number },
  moving = true,
) {
  const until = now.t + ms;
  while (now.t < until) {
    now.t += 16;
    if (moving) clock.sec += 0.016;
    mod.advanceSweep(clock.sec);
  }
}

describe('perfArm sweep', () => {
  let now: { t: number };
  let clock: { sec: number };

  beforeEach(() => {
    now = { t: 1000 };
    clock = { sec: 0 };
    vi.spyOn(performance, 'now').mockImplementation(() => now.t);
  });

  it('is inert unless VITE_PERF_SWEEP=1', async () => {
    const mod = await loadSweep(false);
    play(mod, now, 120_000, clock);
    expect(mod.currentArm()).toBe('off');
    expect(mod.suppressWaveformDraw()).toBe(false);
    expect(mod.suppressDeckTimeText()).toBe(false);
    expect(mod.suppressPhaseText()).toBe(false);
    expect(mod.suppressTimestampText()).toBe(false);
  });

  it('walks baseline → noPhaseText → noTimeText → noDeckText → baseline2 → done', async () => {
    const mod = await loadSweep(true);
    expect(mod.currentArm()).toBe('off');

    play(mod, now, 1000, clock);
    expect(mod.currentArm()).toBe('baseline');

    // The two split arms must suppress exactly one publisher each — a gate that leaks into
    // the other makes the arm measure the pair again, which is the ambiguity §6 was left
    // with and the entire reason this split exists.
    play(mod, now, 30_000, clock);
    expect(mod.currentArm()).toBe('noPhaseText');
    expect(mod.suppressPhaseText()).toBe(true);
    expect(mod.suppressTimestampText()).toBe(false);

    play(mod, now, 30_000, clock);
    expect(mod.currentArm()).toBe('noTimeText');
    expect(mod.suppressPhaseText()).toBe(false);
    expect(mod.suppressTimestampText()).toBe(true);

    // The both-off control has to imply both split gates, or `baseline` vs `noDeckText` is
    // no longer the same comparison §6 made.
    play(mod, now, 30_000, clock);
    expect(mod.currentArm()).toBe('noDeckText');
    expect(mod.suppressDeckTimeText()).toBe(true);
    expect(mod.suppressPhaseText()).toBe(true);
    expect(mod.suppressTimestampText()).toBe(true);

    // The closing baseline is the drift control: without it a run cannot distinguish a real
    // arm effect from the machine simply getting slower.
    play(mod, now, 30_000, clock);
    expect(mod.currentArm()).toBe('baseline2');
    expect(mod.suppressPhaseText()).toBe(false);
    expect(mod.suppressTimestampText()).toBe(false);

    // Past the end it parks on `done`, never silently back on a named arm — a window logged
    // as `baseline` has to mean the sweep deliberately put it there.
    play(mod, now, 30_000, clock);
    expect(mod.currentArm()).toBe('done');
    expect(mod.suppressWaveformDraw()).toBe(false);
    expect(mod.suppressDeckTimeText()).toBe(false);
    expect(mod.suppressPhaseText()).toBe(false);
    expect(mod.suppressTimestampText()).toBe(false);
  });

  it('rearms on pause so each press of play is a complete run', async () => {
    const mod = await loadSweep(true);
    play(mod, now, 40_000, clock);
    expect(mod.currentArm()).toBe('noPhaseText');

    mod.advanceSweep(null);
    expect(mod.currentArm()).toBe('off');

    play(mod, now, 1000, clock);
    expect(mod.currentArm()).toBe('baseline');
  });

  it('refuses to advance when the clock is frozen, even with a deck claiming to play', async () => {
    const mod = await loadSweep(true);
    play(mod, now, 1000, clock);
    expect(mod.currentArm()).toBe('baseline');

    // A wedged GStreamer pipeline: deck.playing stays true and rAF runs at full rate, but
    // position never moves. §5 measured a flawless 62fps "baseline" this way and it was
    // worthless. Holding the arm would be bad; advancing through the whole sweep on a dead
    // clock would be worse.
    play(mod, now, 60_000, clock, false);
    expect(mod.currentArm()).toBe('off');

    // Recovering (a re-load unwedges it) starts a fresh run rather than resuming mid-sweep.
    play(mod, now, 1000, clock);
    expect(mod.currentArm()).toBe('baseline');
  });

  it('tolerates a briefly static clock without dropping the arm', async () => {
    const mod = await loadSweep(true);
    play(mod, now, 1000, clock);
    // Shorter than STALL_GRACE_MS: a poll that resolves late must not look like a wedge.
    play(mod, now, 1000, clock, false);
    expect(mod.currentArm()).toBe('baseline');
  });
});
