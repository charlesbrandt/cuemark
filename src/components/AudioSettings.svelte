<script lang="ts">
  import { onMount } from "svelte";
  import { listAudioDevices, type AudioDevice } from "../lib/audio/pipeline";
  import { mainOutputDeviceIds, cueOutputDeviceId, cueGain } from "../lib/audio/audioSettings";

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

  function toggleMainDevice(id: string, checked: boolean) {
    mainOutputDeviceIds.update(ids =>
      checked ? [...ids, id] : ids.filter(x => x !== id)
    );
  }
</script>

<div class="audio-settings">
  <span class="settings-title">Audio Output</span>

  {#if error}
    <span class="error">{error}</span>
  {:else if devices.length === 0}
    <span class="hint">No audio sinks found — is PipeWire/PulseAudio running?</span>
  {:else}
    <div class="device-group">
      <span class="group-label">Main</span>
      <div class="device-checks">
        <label class="device-check">
          <input
            type="checkbox"
            checked={$mainOutputDeviceIds.includes("")}
            onchange={(e) => toggleMainDevice("", e.currentTarget.checked)}
          />
          Default
        </label>
        {#each devices as d (d.id)}
          <label class="device-check">
            <input
              type="checkbox"
              checked={$mainOutputDeviceIds.includes(d.id)}
              onchange={(e) => toggleMainDevice(d.id, e.currentTarget.checked)}
            />
            {d.label}
          </label>
        {/each}
      </div>
    </div>

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

  .device-group {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .group-label {
    color: #888;
    flex-shrink: 0;
  }

  .device-checks {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .device-check {
    display: flex;
    align-items: center;
    gap: 3px;
    color: #999;
    cursor: pointer;
    white-space: nowrap;
  }

  .device-check input[type="checkbox"] {
    accent-color: #f5a623;
    cursor: pointer;
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
