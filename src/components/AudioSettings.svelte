<script lang="ts">
  import { onMount } from "svelte";
  import { listAudioDevices, type AudioDevice } from "../lib/audio/pipeline";
  import { mainOutputDeviceIds, cueOutputDeviceId, tempoRange, scratchMode, jogSecondsPerRev } from "../lib/audio/audioSettings";
  import { fontScale } from "../lib/settings/displaySettings";
  import { session, setMidiMapping } from "../lib/state/session";

  let devices = $state<AudioDevice[]>([]);
  let error = $state("");

  onMount(async () => {
    try {
      devices = await listAudioDevices();
    } catch (e) {
      error = String(e);
      console.error("[AudioSettings] device enumeration failed:", e);
      return;
    }
    // Drop persisted device ids that no longer match anything in the current device
    // list — otherwise they linger forever, invisible to the checkboxes/<select> below
    // (which only render checked/selected state for ids present in `devices`), with no
    // way for the user to un-stick them short of editing localStorage directly. Confirmed
    // live 2026-08-02: a corrupted `cueOutputDeviceId` survived a full re-pick in Settings
    // because the stale value never matched any <option>, so the bound store never changed.
    const knownIds = new Set(["", ...devices.map(d => d.id)]);
    mainOutputDeviceIds.update(ids => {
      const kept = ids.filter(id => knownIds.has(id));
      if (kept.length !== ids.length) {
        console.warn("[AudioSettings] dropped stale main device id(s):", ids.filter(id => !knownIds.has(id)));
      }
      return kept.length > 0 ? kept : [""];
    });
    if (!knownIds.has($cueOutputDeviceId)) {
      console.warn("[AudioSettings] dropped stale cue device id:", $cueOutputDeviceId);
      cueOutputDeviceId.set("");
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
  <span class="settings-title">Settings</span>

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
      <span class="hint-inline">volume moved to the toolbar's Headphone Volume slider</span>
    </div>
  {/if}

  <div class="settings-row">
    <span class="row-label">Tempo</span>
    <select bind:value={$tempoRange}>
      <option value={4}>±4%</option>
      <option value={6}>±6%</option>
      <option value={8}>±8%</option>
      <option value={10}>±10%</option>
      <option value={16}>±16%</option>
      <option value={20}>±20%</option>
      <option value={50}>±50%</option>
      <option value={100}>±100%</option>
    </select>
    <span class="hint-inline">fader &amp; slider range</span>
  </div>

  <div class="settings-row">
    <span class="row-label">Jog</span>
    <select bind:value={$scratchMode}>
      <option value="shuttle">Shuttle</option>
      <option value="vinyl">Vinyl</option>
    </select>
    <span class="hint-inline">
      {$scratchMode === "vinyl" ? "slow, precise — decays to a stop" : "fast ff/rev — free-runs at speed"}
    </span>
  </div>

  {#if $scratchMode === "vinyl"}
    <!--
      A/B by ear. The faithful 1.8s/rev (33 1/3 rpm) is inaudible at the 3-8 rpm a hand
      actually uses to hunt for a beat on a small wheel — see jogSecondsPerRev's doc comment
      and docs/design/slow-jog-audio-inaudible.md §6. Both readouts are shown because the
      trade is the whole point: pitch goes up and positioning gets coarser together.
    -->
    <div class="settings-row">
      <span class="row-label">Jog scale</span>
      <input
        type="range"
        min="0.2"
        max="3.6"
        step="0.1"
        bind:value={$jogSecondsPerRev}
      />
      <span class="jog-scale-value">{$jogSecondsPerRev.toFixed(1)}s/rev</span>
      <button type="button" class="font-scale-reset" onclick={() => jogSecondsPerRev.set(1.8)}>
        Vinyl
      </button>
      <span class="hint-inline">
        1.0&times; at {(60 / $jogSecondsPerRev).toFixed(0)} rpm &middot;
        a slow 6 rpm turn &rarr; {(6 * $jogSecondsPerRev / 60).toFixed(2)}&times;
        {#if 6 * $jogSecondsPerRev / 60 < 0.35}(likely too low to hear){/if}
      </span>
    </div>
  {/if}

  <div class="settings-row">
    <span class="row-label">Display</span>
    <input
      type="range"
      min="0.8"
      max="1.5"
      step="0.05"
      bind:value={$fontScale}
    />
    <span class="font-scale-value">{Math.round($fontScale * 100)}%</span>
    <button type="button" class="font-scale-reset" onclick={() => fontScale.set(1.0)}>Reset</button>
    <span class="hint-inline">UI text size</span>
  </div>

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
    gap: 8px;
    padding: 12px 20px;
    background: var(--surface);
    border-top: 2px solid var(--accent-deck);
    border-bottom: 1px solid var(--divider);
    font-size: calc(12px * var(--font-scale));
    color: var(--text);
    flex-shrink: 0;
  }

  .settings-title {
    font-family: var(--font-heading);
    font-weight: 800;
    color: var(--accent-deck);
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
    min-width: 32px;
  }

  .side-label {
    color: color-mix(in srgb, var(--text) 45%, transparent);
    font-size: calc(10px * var(--font-scale));
    flex-shrink: 0;
  }

  .hint {
    color: color-mix(in srgb, var(--accent-queue) 70%, transparent);
    font-style: italic;
  }

  .hint-inline {
    color: color-mix(in srgb, var(--text) 40%, transparent);
    font-style: italic;
  }

  .error {
    color: #ff6b6b;
    font-style: italic;
  }

  .device-checks {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  .device-check {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--text);
    cursor: pointer;
    white-space: nowrap;
  }

  .device-check input[type="checkbox"] {
    accent-color: var(--accent-deck);
    cursor: pointer;
  }

  select {
    font-family: var(--font-body);
    background-color: var(--surface2);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: calc(12px * var(--font-scale));
    padding: 5px 24px 5px 8px;
    cursor: pointer;
    max-width: 220px;
  }

  select:focus {
    outline: none;
    border-color: var(--accent-deck);
  }

  .font-scale-value {
    color: var(--text);
    font-variant-numeric: tabular-nums;
    min-width: 34px;
  }

  .jog-scale-value {
    color: var(--text);
    font-variant-numeric: tabular-nums;
    min-width: 58px;
  }

  .font-scale-reset {
    font-family: var(--font-body);
    font-size: calc(11px * var(--font-scale));
    background: var(--surface2);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 3px 8px;
    cursor: pointer;
  }
  .font-scale-reset:hover {
    border-color: var(--accent-deck);
    color: var(--accent-deck);
  }

</style>
