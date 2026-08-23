<script lang="ts">
  import { onDestroy } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import {
    recordFormat, isRecording, recordOutputPath, recordStartedAt, recordingsDir, recordError,
  } from "../lib/audio/recordState";
  import { RECORD_FORMATS as FORMATS, buildRecordFilename, startRecording, stopRecording } from "../lib/audio/recordControl";

  let notes = $state("");
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

  // Live filename preview — recomputed on every render since it embeds the current time,
  // just so the panel isn't showing a filename that's already stale by the time Start is
  // clicked. Not reactive to the second; good enough for a preview.
  let filenamePreview = $derived(buildRecordFilename($recordFormat, notes));

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
      recordError.set(`Could not open folder picker: ${e}`);
      return;
    }
    if (typeof dir === "string") recordingsDir.set(dir);
  }

  async function handleStart() {
    if ($isRecording || starting) return;
    starting = true;
    try {
      await startRecording(notes);
    } finally {
      starting = false;
    }
  }

  async function handleStop() {
    if (!$isRecording || stopping) return;
    stopping = true;
    try {
      await stopRecording();
    } finally {
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

  {#if $recordError}
    <div class="settings-row">
      <span class="rec-error">{$recordError}</span>
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
