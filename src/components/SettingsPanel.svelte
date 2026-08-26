<script lang="ts">
  /**
   * Single Settings surface, tabbed — replaces three separate toolbar toggles
   * (Settings/MIDI/Record) that each opened their own panel. See todo.md: the goal is to
   * keep everything reachable from one place without cluttering the main nav, and to let
   * the toolbar Record button become a plain on/off toggle once these tabs are configured.
   */
  import AudioSettings from "./AudioSettings.svelte";
  import ControlsSettings from "./ControlsSettings.svelte";
  import MidiMonitor from "./MidiMonitor.svelte";
  import RecordPanel from "./RecordPanel.svelte";

  type Tab = "audio" | "controls" | "midi" | "record";
  let tab = $state<Tab>("audio");
</script>

<div class="settings-panel">
  <div class="settings-tabs">
    <button class:active={tab === "audio"} onclick={() => (tab = "audio")}>Audio</button>
    <button class:active={tab === "controls"} onclick={() => (tab = "controls")}>Controls</button>
    <button class:active={tab === "midi"} onclick={() => (tab = "midi")}>MIDI</button>
    <button class:active={tab === "record"} onclick={() => (tab = "record")}>Record</button>
  </div>

  <!-- {#if}, not CSS display:none — MidiMonitor's onMount/onDestroy is what flips the Rust
       raw-MIDI feed on and off (see its own doc comment), so switching away from the MIDI
       tab must actually unmount it or the feed keeps running with the tab hidden. -->
  {#if tab === "audio"}
    <AudioSettings />
  {:else if tab === "controls"}
    <ControlsSettings />
  {:else if tab === "midi"}
    <MidiMonitor />
  {:else}
    <RecordPanel />
  {/if}
</div>

<style>
  .settings-panel {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  .settings-tabs {
    display: flex;
    gap: 4px;
    padding: 8px 20px 0;
    background: var(--surface);
  }

  .settings-tabs button {
    font-family: var(--font-heading);
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: calc(11px * var(--font-scale));
    padding: 6px 14px;
    background: var(--surface2);
    border: 1px solid var(--divider);
    border-bottom: none;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    color: color-mix(in srgb, var(--text) 55%, transparent);
    cursor: pointer;
  }

  .settings-tabs button:hover {
    color: var(--text);
  }

  .settings-tabs button.active {
    background: var(--surface);
    color: var(--accent-deck);
    border-color: var(--accent-deck);
  }
</style>
