import { listen } from "@tauri-apps/api/event";
import { updateDeck, getDeck, setCrossfader, setMasterVolume } from "../state/session";
import { seekDeck } from "../renderer/seekBus";

// Must match the Rust MidiAction enum (snake_case tag + camelCase fields from serde)
export interface MidiAction {
  type:
    | "deck_play_toggle"
    | "deck_opacity"
    | "deck_volume"
    | "deck_playback_rate"
    | "crossfader"
    | "master_volume"
    | "cue_jump"
    | "hot_cue"
    | "loop_toggle";
  deck_id?: string;
  value?: number;
  index?: number;
}

export async function startMidiListener(): Promise<() => void> {
  const unlisten = await listen<MidiAction>("midi-action", ({ payload: a }) => {
    switch (a.type) {
      case "deck_play_toggle": {
        if (!a.deck_id) break;
        const d = getDeck(a.deck_id);
        if (d) updateDeck(d.id, { playing: !d.playing });
        break;
      }
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
      case "hot_cue":
        // TODO: seek to hotCues[index] when implemented
        break;
    }
  });
  return unlisten;
}
