import { get } from 'svelte/store';
import { session, getDeck } from '../state/session';
import { getPhase, getDeckTime, seekDeck } from '../renderer/seekBus';
import { syncRate } from './audioSync';

const NUDGE_MAGNITUDE = 0.15; // ±15% rate change while nudge is active

interface NudgeState {
  restoreRate: number; // rate to restore when nudge ends
  endTime: number;     // performance.now() ms at which to revert
  rafId: number;
}

const activeNudges = new Map<string, NudgeState>();

// Audio-only: skip the store write so the spike/revert doesn't trigger App.svelte's
// $effect → v.playbackRate → WebKit pipeline rebuild (twice per nudge otherwise).
function applyRate(deckId: string, rate: number) {
  syncRate(deckId, rate);
}

function scheduleRevert(deckId: string, restoreRate: number, durationMs: number) {
  // If a nudge is already in flight, keep its original restoreRate so stacked
  // nudges don't drift the base rate.
  const existing = activeNudges.get(deckId);
  const finalRestore = existing ? existing.restoreRate : restoreRate;
  if (existing) cancelAnimationFrame(existing.rafId);

  const endTime = performance.now() + durationMs;

  function tick() {
    if (performance.now() >= endTime) {
      applyRate(deckId, finalRestore);
      activeNudges.delete(deckId);
    } else {
      const state = activeNudges.get(deckId);
      if (state) state.rafId = requestAnimationFrame(tick);
    }
  }

  const rafId = requestAnimationFrame(tick);
  activeNudges.set(deckId, { restoreRate: finalRestore, endTime, rafId });
}

// Find the phase reference for deckId: prefer the deck whose bpm matches session.bpm;
// fall back to any other deck with both bpm and downbeat set.
function findReferenceDeck(deckId: string) {
  const { decks, bpm: masterBpm } = get(session);
  const candidates = decks.filter(
    (d) => d.id !== deckId && d.bpm !== null && d.downbeat !== null
  );
  if (candidates.length === 0) return null;
  // Tolerance rather than exact equality: bpm is fractional now, and the master
  // deck's bpm was float-copied into session.bpm — exact match works for that
  // deck, but a tolerance also survives future re-analysis producing a value
  // a hundredth of a BPM away.
  return (
    candidates.find(
      (d) => masterBpm !== null && d.bpm !== null && Math.abs(d.bpm - masterBpm) < 0.05,
    ) ?? candidates[0]
  );
}

// Nudge deckId's phase toward the reference deck's phase.
//
// While PLAYING: applies a ±15% rate spike for exactly as long as needed to close
// the gap, then reverts via RAF (not setTimeout — too coarse at ~16ms jitter).
//
// While PAUSED: does an immediate seek to the nearest in-phase position. This lets
// the user pre-align decks before pressing play.
//
// No-op if gap < 2% of a beat, or if downbeat/bpm/position are unavailable.
export function nudgePhaseToMaster(deckId: string): void {
  const deck = getDeck(deckId);
  if (!deck || deck.bpm === null || deck.downbeat === null) return;

  const ref = findReferenceDeck(deckId);
  if (!ref) return;

  const deckPhase = getPhase(deckId);
  const refPhase  = getPhase(ref.id);
  if (deckPhase === null || refPhase === null) return;

  // Shortest-arc delta in [-0.5, 0.5].
  // Positive = deck is behind reference → advance forward.
  // Negative = deck is ahead of reference → seek back.
  let delta = refPhase - deckPhase;
  if (delta >  0.5) delta -= 1.0;
  if (delta < -0.5) delta += 1.0;

  if (Math.abs(delta) < 0.02) return;

  const beatPeriod = 60 / deck.bpm;

  if (!deck.playing) {
    // Paused: seek to the correct in-phase position immediately.
    const currentTime = getDeckTime(deckId);
    if (currentTime === null) return;
    const targetTime = Math.max(0, currentTime + delta * beatPeriod);
    seekDeck(deckId, targetTime);
    return;
  }

  // Playing: rate-spike approach so audio stays gapless.
  const gapSeconds = Math.abs(delta) * beatPeriod;

  const nudgeRate = delta > 0
    ? deck.playbackRate * (1 + NUDGE_MAGNITUDE)
    : deck.playbackRate * (1 - NUDGE_MAGNITUDE);

  // Wall time to close the gap:
  //   extra audio gained per wall-second = playbackRate × NUDGE_MAGNITUDE
  //   duration = gapSeconds / (playbackRate × NUDGE_MAGNITUDE)
  const durationMs = (gapSeconds / (deck.playbackRate * NUDGE_MAGNITUDE)) * 1000;

  applyRate(deckId, nudgeRate);
  scheduleRevert(deckId, deck.playbackRate, durationMs);
}
