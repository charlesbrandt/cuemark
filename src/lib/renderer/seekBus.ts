import { get } from 'svelte/store';
import { audioSeek } from '../audio/pipeline';
import { session } from '../state/session';

const els = new Map<string, HTMLVideoElement>();
// Audio clock positions updated by the RAF loop from GStreamer IPC.
// The waveform reads these rather than video.currentTime, which drifts between
// IPC-driven snaps when tempo ≠ 1.0.
const audioTimes = new Map<string, number>();

export function registerVideoEl(deckId: string, el: HTMLVideoElement) {
  els.set(deckId, el);
}

export function unregisterVideoEl(deckId: string) {
  els.delete(deckId);
  audioTimes.delete(deckId);
}

export function seekDeck(deckId: string, time: number) {
  const el = els.get(deckId);
  if (el) el.currentTime = time;
  audioTimes.set(deckId, time); // immediate waveform update before IPC resolves
  audioSeek(deckId, time).catch(console.error);
}

export function setDeckAudioTime(deckId: string, t: number): void {
  audioTimes.set(deckId, t);
}

export function getDeckTime(deckId: string): number | null {
  // Prefer the audio clock (updated from GStreamer IPC each frame).
  // Falls back to video.currentTime when not playing (paused/stopped).
  const at = audioTimes.get(deckId);
  if (at !== undefined) return at;
  return els.get(deckId)?.currentTime ?? null;
}

export function getVideoEl(deckId: string): HTMLVideoElement | undefined {
  return els.get(deckId);
}

// Returns the deck's current beat phase in [0, 1) relative to its downbeat anchor.
// 0.0 = on the beat, 0.5 = halfway between beats.
// Returns null if downbeat or bpm is unset, or if no position is available.
export function getPhase(deckId: string): number | null {
  const deck = get(session).decks.find((d) => d.id === deckId);
  if (!deck || deck.downbeat === null || deck.bpm === null) return null;
  const t = getDeckTime(deckId);
  if (t === null) return null;
  const beatPeriod = 60 / deck.bpm;
  const raw = (t - deck.downbeat) / beatPeriod;
  return ((raw % 1) + 1) % 1; // always [0, 1) even when t < downbeat
}
