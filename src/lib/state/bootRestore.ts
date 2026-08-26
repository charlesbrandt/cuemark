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
import { slotDeck } from "../midi/handler";
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

/**
 * A session snapshot written before 2026-08-22 carries the old single-controller
 * `{left, right}` shape (Session.midiMapping); the current shape is a profile-id-keyed
 * map of slot arrays. Anything that isn't recognizably the old shape is assumed to
 * already be current (or absent, which is a valid empty routing table) and passed
 * through unchanged — this is deliberately not a versioned migration (see
 * decode::persist_kv's doc comment in midi/decode.rs for why the sibling
 * midi_state.json rename made the same call): the old shape only ever named the
 * Starlight's two channels, so there is exactly one sensible target profile id.
 */
function migrateMidiMapping(mapping: unknown): Record<string, string[]> {
  if (mapping && typeof mapping === "object" && "left" in mapping && "right" in mapping) {
    const m = mapping as { left: string; right: string };
    return { "hercules-starlight": [m.left, m.right] };
  }
  return (mapping as Record<string, string[]> | undefined) ?? {};
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
      restored.midiMapping = migrateMidiMapping(restored.midiMapping);
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
      // defaults (the ghost-restore risk above is real for per-deck state). Most global,
      // non-deck settings (master volume, bpm, curves, snap-to-beat, visualization) carry
      // none of that risk — they're just numbers/toggles, safe to apply regardless of
      // whether any deck has audio loaded. Without restoring them, any such setting last
      // changed via the on-screen UI (rather than a physical MIDI control, which
      // separately persists through midi_state.json below) would silently reset to its
      // default on every full app restart, even though it was faithfully written to
      // session-recovery.json the whole time.
      //
      // `crossfaderValue` is deliberately excluded from that list — it's the one field
      // here that actively mutes a deck, and a persisted value for it cannot be trusted
      // the way the others can. Two ways were tried and both failed live 2026-08-25: (1)
      // restoring it as inert state left it silently out of sync with the freshly-defaulted
      // decks' actual volume/opacity until the *next* setCrossfader() call — a manual touch
      // or Auto DJ's near-end ramp — applied the curve for the first time since boot and
      // slammed both decks straight to their curve position in one frame, not gradually
      // (crossfaderValue had been restored to 1.0 from a prior session; deck-0 played at
      // its native full volume the whole track, then cut to silence the instant the first
      // setCrossfader() call landed). (2) Applying it immediately at boot instead avoids
      // that deferred jump, but is worse: it silently mutes whichever deck the DJ loads
      // next with zero action on their part, for no reason visible in the UI — hit
      // immediately on the very next restart, one deck loaded and playing, volume/opacity
      // both pinned at 0.00. Root cause of both: an unmotorized fader's *physical*
      // position can drift from whatever was last read electronically (session-recovery.json
      // or midi_state.json alike) just by being touched by hand while the app is closed —
      // no persisted value can be trusted to reflect where the hardware currently sits, so
      // none is applied. `crossfaderValue` simply stays at the module's own default (0.5,
      // both decks live) until a real signal — a physical touch or Auto DJ — moves it.
      const restored = recovery.snapshot as Session;
      session.update((s) => ({
        ...s,
        masterVolume: restored.masterVolume,
        bpm: restored.bpm,
        masterDeckId: restored.masterDeckId,
        crossfaderMapping: restored.crossfaderMapping,
        midiMapping: migrateMidiMapping(restored.midiMapping),
        crossfaderTargets: restored.crossfaderTargets,
        audioCurve: restored.audioCurve,
        visualCurve: restored.visualCurve,
        snapToBeat: restored.snapToBeat,
        compactControls: restored.compactControls ?? false,
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
        // Key shape since the 2026-08-22 profile refactor: "{profileId}:{slot}.{field}"
        // — Rust no longer knows deck ids at all (see midi/decode.rs persist_kv's doc
        // comment), so slot -> deck is resolved here through the same slotDeck() the
        // live MIDI path uses. A key from a pre-refactor file won't contain ":" before
        // the first "." and is silently dropped — the one-time break the rename
        // deliberately accepted rather than building a versioned migration for values
        // that aren't changing shape.
        const dot = key.indexOf(".");
        const colon = key.indexOf(":");
        if (dot > 0 && colon > 0 && colon < dot) {
          const profileId = key.slice(0, colon);
          const slot = Number(key.slice(colon + 1, dot));
          const field = key.slice(dot + 1);
          const deckId = slotDeck(profileId, slot);
          if (!deckId) continue;
          const patch = deckPatches.get(deckId) ?? {};
          (patch as Record<string, number>)[field] = value;
          deckPatches.set(deckId, patch);
        }
      }
    }
    for (const [deckId, patch] of deckPatches) {
      // eqLow/eqMid/eqHigh don't name flat Deck fields — the EQ knobs write into
      // deck.eq.{low,mid,high}, and a raw patch would create bogus top-level
      // properties while leaving the actual EQ untouched. Merge them into the deck's
      // current eq instead, so the other bands survive.
      const { eqLow, eqMid, eqHigh, ...flat } = patch as Record<string, number>;
      const merged: Record<string, unknown> = { ...flat };
      if (eqLow !== undefined || eqMid !== undefined || eqHigh !== undefined) {
        const deck = get(session).decks.find((d) => d.id === deckId);
        if (deck) {
          merged.eq = {
            low: eqLow ?? deck.eq.low,
            mid: eqMid ?? deck.eq.mid,
            high: eqHigh ?? deck.eq.high,
          };
        }
      }
      updateDeck(deckId, merged as Parameters<typeof updateDeck>[1]);
    }
  } catch (e) {
    console.warn("[midi-state] failed to restore saved state:", e);
  }
}
