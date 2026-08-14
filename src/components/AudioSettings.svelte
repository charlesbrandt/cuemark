<script lang="ts">
  import { onMount } from "svelte";
  import { listAudioDevices, type AudioDevice } from "../lib/audio/pipeline";
  import { mainOutputDeviceIds, cueOutputDeviceId, tempoRange, scratchMode, jogSecondsPerRev, scrubInertiaMs, SCRUB_INERTIA_MAX_MS, networkOutputs } from "../lib/audio/audioSettings";
  import { fontScale } from "../lib/settings/displaySettings";
  import { session, setMidiMapping } from "../lib/state/session";

  let localDevices = $state<AudioDevice[]>([]);
  let error = $state("");

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
  }

  onMount(async () => {
    try {
      localDevices = await listAudioDevices();
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

  <!--
    Outside the device-enumeration {#if} on purpose: a network target must stay addable when
    there are no local sinks at all, which is exactly the machine most likely to need one.
  -->
  <div class="settings-row">
    <span class="row-label">Net</span>
    <div class="net-outputs">
      <input class="net-host" placeholder="snapcast host" bind:value={newHost} />
      <input class="net-port" placeholder="port" bind:value={newPort} />
      <input class="net-label" placeholder="label (optional)" bind:value={newLabel} />
      <button class="net-add" onclick={addNetworkOutput}>Add</button>
    </div>
  </div>
  {#if addError}
    <div class="settings-row"><span class="row-label"></span><span class="error">{addError}</span></div>
  {/if}

  {#each $networkOutputs as n (n.id)}
    <div class="settings-row">
      <span class="row-label"></span>
      <label class="device-check">
        <input
          type="checkbox"
          checked={$mainOutputDeviceIds.includes(n.id)}
          onchange={(e) => setStreaming(n.id, e.currentTarget.checked)}
        />
        Stream
      </label>
      <span class="net-chip">{n.label}</span>
      <span class="side-label">{n.id.replace("snapcast://", "")}</span>
      <label class="device-check">
        delay
        <input
          class="net-port"
          type="number"
          min="0"
          step="10"
          value={n.latencyMs ?? 0}
          oninput={(e) => setLatency(n.id, e.currentTarget.value)}
        />
        ms
      </label>
      <button class="net-remove" title="Remove {n.id}" onclick={() => removeNetworkOutput(n.id)}>✕</button>
    </div>
  {/each}

  {#if $networkOutputs.length > 0}
    <div class="settings-row">
      <span class="row-label"></span>
      <span class="hint-inline">
        delay = the server's own end-to-end buffer (Snapcast's <code>buffer</code> setting)
        plus its client delay — how late the room hears it. It only moves the video when the
        network target is <em>first</em> in Main; list the booth monitor first to keep video
        synced to the booth. Tune by ear, it applies live.
      </span>
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

  <!--
    Deliberately *outside* the vinyl-only block: the waveform drag runs the same position-mode
    scratch path and gets the same platter, whatever the jog wheel is set to. Only shuttle-mode
    jog is unaffected, and that is a jog setting rather than a scrub one.

    Tuned by ear, so the hint reports the trade in the two units it is actually made in — how
    far behind the hand the cursor sits, and whether the detent-by-detent jitter is still
    audible. See scrubInertiaMs's doc comment for the measured table behind these bands.
  -->
  <div class="settings-row">
    <span class="row-label">Platter</span>
    <input
      type="range"
      min="0"
      max={SCRUB_INERTIA_MAX_MS}
      step="5"
      bind:value={$scrubInertiaMs}
    />
    <span class="jog-scale-value">
      {$scrubInertiaMs === 0 ? "off" : `${$scrubInertiaMs}ms`}
    </span>
    <button type="button" class="font-scale-reset" onclick={() => scrubInertiaMs.set(40)}>
      Reset
    </button>
    <span class="hint-inline">
      {#if $scrubInertiaMs === 0}
        no smoothing &mdash; each MIDI detent lands as its own pitch step
      {:else}
        smooths the jog's detent steps &middot; cursor trails the hand by
        {(3 * $scrubInertiaMs + 60).toFixed(0)}ms
        {#if $scrubInertiaMs >= 70}(fluid, but sluggish to steer){/if}
      {/if}
    </span>
  </div>
  <!--
    ⚠️ Not a fader-style control: this changes how the deck *feels*, so it is meant to be
    moved while scratching. The value rides along with every scratch_to call rather than
    being pushed on change, so it takes effect mid-gesture with no extra IPC.
  -->


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
