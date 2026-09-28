<script lang="ts">
  import { onMount } from "svelte";
  import { listAudioDevices, defaultAudioSink, type AudioDevice } from "../lib/audio/pipeline";
  import { mainOutputDeviceIds, cueOutputDeviceId, networkOutputs, outputAttachStatus } from "../lib/audio/audioSettings";

  let localDevices = $state<AudioDevice[]>([]);
  let error = $state("");
  let defaultSink = $state<string | null>(null);

  // "Default" and the device it currently points at are one device. Ticking both is ignored
  // by the backend (it would play the track through two streams into one DAC, heard as a
  // double), so say so here instead of leaving two ticked boxes that do not mean what they show.
  let defaultLabel = $derived(localDevices.find(d => d.id === defaultSink)?.label ?? null);
  let defaultTickedTwice = $derived(
    defaultSink !== null && $mainOutputDeviceIds.includes("") && $mainOutputDeviceIds.includes(defaultSink)
  );

  // Network targets are configured rather than enumerated, so they are merged in here — see
  // the `networkOutputs` store. They must be part of `devices` before the stale-id auto-heal
  // below, which deletes any persisted id it cannot find in this list.
  let devices = $derived<AudioDevice[]>([...localDevices, ...$networkOutputs]);

  let newHost = $state("");
  let newPort = $state("");
  let newLabel = $state("");
  let addError = $state("");

  function addNetworkOutput() {
    const host = newHost.trim();
    const port = Number(newPort.trim());
    if (!host || host.includes(":") || host.includes("/")) {
      addError = "Enter a hostname or IPv4 address (no port, no scheme)";
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      addError = "Port — Snapcast's tcp:// source listens on 4953 unless configured otherwise";
      return;
    }
    const id = `snapcast://${host}:${port}`;
    if ($networkOutputs.some(n => n.id === id) || localDevices.some(d => d.id === id)) {
      addError = "That target is already in the list";
      return;
    }
    networkOutputs.update(list => [
      ...list,
      { id, label: newLabel.trim() || `${host} (Snapcast)`, latencyMs: 0 },
    ]);
    newHost = ""; newPort = ""; newLabel = ""; addError = "";
  }

  function setLatency(id: string, raw: string) {
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms < 0) return;
    networkOutputs.update(list =>
      list.map(n => (n.id === id ? { ...n, latencyMs: Math.round(ms) } : n))
    );
  }

  /**
   * Streaming on/off for a target. This is deliberately the *same* state as the Main
   * checkbox above rather than a second flag: two independent notions of "enabled" would
   * disagree, and the disagreement would present as silence with the toggle reading on.
   */
  function setStreaming(id: string, on: boolean) {
    mainOutputDeviceIds.update(ids => {
      if (on) return ids.includes(id) ? ids : [...ids, id];
      const kept = ids.filter(x => x !== id);
      return kept.length > 0 ? kept : [""];
    });
  }

  function removeNetworkOutput(id: string) {
    networkOutputs.update(list => list.filter(n => n.id !== id));
    // Drop it from the selections too, or it stays routed with no way to un-route it: the
    // checkbox/<option> that owned it no longer renders.
    mainOutputDeviceIds.update(ids => {
      const kept = ids.filter(x => x !== id);
      return kept.length > 0 ? kept : [""];
    });
    if ($cueOutputDeviceId === id) cueOutputDeviceId.set("");
    // Otherwise a removed-then-re-added target under the same id would show a stale badge
    // from before it was ever touched this session.
    outputAttachStatus.update(m => {
      if (!(id in m)) return m;
      const { [id]: _, ...rest } = m;
      return rest;
    });
  }

  onMount(async () => {
    try {
      localDevices = await listAudioDevices();
      defaultSink = await defaultAudioSink().catch(() => null);
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
</script>

<div class="audio-settings">
  <span class="settings-title">Settings</span>

  {#if error}
    <span class="error">{error}</span>
  {:else if devices.length === 0}
    <span class="hint">No audio sinks found — is PipeWire/PulseAudio running?</span>
  {:else}
    <span class="subsection-label">Main output</span>
    <div class="settings-row">
      <div class="switch-row">
        <button
          class="switch-pill"
          class:on={$mainOutputDeviceIds.includes("")}
          aria-pressed={$mainOutputDeviceIds.includes("")}
          onclick={() => toggleMainDevice("", !$mainOutputDeviceIds.includes(""))}
        >
          Default{defaultLabel ? ` (${defaultLabel})` : ""}
        </button>
        {#each devices as d (d.id)}
          <button
            class="switch-pill"
            class:on={$mainOutputDeviceIds.includes(d.id)}
            aria-pressed={$mainOutputDeviceIds.includes(d.id)}
            onclick={() => toggleMainDevice(d.id, !$mainOutputDeviceIds.includes(d.id))}
          >
            {d.label}
          </button>
        {/each}
      </div>
    </div>

    {#if defaultTickedTwice}
      <div class="settings-row">
        <span class="error">
          "Default" is {defaultLabel ?? "the device"} — ticking both plays through it only once.
          Untick one to make that explicit.
        </span>
      </div>
    {/if}

    <span class="subsection-label">Cue</span>
    <div class="settings-row">
      <span class="row-label">🎧</span>
      <select bind:value={$cueOutputDeviceId}>
        <option value="">— none —</option>
        {#each devices as d (d.id)}
          <option value={d.id}>{d.label}</option>
        {/each}
      </select>
    </div>
    <span class="source-hint">Volume moved to the toolbar's Headphone Volume slider.</span>
  {/if}

  <!--
    Outside the device-enumeration {#if} on purpose: a network target must stay addable when
    there are no local sinks at all, which is exactly the machine most likely to need one.
  -->
  <span class="subsection-label">Network targets</span>
  <div class="settings-row">
    <div class="net-outputs">
      <input class="net-host" placeholder="snapcast host" bind:value={newHost} />
      <input class="net-port" placeholder="port" bind:value={newPort} />
      <input class="net-label" placeholder="label (optional)" bind:value={newLabel} />
      <button class="net-add" onclick={addNetworkOutput}>Add</button>
    </div>
  </div>
  {#if addError}
    <div class="settings-row"><span class="error">{addError}</span></div>
  {/if}

  {#each $networkOutputs as n (n.id)}
    <div class="net-card">
      <div class="net-card-head">
        <button
          class="switch-pill"
          class:on={$mainOutputDeviceIds.includes(n.id)}
          aria-pressed={$mainOutputDeviceIds.includes(n.id)}
          onclick={() => setStreaming(n.id, !$mainOutputDeviceIds.includes(n.id))}
        >
          Stream
        </button>
        <span class="net-chip">{n.label}</span>
        <span class="side-label">{n.id.replace("snapcast://", "")}</span>
        {#if $outputAttachStatus[n.id] && !$outputAttachStatus[n.id].ok}
          <span class="net-error" title={$outputAttachStatus[n.id].message ?? ""}>
            ⚠ not connected
          </span>
        {/if}
        <button class="net-remove" title="Remove {n.id}" onclick={() => removeNetworkOutput(n.id)}>✕</button>
      </div>
      <div class="net-card-row">
        <span class="row-label">Delay</span>
        <input
          class="net-port"
          type="number"
          min="0"
          step="10"
          value={n.latencyMs ?? 0}
          oninput={(e) => setLatency(n.id, e.currentTarget.value)}
        />
        <span class="side-label">ms</span>
      </div>
    </div>
  {/each}

  {#if $networkOutputs.length > 0}
    <span
      class="source-hint"
      title="delay = the server's own end-to-end buffer (Snapcast's buffer setting) plus its client delay — how late the room hears it. It only moves the video when the network target is first in Main; list the booth monitor first to keep video synced to the booth. Tune by ear, it applies live."
    >
      Delay compensates for Snapcast's own buffering (hover for the full rule) — list the booth monitor first in Main to keep video synced.
    </span>
  {/if}

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

  .subsection-label {
    font-family: var(--font-heading);
    font-weight: 800;
    color: color-mix(in srgb, var(--text) 55%, transparent);
    letter-spacing: 0.08em;
    font-size: calc(10px * var(--font-scale));
    text-transform: uppercase;
    margin-top: 4px;
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

  .source-hint {
    color: color-mix(in srgb, var(--text) 45%, transparent);
    font-size: calc(10px * var(--font-scale));
  }

  .error {
    color: #ff6b6b;
    font-style: italic;
  }

  .switch-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .switch-pill {
    height: 26px;
    padding: 0 12px;
    border-radius: 13px;
    font-family: var(--font-body);
    font-size: calc(11px * var(--font-scale));
    font-weight: 700;
    border: 1px solid var(--divider);
    background: transparent;
    color: color-mix(in srgb, var(--text) 55%, transparent);
    cursor: pointer;
    white-space: nowrap;
  }

  .switch-pill.on {
    border-color: var(--accent-deck);
    background: var(--accent-deck);
    color: var(--bg);
  }

  .net-outputs {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .net-chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 1px 4px;
    border: 1px solid color-mix(in srgb, var(--text) 25%, transparent);
    border-radius: 3px;
    color: var(--text);
    white-space: nowrap;
  }

  .net-error {
    padding: 1px 4px;
    border: 1px solid color-mix(in srgb, #ff6b6b 50%, transparent);
    border-radius: 3px;
    color: #ff6b6b;
    font-size: calc(10px * var(--font-scale));
    white-space: nowrap;
    cursor: help;
  }

  .net-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
  }

  .net-card-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .net-card-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .net-remove,
  .net-add {
    background: none;
    border: 1px solid color-mix(in srgb, var(--text) 25%, transparent);
    border-radius: 3px;
    color: color-mix(in srgb, var(--text) 70%, transparent);
    font: inherit;
    cursor: pointer;
  }

  .net-remove {
    border: none;
    padding: 0 2px;
    margin-left: auto;
  }

  .net-remove:hover,
  .net-add:hover {
    color: var(--text);
  }

  /* Explicit widths: these are flex children, and this project's canvas-sizing rule exists
     because WebKitGTK is unreliable about intrinsic sizing inside a flex child. */
  .net-host { width: 130px; }
  .net-port { width: 56px; }
  .net-label { width: 120px; }

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
</style>
