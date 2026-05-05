import { audioSeek } from '../audio/pipeline';

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
