/**
 * Self-advancing A/B sweep for control-window frame-budget experiments.
 *
 * `docs/design/control-window-frame-budget.md` §5 established that the control window's
 * rAF throttle is not IPC, not GStreamer and not the position poll, but the *reply's* side
 * effect: `setDeckAudioTime()` publishing the audio clock, which drives every per-frame UI
 * consumer. Suppressing that one call took a playing deck from ~20fps to a flat 62fps.
 *
 * What that arm could not say is *which* consumer costs, because it freezes all of them at
 * once — the waveform playhead, `DeckCard`'s elapsed/remaining text, and the preview loop.
 * This module exists to run the confirming arm the doc asks for: keep `setDeckAudioTime`,
 * and suppress exactly one consumer at a time.
 *
 * **Why a wall-clock sweep and not a keypress or an edit per arm.** Both alternatives were
 * tried first and both produced wrong numbers silently:
 *
 *  - An edit per arm means an HMR remount per arm, which tears the deck down, pauses
 *    playback and can wedge the GStreamer pipeline (see the retry-storm tell in CLAUDE.md).
 *    Four arms that way is four interruptions of the thing being measured, by the
 *    measurement.
 *  - A keyboard switch fails twice over: F7/F8 never reach the webview on this desktop, and
 *    a raw `addEventListener` registered in `onMount` is not unwound by HMR — handlers
 *    belonging to destroyed component instances keep logging arm switches while the live
 *    arm never moves. A log line reporting a *switch* is not evidence the switch took
 *    effect; only a line stamped by the loop under measurement is, which is why
 *    `pollStats.ts` stamps `arm=` onto `[raf]` and `[aux-loop]` rather than logging
 *    transitions here.
 *
 * The sweep therefore advances itself off the render loop's own clock, ends where it began
 * so the closing `baseline` proves the run did not simply drift, and rearms whenever
 * nothing is playing so each press of play is a fresh, complete run.
 *
 * Off unless `VITE_PERF_SWEEP=1` is set in the environment that launches Vite:
 *
 *     VITE_PERF_SWEEP=1 cargo tauri dev
 *
 * It must stay off by default because the arms *suppress real UI updates* — a sweep left
 * enabled would freeze the waveform playhead and the deck timestamp for 30s at a stretch.
 */

/** Seconds per arm. Six 5s flush windows, enough to see within-arm drift. */
const ARM_SECONDS = 30;

/**
 * `baseline` first and last: the closing repeat is the drift control, and §5's sweeps are
 * only trustworthy because their baselines reproduced at the end.
 *
 * **The sequence changed after §7.** The original arms (`noWaveDraw`, `noDeckText`) answered
 * their question: the waveform canvas costs nothing and the deck-card text was the whole
 * frame budget. Rate-limiting both text writes then restored 62fps — but left ~23 points of
 * `WebKitWebProcess` CPU that `noDeckText` still removes, so *something* in the two
 * surviving publishers is expensive out of all proportion to its rate.
 *
 * `noPhaseText` and `noTimeText` split them, which is what §6 asked for and could not do:
 * φ is published at 10Hz and the `m:ss` timestamp about once a second, so if the residual
 * tracks φ it is a per-mutation cost, and if it tracks the timestamp it is something about
 * the mutation itself rather than how often it happens.
 *
 * `noDeckText` is retained deliberately as the target to beat — it is the only arm that
 * shows what the card costs when nothing updates at all, and the fix is only finished when
 * `baseline` matches it on CPU as well as on frame rate.
 */
export const SWEEP_ARMS = [
  'baseline',
  'noPhaseText',
  'noTimeText',
  'noDeckText',
  'baseline2',
] as const;
/**
 * Arms whose gate still exists in the UI but which are not in the current sequence.
 * `noWaveDraw` is answered — twice, in two separate sessions — and costs 30s of every run
 * to re-answer, but keeping its gate means re-testing it is a one-word edit to `SWEEP_ARMS`
 * rather than a re-implementation.
 */
const RETIRED_ARMS = ['noWaveDraw'] as const;

export type ArmName = (typeof SWEEP_ARMS)[number] | (typeof RETIRED_ARMS)[number];
export type PerfArm = ArmName | 'off' | 'done';

const enabled = import.meta.env.VITE_PERF_SWEEP === '1';

/**
 * Optional track for the sweep to load and play by itself
 * (`VITE_PERF_SWEEP_TRACK=/abs/path.wav`), so a run needs no operator at the keyboard.
 *
 * This exists because the alternative on this machine is *no* run at all: driving the real
 * window needs `tauri-driver` + `WebKitWebDriver` (not installed, both need sudo), and
 * Wayland has no input-synthesis tool here. Measuring under Xvfb instead would answer a
 * different question — the whole finding is about what WebKit's rasterizer costs on this
 * hardware, and llvmpipe is not this hardware.
 *
 * A clean boot deliberately declines the session-recovery snapshot (a fresh AudioManager
 * reports no live pipelines, so rehydration correctly refuses to ghost-restore decks), which
 * is why the autostart has to load the track rather than merely press play.
 */
export function sweepAutostartTrack(): string | null {
  if (!enabled) return null;
  const track = import.meta.env.VITE_PERF_SWEEP_TRACK;
  return typeof track === 'string' && track.length > 0 ? track : null;
}

/** A clock that has not moved for this long is a wedged pipeline, not a playing deck. */
const STALL_GRACE_MS = 2000;

let armIndex = 0;
let armStartedAt = 0;
let arm: PerfArm = 'off';
let lastClockSec: number | null = null;
let lastClockMovedAt = 0;

/**
 * The arm in force right now. `off` when the sweep is disabled or nothing has played yet,
 * `done` once the sequence has run out — never a silent fallback to `baseline`, because a
 * window logged as `baseline` must mean the sweep deliberately put it there.
 */
export function currentArm(): PerfArm {
  return arm;
}

/**
 * True when `name` is the arm in force. Gates read this; a disabled sweep answers `false`
 * to every name, so the gated code path is the normal one.
 */
export function armIs(name: ArmName): boolean {
  return arm === name;
}

/** Retired from the sequence (see `RETIRED_ARMS`); the gate stays so re-arming is trivial. */
export function suppressWaveformDraw(): boolean {
  return armIs('noWaveDraw');
}

/** Both deck-card publishers off — the "nothing updates" control, not a candidate fix. */
export function suppressDeckTimeText(): boolean {
  return armIs('noDeckText');
}

/** φ only. Published at 10Hz, so this arm prices a *frequent, small* text mutation. */
export function suppressPhaseText(): boolean {
  return armIs('noPhaseText') || armIs('noDeckText');
}

/** The `m:ss` elapsed/remaining pair only — roughly one mutation per second. */
export function suppressTimestampText(): boolean {
  return armIs('noTimeText') || armIs('noDeckText');
}

/**
 * Advance the sweep. Call once per rAF tick from the render loop with the audio clock of a
 * deck that claims to be playing, or `null` when none is.
 *
 * **It takes the clock rather than `deck.playing` deliberately.** §5 burned an entire run on
 * a flawless-looking 62fps "baseline" that was fake: the pipeline was wedged, so
 * `deck.playing` was true, rAF was at full rate, nothing errored — and position never
 * advanced, which is precisely the condition that makes a frame-budget number meaningless.
 * Requiring the clock to actually move means an arm can only consume its 30s while the
 * thing under measurement is genuinely running, and a wedge rearms the sweep instead of
 * quietly producing a beautiful, worthless window.
 */
export function advanceSweep(clockSec: number | null): void {
  if (!enabled) return;

  const now = performance.now();

  let advancing = clockSec !== null;
  if (clockSec !== null) {
    if (lastClockSec === null || clockSec !== lastClockSec) {
      lastClockSec = clockSec;
      lastClockMovedAt = now;
    } else if (now - lastClockMovedAt > STALL_GRACE_MS) {
      advancing = false;
    }
  } else {
    lastClockSec = null;
    lastClockMovedAt = 0;
  }

  if (!advancing) {
    // Rearm: the next press of play starts the sequence from the top. Resetting rather than
    // pausing is what makes each run self-contained — an arm that spans a stop, a re-load
    // and a re-play is not one arm.
    armIndex = 0;
    armStartedAt = 0;
    arm = 'off';
    return;
  }

  if (armStartedAt === 0) {
    armStartedAt = now;
    arm = SWEEP_ARMS[0];
    return;
  }

  if (now - armStartedAt < ARM_SECONDS * 1000) return;

  armStartedAt = now;
  armIndex += 1;
  arm = armIndex < SWEEP_ARMS.length ? SWEEP_ARMS[armIndex] : 'done';
}
