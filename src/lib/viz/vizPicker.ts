// Pure grouping helper for the single visualization picker <select> (VisualizationPanel.svelte).
// Separated from the component so the grouping/labelling logic is unit-testable without
// mounting Svelte.

export interface VizOptionSource {
  id: string;
  name: string;
  error?: string | null;
  description?: string | null;
  credit?: string | null;
}

export interface VizOption {
  id: string;
  label: string;
  /** Tooltip: the build error when broken, else description/credit if either is present. */
  title?: string;
}

export interface VizOptionGroup {
  label: string;
  options: VizOption[];
}

/**
 * Group built-ins, disk ISF plugins and Milkdrop presets into `<optgroup>`s for one `<select>`.
 * A plugin whose id has a live build error (`vizErrors`) or a discovery-time `.error` gets a
 * trailing "⚠" in its label — matching the old per-button/option warning marker, now applied
 * uniformly to every source instead of Milkdrop-only. Empty groups (no ISF plugins found, no
 * Milkdrop presets found) are omitted so the dropdown never shows a group with nothing
 * selectable in it; "Built-in" is never empty so it always appears.
 */
export function buildVizOptionGroups(
  builtins: VizOptionSource[],
  isfPlugins: VizOptionSource[],
  milkdropPresets: VizOptionSource[],
  errors: Record<string, string>,
): VizOptionGroup[] {
  const toOption = (p: VizOptionSource): VizOption => {
    const err = errors[p.id] ?? p.error;
    const broken = !!err;
    const title = broken ? err! : [p.description, p.credit].filter(Boolean).join(' — ') || undefined;
    return { id: p.id, label: broken ? `${p.name} ⚠` : p.name, title };
  };
  const groups: VizOptionGroup[] = [{ label: 'Built-in', options: builtins.map(toOption) }];
  if (isfPlugins.length) groups.push({ label: 'Plugins', options: isfPlugins.map(toOption) });
  if (milkdropPresets.length) groups.push({ label: 'Milkdrop', options: milkdropPresets.map(toOption) });
  return groups;
}
