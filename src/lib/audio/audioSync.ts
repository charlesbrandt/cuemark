/**
 * Idempotent audio sync helpers — shared between the MIDI handler (direct call path)
 * and App.svelte's $effect (UI slider path). Module-level Maps prevent duplicate IPC
 * calls regardless of which caller fires first.
 *
 * MIDI events bypass the Svelte store entirely for the audio path:
 *   MIDI → syncRate/syncGain/syncVolume → GStreamer (< 1ms)
 *   MIDI → rAF-throttled updateDeck → Svelte store → UI display (≤ 16ms, fine for display)
 *
 * UI slider changes still go through the store:
 *   slider oninput → updateDeck → $effect → syncRate/… → GStreamer
 * The module-level Map prevents the $effect from duplicating a call already made by the MIDI path.
 */
import { audioSetRate, audioSetGain, audioSetVolume } from './pipeline';

const rateMap   = new Map<string, number>();
const gainMap   = new Map<string, number>();
const volumeMap = new Map<string, number>();

export function syncRate(deckId: string, rate: number): void {
  const last = rateMap.get(deckId) ?? -1;
  if (Math.abs(rate - last) < 0.005) return;
  rateMap.set(deckId, rate);
  audioSetRate(deckId, rate).catch(console.error);
}

export function syncGain(deckId: string, gain: number): void {
  if (gainMap.get(deckId) === gain) return;
  gainMap.set(deckId, gain);
  audioSetGain(deckId, gain).catch(console.error);
}

export function syncVolume(deckId: string, volume: number): void {
  if (volumeMap.get(deckId) === volume) return;
  volumeMap.set(deckId, volume);
  audioSetVolume(deckId, volume).catch(console.error);
}

export function clearDeckAudioSync(deckId: string): void {
  rateMap.delete(deckId);
  gainMap.delete(deckId);
  volumeMap.delete(deckId);
}
