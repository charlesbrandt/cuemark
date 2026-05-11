<script lang="ts">
  import { onMount } from "svelte";
  import { listAudioDevices, type AudioDevice } from "../lib/audio/pipeline";
  import { mainOutputDeviceIds, cueOutputDeviceId, cueGain } from "../lib/audio/audioSettings";
  import { session, setMidiMapping } from "../lib/state/session";

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

  let midiMapping = $derived($session.midiMapping);
  let decks = $derived($session.decks);
</script>

<div class="audio-settings">
  <span class="settings-title">Audio Output</span>

  {#if error}
    <span class="error">{error}</span>
  {:else if devices.length === 0}
    <span class="hint">No audio sinks found — is PipeWire/PulseAudio running?</span>
  {:else}
    <div class="settings-row">
      <span class="row-label">Main</span>
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

    <div class="settings-row">
      <span class="row-label">🎧</span>
      <select bind:value={$cueOutputDeviceId}>
        <option value="">— none —</option>
        {#each devices as d (d.id)}
          <option value={d.id}>{d.label}</option>
        {/each}
      </select>
      {#if $cueOutputDeviceId}
        <span class="row-label" style="margin-left:8px">Vol</span>
        <input type="range" min="0" max="1" step="0.01" bind:value={$cueGain} />
        <span class="gain-val">{$cueGain.toFixed(2)}</span>
      {/if}
    </div>
  {/if}

  <div class="settings-row">
    <span class="row-label">MIDI</span>
    <span class="side-label">L</span>
    <select
      value={midiMapping.left}
      onchange={(e) => setMidiMapping(e.currentTarget.value, midiMapping.right)}
    >
      {#each decks as d (d.id)}
        <option value={d.id}>{d.id}</option>
      {/each}
    </select>
    <span class="side-label" style="margin-left:8px">R</span>
    <select
      value={midiMapping.right}
      onchange={(e) => setMidiMapping(midiMapping.left, e.currentTarget.value)}
    >
      {#each decks as d (d.id)}
        <option value={d.id}>{d.id}</option>
      {/each}
    </select>
  </div>
</div>

<style>
  .audio-settings {
    display: flex;
    flex-direction: column;
    gap: 6px;
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
  }

  .settings-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .row-label {
    color: #888;
    flex-shrink: 0;
    min-width: 32px;
  }

  .side-label {
    color: #666;
    font-size: 10px;
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

  select {
    background: #1a1a1a;
    border: 1px solid #2e2e2e;
    border-radius: 3px;
    color: #999;
    font: inherit;
    font-size: 11px;
    padding: 2px 4px;
    cursor: pointer;
    max-width: 220px;
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
