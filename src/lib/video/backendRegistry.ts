/**
 * Per-deck video *presentation* backend state (legacy `<video>` element vs. WebCodecs
 * CodecPlayer) and the reactive mirror DeckCard's badge reads. Extracted from App.svelte.
 *
 * Deliberately a plain Map with an explicit push into `activeVideoBackend`, not a store
 * itself: syncVideoElements mutates this several times per pass and a store would
 * re-trigger the very $effect that drives it. Every mutation must go through the setters
 * here so the reactive mirror can never drift from the map.
 */
import { activeVideoBackend, type ResolvedVideoBackend } from "./videoPathSettings";

export interface VideoBackendState {
  filePath: string;
  kind: ResolvedVideoBackend;
  adoptedPos?: number; // recovery-boot position, carried through an in-flight demux probe
  // Mirrors DeckSource.loadSeq — lets syncVideoElements tell a deliberate reload of the
  // same file apart from a no-op re-sync. Every write to this map must carry the
  // current value through except the "brand-new file" branch, which is the only place
  // allowed to adopt a new one (from deck.source.loadSeq).
  loadSeq?: number;
}

const backendState = new Map<string, VideoBackendState>();

// Decks whose media has no video stream at all (WebCodecs demux timed out waiting for
// parsebin to expose a video pad — confirmed empty container, not a transient failure).
// The legacy <video> fallback still gets created for these (it's how the file plays), but
// its currentTime never has a video track driving it, so both the per-poll drift-correction
// resync (`v.currentTime = contentPos`) and the stall self-heal treat "currentTime
// never moves" as a wedged decoder and either seek or v.load() it — on a real audio-only
// file that's a permanent false positive, firing every poll (resync) or every ~10s
// (self-heal's v.load() pipeline rebuild) for the deck's entire playback. Both paths funnel
// into the same WebKitGTK MediaPlayerPrivateGStreamer seek/rebuild machinery implicated in
// the documented main-thread contention (docs/design/pcm-buffer-playback.md, "Ninth
// mechanism"; skills/audio-debugging.md "UI frozen solid"), so a deck with no video to
// sync should never call either. Cleared on teardown and on a fresh demux attempt.
const audioOnlyDecks = new Set<string>();

export function getBackendState(deckId: string): VideoBackendState | undefined {
  return backendState.get(deckId);
}

export function isAudioOnlyDeck(deckId: string): boolean {
  return audioOnlyDecks.has(deckId);
}

/**
 * Record a deck's resolved backend. `audioOnly`, when given, is applied before the
 * reactive push so the badge never briefly renders the new kind against the old
 * audio-only flag; omit it to leave the flag untouched.
 */
export function setBackendState(deckId: string, state: VideoBackendState, audioOnly?: boolean): void {
  backendState.set(deckId, state);
  if (audioOnly === true) audioOnlyDecks.add(deckId);
  else if (audioOnly === false) audioOnlyDecks.delete(deckId);
  pushActiveBackend(deckId);
}

/** Forget a deck's backend entirely (deck removed, source cleared, or file swapped). */
export function clearBackendState(deckId: string): void {
  backendState.delete(deckId);
  audioOnlyDecks.delete(deckId);
  pushActiveBackend(deckId);
}

// Pushes backendState/audioOnlyDecks (a plain Map/Set, not stores) into the reactive
// activeVideoBackend store so DeckCard's LEGACY badge can reflect the actual resolved
// backend — including a demux-failure fallback to 'legacy-fallback' — instead of the
// desired override, which never clears on fallback.
function pushActiveBackend(deckId: string) {
  const state = backendState.get(deckId);
  activeVideoBackend.update((m) => {
    if (!state) {
      if (!(deckId in m)) return m;
      const next = { ...m };
      delete next[deckId];
      return next;
    }
    const audioOnly = audioOnlyDecks.has(deckId);
    const cur = m[deckId];
    if (cur && cur.kind === state.kind && cur.audioOnly === audioOnly) return m;
    return { ...m, [deckId]: { kind: state.kind, audioOnly } };
  });
}
