import { listen } from "@tauri-apps/api/event";
import { updateDeck, getDeck, setCrossfader, setMasterVolume, session } from "../state/session";
import { seekDeck, getDeckTime } from "../renderer/seekBus";
import { nudgePhaseToMaster } from "../audio/phaseNudge";
import { get } from "svelte/store";

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

// Per-deck jog state: saves the rate that was active before jog started so it can be restored.
const jogBaseRate: Record<string, number> = {};
const jogTimers: Record<string, ReturnType<typeof setTimeout>> = {};

export async function startMidiListener(): Promise<() => void> {
  const unlisten = await listen<MidiAction>("midi-action", ({ payload: a }) => {
    switch (a.type) {
      case "deck_play_toggle": {
        if (!a.deck_id) break;
        const d = getDeck(a.deck_id);
        if (d) updateDeck(d.id, { playing: !d.playing });
        break;
      }
      case "deck_gain":
        if (a.deck_id && a.value !== undefined)
          updateDeck(a.deck_id, { gain: a.value });
        break;
      case "deck_volume":
        if (a.deck_id && a.value !== undefined)
          updateDeck(a.deck_id, { volume: a.value });
        break;
      case "deck_opacity":
        if (a.deck_id && a.value !== undefined)
          updateDeck(a.deck_id, { opacity: a.value });
        break;
      case "deck_playback_rate":
        if (a.deck_id && a.value !== undefined)
          updateDeck(a.deck_id, { playbackRate: a.value });
        break;
      case "crossfader":
        if (a.value !== undefined) setCrossfader(a.value);
        break;
      case "master_volume":
        if (a.value !== undefined) setMasterVolume(a.value);
        break;
      case "cue_jump": {
        if (!a.deck_id) break;
        const d = getDeck(a.deck_id);
        if (d) {
          seekDeck(d.id, d.cuePoint);
          updateDeck(d.id, { playing: false });
        }
        break;
      }
      case "loop_toggle": {
        if (!a.deck_id) break;
        const d = getDeck(a.deck_id);
        if (d) updateDeck(d.id, { loop: !d.loop });
        break;
      }
      case "hot_cue": {
        if (!a.deck_id || a.index === undefined) break;
        const d = getDeck(a.deck_id);
        if (!d) break;
        const t = d.hotCues[a.index];
        if (t !== undefined && !isNaN(t)) seekDeck(d.id, t);
        break;
      }
      case "hot_cue_set": {
        if (!a.deck_id || a.index === undefined) break;
        const d = getDeck(a.deck_id);
        if (!d) break;
        const now = getDeckTime(a.deck_id);
        if (now !== null) {
          const cues = [...d.hotCues];
          cues[a.index] = now;
          updateDeck(d.id, { hotCues: cues });
        }
        break;
      }
      case "jog_nudge": {
        if (!a.deck_id || a.value === undefined) break;
        const deckId = a.deck_id;
        const d = getDeck(deckId);
        if (!d) break;
        // Save rate before first jog event so we can restore it after jog stops.
        if (!(deckId in jogBaseRate)) jogBaseRate[deckId] = d.playbackRate;
        const nudged = Math.max(0.25, Math.min(4.0, d.playbackRate + a.value * 0.02));
        updateDeck(d.id, { playbackRate: nudged });
        clearTimeout(jogTimers[deckId]);
        jogTimers[deckId] = setTimeout(() => {
          const base = jogBaseRate[deckId];
          delete jogBaseRate[deckId];
          if (base !== undefined) updateDeck(deckId, { playbackRate: base });
        }, 150);
        break;
      }
      case "sync_toggle": {
        if (!a.deck_id) break;
        const d = getDeck(a.deck_id);
        const masterBpm = get(session).bpm;
        if (d && d.bpm !== null && masterBpm !== null) {
          // masterBpm / deck.bpm: if deck is slower, rate > 1 to speed up to match master
          updateDeck(d.id, { playbackRate: masterBpm / d.bpm });
        }
        break;
      }
      case "headphone_cue": {
        if (!a.deck_id) break;
        const d = getDeck(a.deck_id);
        if (d) updateDeck(d.id, { cueEnabled: !d.cueEnabled });
        break;
      }
      case "phase_nudge": {
        if (!a.deck_id) break;
        nudgePhaseToMaster(a.deck_id);
        break;
      }
    }
  });
  return unlisten;
}
