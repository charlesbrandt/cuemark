/**
 * Boot-time state restoration: session-of-record rehydration after a freeze-watchdog
 * reload (docs/design/freeze-watchdog.md phase 2) and the last-seen MIDI control
 * positions. Extracted from App.svelte's onMount unchanged.
 */
import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { session, updateDeck, setCrossfader, setMasterVolume } from "./session";
import { sessionRestore } from "../audio/pipeline";
import { clearSavedGrid } from "../audio/gridSource";
import { cueGain } from "../audio/audioSettings";
import { debugLog } from "../debugLog";
import type { Session } from "./types";

// Decks awaiting adoption after a recovery boot: the Rust pipeline survived the
// freeze/reload and is still playing, so the video-backend sync must skip audioLoad() for
// these and just point the fresh backend at the live position instead. Populated by
// restoreSessionOnBoot before the first session.set(restored), consumed (and cleared
// per-deck) the first time that deck's presentation backend is created.
const pendingAdoption = new Map<string, { positionSecs: number; playing: boolean }>();

export function hasPendingAdoption(deckId: string): boolean {
  return pendingAdoption.has(deckId);
}

/** Consumes the adoption record for a deck — a second call returns undefined. */
export function takePendingAdoption(deckId: string): { positionSecs: number; playing: boolean } | undefined {
  const adopted = pendingAdoption.get(deckId);
  if (adopted) pendingAdoption.delete(deckId);
  return adopted;
}

export interface BootRestoreResult {
  /** Both a prior snapshot exists AND at least one live Rust pipeline reports a file. */
  isRecoveryBoot: boolean;
  /** Global (non-deck) settings were applied from a snapshot on an ordinary boot. */
  globalsRestoredFromSnapshot: boolean;
}

/**
 * Rehydrate the session from the session-of-record, before any other init that would
 * otherwise construct decks from the default empty session.
 *
 * A recovery boot is when BOTH a prior snapshot exists AND at least one live Rust
 * pipeline still reports a loaded file — a stale session-recovery.json from a previous
 * app run must not ghost-restore decks into a genuinely clean boot (the AudioManager is
 * fresh with zero pipelines in that case, so `audio` comes back empty and this check
 * correctly declines).
 */
export async function restoreSessionOnBoot(): Promise<BootRestoreResult> {
  let isRecoveryBoot = false;
  let globalsRestoredFromSnapshot = false;
  try {
    const recovery = await sessionRestore();
    isRecoveryBoot = !!recovery.snapshot && recovery.audio.some((a) => a.filePath);
    if (isRecoveryBoot) {
      const restored = recovery.snapshot as Session;
      debugLog(`[recovery] rehydrating session — ${recovery.audio.length} live pipeline(s)`);
      // The trust map that gates saved-grid vs. auto-fit precedence (gridSource.ts) is
      // a module-level Map that died with the old page — it's already empty after this
      // reload, but clear explicitly anyway per the design doc, defensively, in case a
      // future caller invokes this rehydration path without a full page reload. Without
      // it, this is exactly the stale-trust bug class fixed in 060de16.
      for (const deck of restored.decks) clearSavedGrid(deck.id);
      for (const status of recovery.audio) {
        if (status.filePath) {
          // Audio wins on disagreement (design doc "Session-of-record"): the pipeline's
          // playing state is ground truth, the JS snapshot can be up to ~1s stale.
          const deck = restored.decks.find((d) => d.id === status.deckId);
          if (deck) deck.playing = status.playing;
          pendingAdoption.set(status.deckId, {
            positionSecs: status.positionSecs ?? 0,
            playing: status.playing,
          });
        }
      }
      session.set(restored);
    } else if (recovery.snapshot) {
      // Not a recovery boot — no live pipeline to adopt, so decks stay at their fresh
      // defaults (the ghost-restore risk above is real for per-deck state). But global,
      // non-deck settings (master volume, bpm, crossfader position, curves, snap-to-beat,
      // visualization) carry none of that risk — they're just numbers/toggles, safe to
      // apply regardless of whether any deck has audio loaded. Without this, any such
      // setting last changed via the on-screen UI (rather than a physical MIDI control,
      // which separately persists through midi_state.json below) silently reset to its
      // default on every full app restart, even though it was faithfully written to
      // session-recovery.json the whole time.
      const restored = recovery.snapshot as Session;
      session.update((s) => ({
        ...s,
        masterVolume: restored.masterVolume,
        bpm: restored.bpm,
        masterDeckId: restored.masterDeckId,
        crossfaderMapping: restored.crossfaderMapping,
        midiMapping: restored.midiMapping,
        crossfaderValue: restored.crossfaderValue,
        crossfaderTargets: restored.crossfaderTargets,
        audioCurve: restored.audioCurve,
        visualCurve: restored.visualCurve,
        snapToBeat: restored.snapToBeat,
        visualization: restored.visualization,
        visualizationOpacity: restored.visualizationOpacity,
      }));
      globalsRestoredFromSnapshot = true;
    }
  } catch (e) {
    console.error("[recovery] session_restore failed, starting fresh:", e);
  }
  return { isRecoveryBoot, globalsRestoredFromSnapshot };
}

/**
 * Restore last-seen MIDI control positions from the persist file. This pre-populates
 * faders/knobs so the software matches the controller on startup without requiring the
 * user to touch every control. Applied before any track loads so the values are in the
 * session when the first audioLoad pipeline is created.
 *
 * Skipped entirely on a recovery boot: the just-restored session snapshot already carries
 * the exact pre-freeze fader positions, which is strictly more accurate than this separate
 * per-control persist file (last-seen values, not necessarily in sync).
 * 'crossfader'/'masterVolume' are also skipped when `globalsRestoredFromSnapshot` — same
 * reasoning, just for the non-recovery-boot case: the snapshot reflects every change
 * regardless of source, while this file only updates from physical MIDI events, so it can
 * hold a stale value if the control was last touched on-screen.
 */
export async function restoreMidiControlState(globalsRestoredFromSnapshot: boolean): Promise<void> {
  try {
    const saved = await invoke<Record<string, number>>("midi_get_saved_state");
    const deckPatches = new Map<string, Record<string, number>>();
    for (const [key, value] of Object.entries(saved)) {
      if (key === "crossfader") {
        if (!globalsRestoredFromSnapshot) setCrossfader(value);
      } else if (key === "masterVolume") {
        if (!globalsRestoredFromSnapshot) setMasterVolume(value);
      } else if (key === "cueGain") {
        cueGain.set(value);
      } else {
        const dot = key.indexOf(".");
        if (dot > 0) {
          const deckId = key.slice(0, dot);
          const field = key.slice(dot + 1);
          const patch = deckPatches.get(deckId) ?? {};
          (patch as Record<string, number>)[field] = value;
          deckPatches.set(deckId, patch);
        }
      }
    }
    for (const [deckId, patch] of deckPatches) {
      // `eqLow` is the one persisted key that does not name a flat Deck field — the
      // tone knob writes `deck.eq.low`, and a raw patch would create a bogus top-level
      // `eqLow` property while leaving the actual EQ untouched. Merge it into the
      // deck's current eq instead, so the other two bands survive.
      const { eqLow, ...flat } = patch as Record<string, number>;
      const merged: Record<string, unknown> = { ...flat };
      if (eqLow !== undefined) {
        const deck = get(session).decks.find((d) => d.id === deckId);
        if (deck) merged.eq = { ...deck.eq, low: eqLow };
      }
      updateDeck(deckId, merged as Parameters<typeof updateDeck>[1]);
    }
  } catch (e) {
    console.warn("[midi-state] failed to restore saved state:", e);
  }
}
