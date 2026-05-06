import { get } from 'svelte/store';
import { session, updateDeck, getDeck } from '../state/session';
import { getPhase } from '../renderer/seekBus';
import { audioSetRate } from './pipeline';

const NUDGE_MAGNITUDE = 0.15; // ±15% rate change while nudge is active

interface NudgeState {
  restoreRate: number; // rate to restore when nudge ends
  endTime: number;     // performance.now() ms at which to revert
  rafId: number;
}

const activeNudges = new Map<string, NudgeState>();

function applyRate(deckId: string, rate: number) {
  updateDeck(deckId, { playbackRate: rate });
  audioSetRate(deckId, rate).catch(console.error);
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
  return candidates.find((d) => d.bpm === masterBpm) ?? candidates[0];
}

// Nudge deckId's phase toward the reference deck's phase.
// Applies a ±15% rate spike for exactly as long as needed to close the gap,
// then reverts via RAF (not setTimeout — too coarse at ~16ms jitter).
// No-op if gap < 2% of a beat, or if downbeat/bpm/position are unavailable.
export function nudgePhaseToMaster(deckId: string): void {
  const deck = getDeck(deckId);
  if (!deck || !deck.playing || deck.bpm === null || deck.downbeat === null) return;

  const ref = findReferenceDeck(deckId);
  if (!ref) return;

  const deckPhase = getPhase(deckId);
  const refPhase  = getPhase(ref.id);
  if (deckPhase === null || refPhase === null) return;

  // Shortest-arc delta in [-0.5, 0.5].
  // Positive = deck is behind reference → speed up.
  // Negative = deck is ahead of reference → slow down.
  let delta = refPhase - deckPhase;
  if (delta >  0.5) delta -= 1.0;
  if (delta < -0.5) delta += 1.0;

  if (Math.abs(delta) < 0.02) return;

  const beatPeriod = 60 / deck.bpm;
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
