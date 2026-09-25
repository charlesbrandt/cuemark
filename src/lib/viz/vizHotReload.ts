import { listen } from '@tauri-apps/api/event';

/**
 * Subscribes to the Rust plugins-folder watcher (`viz_plugins.rs`). `onChange` receives the
 * plugin ids (same scheme as `viz_list_plugins`) whose files were added, removed or modified.
 * Returns the unlisten function.
 */
export async function startVizHotReload(onChange: (ids: string[]) => void): Promise<() => void> {
  return listen<string[]>('viz-plugins-changed', (e) => {
    if (Array.isArray(e.payload) && e.payload.length > 0) onChange(e.payload);
  });
}
