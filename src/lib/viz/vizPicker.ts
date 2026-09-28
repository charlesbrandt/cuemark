// Pure logic for the visualization Source picker (VisualizationPanel.svelte).
//
// Two groups only: Milkdrop and Shaders (ISF) — the five built-ins fold into Shaders with a
// `builtin` tag instead of getting their own group (docs/design/viz-panel-and-settings-restyle.md
// "The ask": the built-ins "aren't very good compared to what is available through the other
// sources"). Separated from the component so grouping, filtering, favorites and prev/next are
// unit-testable without mounting Svelte.

export interface VizPickerSource {
  id: string;
  name: string;
  error?: string | null;
  description?: string | null;
  credit?: string | null;
  thumbnailPath?: string | null;
}

export type PickerGroupLabel = 'Milkdrop' | 'Shaders (ISF)';

export interface PickerItem {
  id: string;
  name: string;
  group: PickerGroupLabel;
  builtin: boolean;
  broken: boolean;
  /** Tooltip: the build error when broken, else description/credit if either is present. */
  title?: string;
  thumbnailPath?: string | null;
}

export interface PickerGroup {
  label: PickerGroupLabel;
  items: PickerItem[];
}

export type PickerFilter = 'all' | PickerGroupLabel | 'favorites';

/**
 * Flatten built-ins, disk ISF plugins and Milkdrop presets into one item list. Within
 * "Shaders (ISF)", disk plugins are listed before built-ins — the built-ins are the fallback,
 * not the headline. A plugin whose id has a live build error (`errors`) or a discovery-time
 * `.error` is flagged `broken` with a trailing-⚠-worthy title (the caller decides how to render
 * that), matching the old per-option warning marker.
 */
export function buildVizPickerItems(
  builtins: VizPickerSource[],
  isfPlugins: VizPickerSource[],
  milkdropPresets: VizPickerSource[],
  errors: Record<string, string>,
): PickerItem[] {
  const toItem = (p: VizPickerSource, group: PickerGroupLabel, builtin: boolean): PickerItem => {
    const err = errors[p.id] ?? p.error;
    const broken = !!err;
    const title = broken ? err! : [p.description, p.credit].filter(Boolean).join(' — ') || undefined;
    return { id: p.id, name: p.name, group, builtin, broken, title, thumbnailPath: p.thumbnailPath ?? null };
  };
  return [
    ...milkdropPresets.map((p) => toItem(p, 'Milkdrop', false)),
    ...isfPlugins.map((p) => toItem(p, 'Shaders (ISF)', false)),
    ...builtins.map((p) => toItem(p, 'Shaders (ISF)', true)),
  ];
}

/** Group items into fixed Milkdrop → Shaders (ISF) order, omitting a group with nothing in it. */
export function groupPickerItems(items: PickerItem[]): PickerGroup[] {
  const order: PickerGroupLabel[] = ['Milkdrop', 'Shaders (ISF)'];
  return order
    .map((label) => ({ label, items: items.filter((it) => it.group === label) }))
    .filter((g) => g.items.length > 0);
}

/** Filter chip + search box, applied together. Search matches the name, case-insensitively. */
export function filterPickerItems(
  items: PickerItem[],
  filter: PickerFilter,
  favorites: ReadonlySet<string>,
  query: string,
): PickerItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((it) => {
    if (filter === 'favorites' && !favorites.has(it.id)) return false;
    if ((filter === 'Milkdrop' || filter === 'Shaders (ISF)') && it.group !== filter) return false;
    if (q && !it.name.toLowerCase().includes(q)) return false;
    return true;
  });
}

/**
 * Prev/next over the currently visible (filtered) list, wrapping around. If the current
 * selection isn't in that list (filtered out, or nothing selected yet), stepping forward lands
 * on the first item and stepping back lands on the last — never throws, never picks nothing
 * when the list is non-empty.
 */
export function stepSelection(items: PickerItem[], currentId: string | null, delta: 1 | -1): string | null {
  if (!items.length) return null;
  const i = items.findIndex((it) => it.id === currentId);
  if (i === -1) return items[delta > 0 ? 0 : items.length - 1].id;
  const next = (i + delta + items.length) % items.length;
  return items[next].id;
}

/**
 * Deterministic two-color radial gradient for an item with no real thumbnail image (most
 * built-ins and plugins today have none). Same id always yields the same gradient, so a
 * picker row's thumbnail doesn't flicker between renders.
 */
export function thumbGradient(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 40 + (Math.abs(hash >> 8) % 60)) % 360;
  return `radial-gradient(circle at 35% 40%, hsl(${h1} 70% 55%) 0%, hsl(${h2} 55% 18%) 70%)`;
}
