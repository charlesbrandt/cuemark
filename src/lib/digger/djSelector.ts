/**
 * "Who's on the decks" — see docs/design/guest-djs.md in the digger repo (no
 * accounts; one free-text name, no admin screen). Persisted the same
 * `cuemark:`-prefixed localStorage pattern as displaySettings.ts, plus a
 * recent-values MRU modeled on `setDiggerBaseUrl`'s history in ./api.ts.
 *
 * Empty string (the default) means unclaimed — matches Digger's
 * `plays.listener` / `queue_items.owner` convention of NULL = unclaimed,
 * for everyone uniformly. There is no special-cased "owner" identity here:
 * Digger's operator has their own configured name (its Settings → Identity
 * page, backed by `settings.default_owner` — never hardcoded) and selects it
 * the same way any guest DJ would. `currentDjOrNull()` is the one place the
 * empty-string/null conversion happens; every call site sending this to
 * Digger should go through it rather than sending the raw store value, or an
 * empty string can end up serialized as a truthy "no-op" query param / body
 * field instead of being omitted/null.
 *
 * Two very different read rules apply depending on the consumer (see
 * guest-djs.md "Changes, by side → Cuemark", item 2 vs item 3):
 *   - Attribution (`playStart`) reads this at LOAD time and captures it for
 *     that play's whole lifetime — a mid-track DJ handoff must not
 *     retroactively reassign a play already in progress. See history.ts.
 *   - Queue scoping reads this reactively at CALL time — "which queue am I
 *     looking at right now" is presence-based, not lifecycle-based. See
 *     queueStore.ts / DiggerQueue.svelte.
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

const STORAGE_KEY = "cuemark:diggerDj";
const HISTORY_KEY = "cuemark:diggerDjHistory";
const HISTORY_MAX = 5;

/** Current DJ name, empty string = unclaimed. Reactive Svelte store — read with
 * `$currentDj` in a component, or `get(currentDj)` for a one-time snapshot
 * (see history.ts's load-time capture). */
export const currentDj = persistentWritable<string>(STORAGE_KEY, "");

function loadDjHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Records `name` into the recent-DJs MRU, deduped and moved to front — same
 * shape as setDiggerBaseUrl's history in ./api.ts. Not exported: only
 * setCurrentDj should write history, so every recorded name went through the
 * same trim/empty handling. */
function pushDjHistory(name: string) {
  if (!name) return;
  try {
    // Case-insensitive de-dup: "Tessa" and "tessa" are the same DJ (Digger
    // now matches owner/listener names case-insensitively too — see
    // docs/design/guest-djs.md in the digger repo), so the MRU shouldn't
    // show them as two separate chips.
    const lower = name.toLowerCase();
    const history = [name, ...loadDjHistory().filter((n) => n.toLowerCase() !== lower)].slice(0, HISTORY_MAX);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {}
}

/**
 * Sets the current DJ (empty string = unclaimed) and records a non-empty name in
 * the recent-values MRU for one-click reuse. Call this on "commit" (Enter,
 * blur, or picking a recent-value chip) rather than on every keystroke, or
 * the history fills with partial fragments as someone types a new name.
 */
export function setCurrentDj(name: string) {
  const trimmed = name.trim();
  currentDj.set(trimmed);
  pushDjHistory(trimmed);
}

/** MRU list of previously-used DJ names (most recent first), for a
 * recent-value quick-pick in the toolbar selector. */
export function getDjHistory(): string[] {
  return loadDjHistory();
}

/** Normalizes a DJ-selector value for a Digger API call — empty/whitespace
 * becomes null, matching the `listener`/`owner` NULL-means-unclaimed
 * convention. Always call this at the API boundary rather than sending the
 * raw store value, so `owner=""` never reaches Digger as a
 * distinct-from-unset value. */
export function currentDjOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
