// Pure helpers for plugin health: things that render black or vanish without any GL error.
// Kept free of Tauri/Svelte imports so vitest can cover them (vizHealth.test.ts).

// Header JSON of an ISF source (the JSON inside its leading block comment), or null if unparsable.
function headerJson(source: string): Record<string, unknown> | null {
  const m = /\/\*([\s\S]*?)\*\//.exec(source);
  if (!m) return null;
  const body = m[1];
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const j = JSON.parse(body.slice(start, end + 1));
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Names an ISF `IMPORTED` block asks for that the plugin's `assets` map (file name → path,
 * built by `viz_read_plugin` for folder plugins only) does not supply. A bare `.fs` plugin
 * has no assets, so every import is missing — and the shader then samples an unbound
 * texture, which renders black with no GL error.
 */
export function missingImports(source: string, assets: Record<string, string>): string[] {
  const imported = headerJson(source)?.IMPORTED;
  if (!imported || typeof imported !== 'object') return [];
  const have = new Set(Object.keys(assets).map((k) => k.toLowerCase()));
  const missing: string[] = [];
  for (const [name, def] of Object.entries(imported as Record<string, unknown>)) {
    const p = typeof def === 'string' ? def : (def as { PATH?: unknown } | null)?.PATH;
    const label = typeof p === 'string' ? p : name;
    const file = label.split('/').pop()!.toLowerCase();
    if (!have.has(file)) missing.push(label);
  }
  return missing;
}

/** Human warning for `missingImports`, or null when nothing is missing. */
export function importedWarning(id: string, source: string, assets: Record<string, string>): string | null {
  const missing = missingImports(source, assets);
  if (missing.length === 0) return null;
  const bare = !id.includes('/');
  return (
    `uses IMPORTED image${missing.length > 1 ? 's' : ''} (${missing.join(', ')}) that ` +
    (bare
      ? 'a single .fs file cannot carry, so it will render black. Move it into a folder next to its image(s).'
      : 'are not in its folder, so it will render black.')
  );
}

/** What is rendered instead when the selected plugin cannot be loaded. */
export interface VizFallback {
  requestedId: string;
  usingId: string;
  reason: string;
}

/**
 * Should a failed read of `id` fall back to the default built-in? Only disk plugins can go
 * missing; a built-in read cannot fail. The persisted selection is never rewritten (see
 * the design doc's "Missing plugin" note), so this only picks what to *render*.
 */
export function chooseFallback(id: string, reason: string, defaultId: string): VizFallback | null {
  if (id.startsWith('builtin:')) return null;
  return { requestedId: id, usingId: defaultId, reason };
}

/** Panel note for an active fallback. */
export function fallbackNote(f: VizFallback, nameOf: (id: string) => string): string {
  return (
    `"${f.requestedId}" could not be loaded (${f.reason}). Showing ${nameOf(f.usingId)} instead. ` +
    `Your choice is kept: Rescan (or reselect it) once the file is back.`
  );
}
