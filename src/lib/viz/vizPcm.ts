/**
 * vizPcm.ts — control-window side of the Phase 5a PCM tap
 * (docs/design/visualization-plugins.md, "Phase 5a").
 *
 * Rust taps the main mix (pre-master-volume, main channel pair only) and emits an
 * `audio-pcm` event, at most 60 Hz, whose payload is a base64 string of 3072 bytes:
 * `mono[1024] | left[1024] | right[1024]`, each sample quantised to 0..255 with 128 = silence.
 * This module decodes it, remembers the latest frame for `postFrame()` to forward in the frame
 * message's `pcm` field, and tells Rust whether anyone is listening (`viz_set_listening`).
 *
 * ## The gate
 * A closed projector must cost no PCM work, and neither must a viz that cannot use it. The tap
 * is switched on only while ALL of these hold: the output window is alive (the same `alive`
 * beacon `postFrame()` uses — no second liveness signal), a visualization is selected, and the
 * selected plugin declares an `audio` input (`pluginWantsPcm`). None of the five built-ins do,
 * so ordinary use never turns the tap on. Milkdrop presets always want it (phase 6).
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { debugLog } from '../debugLog';
import type { VizPluginPayload } from '../renderer/outputProtocol';

export const PCM_LEN = 1024;
export const PCM_FRAME_BYTES = PCM_LEN * 3;

/** How often the gate is re-evaluated. The beacon has 1 s / 3 s granularity, so this is plenty. */
const GATE_INTERVAL_MS = 500;

let latest: Uint8Array | null = null;
let latestAt = 0;
/** A frame older than this is stale (tap stopped, e.g. every deck paused is NOT stale: the
 * tap keeps emitting silence — see below); the output window then gets no `pcm`. */
const STALE_MS = 500;

let wantedByViz = false;
let listeningSent: boolean | null = null;
let unlisten: UnlistenFn | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let isOutputAlive: () => boolean = () => false;

/**
 * Does this plugin read PCM? An ISF `audio` input (`audioFFT` is a different type), or any
 * Milkdrop preset: Butterchurn runs its own FFT on the raw samples, so it always needs the tap.
 */
export function pluginWantsPcm(plugin: VizPluginPayload | null | undefined): boolean {
  if (!plugin) return false;
  if (plugin.format === 'milkdrop') return true;
  if (plugin.format !== 'isf') return false;
  return /"TYPE"\s*:\s*"audio"/.test(plugin.source);
}

/** Decode the event payload; null if it is not a well-formed frame. */
export function decodePcm(b64: string): Uint8Array | null {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (bin.length !== PCM_FRAME_BYTES) return null;
  const out = new Uint8Array(PCM_FRAME_BYTES);
  for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Called every frame by App.svelte with the active plugin. Cheap: one regex per plugin change. */
let lastPlugin: VizPluginPayload | null | undefined;
export function noteActivePlugin(plugin: VizPluginPayload | null): void {
  if (plugin === lastPlugin) return;
  lastPlugin = plugin;
  wantedByViz = pluginWantsPcm(plugin);
}

/** Latest frame for the output window, or undefined if none / stale (send nothing). */
export function latestPcm(): Uint8Array | undefined {
  if (!latest || performance.now() - latestAt > STALE_MS) return undefined;
  return latest;
}

function evaluateGate(): void {
  const want = wantedByViz && isOutputAlive();
  if (want === listeningSent) return;
  listeningSent = want;
  if (!want) latest = null;
  debugLog(`[vizPcm] viz_set_listening(${want}) wantsPcm=${wantedByViz} outputAlive=${isOutputAlive()}`);
  invoke('viz_set_listening', { listening: want }).catch((e) => {
    listeningSent = null; // retry on the next tick
    debugLog(`[vizPcm] viz_set_listening failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}

/** Start listening for `audio-pcm` and driving the gate. `outputAlive` is outputBus's beacon check. */
export async function startVizPcm(outputAlive: () => boolean): Promise<void> {
  isOutputAlive = outputAlive;
  unlisten = await listen<string>('audio-pcm', (e) => {
    const f = decodePcm(e.payload);
    if (f) {
      latest = f;
      latestAt = performance.now();
    }
  });
  timer = setInterval(evaluateGate, GATE_INTERVAL_MS);
}

export function stopVizPcm(): void {
  unlisten?.();
  if (timer) clearInterval(timer);
  timer = undefined;
  if (listeningSent) invoke('viz_set_listening', { listening: false }).catch(() => {});
  listeningSent = null;
}
