import { listen } from "@tauri-apps/api/event";
import { updateDeck, getDeck, setCrossfader, setMasterVolume, session } from "../state/session";
import { seekDeck, getDeckTime } from "../renderer/seekBus";
import { nudgePhaseToMaster } from "../audio/phaseNudge";
import { syncRate, syncGain, syncVolume } from "../audio/audioSync";
import { cueGain, tempoRange } from "../audio/audioSettings";
import { get } from "svelte/store";

// Buffers the latest deck patch for continuous MIDI controls (rate, gain, volume)
// and flushes them once per rAF. This decouples the audio path (immediate, via syncRate/…)
// from the Svelte store update (display only — capped at 60fps to prevent 200 reactive
// re-renders/sec from saturating the JS thread and lagging the UI).
const _pendingPatches = new Map<string, Record<string, unknown>>();
let _patchFlushPending = false;

function queueDeckPatch(deckId: string, patch: Record<string, unknown>) {
  const existing = _pendingPatches.get(deckId) ?? {};
  _pendingPatches.set(deckId, { ...existing, ...patch });
  if (!_patchFlushPending) {
    _patchFlushPending = true;
    requestAnimationFrame(() => {
      _patchFlushPending = false;
      for (const [id, p] of _pendingPatches) {
        updateDeck(id, p as Parameters<typeof updateDeck>[1]);
      }
      _pendingPatches.clear();
    });
  }
}

// Same pattern for crossfader — setCrossfader() updates both deck volumes/opacities,
// which is expensive at 200/sec. Audio volume is synced directly; UI updates at rAF rate.
let _pendingCrossfader: number | undefined;
let _crossfaderFlushPending = false;

function queueCrossfader(value: number) {
  _pendingCrossfader = value;
  if (!_crossfaderFlushPending) {
    _crossfaderFlushPending = true;
    requestAnimationFrame(() => {
      _crossfaderFlushPending = false;
      if (_pendingCrossfader !== undefined) {
        setCrossfader(_pendingCrossfader);
        _pendingCrossfader = undefined;
      }
    });
  }
}

// Must match the Rust MidiAction enum (snake_case tag + camelCase fields from serde)
export interface MidiAction {
  type:
    | "deck_play_toggle"
    | "deck_opacity"
    | "deck_gain"
    | "deck_volume"
    | "deck_playback_rate"
    | "jog_nudge"
    | "crossfader"
    | "master_volume"
    | "cue_gain"
    | "cue_jump"
    | "hot_cue"
    | "hot_cue_set"
    | "loop_toggle"
    | "sync_toggle"
    | "headphone_cue"
    | "phase_nudge";
  deck_id?: string;
  value?: number;
  index?: number;
}

// Remap a MIDI-side deck ID ("deck-0"/"deck-1") to the configured software deck.
// The Rust map hardcodes "deck-0" for the left controller channel and "deck-1" for
// the right; midiMapping lets the user reassign without touching the Rust map.
function midiDeckId(hardcoded: string | undefined): string | undefined {
  if (!hardcoded) return hardcoded;
  const m = get(session).midiMapping;
  if (hardcoded === "deck-0") return m.left;
  if (hardcoded === "deck-1") return m.right;
  return hardcoded;
}

// Per-deck jog state: saves the rate that was active before jog started so it can be restored.
const jogBaseRate: Record<string, number> = {};
const jogTimers: Record<string, ReturnType<typeof setTimeout>> = {};

export async function startMidiListener(): Promise<() => void> {
  const unlisten = await listen<MidiAction>("midi-action", ({ payload: a }) => {
    const deckId = midiDeckId(a.deck_id);
    switch (a.type) {
      case "deck_play_toggle": {
        if (!deckId) break;
        const d = getDeck(deckId);
        if (d) updateDeck(d.id, { playing: !d.playing });
        break;
      }
      case "deck_gain":
        if (deckId && a.value !== undefined) {
          syncGain(deckId, a.value);              // audio: immediate
          queueDeckPatch(deckId, { gain: a.value }); // UI: rAF-throttled
        }
        break;
      case "deck_volume":
        if (deckId && a.value !== undefined) {
          syncVolume(deckId, a.value);
          queueDeckPatch(deckId, { volume: a.value });
        }
        break;
      case "deck_opacity":
        if (deckId && a.value !== undefined)
          updateDeck(deckId, { opacity: a.value }); // visual only — store is fine
        break;
      case "deck_playback_rate":
        if (deckId && a.value !== undefined) {
          // Rust always emits rate = 1.0 + delta*0.5 (±50% throw). Rescale delta to the
          // user-configured range so the full fader throw maps to exactly ±tempoRange%.
          const delta = (a.value - 1.0) / 0.5;
          const range = get(tempoRange) / 100;
          const scaled = 1.0 + delta * range;
          syncRate(deckId, scaled);               // audio: immediate, no Svelte overhead
          queueDeckPatch(deckId, { playbackRate: scaled }); // UI: rAF-throttled
        }
        break;
      case "crossfader":
        // Throttle to rAF — setCrossfader() recomputes volumes+opacities for all decks,
        // creating new Session+Deck objects and triggering full Svelte re-renders. At 100+
        // events/sec this saturates the JS thread. 16ms display lag is imperceptible for
        // a visual/audio fader sweep. Audio volume lag is tolerable at 60fps.
        if (a.value !== undefined) queueCrossfader(a.value);
        break;
      case "master_volume":
        if (a.value !== undefined) setMasterVolume(a.value);
        break;
      case "cue_gain":
        if (a.value !== undefined) cueGain.set(a.value);
        break;
      case "cue_jump": {
        if (!deckId) break;
        const d = getDeck(deckId);
        if (d) {
          seekDeck(d.id, d.cuePoint);
          updateDeck(d.id, { playing: false });
        }
        break;
      }
      case "loop_toggle": {
        if (!deckId) break;
        const d = getDeck(deckId);
        if (d) updateDeck(d.id, { loop: !d.loop });
        break;
      }
      case "hot_cue": {
        if (!deckId || a.index === undefined) break;
        const d = getDeck(deckId);
        if (!d) break;
        const t = d.hotCues[a.index];
        if (t !== undefined && !isNaN(t)) seekDeck(d.id, t);
        break;
      }
      case "hot_cue_set": {
        if (!deckId || a.index === undefined) break;
        const d = getDeck(deckId);
        if (!d) break;
        const now = getDeckTime(deckId);
        if (now !== null) {
          const cues = [...d.hotCues];
          cues[a.index] = now;
          updateDeck(d.id, { hotCues: cues });
        }
        break;
      }
      case "jog_nudge": {
        if (!deckId || a.value === undefined) break;
        const d = getDeck(deckId);
        if (!d) break;
        if (!(deckId in jogBaseRate)) jogBaseRate[deckId] = d.playbackRate;
        const nudged = Math.max(0.25, Math.min(4.0, d.playbackRate + a.value * 0.02));
        syncRate(d.id, nudged);
        updateDeck(d.id, { playbackRate: nudged });
        clearTimeout(jogTimers[deckId]);
        jogTimers[deckId] = setTimeout(() => {
          const base = jogBaseRate[deckId];
          delete jogBaseRate[deckId];
          if (base !== undefined) {
            syncRate(deckId, base);
            updateDeck(deckId, { playbackRate: base });
          }
        }, 150);
        break;
      }
      case "sync_toggle": {
        if (!deckId) break;
        const d = getDeck(deckId);
        const s = get(session);
        const masterBpm = s.bpm;
        if (!d || d.bpm === null || masterBpm === null) {
          console.warn(`[sync_toggle] no-op — masterBpm=${masterBpm}, deck.bpm=${d?.bpm ?? 'no deck'}`);
          break;
        }
        updateDeck(d.id, { playbackRate: masterBpm / d.bpm });

        // Wait for WebKit's video-pipeline rebuild (triggered by the playbackRate write
        // above) to settle before seeking — see CLAUDE.md "Rate-then-seek ordering".
        setTimeout(() => nudgePhaseToMaster(d.id), 200);
        break;
      }
      case "headphone_cue": {
        if (!deckId) break;
        const d = getDeck(deckId);
        if (d) updateDeck(d.id, { cueEnabled: !d.cueEnabled });
        break;
      }
      case "phase_nudge": {
        if (!deckId) break;
        nudgePhaseToMaster(deckId);
        break;
      }
    }
  });
  return unlisten;
}
