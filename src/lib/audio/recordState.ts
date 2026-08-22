import { writable } from "svelte/store";
import type { RecordFormat } from "./pipeline";

/**
 * Recording is a backend session (RecordingSink in record.rs) with no lifetime tied to
 * any UI component — a plain component-local $state in RecordPanel would reset to
 * "not recording" every time the panel is toggled closed and reopened while the backend
 * keeps running underneath it. These stores live for the app's session instead.
 */
export const recordFormat = writable<RecordFormat>("opus");
export const isRecording = writable(false);
export const recordOutputPath = writable<string | null>(null);
export const recordStartedAt = writable<number | null>(null);

// Same persistentWritable/`cuemark:` localStorage pattern as audioSettings.ts —
// each module keeps its own copy rather than sharing one, by convention here.
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
      store.update((value) => {
        const next = fn(value);
        try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
        return next;
      });
    },
  };
}

/**
 * Where recordings are auto-saved. Empty string = not configured, in which case
 * RecordPanel falls back to a save dialog per recording. Set, this makes "Start
 * Recording" a one-click operation — no dialog, an auto-generated
 * `<date>_<time>[_<notes>].<ext>` filename in this folder.
 */
export const recordingsDir = persistentWritable<string>("cuemark:recordingsDir", "");
