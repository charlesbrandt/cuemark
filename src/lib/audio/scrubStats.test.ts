/**
 * Coverage for the scrub-delivery instrument.
 *
 * Worth testing for the same reason `servo_test` exists on the Rust side: this project has
 * twice been sent in the wrong direction by an instrument that produced clean, plausible,
 * wrong numbers (a "baseline" measured against a wedged pipeline; a cadence figure that had
 * never been measured at all). The whole value of this one is that it attributes a stall to
 * the right leg, so that is what these tests pin — a stall injected into one leg must show up
 * in that leg and nowhere else, since the candidate causes have opposite fixes
 * (`docs/design/scratch-audio-downstream-delivery.md`, "why does target delivery stall").
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../debugLog', () => ({ debugLog: vi.fn() }));

/** Fresh module per test: the evQueue calibration floor is deliberately session-global. */
async function load() {
  vi.resetModules();
  const { debugLog } = await import('../debugLog');
  (debugLog as Mock).mockClear();
  return { mod: await import('./scrubStats'), lines: debugLog as Mock };
}

/** Every emitted line as one string, for coarse assertions. */
function joined(lines: Mock): string {
  return lines.mock.calls.map((c) => String(c[0])).join('\n');
}

/** The `[scrub-deliver/…]` line containing `needle`. */
function lineWith(lines: Mock, needle: string): string {
  const found = lines.mock.calls.map((c) => String(c[0])).find((l) => l.includes(needle));
  expect(found, `no line containing "${needle}" in:\n${joined(lines)}`).toBeDefined();
  return found as string;
}

/** `max=` value of the named leg, as reported. */
function legMax(lines: Mock, leg: string): number {
  const line = lineWith(lines, `${leg} `);
  const m = new RegExp(`${leg} p50=-?\\d+ p90=-?\\d+ max=(-?\\d+)`).exec(line);
  expect(m, `could not parse ${leg} from: ${line}`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}

describe('scrubStats delivery legs', () => {
  let now: number;

  beforeEach(() => {
    now = 10_000;
    inflight = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  type Mod = Awaited<ReturnType<typeof load>>['mod'];

  /**
   * `SKEW` stands in for the constant clock offset between `event.timeStamp` and
   * `performance.now()` measured on this WebKitGTK (−44ms and −466ms in two probe runs),
   * which the instrument must calibrate away rather than report as a delay.
   */
  const SKEW = -450;

  /**
   * In-flight IPC replies, settled as the clock passes their due time — a one-deck event
   * loop. Needed because the clock must stay monotonic *and* a reply must be allowed to land
   * in the middle of the input stream rather than between two inputs.
   */
  let inflight: { token: number; due: number; ok: boolean }[] = [];

  function advance(mod: Mod, ms: number) {
    const target = now + ms;
    inflight.sort((a, b) => a.due - b.due);
    while (inflight.length > 0 && inflight[0].due <= target) {
      const f = inflight.shift() as { token: number; due: number; ok: boolean };
      now = f.due;
      mod.noteScrubDispatchResult('deck-0', f.token, f.ok);
    }
    now = target;
  }

  function input(mod: Mod, { gapMs = 20, queueMs = 0 } = {}) {
    advance(mod, gapMs);
    mod.noteScrubInput('deck-0', now - queueMs - SKEW);
  }

  /**
   * One update cycle. `rafMs` and `ipcMs` overlap with continued input delivery on purpose —
   * a sequential harness that advanced the clock through a stalled rAF *before* the next
   * input would push that input's gap out too, and the resulting cross-talk between legs is
   * exactly what these tests exist to rule out. So inputs keep arriving during the rAF wait
   * (they coalesce into the one dispatch, as in the real bus), and the reply is queued to
   * settle `ipcMs` later while the input stream carries on.
   */
  function update(mod: Mod, { gapMs = 20, queueMs = 0, rafMs = 16, ipcMs = 3 } = {}) {
    input(mod, { gapMs, queueMs });
    mod.noteScrubFlushScheduled();
    let waited = 0;
    while (waited + gapMs < rafMs) {
      waited += gapMs;
      input(mod, { gapMs, queueMs });
    }
    advance(mod, rafMs - waited);
    mod.noteScrubFlushRan();
    inflight.push({ token: mod.noteScrubDispatch('deck-0'), due: now + ipcMs, ok: true });
  }

  it('reports a healthy gesture with every leg small', async () => {
    const { mod, lines } = await load();
    mod.beginScrubGesture('deck-0', true);
    for (let i = 0; i < 30; i++) update(mod);
    mod.endScrubGesture('deck-0');

    expect(legMax(lines, 'gap')).toBeLessThan(40);
    expect(legMax(lines, 'rafWait')).toBeLessThan(40);
    expect(legMax(lines, 'ipc')).toBeLessThan(20);
    expect(joined(lines)).toContain('sent=30');
  });

  it('attributes a stall in event delivery to gap + evQueue, not to rafWait or ipc', async () => {
    const { mod, lines } = await load();
    mod.beginScrubGesture('deck-0', true);
    for (let i = 0; i < 10; i++) update(mod);
    // The hand kept moving; the event took 800ms to reach the handler.
    update(mod, { gapMs: 800, queueMs: 780 });
    for (let i = 0; i < 10; i++) update(mod);
    mod.endScrubGesture('deck-0');

    expect(legMax(lines, 'gap')).toBeGreaterThan(700);
    expect(legMax(lines, 'evQueue')).toBeGreaterThan(700);
    // The legs that must stay clean — these are the ones with a different fix.
    expect(legMax(lines, 'rafWait')).toBeLessThan(40);
    expect(legMax(lines, 'ipc')).toBeLessThan(20);
    expect(lineWith(lines, 'worst:')).toMatch(/gap 8\d\dms @.*evQueue 7\d\dms/);
  });

  it('distinguishes "no event was produced" from "an event waited": gap large, evQueue ~0', async () => {
    const { mod, lines } = await load();
    mod.beginScrubGesture('deck-0', true);
    for (let i = 0; i < 10; i++) update(mod);
    // 800ms with no input at all, then a freshly-stamped event.
    update(mod, { gapMs: 800, queueMs: 0 });
    for (let i = 0; i < 10; i++) update(mod);
    mod.endScrubGesture('deck-0');

    expect(legMax(lines, 'gap')).toBeGreaterThan(700);
    expect(legMax(lines, 'evQueue')).toBeLessThan(20);
  });

  it('attributes a stalled rAF to rafWait alone', async () => {
    const { mod, lines } = await load();
    mod.beginScrubGesture('deck-0', true);
    for (let i = 0; i < 10; i++) update(mod);
    update(mod, { rafMs: 850 });
    for (let i = 0; i < 10; i++) update(mod);
    mod.endScrubGesture('deck-0');

    expect(legMax(lines, 'rafWait')).toBeGreaterThan(800);
    // dispatchLag necessarily includes the rAF wait — it is the delay on the value actually
    // sent — but the input stream itself must read clean.
    expect(legMax(lines, 'gap')).toBeLessThan(40);
    expect(legMax(lines, 'evQueue')).toBeLessThan(20);
    expect(legMax(lines, 'ipc')).toBeLessThan(20);
  });

  it('attributes a slow IPC call to ipc alone', async () => {
    const { mod, lines } = await load();
    mod.beginScrubGesture('deck-0', true);
    for (let i = 0; i < 10; i++) update(mod);
    update(mod, { ipcMs: 820 }); // stays in flight while the gesture continues
    for (let i = 0; i < 10; i++) update(mod);
    advance(mod, 1000); // let the straggler settle before the gesture is reported
    mod.endScrubGesture('deck-0');

    expect(legMax(lines, 'ipc')).toBeGreaterThan(800);
    expect(legMax(lines, 'gap')).toBeLessThan(40);
    expect(legMax(lines, 'rafWait')).toBeLessThan(40);
  });

  it('reports evQueue as "—" for MIDI rather than as zero', async () => {
    // The trap this pins: an absent measurement rendered as 0 reads as "no queueing", which
    // is a claim the MIDI path cannot make — it has no platform stamp to compare against.
    const { mod, lines } = await load();
    mod.beginScrubGesture('deck-0', true);
    for (let i = 0; i < 5; i++) {
      now += 30;
      mod.noteScrubInput('deck-0', null);
      mod.noteScrubFlushScheduled();
      now += 16;
      mod.noteScrubFlushRan();
      mod.noteScrubDispatch('deck-0');
    }
    mod.endScrubGesture('deck-0');

    const summary = lineWith(lines, 'inputs n=5');
    expect(summary).toContain('evQueue —');
    expect(summary).toContain('midi');
  });

  it('counts inputs coalesced into one dispatch', async () => {
    const { mod, lines } = await load();
    mod.beginScrubGesture('deck-0', true);
    // Inputs every 4ms against a 16ms rAF: four arrive per pending flush and collapse into
    // the single dispatch it makes, which is the bus's coalescing as actually built.
    for (let i = 0; i < 6; i++) update(mod, { gapMs: 4, rafMs: 16 });
    mod.endScrubGesture('deck-0');

    expect(joined(lines)).toContain('inputs n=24');
    expect(joined(lines)).toContain('sent=6');
    expect(legMax(lines, 'coalesced')).toBe(4);
  });

  it('calls out a second with no events at all', async () => {
    const { mod, lines } = await load();
    mod.beginScrubGesture('deck-0', true);
    update(mod);
    advance(mod, 3500); // spans two whole seconds with nothing in them
    update(mod);
    mod.endScrubGesture('deck-0');

    const secLines = lines.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('[scrub-sec/'));
    expect(secLines.filter((l) => l.includes('NO EVENTS THIS SECOND')).length).toBe(2);
  });

  it('emits nothing for a press that never moved', async () => {
    const { mod, lines } = await load();
    mod.beginScrubGesture('deck-0', true);
    mod.endScrubGesture('deck-0');
    expect(lines.mock.calls.length).toBe(0);
  });

  it('does not carry samples from an abandoned gesture into the next one', async () => {
    const { mod, lines } = await load();
    mod.beginScrubGesture('deck-0', true);
    for (let i = 0; i < 5; i++) update(mod);
    mod.endScrubGesture('deck-0');
    lines.mockClear();

    now += 30_000; // deck sat idle for half a minute
    mod.beginScrubGesture('deck-0', true);
    for (let i = 0; i < 5; i++) update(mod);
    mod.endScrubGesture('deck-0');

    // A leaked lastInputAt would show as a ~30s first gap.
    expect(legMax(lines, 'gap')).toBeLessThan(40);
  });

  it('counts a rejected call as an error without losing its timing', async () => {
    const { mod, lines } = await load();
    mod.beginScrubGesture('deck-0', true);
    for (let i = 0; i < 3; i++) update(mod);
    now += 20;
    mod.noteScrubInput('deck-0', now - SKEW);
    mod.noteScrubFlushScheduled();
    now += 16;
    mod.noteScrubFlushRan();
    const token = mod.noteScrubDispatch('deck-0');
    now += 5;
    mod.noteScrubDispatchResult('deck-0', token, false);
    mod.noteScrubWentSilent('deck-0');
    mod.endScrubGesture('deck-0');

    expect(joined(lines)).toContain('err=1');
    expect(joined(lines)).toContain('silent');
  });

  it('counts silent-path throttle skips separately from sends', async () => {
    const { mod, lines } = await load();
    mod.beginScrubGesture('deck-0', false);
    for (let i = 0; i < 4; i++) {
      now += 20;
      mod.noteScrubInput('deck-0', now - SKEW);
      mod.noteScrubFlushScheduled();
      now += 16;
      mod.noteScrubFlushRan();
      if (i % 2 === 0) mod.noteScrubDispatch('deck-0');
      else mod.noteScrubThrottleSkip('deck-0');
    }
    mod.endScrubGesture('deck-0');

    expect(joined(lines)).toContain('sent=2');
    expect(joined(lines)).toContain('skipped=2');
  });
});
