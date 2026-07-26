/**
 * Feature flag + per-deck A/B toggle for the WebCodecs video path
 * (docs/design/webcodecs-video-path.md phase 2). Same persistentWritable/`cuemark:`
 * pattern as audioSettings.ts.
 */
import { writable } from "svelte/store";

export type VideoPath = "legacy" | "webcodecs";

function persistentWritable<T>(key: string, defaultValue: T) {
  let initial: T;
  try {
    const raw = localStorage.getItem(key);
    initial = raw !== null ? (JSON.parse(raw) as T) : defaultValue;
  } catch {
    initial = defaultValue;
  }

  const store = writable<T>(initial);

  return {
    subscribe: store.subscribe,
    set(value: T) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
      store.set(value);
    },
    update(fn: (value: T) => T) {
      store.update((current) => {
        const next = fn(current);
        try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
        return next;
      });
    },
  };
}

// VITE_VIDEO_PATH=legacy seeds the default only on a machine's first run — once
// localStorage has a value (persistentWritable's `raw !== null` branch), it wins
// forever regardless of the env var, so a build-time flag never fights a user's
// already-persisted choice on every load.
// webcodecs is the default as of docs/design/webcodecs-video-path.md phase 5 —
// legacy remains available as a per-deck override and as the automatic fallback
// for codecs the demuxer/decoder can't handle (see resolveVideoPath / legacy-fallback).
const envDefault: VideoPath = import.meta.env.VITE_VIDEO_PATH === "legacy" ? "legacy" : "webcodecs";

/** Global default video path for decks with no per-deck override. Persisted. */
export const videoPathDefault = persistentWritable<VideoPath>("cuemark:videoPathDefault", envDefault);

/** Per-deck override map (deckId -> path), live-switchable from DeckCard's toggle. */
export const videoPathOverrides = persistentWritable<Record<string, VideoPath>>("cuemark:videoPathOverride", {});

export function setVideoPathOverride(deckId: string, path: VideoPath | null): void {
  videoPathOverrides.update((overrides) => {
    const next = { ...overrides };
    if (path === null) delete next[deckId];
    else next[deckId] = path;
    return next;
  });
}

/** Pure so it can be used from a reactive Svelte `$derived` as well as imperative code. */
export function resolveVideoPath(
  deckId: string,
  overrides: Record<string, VideoPath>,
  globalDefault: VideoPath,
): VideoPath {
  return overrides[deckId] ?? globalDefault;
}
