/**
 * Tracks, per deck, whether the CURRENT track's bpm/downbeat came from a saved
 * source (local sidecar, or in a later step, Digger) rather than the auto-fit —
 * used to gate the auto-fit's `onAnalyzed` callback so a saved grid always wins.
 */
const savedGridDecks = new Set<string>();

export function markGridSaved(deckId: string): void {
  savedGridDecks.add(deckId);
}

export function hasSavedGrid(deckId: string): boolean {
  return savedGridDecks.has(deckId);
}

export function clearSavedGrid(deckId: string): void {
  savedGridDecks.delete(deckId);
}
