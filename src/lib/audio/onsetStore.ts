/**
 * Retains, per deck, the detected onset times from the most recent beat-grid fit
 * (bpm.ts's detectBeatGrid) — otherwise discarded once the fit completes. Lets SET BEAT
 * (bpm.ts's snapToNearestOnset) correct for human button latency instead of stamping the
 * raw press time. Keyed by file path like gridSource.ts: an onset list captured for one
 * track must not be mistaken for another track later loaded onto the same deck.
 */
const deckOnsets = new Map<string, { filePath: string; onsets: number[] }>();

export function setDeckOnsets(deckId: string, filePath: string, onsets: number[]): void {
  deckOnsets.set(deckId, { filePath, onsets });
}

export function getDeckOnsets(deckId: string, filePath: string): number[] | null {
  const entry = deckOnsets.get(deckId);
  return entry && entry.filePath === filePath ? entry.onsets : null;
}
