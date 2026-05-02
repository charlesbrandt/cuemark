<script lang="ts">
  import { onMount } from "svelte";
  import { listAudioOutputs, sinkIdSupported, type AudioOutputDevice } from "../lib/audio/devices";
  import { mainOutputDeviceId, cueOutputDeviceId, cueGain } from "../lib/audio/audioSettings";

  let { onMainDeviceChange }: { onMainDeviceChange: (deviceId: string) => void } = $props();

  let devices = $state<AudioOutputDevice[]>([]);
  const supported = sinkIdSupported();

  onMount(async () => {
    devices = await listAudioOutputs();
  });
</script>

<div class="audio-settings">
  <span class="settings-title">Audio Output</span>

  {#if !supported}
    <span class="unsupported">Output selection unavailable in this runtime — use the system audio mixer.</span>
  {:else}
    <label class="device-label">
      Main
      <select
        bind:value={$mainOutputDeviceId}
        onchange={() => onMainDeviceChange($mainOutputDeviceId)}
      >
        <option value="">Default</option>
        {#each devices as d (d.deviceId)}
          <option value={d.deviceId}>{d.label}</option>
        {/each}
      </select>
    </label>

    <label class="device-label">
      Headphones
      <select bind:value={$cueOutputDeviceId}>
        <option value="">— none —</option>
        {#each devices as d (d.deviceId)}
          <option value={d.deviceId}>{d.label}</option>
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
    padding: 6px 16px;
    background: #0f0f0f;
    border-bottom: 1px solid #1e1e1e;
    font-size: 11px;
    color: #666;
    flex-shrink: 0;
  }

  .settings-title {
    color: #444;
    letter-spacing: 0.08em;
    font-size: 10px;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .unsupported {
    color: #554444;
    font-style: italic;
  }

  .device-label {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #555;
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
