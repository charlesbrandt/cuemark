/**
 * Favorited visualization ids for the Source picker's ★ Favorites filter. Same
 * persistentWritable/`cuemark:` pattern as displaySettings.ts — a local copy, not a shared
 * helper (see feedback_settings_persistence_pattern).
 */
import { writable } from "svelte/store";

const KEY = "cuemark:vizFavorites";

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw !== null ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function persist(ids: string[]) {
  try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch {}
}

const store = writable<string[]>(load());

/** Favorited plugin ids, as an array (preserves add order for a stable ★ list). */
export const vizFavorites = { subscribe: store.subscribe };

export function toggleVizFavorite(id: string) {
  store.update((ids) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    persist(next);
    return next;
  });
}
