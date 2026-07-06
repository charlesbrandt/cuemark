/**
 * Tracks, per deck, which file path's bpm/downbeat came from a trusted saved
 * source (local sidecar or Digger) rather than the auto-fit. Keyed by file path,
 * not just deck ID: a flag set for one track must not be mistaken for trust in
 * a different track later loaded onto the same deck.
 */
const savedGridPaths = new Map<string, string>();

export function markGridSaved(deckId: string, filePath: string): void {
  savedGridPaths.set(deckId, filePath);
}

export function hasSavedGrid(deckId: string, filePath: string): boolean {
  return savedGridPaths.get(deckId) === filePath;
}

export function clearSavedGrid(deckId: string): void {
  savedGridPaths.delete(deckId);
}
