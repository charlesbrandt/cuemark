import { writable, get } from "svelte/store";
import type { Session, Deck, CrossfaderTarget, CrossfaderCurve, Visualization } from "./types";

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
    diggerTrackId: null,
    diggerFileId: null,
    loopIn: null,
    loopOut: null,
    eq: { low: 0, mid: 0, high: 0 },
    filter: 0,
    cueEnabled: false,
    syncLocked: false,
  };
}

const initial: Session = {
  decks: [makeDeck(0), makeDeck(1)],
  masterVolume: 1.0,
  bpm: null,
  masterDeckId: null,
  crossfaderMapping: { left: "deck-0", right: "deck-1" },
  midiMapping: { left: "deck-0", right: "deck-1" },
  crossfaderValue: 0.5,
  crossfaderTargets: ["opacity", "volume"],
  audioCurve: "equal-power",
  visualCurve: "linear",
  snapToBeat: false,
  effects: [],
  visualization: null,
  visualizationOpacity: 0.5,
};

export const session = writable<Session>(initial);

function nextDeckIndex(decks: Deck[]): number {
  let max = -1;
  for (const d of decks) {
    const m = /^deck-(\d+)$/.exec(d.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

export function addDeck() {
  session.update((s) => ({
    ...s,
    decks: [...s.decks, makeDeck(nextDeckIndex(s.decks))],
  }));
}

export function removeDeck(id: string) {
  session.update((s) => {
    const decks = s.decks.filter((d) => d.id !== id);
    let next: Session = { ...s, decks, masterDeckId: s.masterDeckId === id ? null : s.masterDeckId };
    next = reconcileMaster(next);
    return applyLockedRates(next);
  });
}

// Keeps Session.bpm live when it's derived from a deck (masterDeckId set), instead of
// the frozen snapshot the old setMasterBpm(deck.bpm * deck.playbackRate) call produced —
// without this, bending the master deck's pitch fader after the fact silently went stale.
function refreshMasterBpm(s: Session): Session {
  if (s.masterDeckId === null) return s;
  const deck = s.decks.find((d) => d.id === s.masterDeckId);
  if (!deck || deck.bpm === null) return s;
  const bpm = deck.bpm * deck.playbackRate;
  return bpm === s.bpm ? s : { ...s, bpm };
}

// Auto-promotion: whenever exactly one deck is playing, it becomes (or stays) the main
// beat reference. Covers both "first deck to start playing becomes master" and "master
// stops/pauses while one other deck keeps going, so master follows the solo survivor".
// Two-or-more or zero playing decks leave the current reference untouched (sticky).
function reconcileMaster(s: Session): Session {
  const playing = s.decks.filter((d) => d.playing);
  if (playing.length !== 1) return s;
  const solo = playing[0];
  if (solo.bpm === null || s.masterDeckId === solo.id) return s;
  return { ...s, masterDeckId: solo.id, bpm: solo.bpm * solo.playbackRate };
}

// Sync-locked decks continuously track the main beat rather than the manual Sync
// button's one-shot rate calc — recompute here so every path that can move Session.bpm
// (master reassignment, master's own rate change, tap tempo) keeps them following.
function applyLockedRates(s: Session): Session {
  if (s.bpm === null) return s;
  let decks = s.decks;
  for (let i = 0; i < decks.length; i++) {
    const d = decks[i];
    if (!d.syncLocked || d.id === s.masterDeckId || d.bpm === null) continue;
    const rate = s.bpm / d.bpm;
    if (Math.abs(rate - d.playbackRate) < 0.0005) continue;
    if (decks === s.decks) decks = [...s.decks];
    decks[i] = { ...d, playbackRate: rate };
  }
  return decks === s.decks ? s : { ...s, decks };
}

export function updateDeck(id: string, patch: Partial<Deck>) {
  session.update((s) => {
    let next: Session = { ...s, decks: s.decks.map((d) => (d.id === id ? { ...d, ...patch } : d)) };
    next = refreshMasterBpm(next);
    if ("playing" in patch || "bpm" in patch) next = reconcileMaster(next);
    return applyLockedRates(next);
  });
}

// Explicitly promote deckId to main-beat reference (the Main Beat button). No-op if the
// deck has no detected/tapped bpm yet. Pass null to clear back to a plain manual value.
export function setMasterDeck(deckId: string | null) {
  session.update((s) => {
    if (deckId === null) return applyLockedRates({ ...s, masterDeckId: null });
    const deck = s.decks.find((d) => d.id === deckId);
    if (!deck || deck.bpm === null) return s;
    return applyLockedRates({ ...s, masterDeckId: deckId, bpm: deck.bpm * deck.playbackRate });
  });
}

export function getDeck(id: string): Deck | undefined {
  return get(session).decks.find((d) => d.id === id);
}

export function setMasterVolume(value: number) {
  session.update((s) => ({ ...s, masterVolume: value }));
}

function applyCurve(v: number, curve: CrossfaderCurve): [number, number] {
  switch (curve) {
    case "equal-power":
      return [Math.cos(v * Math.PI * 0.5), Math.sin(v * Math.PI * 0.5)];
    case "cut":
      // both sources at full until well past center; quick drop on their respective far sides
      return [
        Math.min(1.0, Math.max(0.0, (0.75 - v) / 0.25)),
        Math.min(1.0, Math.max(0.0, (v - 0.25) / 0.25)),
      ];
    default: // linear
      return [1.0 - v, v];
  }
}

// value: 0.0 (full left) → 1.0 (full right)
export function setCrossfader(value: number) {
  session.update((s) => {
    const [leftAudio, rightAudio] = applyCurve(value, s.audioCurve);
    const [leftVisual, rightVisual] = applyCurve(value, s.visualCurve);
    return {
      ...s,
      crossfaderValue: value,
      decks: s.decks.map((d) => {
        const isLeft = d.id === s.crossfaderMapping.left;
        const isRight = d.id === s.crossfaderMapping.right;
        if (!isLeft && !isRight) return d;
        const patch: Partial<Deck> = {};
        if (s.crossfaderTargets.includes("volume"))
          patch.volume = isLeft ? leftAudio : rightAudio;
        if (s.crossfaderTargets.includes("opacity"))
          patch.opacity = isLeft ? leftVisual : rightVisual;
        return { ...d, ...patch };
      }),
    };
  });
}

export function setCrossfaderTargets(targets: CrossfaderTarget[]) {
  session.update((s) => ({ ...s, crossfaderTargets: targets }));
}

export function setCrossfaderMapping(left: string, right: string) {
  session.update((s) => ({ ...s, crossfaderMapping: { left, right } }));
}

export function setCrossfaderAudioCurve(curve: CrossfaderCurve) {
  session.update((s) => ({ ...s, audioCurve: curve }));
}

export function setCrossfaderVisualCurve(curve: CrossfaderCurve) {
  session.update((s) => ({ ...s, visualCurve: curve }));
}

// Tap tempo: an independent manual reference, not tied to any deck.
export function setMasterBpm(bpm: number | null) {
  session.update((s) => applyLockedRates({ ...s, bpm, masterDeckId: null }));
}

export function setSnapToBeat(value: boolean) {
  session.update((s) => ({ ...s, snapToBeat: value }));
}

export function setMidiMapping(left: string, right: string) {
  session.update((s) => ({ ...s, midiMapping: { left, right } }));
}

export function setVisualization(visualization: Visualization | null) {
  session.update((s) => ({ ...s, visualization }));
}

export function setVisualizationOpacity(value: number) {
  session.update((s) => ({ ...s, visualizationOpacity: value }));
}
