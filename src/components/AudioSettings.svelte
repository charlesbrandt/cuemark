<script lang="ts">
  import { onMount } from "svelte";
  import { listAudioDevices, type AudioDevice } from "../lib/audio/pipeline";
  import { mainOutputDeviceId, cueOutputDeviceId, cueGain } from "../lib/audio/audioSettings";

  let { onMainDeviceChange }: { onMainDeviceChange: (deviceId: string) => void } = $props();

  let devices = $state<AudioDevice[]>([]);
  let error = $state("");

  onMount(async () => {
    try {
      devices = await listAudioDevices();
    } catch (e) {
      error = String(e);
      console.error("[AudioSettings] device enumeration failed:", e);
    }
  });
</script>

<div class="audio-settings">
  <span class="settings-title">Audio Output</span>

  {#if error}
    <span class="error">{error}</span>
  {:else if devices.length === 0}
    <span class="hint">No audio sinks found — is PipeWire/PulseAudio running?</span>
  {:else}
    <label class="device-label">
      Main
      <select
        bind:value={$mainOutputDeviceId}
        onchange={() => onMainDeviceChange($mainOutputDeviceId)}
      >
        <option value="">Default</option>
        {#each devices as d (d.id)}
          <option value={d.id}>{d.label}</option>
        {/each}
      </select>
    </label>

    <label class="device-label">
      Headphones
      <select bind:value={$cueOutputDeviceId}>
        <option value="">— none —</option>
        {#each devices as d (d.id)}
          <option value={d.id}>{d.label}</option>
        {/each}
      </select>
    </label>

    {#if $cueOutputDeviceId}
      <label class="device-label">
        Cue vol
        <input type="range" min="0" max="1" step="0.01" bind:value={$cueGain} />
        <span class="gain-val">{$cueGain.toFixed(2)}</span>
      </label>
    {/if}
  {/if}
</div>

<style>
  .audio-settings {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    background: #161616;
    border-top: 2px solid #f5a623;
    border-bottom: 1px solid #2a2a2a;
    font-size: 11px;
    color: #999;
    flex-shrink: 0;
  }

  .settings-title {
    color: #f5a623;
    letter-spacing: 0.08em;
    font-size: 10px;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .hint {
    color: #887755;
    font-style: italic;
  }

  .error {
    color: #cc5555;
    font-style: italic;
  }

  .device-label {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #888;
  }

  select {
    background: #1a1a1a;
    border: 1px solid #2e2e2e;
    border-radius: 3px;
    color: #999;
    font: inherit;
    font-size: 11px;
    padding: 2px 4px;
    cursor: pointer;
    max-width: 200px;
  }

  select:focus {
    outline: none;
    border-color: #444;
  }

  .gain-val {
    min-width: 28px;
    color: #777;
    font-variant-numeric: tabular-nums;
  }
</style>
