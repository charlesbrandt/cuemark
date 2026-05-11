import { listen } from "@tauri-apps/api/event";
import { updateDeck, getDeck, setCrossfader, setMasterVolume, session } from "../state/session";
import { seekDeck, getDeckTime, getPhase } from "../renderer/seekBus";
import { nudgePhaseToMaster } from "../audio/phaseNudge";
import { cueGain } from "../audio/audioSettings";
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
        if (deckId && a.value !== undefined)
          updateDeck(deckId, { gain: a.value });
        break;
      case "deck_volume":
        if (deckId && a.value !== undefined)
          updateDeck(deckId, { volume: a.value });
        break;
      case "deck_opacity":
        if (deckId && a.value !== undefined)
          updateDeck(deckId, { opacity: a.value });
        break;
      case "deck_playback_rate":
        if (deckId && a.value !== undefined)
          updateDeck(deckId, { playbackRate: a.value });
        break;
      case "crossfader":
        if (a.value !== undefined) setCrossfader(a.value);
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
        if (!deckId) break;
        const d = getDeck(deckId);
        const s = get(session);
        const masterBpm = s.bpm;
        if (!d || d.bpm === null || masterBpm === null) {
          console.warn(`[sync_toggle] no-op — masterBpm=${masterBpm}, deck.bpm=${d?.bpm ?? 'no deck'}`);
          break;
        }
        updateDeck(d.id, { playbackRate: masterBpm / d.bpm });

        if (d.downbeat !== null) {
          const ref = s.decks.find(r => r.id !== d.id && r.bpm !== null && r.downbeat !== null);
          if (ref) {
            const deckPhase = getPhase(d.id);
            const refPhase  = getPhase(ref.id);
            if (deckPhase !== null && refPhase !== null) {
              let delta = refPhase - deckPhase;
              if (delta >  0.5) delta -= 1.0;
              if (delta < -0.5) delta += 1.0;
              if (Math.abs(delta) >= 0.02) {
                const beatPeriod = 60 / d.bpm;
                const currentTime = getDeckTime(d.id);
                if (currentTime !== null) {
                  seekDeck(d.id, Math.max(0, currentTime + delta * beatPeriod));
                }
              }
            }
          }
        }
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
