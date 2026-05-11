import { writable } from "svelte/store";

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
      store.update(current => {
        const next = fn(current);
        try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
        return next;
      });
    },
  };
}

/** Device IDs for the main mix outputs. Defaults to [""] (system default). Persisted across restarts. */
export const mainOutputDeviceIds = persistentWritable<string[]>("cuemark:mainOutputDeviceIds", [""]);

/** Device ID for the headphone / cue monitor output. '' = none. Persisted across restarts. */
export const cueOutputDeviceId = persistentWritable<string>("cuemark:cueOutputDeviceId", "");

/** Headphone / cue monitor master gain (0–1). Persisted across restarts. */
export const cueGain = persistentWritable<number>("cuemark:cueGain", 1.0);
