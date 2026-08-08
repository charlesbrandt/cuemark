/**
 * Global display settings. Same persistentWritable/`cuemark:` pattern as audioSettings.ts.
 */
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
      store.update((current) => {
        const next = fn(current);
        try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
        return next;
      });
    },
  };
}

/**
 * Global UI text scale multiplier (0.8-1.5). Applied via the `--font-scale` CSS custom
 * property on `documentElement` (see App.svelte), which every `font-size: calc(Npx *
 * var(--font-scale))` declaration in app.css and component styles inherits. Persisted
 * per-machine so it can compensate for high-DPI screens without changing the base sizes
 * everywhere else.
 */
export const fontScale = persistentWritable<number>("cuemark:fontScale", 1.0);
