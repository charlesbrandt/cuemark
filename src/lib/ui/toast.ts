/**
 * Minimal transient-message primitive — didn't exist anywhere in the app before this
 * (checked: no toast/status-bar component). Reserved for Tier-3 Auto DJ events (see
 * docs/design/auto-dj-transitions.md "Manual/auto interaction") — a human quietly
 * taking over one deck (Tier 2, "park") stays silent by design; only the cases where
 * Auto DJ actually turns itself off warrant interrupting the DJ's attention.
 */
import { writable } from "svelte/store";

export interface ToastMessage {
  id: number;
  text: string;
  kind: "info" | "warning";
}

export const toasts = writable<ToastMessage[]>([]);

let nextId = 0;

export function showToast(text: string, kind: ToastMessage["kind"] = "info", durationMs = 6000): void {
  const id = ++nextId;
  toasts.update((t) => [...t, { id, text, kind }]);
  setTimeout(() => {
    toasts.update((t) => t.filter((m) => m.id !== id));
  }, durationMs);
}

export function dismissToast(id: number): void {
  toasts.update((t) => t.filter((m) => m.id !== id));
}
