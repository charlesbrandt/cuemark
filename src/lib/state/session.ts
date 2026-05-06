import { writable, get } from "svelte/store";
import type { Session, Deck, CrossfaderTarget } from "./types";

function makeDeck(index: number): Deck {
  return {
    id: `deck-${index}`,
    source: null,
    playing: false,
    playbackRate: 1.0,
    gain: 1.0,
    volume: 1.0,
    opacity: 1.0,
    loop: false,
    cuePoint: 0,
    hotCues: [],
    bpm: null,
    downbeat: null,
    loopIn: null,
    loopOut: null,
    eq: { low: 0, mid: 0, high: 0 },
    cueEnabled: false,
  };
}

const initial: Session = {
  decks: [makeDeck(0), makeDeck(1)],
  masterVolume: 1.0,
  bpm: null,
  crossfaderMapping: { left: "deck-0", right: "deck-1" },
  crossfaderValue: 0.5,
  crossfaderTargets: ["opacity", "volume"],
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
    crossfaderValue: value,
    decks: s.decks.map((d) => {
      const isLeft = d.id === s.crossfaderMapping.left;
      const isRight = d.id === s.crossfaderMapping.right;
      if (!isLeft && !isRight) return d;
      const level = isLeft ? 1.0 - value : value;
      const patch: Partial<Deck> = {};
      if (s.crossfaderTargets.includes("opacity")) patch.opacity = level;
      if (s.crossfaderTargets.includes("volume")) patch.volume = level;
      return { ...d, ...patch };
    }),
  }));
}

export function setCrossfaderTargets(targets: CrossfaderTarget[]) {
  session.update((s) => ({ ...s, crossfaderTargets: targets }));
}

export function setCrossfaderMapping(left: string, right: string) {
  session.update((s) => ({ ...s, crossfaderMapping: { left, right } }));
}

export function setMasterBpm(bpm: number | null) {
  session.update((s) => ({ ...s, bpm }));
}
