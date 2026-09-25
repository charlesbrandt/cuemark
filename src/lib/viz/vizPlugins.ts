// Control-window side of visualization plugins (docs/design/visualization-plugins.md).
//
// Owns the picker's list (built-ins + whatever `viz_list_plugins` found in the plugins
// folder), resolves the selected plugin id to its source, and collects errors reported by
// the output window, which is the only place a shader is actually compiled.

import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { debugLog } from '../debugLog';
import { BUILTIN_ISF } from '../renderer/isf/builtins';
import type { VizPluginPayload } from '../renderer/outputProtocol';
import type { Visualization } from '../state/types';

/** One row of `viz_list_plugins` (src-tauri/src/viz_plugins.rs). */
export interface VizPluginInfo {
  id: string;
  format: 'isf';
  name: string;
  description?: string | null;
  credit?: string | null;
  categories: string[];
  thumbnailPath?: string | null;
  licensePath?: string | null;
  /** Set when the file couldn't be read or its header didn't parse. */
  error?: string | null;
}

interface VizPluginSource {
  id: string;
  fragmentSource: string;
  vertexSource?: string | null;
  assets: Record<string, string>;
}

/** Plugins found on disk. Built-ins are not in here; see `BUILTIN_ISF`. */
export const diskPlugins = writable<VizPluginInfo[]>([]);

/**
 * Latest error per plugin id — from listing, from `viz_read_plugin`, or from the output
 * window's parse/compile/link (`vizError`). Cleared when that plugin next loads cleanly.
 */
export const vizErrors = writable<Record<string, string>>({});

export function setVizError(pluginId: string, message: string | null) {
  vizErrors.update((m) => {
    const next = { ...m };
    if (message === null) delete next[pluginId];
    else next[pluginId] = message;
    return next;
  });
}

export async function refreshPluginList(): Promise<void> {
  try {
    const list = await invoke<VizPluginInfo[]>('viz_list_plugins');
    diskPlugins.set(list);
  } catch (e) {
    debugLog(`[viz] viz_list_plugins failed: ${e}`);
  }
}

export function isBuiltinId(id: string): boolean {
  return id.startsWith('builtin:');
}

/** Display name for a plugin id, for the picker and log lines. */
export function pluginName(id: string): string {
  const b = BUILTIN_ISF.find((p) => p.id === id);
  if (b) return b.name;
  return get(diskPlugins).find((p) => p.id === id)?.name ?? id;
}

/** Everything the output window needs to build the plugin. Throws on a read failure. */
export async function resolvePlugin(id: string): Promise<VizPluginPayload> {
  const b = BUILTIN_ISF.find((p) => p.id === id);
  if (b) return { id, format: 'isf', source: b.source, assets: {} };
  const src = await invoke<VizPluginSource>('viz_read_plugin', { id });
  return {
    id,
    format: 'isf',
    source: src.fragmentSource,
    vertexSource: src.vertexSource ?? undefined,
    assets: src.assets,
  };
}

let mediaPort: number | null = null;

/** http URL for a local file, over the media server (never file:// — see CLAUDE.md). */
export async function mediaUrl(absPath: string): Promise<string> {
  const encoded = absPath.split('/').map(encodeURIComponent).join('/');
  if (import.meta.env.DEV) return '/media' + encoded;
  mediaPort ??= await invoke<number>('media_server_port');
  return `http://127.0.0.1:${mediaPort}${encoded}`;
}

/**
 * Bring a persisted `Session.visualization` up to the current shape.
 *
 * Until 2026-09-25 it carried the shader source itself (`{ fragmentSrc, uniforms, name }`).
 * A built-in is recognised by its old name and mapped to its ISF port; anything else
 * becomes "None" rather than guessing, since the old field could hold arbitrary GLSL that no
 * longer has a loader.
 */
export function migrateVisualization(v: unknown): Visualization | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.pluginId === 'string') {
    return { pluginId: o.pluginId, params: (o.params as Visualization['params']) ?? {} };
  }
  if (typeof o.name === 'string') {
    const b = BUILTIN_ISF.find((p) => p.name === o.name);
    if (b) return { pluginId: b.id, params: {} };
  }
  return null;
}

// ── Active plugin → output window ────────────────────────────────────────────────────────

let activePayload: VizPluginPayload | null = null;

/**
 * The resolved payload for `Session.visualization`, for `postFrame()`. Stays the same
 * object until the selection changes: outputBus compares it by reference to decide when to
 * re-send the (large) source.
 */
export function activeVizPayload(): VizPluginPayload | null {
  return activePayload;
}

/**
 * Keep `activeVizPayload()` in step with the session's selection, and route the output
 * window's build reports into `vizErrors`. Call once from the control window.
 */
export function startVizPluginSync(
  sessionStore: { subscribe: (fn: (s: { visualization: Visualization | null }) => void) => () => void },
  onReport: (fn: (r: { kind: 'vizError' | 'vizOk'; pluginId: string; stage?: string; message?: string }) => void) => void,
) {
  onReport((r) => {
    if (r.kind === 'vizOk') setVizError(r.pluginId, null);
    else setVizError(r.pluginId, `${r.stage}: ${r.message}`);
  });

  let currentId: string | null = null;
  let seq = 0;
  sessionStore.subscribe((s) => {
    const id = s.visualization?.pluginId ?? null;
    if (id === currentId) return;
    currentId = id;
    const mySeq = ++seq;
    if (id === null) {
      activePayload = null;
      return;
    }
    resolvePlugin(id).then(
      (payload) => {
        if (mySeq === seq) activePayload = payload;
      },
      (e) => {
        if (mySeq !== seq) return;
        activePayload = null;
        debugLog(`[viz] could not read plugin ${id}: ${e}`);
        setVizError(id, `read: ${e}`);
      },
    );
  });
}
