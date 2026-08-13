/**
 * Frontend-side delivery instrumentation for scrub/scratch position targets.
 *
 * Why this exists: `docs/design/scratch-audio-downstream-delivery.md` measured
 * multi-hundred-millisecond stalls in target delivery mid-gesture (gap max 874ms against a
 * p50 of 18ms) and established that the servo is behaving correctly — it is faithfully
 * reporting "no new information for 874ms". But that gap is timed **where the call lands in
 * Rust**, which cannot distinguish:
 *
 *   (a) no pointer/MIDI event fired at all,
 *   (b) an event fired and sat queued behind a busy main thread,
 *   (c) an event fired, the scrub bus coalesced it into an rAF that never ran on time,
 *   (d) all of the above were fine and the IPC call itself took 800ms to arrive.
 *
 * Those have opposite fixes, so this splits the path into legs the same way `pollStats.ts`
 * splits the position poll:
 *
 *   device ──evQueue──► JS handler ──rafWait──► bus flush ──dispatchLag──► invoke ──ipc──► resolved
 *
 * ## How to read a gesture
 *
 * | Shape | Where the stall is |
 * |---|---|
 * | `gap` large, `evQueue` large on the arriving event | events were produced and queued — the main thread was blocked (a); look at `[raf]`/`[aux-loop]` busy% for the same window |
 * | `gap` large, `evQueue` ≈ 0 | no events were produced (b) — WebKit/device coalescing upstream, or the hand really did pause. Compare against the user's account of the gesture |
 * | `gap` small, `rafWait` large | this file's own scrub bus is the throttle (c) — its rAF coalescing rides the control window's frame rate, measured on this machine at 9–57fps. Cross-check `[raf] gap` for the same seconds |
 * | `gap`/`rafWait` small, `ipc` large | IPC backpressure (d) — cross-check the `[ipc-ping]` control arm, which is the only thing that can exonerate the callee |
 * | everything small here, but `[scratch-tel] gap max` still large | the stall is between `invoke()` and the command being dispatched on the GTK main thread (`toRust` in pollStats' terms) — nothing on the JS side can fix that |
 *
 * `sent/s` here is directly comparable with `targets N/s` in `[scratch-tel]`: the same
 * calls, counted at the two ends of the bridge. A disagreement is itself a finding.
 *
 * ## Two deliberate design choices
 *
 * **Nothing is logged during the gesture.** `debugLog` is an `invoke()` on the same bridge
 * under measurement (its own doc comment says as much), so a per-second line would
 * contaminate the delivery it is timing — the one thing this instrument cannot afford. Every
 * sample is buffered and the whole gesture is emitted at `endScrubGesture()`, including the
 * per-second breakdown, so the numbers describe an uninstrumented-looking path.
 *
 * **`evQueue` is calibrated, not absolute.** `PointerEvent.timeStamp` here is
 * platform-derived — verified, not assumed: `scripts/probes/pointer_events_probe.py`'s
 * `stale` stage backdates one `GdkEvent.time` by 250ms and the DOM stamp moves with it by
 * +250ms, so the value really does carry when the event happened. But it sits on a clock
 * whose origin is offset from `performance.now()`'s by a constant that differs per page load
 * (−44ms and −466ms in two runs of the probe). Only the *variation* is meaningful, so this
 * tracks the smallest `now - timeStamp` seen across the session and reports each sample
 * relative to that floor. The floor is session-global rather than per-gesture on purpose: a
 * short gesture that was stalled throughout would otherwise calibrate its own stall away.
 *
 * ⚠️ A running minimum **under-reports the earliest samples**: a stall that happens before
 * any un-stalled event has been seen becomes the floor and reads as 0. The summary line
 * therefore prints the floor and how many samples established it, so a first gesture with
 * `n` in single digits can be read with the suspicion it deserves — and the fix is simply to
 * discard the first gesture of a session, which is free.
 */
import { debugLog } from '../debugLog';

/** Which hardware produced the gesture. Inferred from whether inputs carry a platform stamp. */
type ScrubSource = 'pointer' | 'midi' | 'unknown';

interface InputSample {
  /** ms since gesture start */
  at: number;
  /** ms since the previous input of this gesture; null for the first */
  gap: number | null;
  /** calibrated event-queueing delay, or null when the input carried no platform stamp */
  queue: number | null;
}

interface DispatchSample {
  /** dispatch time on `performance.now()`'s clock — the token handed to the caller */
  token: number;
  at: number;
  /** rAF schedule → flush callback entry */
  rafWait: number;
  /** newest input arrival → this dispatch (delay the bus added to the value actually sent) */
  dispatchLag: number;
  /** inputs that collapsed into this one dispatch */
  coalesced: number;
  /** invoke → promise settled; null on the silent path, which has no promise to time */
  ipc: number | null;
  ok: boolean;
}

interface Gesture {
  source: ScrubSource;
  audible: boolean;
  t0: number;
  inputs: InputSample[];
  dispatches: DispatchSample[];
  /** flushes where the silent path's SILENT_SCRUB_SEEK_MS throttle dropped the target */
  skipped: number;
  lastInputAt: number | null;
  /** inputs since the last dispatch — becomes `coalesced` on the next one */
  pendingInputs: number;
  truncated: boolean;
}

/**
 * Sample cap per gesture (~2 minutes at 50/s). A gesture that hits it keeps counting
 * totals and stops keeping per-sample detail, and the summary says so — a silently
 * truncated distribution is exactly the kind of thing this project has been misled by.
 */
const MAX_SAMPLES = 6000;
/** Per-second lines emitted at most, so one very long gesture cannot flood the log. */
const MAX_SECOND_LINES = 120;

const gestures = new Map<string, Gesture>();

/**
 * Smallest `performance.now() - event.timeStamp` seen this session — the zero point for
 * `evQueue`. Session-global; see the module doc comment.
 */
let queueFloor = Number.POSITIVE_INFINITY;
let queueFloorSamples = 0;

/** rAF scheduled at (module-level: one flush serves every deck). */
let flushScheduledAt: number | null = null;
/** rAF wait measured by the flush currently running, attributed to each deck it serves. */
let currentFlushWait = 0;

export function beginScrubGesture(deckId: string, audible: boolean): void {
  gestures.set(deckId, {
    source: 'unknown',
    audible,
    t0: performance.now(),
    inputs: [],
    dispatches: [],
    skipped: 0,
    lastInputAt: null,
    pendingInputs: 0,
    truncated: false,
  });
}

/**
 * One input event arriving in JS — a `pointermove`, or a MIDI jog tick's handler run.
 *
 * @param eventTimeStampMs `event.timeStamp` for a real DOM event; null for MIDI, which
 *        arrives over Tauri IPC and carries no platform stamp. A null here is what makes
 *        the gesture's `source` read `midi`.
 */
export function noteScrubInput(deckId: string, eventTimeStampMs: number | null): void {
  const g = gestures.get(deckId);
  if (!g) return;
  const now = performance.now();

  let queue: number | null = null;
  if (eventTimeStampMs !== null && eventTimeStampMs > 0) {
    if (g.source === 'unknown') g.source = 'pointer';
    const raw = now - eventTimeStampMs;
    if (raw < queueFloor) queueFloor = raw;
    queueFloorSamples++;
    queue = raw - queueFloor;
  } else if (g.source === 'unknown') {
    g.source = 'midi';
  }

  g.pendingInputs++;
  const gap = g.lastInputAt === null ? null : now - g.lastInputAt;
  g.lastInputAt = now;
  if (g.inputs.length < MAX_SAMPLES) {
    g.inputs.push({ at: now - g.t0, gap, queue });
  } else {
    g.truncated = true;
  }
}

/** The scrub bus scheduled its coalescing rAF. */
export function noteScrubFlushScheduled(): void {
  flushScheduledAt = performance.now();
}

/** First statement of the scrub bus's rAF callback — closes the `rafWait` leg. */
export function noteScrubFlushRan(): void {
  currentFlushWait = flushScheduledAt === null ? 0 : performance.now() - flushScheduledAt;
  flushScheduledAt = null;
}

/**
 * A target is about to be dispatched for this deck. Returns a token to hand back to
 * `noteScrubDispatchResult` — the dispatch time, kept opaque so the caller never has to
 * take a second clock reading of its own.
 */
export function noteScrubDispatch(deckId: string): number {
  const now = performance.now();
  const g = gestures.get(deckId);
  if (!g) return now;
  if (g.dispatches.length < MAX_SAMPLES) {
    g.dispatches.push({
      token: now,
      at: now - g.t0,
      rafWait: currentFlushWait,
      dispatchLag: g.lastInputAt === null ? 0 : now - g.lastInputAt,
      coalesced: Math.max(1, g.pendingInputs),
      ipc: null,
      ok: true,
    });
  } else {
    g.truncated = true;
  }
  g.pendingInputs = 0;
  return now;
}

/**
 * The dispatched call settled. `ok=false` covers the "no PCM buffer" rejection that
 * degrades the gesture to a silent seek scrub — worth counting separately, since a gesture
 * full of those is a different story from a slow one.
 */
export function noteScrubDispatchResult(deckId: string, token: number, ok: boolean): void {
  const g = gestures.get(deckId);
  if (!g) return;
  // Searched from the end: a gesture is thousands of samples long and the reply belongs to
  // one of the most recent dispatches. Bails as soon as it passes the token rather than
  // scanning the whole gesture for a dispatch that was never recorded (sample cap hit).
  for (let i = g.dispatches.length - 1; i >= 0; i--) {
    const d = g.dispatches[i];
    if (d.token === token) {
      d.ipc = performance.now() - token;
      d.ok = ok;
      return;
    }
    if (d.token < token) return;
  }
}

/** A flush where the silent path's seek throttle dropped this deck's pending target. */
export function noteScrubThrottleSkip(deckId: string): void {
  const g = gestures.get(deckId);
  if (g) g.skipped++;
}

/** The gesture fell back to the silent seek path mid-flight (PCM decode unavailable). */
export function noteScrubWentSilent(deckId: string): void {
  const g = gestures.get(deckId);
  if (g) g.audible = false;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** `p50=… p90=… max=…` over a set of samples, or `—` when there are none. */
function summarize(values: (number | null)[]): string {
  const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return '—';
  return (
    `p50=${pct(sorted, 0.5).toFixed(0)} p90=${pct(sorted, 0.9).toFixed(0)} ` +
    `max=${sorted[sorted.length - 1].toFixed(0)}`
  );
}

function maxOf(values: (number | null)[]): number {
  let m = 0;
  for (const v of values) if (v !== null && v > m) m = v;
  return m;
}

/**
 * End the gesture and emit it. One summary line, one leg line, one worst-case line, and one
 * line per second of the gesture — the per-second lines exist to be joined against
 * `[scratch-tel/…]`, which the Rust side emits on the same cadence, so a bad second can be
 * read from both ends of the bridge at once.
 */
export function endScrubGesture(deckId: string): void {
  const g = gestures.get(deckId);
  if (!g) return;
  gestures.delete(deckId);
  if (g.inputs.length === 0 && g.dispatches.length === 0) return; // a press that never moved

  const durMs = performance.now() - g.t0;
  const secs = Math.max(durMs / 1000, 0.001);
  const rate = (n: number) => (n / secs).toFixed(0);
  const path = g.audible ? 'audible' : 'silent';
  const errs = g.dispatches.filter((d) => !d.ok).length;
  const trunc = g.truncated ? ` (TRUNCATED at ${MAX_SAMPLES} samples)` : '';

  debugLog(
    `[scrub-deliver/${deckId}] ${g.source} ${path} ${(durMs / 1000).toFixed(1)}s${trunc} | ` +
      `inputs n=${g.inputs.length} (${rate(g.inputs.length)}/s) ` +
      `gap ${summarize(g.inputs.map((i) => i.gap))} | ` +
      `evQueue ${summarize(g.inputs.map((i) => i.queue))} ` +
      `(floor ${queueFloor === Number.POSITIVE_INFINITY ? 'n/a' : queueFloor.toFixed(0)}ms, ` +
      `n=${queueFloorSamples}) | ` +
      `sent=${g.dispatches.length} (${rate(g.dispatches.length)}/s) ` +
      `skipped=${g.skipped} err=${errs} ` +
      `coalesced ${summarize(g.dispatches.map((d) => d.coalesced))}`,
  );
  debugLog(
    `[scrub-deliver/${deckId}] rafWait ${summarize(g.dispatches.map((d) => d.rafWait))} | ` +
      `dispatchLag ${summarize(g.dispatches.map((d) => d.dispatchLag))} | ` +
      `ipc ${summarize(g.dispatches.map((d) => d.ipc))}`,
  );

  // The worst gap with its own context, because a single stall is what the investigation is
  // chasing and percentiles cannot say which leg the *same* stall was in.
  const worstInput = g.inputs.reduce<InputSample | null>(
    (w, i) => (i.gap !== null && (w === null || i.gap > (w.gap ?? 0)) ? i : w),
    null,
  );
  const worstRaf = g.dispatches.reduce<DispatchSample | null>(
    (w, d) => (w === null || d.rafWait > w.rafWait ? d : w),
    null,
  );
  const worstIpc = g.dispatches.reduce<DispatchSample | null>(
    (w, d) => (d.ipc !== null && (w === null || d.ipc > (w.ipc ?? 0)) ? d : w),
    null,
  );
  const at = (t: number) => `${(t / 1000).toFixed(1)}s`;
  debugLog(
    `[scrub-deliver/${deckId}] worst: ` +
      (worstInput
        ? `gap ${worstInput.gap?.toFixed(0)}ms @${at(worstInput.at)} ` +
          `(evQueue ${worstInput.queue === null ? 'n/a' : worstInput.queue.toFixed(0) + 'ms'} ` +
          `on the arriving event)`
        : 'gap n/a') +
      (worstRaf ? ` | rafWait ${worstRaf.rafWait.toFixed(0)}ms @${at(worstRaf.at)}` : '') +
      (worstIpc ? ` | ipc ${worstIpc.ipc?.toFixed(0)}ms @${at(worstIpc.at)}` : ''),
  );

  // Per-second breakdown. Maxima rather than percentiles: within one second the question is
  // "was there a stall in here", and a p90 over ~30 samples hides exactly that.
  const lastSecond = Math.floor(durMs / 1000);
  for (let s = 0; s <= Math.min(lastSecond, MAX_SECOND_LINES - 1); s++) {
    const lo = s * 1000;
    const hi = lo + 1000;
    const ins = g.inputs.filter((i) => i.at >= lo && i.at < hi);
    const outs = g.dispatches.filter((d) => d.at >= lo && d.at < hi);
    if (ins.length === 0 && outs.length === 0) {
      // A whole second with nothing at all in it is the loudest possible signal here —
      // never skip it as an empty row.
      debugLog(`[scrub-sec/${deckId}] t=${s} in=0 sent=0 — NO EVENTS THIS SECOND`);
      continue;
    }
    debugLog(
      `[scrub-sec/${deckId}] t=${s} in=${ins.length} sent=${outs.length} | ` +
        `gapMax=${maxOf(ins.map((i) => i.gap)).toFixed(0)} ` +
        `qMax=${maxOf(ins.map((i) => i.queue)).toFixed(0)} ` +
        `rafMax=${maxOf(outs.map((d) => d.rafWait)).toFixed(0)} ` +
        `lagMax=${maxOf(outs.map((d) => d.dispatchLag)).toFixed(0)} ` +
        `ipcMax=${maxOf(outs.map((d) => d.ipc)).toFixed(0)}`,
    );
  }
  if (lastSecond >= MAX_SECOND_LINES) {
    debugLog(
      `[scrub-sec/${deckId}] … ${lastSecond - MAX_SECOND_LINES + 1} further seconds not ` +
        `itemised (cap ${MAX_SECOND_LINES})`,
    );
  }
}
