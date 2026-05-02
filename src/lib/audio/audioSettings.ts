import { writable } from "svelte/store";

/** Device ID for the main mix output (speakers / projector). '' = system default. */
export const mainOutputDeviceId = writable<string>("");

/** Device ID for the headphone / cue monitor output. '' = none selected. */
export const cueOutputDeviceId = writable<string>("");

/** Headphone / cue monitor master gain (0–1). */
export const cueGain = writable<number>(1.0);
