// Mirrors deck boolean state (headphone cue, play, sync lock) onto a physical
// controller's matching button LED — the reverse direction of handler.ts's button
// cases (press -> deck state). See docs/design/controller-mapping.md §11/§12 for the
// bench-verified LED protocol this is built on (plain Note On vel 127 / Note Off
// vel 0, same bytes as the button's own input, no SysEx handshake needed for any of
// these three controls, on either the FLX4 or the Starlight).

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
 * Pushes `on` to `action`'s LED on every connected controller whose slot routing
 * (Session.midiMapping, via slotDeck — same resolution handler.ts uses) currently
 * points at `deckId`. A silent no-op on any controller/profile that has no
 * bench-verified LED row for this control (Rust's led_control() returns None) or no
 * output port at all — see Control::led's doc comment for why that must never be
 * assumed rather than captured.
 */
function syncLed(action: string, deckId: string, on: boolean) {
  start();
  for (const c of controllers) {
    for (let slot = 0; slot < c.slots; slot++) {
      if (slotDeck(c.profile_id, slot) === deckId) {
        invoke("midi_set_led", { profileId: c.profile_id, slot, action, on }).catch(() => {});
      }
    }
  }
}

export function syncHeadphoneCueLed(deckId: string, on: boolean) {
  syncLed("headphone_cue", deckId, on);
}

export function syncPlayLed(deckId: string, on: boolean) {
  syncLed("play_toggle", deckId, on);
}

export function syncSyncLed(deckId: string, on: boolean) {
  syncLed("sync_toggle", deckId, on);
}
