export interface AudioOutputDevice {
  deviceId: string;
  label: string;
}

export async function listAudioOutputs(): Promise<AudioOutputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audiooutput")
    .map((d) => ({ deviceId: d.deviceId, label: d.label || d.deviceId || "Unknown output" }));
}

/** True if AudioContext.setSinkId() is available in this runtime. */
export function sinkIdSupported(): boolean {
  return typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
}
