/**
 * Idempotent audio sync helpers — shared between the MIDI handler (direct call path)
 * and App.svelte's $effect (UI slider path). Module-level Maps prevent duplicate IPC
 * calls regardless of which caller fires first.
 *
 * MIDI events bypass the Svelte store entirely for the audio path:
 *   MIDI → syncRate/syncGain/syncVolume → GStreamer (< 1ms)
 *   MIDI → rAF-throttled updateDeck → Svelte store → UI display (≤ 16ms, fine for display)
 *
 * UI slider changes still go through the store:
 *   slider oninput → updateDeck → $effect → syncRate/… → GStreamer
 * The module-level Map prevents the $effect from duplicating a call already made by the MIDI path.
 */
import { audioSetRate, audioSetGain, audioSetVolume, audioSetEq, audioSetFilter } from './pipeline';

const rateMap   = new Map<string, number>();
const gainMap   = new Map<string, number>();
const volumeMap = new Map<string, number>();
// EQ is three numbers behind one IPC call, so the dedupe key is the triple, not a
// scalar — keyed on the serialised bands rather than one of them.
const eqMap     = new Map<string, string>();
const filterMap = new Map<string, number>();

export function syncRate(deckId: string, rate: number): void {
  const last = rateMap.get(deckId) ?? -1;
  if (Math.abs(rate - last) < 0.005) return;
  rateMap.set(deckId, rate);
  audioSetRate(deckId, rate).catch(console.error);
  recordRateChange(deckId, rate);
}

// Timestamped rate-change log, used by App.svelte's content-position integration
// (see contentPosTracker) to recover the actual content position from GStreamer's
// wall-clock query_position. That integration needs the rate that was ACTUALLY in
// effect across a wall-clock span, not just the rate at the instant the span ends —
// during active tempo/pitch adjustment (MIDI can fire 200+ rate events/sec) the rate
// often changes several times within a single position-poll's round trip (~140-190ms
// per the IPC latency baseline), so "latest known rate applied to the whole span"
// systematically over/undershoots the true content position while the fader is moving.
interface RateChange { ts: number; rate: number }
const rateHistory = new Map<string, RateChange[]>();
const RATE_HISTORY_MAX_AGE_MS = 2000;

function recordRateChange(deckId: string, rate: number): void {
  const now = performance.now();
  let history = rateHistory.get(deckId);
  if (!history) {
    history = [];
    rateHistory.set(deckId, history);
  }
  history.push({ ts: now, rate });
  // Trim stale entries, but always leave at least one at/before the cutoff so the
  // rate in effect at any timestamp within the retention window stays resolvable.
  const cutoff = now - RATE_HISTORY_MAX_AGE_MS;
  let i = 0;
  while (i < history.length - 1 && history[i + 1].ts <= cutoff) i++;
  if (i > 0) history.splice(0, i);
}

/**
 * Time-weighted average rate applied to `deckId` over [fromMs, toMs] (both
 * `performance.now()`-space timestamps), accounting for any rate changes recorded
 * inside that window. Falls back to `currentRate` when there's no window or no
 * history (e.g. before the deck's first rate sync).
 */
export function averageRateOverWindow(deckId: string, fromMs: number, toMs: number, currentRate: number): number {
  if (toMs <= fromMs) return currentRate;
  const history = rateHistory.get(deckId);
  if (!history || history.length === 0) return currentRate;

  let segStart = fromMs;
  let segRate = currentRate;
  for (const change of history) {
    if (change.ts <= fromMs) segRate = change.rate;
    else break;
  }

  let weighted = 0;
  for (const change of history) {
    if (change.ts <= fromMs || change.ts >= toMs) continue;
    weighted += (change.ts - segStart) * segRate;
    segStart = change.ts;
    segRate = change.rate;
  }
  weighted += (toMs - segStart) * segRate;
  return weighted / (toMs - fromMs);
}

export function syncGain(deckId: string, gain: number): void {
  if (gainMap.get(deckId) === gain) return;
  gainMap.set(deckId, gain);
  audioSetGain(deckId, gain).catch(console.error);
}

export function syncVolume(deckId: string, volume: number): void {
  if (volumeMap.get(deckId) === volume) return;
  volumeMap.set(deckId, volume);
  audioSetVolume(deckId, volume).catch(console.error);
}

export function syncEq(deckId: string, low: number, mid: number, high: number): void {
  const key = `${low}/${mid}/${high}`;
  if (eqMap.get(deckId) === key) return;
  eqMap.set(deckId, key);
  audioSetEq(deckId, low, mid, high).catch(console.error);
}

export function syncFilter(deckId: string, pos: number): void {
  if (filterMap.get(deckId) === pos) return;
  filterMap.set(deckId, pos);
  audioSetFilter(deckId, pos).catch(console.error);
}

export function clearDeckAudioSync(deckId: string): void {
  rateMap.delete(deckId);
  gainMap.delete(deckId);
  volumeMap.delete(deckId);
  eqMap.delete(deckId);
  filterMap.delete(deckId);
  rateHistory.delete(deckId);
}
