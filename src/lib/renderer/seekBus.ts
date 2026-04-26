const els = new Map<string, HTMLVideoElement>();

export function registerVideoEl(deckId: string, el: HTMLVideoElement) {
  els.set(deckId, el);
}

export function unregisterVideoEl(deckId: string) {
  els.delete(deckId);
}

export function seekDeck(deckId: string, time: number) {
  const el = els.get(deckId);
  if (el) el.currentTime = time;
}

export function getDeckTime(deckId: string): number | null {
  return els.get(deckId)?.currentTime ?? null;
}
