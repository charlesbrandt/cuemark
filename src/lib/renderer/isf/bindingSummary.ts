/**
 * Pure helpers for the output window's `[viz] bindings` log line. Kept out of
 * `output.ts` (which has import-time side effects) so vitest can reach them.
 */

/** Running min/max of `bass` over the current log window. */
export interface BindingWindow {
  frames: number;
  bassMin: number;
  bassMax: number;
}

export function newBindingWindow(): BindingWindow {
  return { frames: 0, bassMin: Infinity, bassMax: -Infinity };
}

export function noteBindings(w: BindingWindow, bindings: Record<string, number>): void {
  w.frames++;
  const b = bindings.bass;
  if (typeof b === "number") {
    if (b < w.bassMin) w.bassMin = b;
    if (b > w.bassMax) w.bassMax = b;
  }
}

/**
 * `[viz] bindings <id> bass=0.123 mid=… high=… bass_range=a..b (frames=N)`
 * Every key present in `bindings` is listed, 3 decimals; the bass range only
 * when bass was seen in the window.
 */
export function formatBindings(
  pluginId: string,
  bindings: Record<string, number>,
  w: BindingWindow,
): string {
  const parts = Object.keys(bindings).map((k) => `${k}=${(bindings[k] ?? 0).toFixed(3)}`);
  if (w.bassMin <= w.bassMax) {
    parts.push(`bass_range=${w.bassMin.toFixed(3)}..${w.bassMax.toFixed(3)}`);
  }
  return `[viz] bindings ${pluginId} ${parts.join(" ")} (frames=${w.frames})`;
}
