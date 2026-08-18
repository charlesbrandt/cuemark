<script lang="ts">
  /**
   * Raw MIDI monitor — every byte arriving on the port, mapped or not.
   *
   * This is a *bench* tool for authoring controller profiles, not a performance panel.
   * It exists because the two other ways to watch MIDI here both hide the thing being
   * measured: the `[midi]` log throttles continuous controls to one line per 500ms per
   * key, and `amidi -d` cannot open the port at all while cuemark holds it (see the
   * block comment on `MONITOR` in midi.rs). Design: docs/design/controller-mapping.md §7a.
   *
   * ⚠️ Every number in the "guess" column is a **hint from what has been seen so far**,
   * never a conclusion. A fader that has only been nudged looks like an encoder; an
   * encoder that has been spun one way looks like a fader stuck at one end. Wiggle a
   * control through its whole travel before believing its row, and settle the questions
   * that matter (encoder deltas, firmware-vs-host modes) with the capture procedures in
   * docs/design/controller-mapping.md §8 — not by reading this table.
   */
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";

  interface MidiRaw {
    port: string;
    bytes: number[];
    len: number;
    t: number;
    mapped: string | null;
  }

  interface MidiPortInfo {
    name: string;
    connected: boolean;
  }

  interface ControlStat {
    key: string;
    status: number;
    d1: number;
    n: number;
    lastD2: number;
    minD2: number;
    maxD2: number;
    /** Capped — the question these answer ("does this encoder only ever send ±1?") is
        answered by the first handful of distinct values, and an uncapped set on a 14-bit
        fader would grow to 128 entries of noise. */
    values: Set<number>;
    /** Timestamps of recent messages, for a *live* rate rather than a lifetime average.
        The lifetime average of a jog wheel that was spun once ten minutes ago is ~0/s,
        which is precisely the reading that made the Rust log useless for this. */
    recentT: number[];
    mapped: string | null;
    lastT: number;
  }

  const VALUES_CAP = 24;
  const RATE_WINDOW = 32;
  /** Rows shown in the raw tail. Reading is human-speed; the capture keeps the rest. */
  const TAIL_CAP = 150;
  /** Hard cap on a saved capture, so a monitor left running overnight cannot fill a disk. */
  const CAPTURE_CAP = 20000;
  /**
   * Table refresh interval. Messages arrive at ~260/s with two jog wheels turning, and
   * writing Svelte state per message is the documented way to freeze this UI (see the
   * jog-wheel gotchas in skills/midi/SKILL.md — a sustained spin through the store froze
   * the app while GStreamer kept playing). So the listener writes into plain non-reactive
   * maps and only the flush below touches `$state`. 10Hz is far faster than anyone reads
   * a number and slower than any burst can hurt.
   */
  const FLUSH_MS = 100;

  // ── Non-reactive accumulators, written by the event listener ────────────────
  const stats = new Map<string, ControlStat>();
  let tail: MidiRaw[] = [];
  let capture: MidiRaw[] = [];
  let dropped = 0;
  let dirty = false;

  // ── Reactive view, written only by flush() ──────────────────────────────────
  let rows = $state<ControlStat[]>([]);
  let tailView = $state<MidiRaw[]>([]);
  let total = $state(0);
  let capturedCount = $state(0);
  let droppedCount = $state(0);

  let recording = $state(true);
  let ports = $state<MidiPortInfo[]>([]);
  let portError = $state("");
  let savedPath = $state("");
  let saveError = $state("");

  let unlisten: (() => void) | null = null;
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");

  function msgType(status: number): string {
    switch (status & 0xf0) {
      case 0x80: return "NoteOff";
      case 0x90: return "NoteOn";
      case 0xa0: return "Aftertch";
      case 0xb0: return "CC";
      case 0xc0: return "Program";
      case 0xd0: return "ChanPress";
      case 0xe0: return "PitchBend";
      case 0xf0: return "System";
      default:   return "?";
    }
  }

  /**
   * A shape hint, hedged on purpose. Each string below is "what this looks like from what
   * has arrived", and the wording says so — this project has been bitten more than once by
   * a plausible reading of an instrument being taken for a measurement.
   */
  function guess(s: ControlStat): string {
    const hi = s.status & 0xf0;
    if (hi === 0x90 || hi === 0x80) {
      const vals = [...s.values];
      if (vals.every((v) => v === 0 || v === 127)) return "button (0/127)";
      return "note, velocity varies";
    }
    if (hi !== 0xb0) return "";

    // 14-bit pairing: a partner 32 CCs away is the near-universal spelling. Reported as a
    // partner sighting rather than as a fact, because "+32" is a convention and a profile
    // is allowed to say otherwise (controller-mapping.md §3.3).
    const partnerHi = stats.get(`${hex2(s.status)}:${hex2(s.d1 + 32)}`);
    const partnerLo = s.d1 >= 32 ? stats.get(`${hex2(s.status)}:${hex2(s.d1 - 32)}`) : undefined;

    const vals = [...s.values];
    const smallLow = vals.filter((v) => v <= 8).length;
    const smallHigh = vals.filter((v) => v >= 120).length;
    const midRange = vals.filter((v) => v > 8 && v < 120).length;
    if (vals.length > 1 && midRange === 0 && (smallLow > 0 || smallHigh > 0)) {
      return "relative? (only near 0/127)";
    }
    if (s.maxD2 - s.minD2 > 100) {
      if (partnerHi) return `absolute, MSB? (partner CC ${s.d1 + 32})`;
      if (partnerLo) return `absolute, LSB? (partner CC ${s.d1 - 32})`;
      return "absolute (full travel seen)";
    }
    if (partnerHi) return `partner CC ${s.d1 + 32} seen`;
    if (partnerLo) return `partner CC ${s.d1 - 32} seen`;
    return "absolute, partial travel";
  }

  function rate(s: ControlStat): number {
    if (s.recentT.length < 2) return 0;
    const span = (s.recentT[s.recentT.length - 1] - s.recentT[0]) / 1000;
    return span > 0 ? (s.recentT.length - 1) / span : 0;
  }

  function record(m: MidiRaw) {
    if (!recording) return;
    total++;

    tail.push(m);
    if (tail.length > TAIL_CAP) tail = tail.slice(-TAIL_CAP);

    if (capture.length < CAPTURE_CAP) capture.push(m);
    else dropped++;

    if (m.len < 2) {
      dirty = true;
      return;
    }
    const [status, d1] = m.bytes;
    const d2 = m.len >= 3 ? m.bytes[2] : 0;
    const key = `${hex2(status)}:${hex2(d1)}`;
    let s = stats.get(key);
    if (!s) {
      s = {
        key, status, d1,
        n: 0, lastD2: d2, minD2: d2, maxD2: d2,
        values: new Set(), recentT: [], mapped: m.mapped, lastT: m.t,
      };
      stats.set(key, s);
    }
    s.n++;
    s.lastD2 = d2;
    s.minD2 = Math.min(s.minD2, d2);
    s.maxD2 = Math.max(s.maxD2, d2);
    if (s.values.size < VALUES_CAP) s.values.add(d2);
    s.recentT.push(m.t);
    if (s.recentT.length > RATE_WINDOW) s.recentT.shift();
    s.mapped = m.mapped;
    s.lastT = m.t;
    dirty = true;
  }

  function flush() {
    if (!dirty) return;
    dirty = false;
    // Most-recently-touched first: wiggle a control and its row jumps to the top, which is
    // the entire interaction model for identifying an unknown surface.
    rows = [...stats.values()].sort((a, b) => b.lastT - a.lastT);
    tailView = [...tail].reverse();
    capturedCount = capture.length;
    droppedCount = dropped;
  }

  function clear() {
    stats.clear();
    tail = [];
    capture = [];
    dropped = 0;
    total = 0;
    rows = [];
    tailView = [];
    capturedCount = 0;
    droppedCount = 0;
    savedPath = "";
    saveError = "";
  }

  async function refreshPorts() {
    portError = "";
    try {
      ports = await invoke<MidiPortInfo[]>("midi_list_ports");
    } catch (e) {
      portError = String(e);
      ports = [];
    }
  }

  async function saveCapture() {
    saveError = "";
    savedPath = "";
    if (capture.length === 0) {
      saveError = "nothing captured yet";
      return;
    }
    try {
      savedPath = await invoke<string>("midi_capture_save", {
        json: JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            port: capture[0]?.port ?? "",
            truncated: dropped > 0,
            messages: capture.map((m) => ({ t: m.t, bytes: m.bytes, len: m.len })),
          },
          null,
          1,
        ),
      });
    } catch (e) {
      saveError = String(e);
    }
  }

  onMount(async () => {
    // Mounting the panel *is* the intent to monitor — the Rust gate is off by default and
    // this is the only thing that turns it on. onDestroy turns it back off, so the raw feed
    // costs nothing whenever this panel is closed (see MONITOR's comment in midi.rs).
    await invoke("midi_monitor_set", { enabled: true });
    unlisten = await listen<MidiRaw>("midi-raw", ({ payload }) => record(payload));
    flushTimer = setInterval(flush, FLUSH_MS);
    await refreshPorts();
  });

  onDestroy(() => {
    if (flushTimer) clearInterval(flushTimer);
    unlisten?.();
    invoke("midi_monitor_set", { enabled: false }).catch(() => {});
  });
</script>

<div class="midi-monitor">
  <div class="settings-title">MIDI Monitor</div>

  <div class="settings-row">
    <button class="mm-btn" class:armed={recording} onclick={() => (recording = !recording)}>
      {recording ? "◉ Recording" : "❚❚ Paused"}
    </button>
    <button class="mm-btn" onclick={clear}>Clear</button>
    <button class="mm-btn" onclick={saveCapture}>Save capture</button>
    <button class="mm-btn" onclick={refreshPorts}>Rescan ports</button>
    <span class="side-label">{total} msgs · {rows.length} controls · {capturedCount} captured</span>
    {#if droppedCount > 0}
      <span class="mm-warn">capture full — {droppedCount} dropped</span>
    {/if}
  </div>

  {#if savedPath}
    <div class="settings-row"><span class="row-label"></span><span class="hint-inline">saved → {savedPath}</span></div>
  {/if}
  {#if saveError}
    <div class="settings-row"><span class="row-label"></span><span class="mm-warn">{saveError}</span></div>
  {/if}

  <div class="settings-row">
    <span class="row-label">Ports</span>
    {#if portError}
      <span class="mm-warn">{portError}</span>
    {:else if ports.length === 0}
      <span class="hint-inline">no MIDI input ports — is the controller plugged in?</span>
    {:else}
      {#each ports as p (p.name)}
        <span class="mm-port" class:live={p.connected}>{p.name}{p.connected ? " ●" : ""}</span>
      {/each}
    {/if}
  </div>
  <div class="settings-row">
    <span class="row-label"></span>
    <span class="hint-inline">
      ● = the port cuemark opened. A port listed without it is enumerating but unclaimed —
      cuemark connects to one port, chosen by name at startup, and does not rescan.
    </span>
  </div>

  {#if rows.length > 0}
    <div class="mm-table">
      <div class="mm-head">
        <span>ctrl</span><span>type</span><span>ch</span><span>d2</span>
        <span>range</span><span>msg/s</span><span>n</span><span>values</span>
        <span>guess</span><span>mapped to</span>
      </div>
      {#each rows as s (s.key)}
        <div class="mm-row" class:unmapped={!s.mapped}>
          <span class="mono">{s.key}</span>
          <span>{msgType(s.status)}</span>
          <span class="mono">{(s.status & 0x0f) + 1}</span>
          <span class="mono">{s.lastD2}</span>
          <span class="mono">{s.minD2}–{s.maxD2}</span>
          <span class="mono">{rate(s).toFixed(0)}</span>
          <span class="mono">{s.n}</span>
          <span class="mono vals">
            {[...s.values].sort((a, b) => a - b).join(",")}{s.values.size >= VALUES_CAP ? "…" : ""}
          </span>
          <span class="mm-guess">{guess(s)}</span>
          <span class="mono mapped">{s.mapped ?? "—"}</span>
        </div>
      {/each}
    </div>
  {:else}
    <div class="settings-row">
      <span class="row-label"></span>
      <span class="hint-inline">Move a control on the controller — every message shows up here, mapped or not.</span>
    </div>
  {/if}

  {#if tailView.length > 0}
    <div class="settings-title">Raw tail (newest first)</div>
    <div class="mm-tail">
      {#each tailView as m, i (i)}
        <div class="mono mm-tail-row" class:unmapped={!m.mapped}>
          {m.bytes.map(hex2).join(" ")}{m.len > m.bytes.length ? ` …(${m.len}B)` : ""}
          <span class="mm-tail-map">{m.mapped ?? ""}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .midi-monitor {
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
  }

  .hint-inline {
    color: color-mix(in srgb, var(--text) 40%, transparent);
    font-style: italic;
  }

  .mono {
    font-family: var(--font-mono, monospace);
    font-variant-numeric: tabular-nums;
  }

  .mm-btn {
    font-family: var(--font-body);
    font-size: calc(11px * var(--font-scale));
    background: var(--surface2);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 3px 10px;
    cursor: pointer;
  }
  .mm-btn:hover { border-color: var(--accent-deck); color: var(--accent-deck); }
  .mm-btn.armed { border-color: var(--accent-deck); color: var(--accent-deck); }

  .mm-warn { color: #ff6b6b; font-style: italic; }

  .mm-port {
    background: var(--surface2);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    padding: 2px 8px;
    font-size: calc(11px * var(--font-scale));
  }
  .mm-port.live { border-color: var(--accent-deck); color: var(--accent-deck); }

  /* Fixed column widths rather than a real table: WebKitGTK's auto table layout reflows
     on every flush here, and at 10Hz that visibly jitters the numbers being read. */
  .mm-table {
    display: flex;
    flex-direction: column;
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
  }

  .mm-head,
  .mm-row {
    display: grid;
    grid-template-columns: 64px 74px 28px 40px 62px 48px 56px 1fr 168px 1fr;
    gap: 8px;
    padding: 2px 8px;
    align-items: baseline;
  }

  .mm-head {
    position: sticky;
    top: 0;
    background: var(--surface2);
    color: color-mix(in srgb, var(--text) 55%, transparent);
    font-size: calc(10px * var(--font-scale));
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .mm-row:nth-child(even) { background: color-mix(in srgb, var(--surface2) 40%, transparent); }
  .mm-row.unmapped { color: color-mix(in srgb, var(--text) 65%, transparent); }

  .vals, .mapped, .mm-guess {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mm-guess { color: color-mix(in srgb, var(--accent-queue) 75%, transparent); font-style: italic; }
  .mapped { color: var(--accent-deck); }

  .mm-tail {
    display: flex;
    flex-direction: column;
    max-height: 150px;
    overflow-y: auto;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    padding: 4px 8px;
    font-size: calc(11px * var(--font-scale));
  }
  .mm-tail-row.unmapped { color: color-mix(in srgb, var(--text) 55%, transparent); }
  .mm-tail-map { color: var(--accent-deck); margin-left: 12px; }
</style>
