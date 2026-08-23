import { get } from "svelte/store";
import { save } from "@tauri-apps/plugin-dialog";
import { audioRecordStart, audioRecordStop, type RecordFormat } from "./pipeline";
import {
  recordFormat, isRecording, recordOutputPath, recordStartedAt, recordingsDir, recordError,
} from "./recordState";

// Shared by the Settings > Record tab (which has notes/format/folder controls) and the
// toolbar Record button (which has none of those — it just starts/stops with whatever was
// last configured). Both must go through the same start/stop path so `isRecording` and
// friends never diverge between the two entry points.

// Both formats mux into Ogg now (see mixer.rs's build_record_sink_chain doc comment) —
// Ogg pages need no footer/index to finalize, so a crash mid-recording still leaves a
// valid, playable file. ".oga" for FLAC (not ".ogg") so the extension doesn't imply a
// video-capable container it isn't.
export const RECORD_FORMATS: { id: RecordFormat; label: string; ext: string }[] = [
  { id: "opus", label: "Opus (small)", ext: "ogg" },
  { id: "flac", label: "FLAC (lossless)", ext: "oga" },
];

function kebabCase(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function buildRecordFilename(fmt: RecordFormat, notesText: string): string {
  const ext = RECORD_FORMATS.find((f) => f.id === fmt)!.ext;
  const notesPart = kebabCase(notesText);
  return notesPart ? `${timestamp()}_${notesPart}.${ext}` : `${timestamp()}.${ext}`;
}

/** No-op if already recording. Returns the path started, or null if the user cancelled
    the save dialog (only possible when no `recordingsDir` is configured). */
export async function startRecording(notes = ""): Promise<string | null> {
  if (get(isRecording)) return null;
  recordError.set(null);

  const dir = get(recordingsDir);
  const fmt = get(recordFormat);
  let path: string;
  if (dir) {
    // One click: destination is known, so just build the path and go — no dialog.
    path = `${dir}/${buildRecordFilename(fmt, notes)}`;
  } else {
    const chosenFormat = RECORD_FORMATS.find((f) => f.id === fmt)!;
    let chosen: string | null;
    try {
      chosen = await save({
        title: "Record session to…",
        defaultPath: buildRecordFilename(fmt, notes),
        filters: [{ name: chosenFormat.label, extensions: [chosenFormat.ext] }],
      });
    } catch (e) {
      recordError.set(`Could not open save dialog: ${e}`);
      return null;
    }
    if (!chosen) return null; // user cancelled
    path = chosen;
  }

  try {
    await audioRecordStart(path, fmt);
  } catch (e) {
    recordError.set(`Could not start recording: ${e}`);
    return null;
  }
  recordOutputPath.set(path);
  recordStartedAt.set(performance.now());
  isRecording.set(true);
  return path;
}

/** No-op if not recording. */
export async function stopRecording(): Promise<void> {
  if (!get(isRecording)) return;
  try {
    await audioRecordStop();
  } catch (e) {
    recordError.set(`Could not stop recording cleanly: ${e}`);
  } finally {
    isRecording.set(false);
    recordStartedAt.set(null);
  }
}

/** What the toolbar Record button drives — start/stop with whatever was last configured
    in Settings > Record, no dialog for notes (there's no UI to type them into here). */
export async function toggleRecording(): Promise<void> {
  if (get(isRecording)) await stopRecording();
  else await startRecording();
}
