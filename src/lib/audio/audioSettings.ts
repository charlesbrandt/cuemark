import { writable } from "svelte/store";

function persistentWritable<T>(key: string, defaultValue: T) {
  let initial: T;
  try {
    const raw = localStorage.getItem(key);
    initial = raw !== null ? (JSON.parse(raw) as T) : defaultValue;
  } catch {
    initial = defaultValue;
  }

  const store = writable<T>(initial);

  return {
    subscribe: store.subscribe,
    set(value: T) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
      store.set(value);
    },
    update(fn: (value: T) => T) {
      store.update(current => {
        const next = fn(current);
        try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
        return next;
      });
    },
  };
}

/** Device IDs for the main mix outputs. Defaults to [""] (system default). Persisted across restarts. */
export const mainOutputDeviceIds = persistentWritable<string[]>("cuemark:mainOutputDeviceIds", [""]);

/** Device ID for the headphone / cue monitor output. '' = none. Persisted across restarts. */
export const cueOutputDeviceId = persistentWritable<string>("cuemark:cueOutputDeviceId", "");

/**
 * Network output targets — Snapcast servers, as `snapcast://<host>:<port>` device ids.
 *
 * These are **configured, not discovered** — a Snapcast server is reached by address, and
 * nothing here assumes it is discoverable (mDNS does not cross a routed subnet boundary, so
 * on many networks it is not). The backend's `list_audio_devices` enumerates local PipeWire
 * sinks only, so `AudioSettings` merges these in before its stale-id auto-heal runs — an id
 * the heal cannot see is an id it deletes, which is why this list has to reach the picker
 * rather than living only in `mainOutputDeviceIds`.
 *
 * See `docs/design/network-audio-output.md`. Persisted across restarts.
 */
export type NetworkOutput = {
  id: string;
  label: string;
  /**
   * How far behind this app the target's listeners actually are, in milliseconds — the
   * receiving server's end-to-end buffer plus its clients' presentation delay.
   *
   * ⚠️ **Not a preference and not guessable — a property of the server**, which is why it
   * has no meaningful default (0 = uncorrected). For Snapcast it is the server's `buffer`
   * setting. Video syncs to the deck's *first* main output, so this only moves the picture
   * when the network target is first in the Main list. Tune by ear against the room.
   */
  latencyMs: number;
};
export const networkOutputs = persistentWritable<NetworkOutput[]>("cuemark:networkOutputs", []);

/** Headphone / cue monitor master gain (0–1). Persisted across restarts. */
export const cueGain = persistentWritable<number>("cuemark:cueGain", 1.0);

/** MIDI fader and UI rate slider range as ±percentage (1–100). Default ±20%. Persisted across restarts. */
export const tempoRange = persistentWritable<number>("cuemark:tempoRange", 20);

/**
 * Paused-deck jog wheel control model. 'shuttle' (default): jog velocity → playback
 * speed, free-running between MIDI ticks — fast for cueing/searching but reversed
 * audio at speed reads ambiguously by ear. 'vinyl': jog input → brief, gentle motion
 * that decays to a hold almost immediately once ticks stop, approximating direct 1:1
 * position control like a hand on a real record — slower and more precise, silent the
 * instant the wheel stops. See docs/design/pcm-buffer-playback.md "Open question:
 * shuttle mode vs. vinyl mode". Global (not per-deck) for now. Persisted across restarts.
 */
export const scratchMode = persistentWritable<"shuttle" | "vinyl">("cuemark:scratchMode", "vinyl");

/**
 * Vinyl-mode jog scale: **seconds of audio covered by one full revolution of the wheel.**
 *
 * The default 1.8 is a real 12" platter at 33⅓ rpm, which is where this feature started —
 * turn the wheel at record speed and you get 1.0x, exactly like a hand on vinyl.
 *
 * ⚠️ **That faithful mapping is not obviously the right one on a small controller wheel**,
 * and this setting exists because the question is a matter of taste that has to be answered
 * by ear (`docs/design/slow-jog-audio-inaudible.md` §6). Measured 2026-08-10: sustained
 * cueing gestures on the Starlight run at **0.10–0.26x**, i.e. 3–8 rpm, because that is the
 * speed a hand naturally uses to hunt for a beat on a wheel a few inches across. At 0.15x
 * the audio is pitched down ~2.7 octaves — present at full level, and almost inaudible.
 * Halving this doubles the pitch for the same hand motion.
 *
 * The trade is real in both directions and there is no free setting: **lower = more audible
 * but coarser positioning**, since one revolution now covers less content. Nothing here is
 * a bug fix — the pipeline is doing exactly what it is told at every value.
 *
 * ⚠️ Do **not** fold the encoder's ticks-per-revolution into this. That is a measured
 * hardware property (`VINYL_TICKS_PER_REV` in `handler.ts`, 256, confirmed by five
 * calibration gestures), not a preference, and making it adjustable would let a wrong
 * hardware number hide inside a taste setting. Persisted across restarts.
 */
export const jogSecondsPerRev = persistentWritable<number>("cuemark:jogSecondsPerRev", 1.8);
