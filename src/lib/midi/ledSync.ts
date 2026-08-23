// Mirrors deck.cueEnabled onto a physical controller's headphone-Cue button LED, the
// reverse direction of handler.ts's headphone_cue case (button press -> deck state).
// See docs/design/controller-mapping.md §11/§12 for the bench-verified LED protocol
// this is built on (plain Note On vel 127 / Note Off vel 0, same bytes as the button's
// own input, no SysEx handshake needed for this control).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { slotDeck } from "./handler";

interface ControllerInfo {
  source: number;
  port: string;
  profile_id: string;
  profile_name: string;
  slots: number;
  jog_ticks_per_rev: number;
}

// Own tiny mirror of AudioSettings.svelte's controller list rather than sharing a
// store — this module needs to work with no Settings panel ever opened, and the two
// consumers have nothing else in common.
let controllers: ControllerInfo[] = [];
let started = false;

function start() {
  if (started) return;
  started = true;
  invoke<ControllerInfo[]>("midi_list_controllers")
    .then((c) => { controllers = c; })
    .catch(() => {});
  listen<ControllerInfo[]>("midi-controllers", ({ payload }) => { controllers = payload; })
    .catch(() => {});
}

/**
 * Pushes `on` to the headphone-Cue LED of every connected controller whose slot
 * routing (Session.midiMapping, via slotDeck — same resolution handler.ts uses)
 * currently points at `deckId`. A silent no-op on any controller/profile that has
 * no bench-verified LED row for this control (Rust's led_control() returns None) or
 * no output port at all — see Control::led's doc comment for why that must never be
 * assumed rather than captured.
 */
export function syncHeadphoneCueLed(deckId: string, on: boolean) {
  start();
  for (const c of controllers) {
    for (let slot = 0; slot < c.slots; slot++) {
      if (slotDeck(c.profile_id, slot) === deckId) {
        invoke("midi_set_headphone_cue_led", { profileId: c.profile_id, slot, on }).catch(() => {});
      }
    }
  }
}
