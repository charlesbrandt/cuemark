<script lang="ts">
  import { onDestroy } from "svelte";
  import { open, save } from "@tauri-apps/plugin-dialog";
  import { audioRecordStart, audioRecordStop, type RecordFormat } from "../lib/audio/pipeline";
  import {
    recordFormat, isRecording, recordOutputPath, recordStartedAt, recordingsDir,
  } from "../lib/audio/recordState";

  // Both formats mux into Ogg now (see mixer.rs's build_record_sink_chain doc comment) —
  // Ogg pages need no footer/index to finalize, so a crash mid-recording still leaves a
  // valid, playable file. ".oga" for FLAC (not ".ogg") so the extension doesn't imply a
  // video-capable container it isn't.
  const FORMATS: { id: RecordFormat; label: string; ext: string }[] = [
    { id: "opus", label: "Opus (small)", ext: "ogg" },
    { id: "flac", label: "FLAC (lossless)", ext: "oga" },
  ];

  let notes = $state("");
  let error = $state<string | null>(null);
  let starting = $state(false);
  let stopping = $state(false);
  let elapsed = $state("00:00");
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;

  function formatElapsed(ms: number): string {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function kebabCase(s: string): string {
    return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function timestamp(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  function buildFilename(fmt: RecordFormat, notesText: string): string {
    const ext = FORMATS.find((f) => f.id === fmt)!.ext;
    const notesPart = kebabCase(notesText);
    return notesPart ? `${timestamp()}_${notesPart}.${ext}` : `${timestamp()}.${ext}`;
  }

  // Live filename preview — recomputed on every render since it embeds the current time,
  // just so the panel isn't showing a filename that's already stale by the time Start is
  // clicked. Not reactive to the second; good enough for a preview.
  let filenamePreview = $derived(buildFilename($recordFormat, notes));

  // Re-derive the ticking display from $recordStartedAt on mount, in case the panel is
  // reopened while a recording (started from a previous mount) is still running.
  $effect(() => {
    if ($isRecording && $recordStartedAt !== null) {
      const startedAt = $recordStartedAt;
      elapsed = formatElapsed(performance.now() - startedAt);
      if (!elapsedTimer) {
        elapsedTimer = setInterval(() => {
          elapsed = formatElapsed(performance.now() - startedAt);
        }, 1000);
      }
    } else if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = undefined;
    }
  });

  onDestroy(() => {
    if (elapsedTimer) clearInterval(elapsedTimer);
  });

  async function chooseFolder() {
    let dir: string | null;
    try {
      dir = await open({ directory: true, multiple: false, defaultPath: $recordingsDir || undefined });
    } catch (e) {
      error = `Could not open folder picker: ${e}`;
      return;
    }
    if (typeof dir === "string") recordingsDir.set(dir);
  }

  async function handleStart() {
    if ($isRecording || starting) return;
    error = null;

    let path: string;
    if ($recordingsDir) {
      // One click: destination is known, so just build the path and go — no dialog.
      path = `${$recordingsDir}/${buildFilename($recordFormat, notes)}`;
    } else {
      const chosenFormat = FORMATS.find((f) => f.id === $recordFormat)!;
      let chosen: string | null;
      try {
        chosen = await save({
          title: "Record session to…",
          defaultPath: buildFilename($recordFormat, notes),
          filters: [{ name: chosenFormat.label, extensions: [chosenFormat.ext] }],
        });
      } catch (e) {
        error = `Could not open save dialog: ${e}`;
        return;
      }
      if (!chosen) return; // user cancelled
      path = chosen;
    }

    starting = true;
    try {
      await audioRecordStart(path, $recordFormat);
      recordOutputPath.set(path);
      recordStartedAt.set(performance.now());
      isRecording.set(true);
    } catch (e) {
      error = `Could not start recording: ${e}`;
    } finally {
      starting = false;
    }
  }

  async function handleStop() {
    if (!$isRecording || stopping) return;
    stopping = true;
    try {
      await audioRecordStop();
    } catch (e) {
      error = `Could not stop recording cleanly: ${e}`;
    } finally {
      isRecording.set(false);
      recordStartedAt.set(null);
      stopping = false;
    }
  }
</script>

<div class="record-panel">
  <span class="settings-title">Record</span>

  <div class="settings-row">
    <span class="row-label">Folder</span>
    {#if $recordingsDir}
      <span class="rec-path" title={$recordingsDir}>{$recordingsDir}</span>
      <button class="fmt-btn" disabled={$isRecording} onclick={chooseFolder}>Change</button>
      <button class="fmt-btn" disabled={$isRecording} onclick={() => recordingsDir.set("")}>Clear</button>
    {:else}
      <span class="rec-path rec-unset">not set — Start will prompt each time</span>
      <button class="fmt-btn" disabled={$isRecording} onclick={chooseFolder}>Choose…</button>
    {/if}
  </div>

  <div class="settings-row">
    {#each FORMATS as f}
      <button
        class="fmt-btn"
        class:fmt-active={$recordFormat === f.id}
        disabled={$isRecording || starting}
        onclick={() => recordFormat.set(f.id)}
      >{f.label}</button>
    {/each}
  </div>

  <div class="settings-row">
    <span class="row-label">Notes</span>
    <input
      class="notes-input"
      type="text"
      placeholder="e.g. garage party — used in the auto-generated filename"
      disabled={$isRecording}
      bind:value={notes}
    />
  </div>

  <div class="settings-row">
    {#if !$isRecording}
      <button class="record-btn start" disabled={starting} onclick={handleStart}>
        {starting ? "Starting…" : "● Start Recording"}
      </button>
      <span class="rec-preview" title="Auto-generated filename">{filenamePreview}</span>
    {:else}
      <button class="record-btn stop" disabled={stopping} onclick={handleStop}>
        {stopping ? "Stopping…" : "■ Stop Recording"}
      </button>
      <span class="rec-indicator">● REC</span>
      <span class="rec-elapsed">{elapsed}</span>
    {/if}
  </div>

  {#if $recordOutputPath}
    <div class="settings-row">
      <span class="row-label">File</span>
      <span class="rec-path" title={$recordOutputPath}>{$recordOutputPath}</span>
    </div>
  {/if}

  {#if error}
    <div class="settings-row">
      <span class="rec-error">{error}</span>
    </div>
  {/if}
</div>

<style>
  .record-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 20px;
    background: var(--surface);
    border-top: 2px solid #e04040;
    border-bottom: 1px solid var(--divider);
    font-size: calc(12px * var(--font-scale));
    color: var(--text);
    flex-shrink: 0;
  }

  .settings-title {
    font-family: var(--font-heading);
    font-weight: 800;
    color: #e04040;
    letter-spacing: 0.08em;
    font-size: calc(10px * var(--font-scale));
    text-transform: uppercase;
  }

  .settings-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .row-label {
    font-family: var(--font-heading);
    color: color-mix(in srgb, var(--text) 55%, transparent);
    flex-shrink: 0;
    min-width: 50px;
  }

  .fmt-btn {
    font-family: var(--font-heading);
    font-weight: 600;
    padding: 5px 10px;
    font-size: calc(11px * var(--font-scale));
    background: var(--surface2);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: color-mix(in srgb, var(--text) 55%, transparent);
    cursor: pointer;
  }

  .fmt-btn:hover:not(:disabled) {
    border-color: #e04040;
    color: #e04040;
  }

  .fmt-btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .fmt-btn.fmt-active {
    background: #e04040;
    border-color: #e04040;
    color: #fff;
  }

  .notes-input {
    flex: 1;
    min-width: 200px;
    max-width: 420px;
    font-family: var(--font-heading);
    font-size: calc(11px * var(--font-scale));
    padding: 5px 8px;
    background: var(--surface2);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text);
  }

  .notes-input:disabled {
    opacity: 0.6;
  }

  .record-btn {
    font-family: var(--font-heading);
    font-weight: 700;
    padding: 6px 14px;
    font-size: calc(11px * var(--font-scale));
    border-radius: var(--radius-sm);
    cursor: pointer;
    border: 1px solid #e04040;
  }

  .record-btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .record-btn.start {
    background: var(--surface2);
    color: #e04040;
  }

  .record-btn.start:hover:not(:disabled) {
    background: #e04040;
    color: #fff;
  }

  .record-btn.stop {
    background: #e04040;
    color: #fff;
  }

  .rec-indicator {
    color: #e04040;
    font-family: var(--font-heading);
    font-weight: 800;
    animation: rec-blink 1.2s infinite;
  }

  @keyframes rec-blink {
    0%, 50% { opacity: 1; }
    51%, 100% { opacity: 0.25; }
  }

  .rec-elapsed {
    font-variant-numeric: tabular-nums;
    color: color-mix(in srgb, var(--text) 70%, transparent);
  }

  .rec-preview,
  .rec-path {
    color: color-mix(in srgb, var(--text) 55%, transparent);
    font-size: calc(11px * var(--font-scale));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 480px;
  }

  .rec-unset {
    font-style: italic;
  }

  .rec-error {
    color: #e04040;
    font-size: calc(11px * var(--font-scale));
  }
</style>
