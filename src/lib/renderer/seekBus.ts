import { get } from 'svelte/store';
import { audioSeek } from '../audio/pipeline';
import { session } from '../state/session';

const els = new Map<string, HTMLVideoElement>();
// Audio clock positions updated by the RAF loop from GStreamer IPC.
// The waveform reads these rather than video.currentTime, which drifts between
// IPC-driven snaps when tempo ≠ 1.0.
const audioTimes = new Map<string, number>();
// When a seek is in flight, holds the target position so the RAF loop can
// filter out stale pre-seek GStreamer position responses. Heavy videos can take
// >1s to complete a seek; during that time audioGetPosition returns the old position.
const pendingSeekTarget = new Map<string, number>();

export function registerVideoEl(deckId: string, el: HTMLVideoElement) {
  els.set(deckId, el);
}

export function unregisterVideoEl(deckId: string) {
  els.delete(deckId);
  audioTimes.delete(deckId);
  pendingSeekTarget.delete(deckId);
}

export function seekDeck(deckId: string, time: number) {
  const el = els.get(deckId);
  if (el) el.currentTime = time;
  // Delete rather than set: getDeckTime falls back to v.currentTime (which equals `time`
  // immediately after the seek above). Setting to `time` would block the fallback and
  // leave the waveform stuck at the seek position if the GStreamer IPC gets stuck in
  // the EOS→seek→play transition.
  audioTimes.delete(deckId);
  // Record seek target so the RAF loop can ignore stale pre-seek IPC responses.
  pendingSeekTarget.set(deckId, time);
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

// Returns the pending seek target if a seek is in progress, undefined otherwise.
export function getPendingSeekTarget(deckId: string): number | undefined {
  return pendingSeekTarget.get(deckId);
}

// Clears the pending seek flag once the first valid post-seek IPC arrives.
export function clearPendingSeekTarget(deckId: string): void {
  pendingSeekTarget.delete(deckId);
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

// Quantizes t to the nearest beat on deck's grid when snapToBeat is on and the
// deck has a fitted grid (bpm + downbeat); otherwise returns t unchanged.
export function quantizeToGrid(deckId: string, t: number): number {
  if (!get(session).snapToBeat) return t;
  const deck = get(session).decks.find((d) => d.id === deckId);
  if (!deck || deck.bpm === null || deck.downbeat === null) return t;
  const period = 60 / deck.bpm;
  const k = Math.round((t - deck.downbeat) / period);
  return Math.max(0, deck.downbeat + k * period);
}
