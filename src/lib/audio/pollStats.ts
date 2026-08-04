/**
 * Latency instrumentation for the `audio_get_position` poll — the master clock's
 * transport (see `docs/design/av-sync-architecture.md`).
 *
 * Two things this exists to fix about the previous instrumentation:
 *
 *  1. **It logged only outliers.** A bare `if (pollMs > 300) debugLog(…)` shows the tail
 *     and hides the distribution, so a run of 300–424ms lines can't be told apart from a
 *     baseline that is already slow (the documented normal round trip is ~140–190ms).
 *     Here every sample is accumulated and one percentile line is emitted per bucket per
 *     flush interval, so the shape is visible without flooding the IPC bridge that is
 *     itself under measurement (`debugLog` goes through that same bridge).
 *
 *  2. **It couldn't attribute the time.** A round trip spans three legs, and only one of
 *     them is the audio backend:
 *
 *        JS invoke ──toRust──► GTK main thread ──inRust──► reply ──toJs──► promise callback
 *
 *     `audio_get_position` is a synchronous `#[tauri::command]`, so it is dispatched on
 *     the GTK main thread: `toRust` measures how long that thread took to get to it, and
 *     `toJs` how long the webview's JS main thread took to run the callback. Neither is
 *     GStreamer. `inRust` splits further into `lock` (contending for `Mutex<AudioManager>`)
 *     and `query` (GStreamer's `query_position`). Timestamps cross the boundary as epoch
 *     ms — the only clock both processes share.
 *
 * The `ipc-ping` control arm closes the argument: a command that does nothing, fired on
 * the same transport at the same moment. If the no-op is just as slow, the backend is
 * exonerated regardless of what the legs say.
 *
 * Scratch is a free second control: during a gesture `position()` returns the feeder's
 * atomic cursor and never touches GStreamer, so a `deck-N/scratch` bucket showing
 * `query p50≈0` alongside a slow total localizes the cost to the transport by itself.
 */
import { debugLog } from '../debugLog';
import { ipcPing, type PositionSample } from './pipeline';

/** Individually logged, with full leg breakdown, so outliers keep their detail. */
const OUTLIER_MS = 300;
/** One percentile line per bucket per interval. */
const FLUSH_INTERVAL_MS = 5000;
/** Lower bound on control-arm spacing; ~1 no-op IPC/sec while a deck plays. */
const PING_INTERVAL_MS = 1000;

interface Legs {
  total: number;
  toRust: number;
  inRust: number;
  lock: number;
  query: number;
  toJs: number;
}

const buckets = new Map<string, Legs[]>();
const pings: { total: number; toRust: number; toJs: number }[] = [];
const frames: { gap: number; dur: number }[] = [];
const posts: { sync: number; total: number; bitmaps: number }[] = [];
const auxLoops = new Map<string, { dur: number; drew: boolean }[]>();
let lastFlushAt = 0;
let lastPingAt = 0;

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** `p50=… p90=… max=…` for one leg across a window of samples. */
function summarize(samples: Legs[], leg: keyof Legs): string {
  const sorted = samples.map((s) => s[leg]).sort((a, b) => a - b);
  return `p50=${pct(sorted, 0.5).toFixed(0)} p90=${pct(sorted, 0.9).toFixed(0)} max=${sorted[sorted.length - 1].toFixed(0)}`;
}

/**
 * Record one resolved position poll.
 *
 * @param deckId      deck the poll was for
 * @param sample      the reply, carrying the backend's own entry/exit epoch stamps
 * @param startEpochMs `Date.now()` captured immediately before `invoke()`
 * @param totalMs     `performance.now()` delta across the whole round trip (the precise
 *                    number; the epoch stamps are 1ms-granular and only split it up)
 * @param scratching  whether a scratch gesture was active — selects a separate bucket,
 *                    since that path bypasses GStreamer entirely
 */
export function recordPollSample(
  deckId: string,
  sample: PositionSample,
  startEpochMs: number,
  totalMs: number,
  scratching: boolean,
): void {
  const endEpochMs = Date.now();
  // Legs are differences between two 1ms-granular wall clocks, so a leg that is really
  // ~0 can land slightly negative. Left unclamped deliberately: a *systematically*
  // negative leg would mean the two clocks disagree, which is worth seeing rather than
  // hiding behind a Math.max(0, …).
  const legs: Legs = {
    total: totalMs,
    toRust: sample.entryMs - startEpochMs,
    inRust: sample.exitMs - sample.entryMs,
    lock: sample.lockMs,
    query: sample.queryMs,
    toJs: endEpochMs - sample.exitMs,
  };

  if (totalMs > OUTLIER_MS) {
    debugLog(
      `[position-poll] ${deckId}${scratching ? '/scratch' : ''} took ${totalMs.toFixed(0)}ms — ` +
        `toRust=${legs.toRust.toFixed(0)} inRust=${legs.inRust.toFixed(0)} ` +
        `(lock=${legs.lock.toFixed(1)} query=${legs.query.toFixed(1)}) toJs=${legs.toJs.toFixed(0)} ` +
        `pos=${sample.pos === null ? 'null' : sample.pos.toFixed(3)}`,
    );
  }

  const key = `${deckId}${scratching ? '/scratch' : ''}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = [];
    buckets.set(key, bucket);
  }
  bucket.push(legs);

  maybeFlush();
}

/**
 * Record one rAF tick of the control window's render loop: `gapMs` since the previous
 * tick, and the synchronous `durationMs` of this one.
 *
 * This is the discriminator for a slow `toJs` leg. A poll's reply can only run once the
 * JS main thread gets to it, so a large `toJs` has two very different causes:
 *   - `gap` ≈ `dur` ≈ the latency → the thread is saturated by the render loop's own
 *     synchronous work; the fix is to do less per frame.
 *   - `gap` large but `dur` small → the loop is not the thing eating the thread; look at
 *     work it schedules but doesn't execute inline, or at how WebKit prioritizes IPC
 *     reply delivery against compositing.
 *   - `gap` ≈ 16ms with a large `toJs` → the thread is keeping up fine and reply delivery
 *     itself is being starved, which no amount of per-frame optimization will fix.
 */
export function recordFrameTiming(gapMs: number, durationMs: number): void {
  frames.push({ gap: gapMs, dur: durationMs });
  maybeFlush();
}

/**
 * Record one `outputBus.postFrame()` send: `syncMs` is the part that runs inline in the
 * rAF tick (the per-deck `drawImage` into the scratch canvas), `totalMs` runs to the
 * `postMessage` completing, and `bitmaps` is how many were built.
 *
 * Measured because `frame-dur` provably does not account for the frame period: with one
 * deck playing the loop drops to ~17fps (58ms/frame) while `frame-dur` is 11ms, so ~80%
 * of each frame is spent outside the synchronous render loop (2026-08-03). `postFrame`'s
 * async tail — `createImageBitmap` resolving plus the cross-process structured clone of a
 * full-resolution bitmap — is the leading candidate for that gap, and it runs whether or
 * not an output window is actually listening.
 */
export function recordPostFrame(syncMs: number, totalMs: number, bitmaps: number): void {
  posts.push({ sync: syncMs, total: totalMs, bitmaps });
  maybeFlush();
}

/**
 * Record one tick of a rAF loop *other than* `App.svelte`'s `frame()`.
 *
 * `frame-dur` measures only the render loop, but the control window runs three independent
 * rAF loops per playing deck — `frame()`, `DeckCard`'s preview `draw()`, and
 * `WaveformCanvas`'s playhead `loop()`. The latter two execute in the *same* rAF turn and
 * are invisible to `frame-dur`, which is exactly the "gap large, dur small" signature the
 * arm-1 residual shows (`docs/design/control-window-frame-budget.md`). Attributing that
 * residual requires timing each loop separately rather than inferring it.
 *
 * @param label  bucket name, e.g. `preview/deck-0` — per-deck so a two-deck run stays legible
 * @param durMs  synchronous duration of this tick
 * @param drew   whether the tick actually redrew, or bailed on its change-guard. Both loops
 *               skip work when nothing moved, so n alone cannot distinguish "cheap because
 *               guarded" from "cheap because fast" — and only the first is load-dependent.
 */
export function recordAuxLoop(label: string, durMs: number, drew: boolean): void {
  let bucket = auxLoops.get(label);
  if (!bucket) {
    bucket = [];
    auxLoops.set(label, bucket);
  }
  bucket.push({ dur: durMs, drew });
  maybeFlush();
}

function maybeFlush(): void {
  const now = performance.now();
  if (lastFlushAt === 0) lastFlushAt = now;
  if (now - lastFlushAt >= FLUSH_INTERVAL_MS) {
    lastFlushAt = now;
    flush();
  }
}

/**
 * Share of wall-clock time a bucket's synchronous work occupied over the flush window.
 *
 * This is the number that actually settles attribution: percentiles say what one tick cost,
 * `busy%` says how much of the frame budget the loop consumed in total. Summing `busy%`
 * across every instrumented loop and subtracting from 100 leaves the *unaccounted* share —
 * decode callbacks, style/layout, compositing, WebKit internals — which is the only honest
 * way to know whether the instrumented suspects explain the residual or merely contribute.
 */
function busyPct(durations: number[]): string {
  const sum = durations.reduce((a, b) => a + b, 0);
  return `${((sum / FLUSH_INTERVAL_MS) * 100).toFixed(0)}%`;
}

function flush(): void {
  for (const [key, samples] of buckets) {
    if (samples.length === 0) continue;
    debugLog(
      `[poll-stats] ${key} n=${samples.length} | total ${summarize(samples, 'total')} | ` +
        `toRust ${summarize(samples, 'toRust')} | inRust ${summarize(samples, 'inRust')} ` +
        `(lock ${summarize(samples, 'lock')}, query ${summarize(samples, 'query')}) | ` +
        `toJs ${summarize(samples, 'toJs')}`,
    );
  }
  buckets.clear();

  if (frames.length > 0) {
    const s = (leg: 'gap' | 'dur') => {
      const sorted = frames.map((f) => f[leg]).sort((a, b) => a - b);
      return `p50=${pct(sorted, 0.5).toFixed(0)} p90=${pct(sorted, 0.9).toFixed(0)} max=${sorted[sorted.length - 1].toFixed(0)}`;
    };
    const fps = (frames.length / (FLUSH_INTERVAL_MS / 1000)).toFixed(1);
    debugLog(
      `[raf] n=${frames.length} (~${fps}fps) | gap ${s('gap')} | frame-dur ${s('dur')} | ` +
        `busy ${busyPct(frames.map((f) => f.dur))}`,
    );
    frames.length = 0;
  }

  for (const [label, ticks] of auxLoops) {
    if (ticks.length === 0) continue;
    const sorted = ticks.map((t) => t.dur).sort((a, b) => a - b);
    const drew = ticks.filter((t) => t.drew).length;
    debugLog(
      `[aux-loop] ${label} n=${ticks.length} drew=${drew} | dur ` +
        `p50=${pct(sorted, 0.5).toFixed(1)} p90=${pct(sorted, 0.9).toFixed(1)} ` +
        `max=${sorted[sorted.length - 1].toFixed(1)} | busy ${busyPct(sorted)}`,
    );
  }
  auxLoops.clear();

  if (posts.length > 0) {
    const s = (leg: 'sync' | 'total') => {
      const sorted = posts.map((p) => p[leg]).sort((a, b) => a - b);
      return `p50=${pct(sorted, 0.5).toFixed(0)} p90=${pct(sorted, 0.9).toFixed(0)} max=${sorted[sorted.length - 1].toFixed(0)}`;
    };
    const bitmaps = posts.reduce((n, p) => n + p.bitmaps, 0);
    debugLog(
      `[post-frame] n=${posts.length} bitmaps=${bitmaps} | sync ${s('sync')} | to-postMessage ${s('total')}`,
    );
    posts.length = 0;
  }

  if (pings.length > 0) {
    const s = (leg: 'total' | 'toRust' | 'toJs') => {
      const sorted = pings.map((p) => p[leg]).sort((a, b) => a - b);
      return `p50=${pct(sorted, 0.5).toFixed(0)} p90=${pct(sorted, 0.9).toFixed(0)} max=${sorted[sorted.length - 1].toFixed(0)}`;
    };
    debugLog(
      `[ipc-ping] noop n=${pings.length} | total ${s('total')} | toRust ${s('toRust')} | toJs ${s('toJs')}`,
    );
    pings.length = 0;
  }
}

/**
 * Fire the no-op control arm, at most once per `PING_INTERVAL_MS`. Call it from the
 * same tick that starts a position poll so the two measure the same transport under the
 * same load; results are reported by the shared flush above.
 */
export function maybePingIpc(): void {
  const now = performance.now();
  if (now - lastPingAt < PING_INTERVAL_MS) return;
  lastPingAt = now;

  const startEpochMs = Date.now();
  const startMs = now;
  ipcPing()
    .then((rustEpochMs) => {
      pings.push({
        total: performance.now() - startMs,
        toRust: rustEpochMs - startEpochMs,
        toJs: Date.now() - rustEpochMs,
      });
    })
    .catch(() => {});
}
