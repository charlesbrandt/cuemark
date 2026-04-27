import { writable, get } from "svelte/store";
import type { Session, Deck } from "./types";

function makeDeck(index: number): Deck {
  return {
    id: `deck-${index}`,
    source: null,
    playing: false,
    playbackRate: 1.0,
    volume: 1.0,
    opacity: 1.0,
    loop: true,
    cuePoint: 0,
    hotCues: [],
  };
}

const initial: Session = {
  decks: [makeDeck(0), makeDeck(1)],
  masterVolume: 1.0,
  bpm: null,
  crossfaderMapping: { left: "deck-0", right: "deck-1" },
  effects: [],
};

export const session = writable<Session>(initial);

export function addDeck() {
  session.update((s) => ({
    ...s,
    decks: [...s.decks, makeDeck(s.decks.length)],
  }));
}

export function removeDeck(id: string) {
  session.update((s) => ({
    ...s,
    decks: s.decks.filter((d) => d.id !== id),
  }));
}

export function updateDeck(id: string, patch: Partial<Deck>) {
  session.update((s) => ({
    ...s,
    decks: s.decks.map((d) => (d.id === id ? { ...d, ...patch } : d)),
  }));
}

export function getDeck(id: string): Deck | undefined {
  return get(session).decks.find((d) => d.id === id);
}

export function setMasterVolume(value: number) {
  session.update((s) => ({ ...s, masterVolume: value }));
}

// value: 0.0 (full left) → 1.0 (full right)
export function setCrossfader(value: number) {
  session.update((s) => ({
    ...s,
    decks: s.decks.map((d) => {
      if (d.id === s.crossfaderMapping.left) return { ...d, opacity: 1.0 - value };
      if (d.id === s.crossfaderMapping.right) return { ...d, opacity: value };
      return d;
    }),
  }));
}
