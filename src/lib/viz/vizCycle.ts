/**
 * vizCycle.ts — Milkdrop auto-cycle ("screensaver"): advance to the next preset every N
 * seconds, or every N bars when the dominant deck has a beat grid.
 *
 * Pure decision logic (`stepCycle`, `nextPresetId`) plus one small stateful wrapper
 * (`tickAutoCycle`) that App.svelte calls each rAF tick while a Milkdrop preset is active.
 *
 * ## Params (stored in `Visualization.params`, so they persist with the selection)
 *   cycleMode    0 off | 1 seconds | 2 bars
 *   cycleSeconds interval for mode 1, and the FALLBACK interval for mode 2 (default 30)
 *   cycleBars    bars for mode 2 (default 8); a bar is 4 beats
 *   cycleShuffle 1 = random next preset, 0 = list order
 *
 * ## Bars, and what "has a beat grid" means
 * The dominant deck's `getPhase()` is a 0..1 phase within one beat (`deck.downbeat` is a
 * beat-level anchor, NOT bar-beat-1: nothing detects bar identity yet, see CLAUDE.md), so a
 * "bar" here is 4 beats counted from when the cycle (re)started. The advance fires on the very
 * tick the phase wraps, which is what lands the preset change on a beat. With no grid (no
 * dominant deck, no bpm, or no phase) bars mode falls back to `cycleSeconds`.
 */

export const CYCLE_OFF = 0;
export const CYCLE_SECONDS = 1;
export const CYCLE_BARS = 2;
export const BEATS_PER_BAR = 4;

export const DEFAULT_CYCLE_SECONDS = 30;
export const DEFAULT_CYCLE_BARS = 8;
export const DEFAULT_BLEND_SECONDS = 2;

export interface CycleConfig {
  mode: number;
  seconds: number;
  bars: number;
}

export interface CycleState {
  startedAt: number;
  beats: number;
  lastPhase: number | null;
}

export interface BeatInfo {
  /** Phase within the current beat, 0..1; null when the dominant deck has none. */
  phase: number | null;
  /** Effective bpm (deck bpm x playback rate); 0 = no grid. */
  bpm: number;
}

export const newCycleState = (nowMs: number): CycleState => ({ startedAt: nowMs, beats: 0, lastPhase: null });

type Params = Record<string, number | number[] | boolean>;

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function cycleConfig(params: Params | undefined): CycleConfig {
  return {
    mode: Math.round(num(params?.cycleMode, CYCLE_OFF)),
    seconds: Math.max(1, num(params?.cycleSeconds, DEFAULT_CYCLE_SECONDS)),
    bars: Math.max(1, Math.round(num(params?.cycleBars, DEFAULT_CYCLE_BARS))),
  };
}

export const hasGrid = (b: BeatInfo | null): b is BeatInfo & { phase: number } =>
  !!b && b.phase !== null && Number.isFinite(b.phase) && b.bpm > 0;

/**
 * Advance the state by one tick; true = switch preset now (state is reset by the caller via
 * `newCycleState`). `deckPlaying` matters because a paused deck's phase is frozen: no wraps
 * would ever arrive, so bars would never elapse; treat it as "no grid" and use seconds.
 */
export function stepCycle(st: CycleState, nowMs: number, cfg: CycleConfig, beat: BeatInfo | null, deckPlaying: boolean): boolean {
  if (cfg.mode !== CYCLE_SECONDS && cfg.mode !== CYCLE_BARS) return false;
  const elapsed = nowMs - st.startedAt;
  if (cfg.mode === CYCLE_BARS && deckPlaying && hasGrid(beat)) {
    // A wrap is the phase falling by more than half a beat (jitter never does).
    if (st.lastPhase !== null && beat.phase < st.lastPhase - 0.5) st.beats++;
    st.lastPhase = beat.phase;
    // Only ever on the wrap tick itself, so the change lands on a beat.
    return st.beats >= cfg.bars * BEATS_PER_BAR;
  }
  st.lastPhase = null; // grid lost: do not count a bogus wrap when it returns
  return elapsed >= cfg.seconds * 1000;
}

/** Next id after `current` in `ids` (list order, wrapping), or a random other one. */
export function nextPresetId(ids: string[], current: string, shuffle: boolean, rng: () => number = Math.random): string | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0] === current ? null : ids[0];
  if (shuffle) {
    const others = ids.filter((i) => i !== current);
    return others[Math.min(others.length - 1, Math.floor(rng() * others.length))];
  }
  const i = ids.indexOf(current);
  return ids[(i + 1) % ids.length]; // i === -1 (current not listed) starts at the first
}

// ── stateful wrapper ────────────────────────────────────────────────────────────────────────

let state: CycleState | null = null;
let stateFor: string | null = null;
let stateMode = -1;

/**
 * Call once per tick while a Milkdrop preset is selected. Returns the id to switch to, or null.
 * `presetIds` is the ordered list of usable (error-free) presets. The interval restarts
 * whenever the selection or the mode changes, so a manual pick gets a full interval.
 */
export function tickAutoCycle(
  nowMs: number,
  currentId: string,
  params: Params | undefined,
  beat: BeatInfo | null,
  deckPlaying: boolean,
  presetIds: string[],
): string | null {
  const cfg = cycleConfig(params);
  if (!state || stateFor !== currentId || stateMode !== cfg.mode) {
    state = newCycleState(nowMs);
    stateFor = currentId;
    stateMode = cfg.mode;
  }
  if (!stepCycle(state, nowMs, cfg, beat, deckPlaying)) return null;
  const next = nextPresetId(presetIds, currentId, num(params?.cycleShuffle, 0) >= 0.5);
  state = newCycleState(nowMs);
  return next;
}

/** Forget cycle state (Milkdrop deselected). */
export function resetAutoCycle() {
  state = null;
  stateFor = null;
  stateMode = -1;
}
