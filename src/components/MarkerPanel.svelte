<script lang="ts">
  /**
   * Per-deck marker / mix-zone management — phase 6 of docs/design/auto-dj-transitions.md
   * (2026-08-30). Occupies the space the opacity/volume/rate sliders used to hold by
   * default (`Session.compactControls` now defaults to hiding those; this panel is always
   * shown), because the points listed here are the ones that are *hard* to reach: hot cues
   * already have their own always-visible row, while the intro/outro zones Auto DJ mixes
   * on could previously only be adjusted by leaving cuemark for Digger's web UI mid-mix —
   * the exact friction the DJ reported while workshopping.
   *
   * Rows are deliberately uniform (label · time · set-to-playhead · clear) rather than
   * bespoke per marker type: the whole point is one place with one grammar.
   *
   * ⚠️ Intro/Outro write back to Digger through `setMixMarker`, which DELETES every
   * existing marker of that type before inserting — read that function's comment in
   * api.ts before changing it. Digger resolves mix_in/mix_out as "first marker of the type
   * by position_ms", so an appended manual marker later in the track silently loses to the
   * auto-derived one, which is why phase 4 declined to ship a SET OUTRO button at all.
   */
  import type { Deck } from "../lib/state/types";
  import { updateDeck } from "../lib/state/session";
  import { getDeckTime, quantizeToGrid } from "../lib/renderer/seekBus";
  import { setMixMarker, clearMixMarker, pushMarker } from "../lib/digger/api";
  import { previewTransition } from "../lib/digger/autoMix";
  import { showToast } from "../lib/ui/toast";
  import { debugLog } from "../lib/debugLog";

  let { deck }: { deck: Deck } = $props();

  const duration = $derived(deck.source?.type === "video" ? deck.source.duration : 0);
  // Busy state is per-row, not global: a slow Digger round-trip on the outro row must not
  // grey out the intro row (or the preview button, which touches no network at all).
  let busy = $state<Record<string, boolean>>({});

  function fmt(s: number | null): string {
    if (s === null || !isFinite(s)) return "—";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  }

  /** The playhead, snapped by the global SNAP rule — same treatment every other
   *  point-setting control in DeckCard uses, so a mix point lands on the grid too. */
  function playhead(): number | null {
    const t = getDeckTime(deck.id);
    return t === null ? null : quantizeToGrid(deck.id, t);
  }

  async function withBusy(key: string, fn: () => Promise<void>) {
    busy = { ...busy, [key]: true };
    try {
      await fn();
    } catch (e) {
      debugLog(`[markers] deck-${deck.id} ${key} failed: ${e}`);
      showToast(`Couldn't save the ${key} marker: ${e}`, "warning");
    } finally {
      busy = { ...busy, [key]: false };
    }
  }

  function setMix(type: "mix_in" | "mix_out") {
    const t = playhead();
    if (t === null) return;
    const field = type === "mix_in" ? "introPoint" : "outroPoint";
    // Local first, Digger second: the deck must reflect the DJ's edit immediately (the
    // waveform zone shading and the next transition's duration both read the deck, not
    // Digger), and a Digger write is best-effort — a local file has no track id at all.
    updateDeck(deck.id, { [field]: t });
    debugLog(`[markers] deck-${deck.id} ${type} set to ${t.toFixed(2)}s (digger track ${deck.diggerTrackId ?? "none"})`);
    if (deck.diggerTrackId === null) return;
    const trackId = deck.diggerTrackId;
    withBusy(type, () => setMixMarker(trackId, type, t));
  }

  function clearMix(type: "mix_in" | "mix_out") {
    const field = type === "mix_in" ? "introPoint" : "outroPoint";
    updateDeck(deck.id, { [field]: null });
    debugLog(`[markers] deck-${deck.id} ${type} cleared`);
    if (deck.diggerTrackId === null) return;
    const trackId = deck.diggerTrackId;
    withBusy(type, () => clearMixMarker(trackId, type));
  }

  function setCue() {
    const t = playhead();
    if (t === null) return;
    updateDeck(deck.id, { cuePoint: t });
    if (deck.diggerTrackId !== null) {
      pushMarker(deck.diggerTrackId, Math.round(t * 1000), "cue").catch((e) => debugLog(`[markers] cue push failed: ${e}`));
    }
  }

  // Zone lengths, shown next to the times because the *length* is what Auto DJ actually
  // uses (computeTransitionDurationMs in autoMix.ts takes the shorter of the two), and a
  // bare timestamp doesn't tell a DJ whether a blend will be long or short.
  const introZone = $derived(deck.introPoint);
  const outroZone = $derived(deck.outroPoint !== null && duration > 0 ? duration - deck.outroPoint : null);
</script>

<div class="marker-panel">
  <div class="mp-head">
    <span class="mp-title">Mix points</span>
    <button
      class="mp-preview"
      onclick={() => previewTransition(deck.id)}
      disabled={!deck.source}
      title="Preview the auto transition out of this deck now — seeks to the trigger point and runs the real crossfade (nothing is consumed; the deck stays loaded)"
    >▶ Preview</button>
  </div>

  <div class="mp-row">
    <span class="mp-label">Cue</span>
    <span class="mp-time">{fmt(deck.cuePoint)}</span>
    <span class="mp-zone"></span>
    <button class="mp-btn" onclick={setCue} disabled={!deck.source} title="Set cue at the playhead">⦿</button>
    <button class="mp-btn" onclick={() => updateDeck(deck.id, { cuePoint: 0 })} disabled={deck.cuePoint === 0} title="Reset cue to the track start">✕</button>
  </div>

  <div class="mp-row">
    <span class="mp-label" title="Where this track becomes blendable — the incoming half of an auto transition">Intro</span>
    <span class="mp-time">{fmt(deck.introPoint)}</span>
    <span class="mp-zone">{introZone !== null ? `${introZone.toFixed(1)}s zone` : ""}</span>
    <button class="mp-btn" onclick={() => setMix("mix_in")} disabled={!deck.source || busy["mix_in"]} title="Set the intro/mix-in point at the playhead (saved to Digger)">⦿</button>
    <button class="mp-btn" onclick={() => clearMix("mix_in")} disabled={deck.introPoint === null || busy["mix_in"]} title="Clear the intro point (removes it in Digger too)">✕</button>
  </div>

  <div class="mp-row">
    <span class="mp-label" title="Where this track's outro starts — the outgoing half of an auto transition, and what the near-end trigger measures from">Outro</span>
    <span class="mp-time">{fmt(deck.outroPoint)}</span>
    <span class="mp-zone">{outroZone !== null ? `${outroZone.toFixed(1)}s zone` : ""}</span>
    <button class="mp-btn" onclick={() => setMix("mix_out")} disabled={!deck.source || busy["mix_out"]} title="Set the outro/mix-out point at the playhead (saved to Digger)">⦿</button>
    <button class="mp-btn" onclick={() => clearMix("mix_out")} disabled={deck.outroPoint === null || busy["mix_out"]} title="Clear the outro point (removes it in Digger too)">✕</button>
  </div>

  <div class="mp-row">
    <span class="mp-label">Loop</span>
    <span class="mp-time">{fmt(deck.loopIn)} – {fmt(deck.loopOut)}</span>
    <span class="mp-zone"></span>
    <button
      class="mp-btn"
      onclick={() => { const t = playhead(); if (t !== null) updateDeck(deck.id, deck.loopIn === null || t <= deck.loopIn ? { loopIn: t } : { loopOut: t }); }}
      disabled={!deck.source}
      title="Set loop in at the playhead — again past it sets loop out"
    >⦿</button>
    <button class="mp-btn" onclick={() => updateDeck(deck.id, { loopIn: null, loopOut: null, loop: false })} disabled={deck.loopIn === null && deck.loopOut === null} title="Clear the loop region">✕</button>
  </div>

  {#if deck.source && deck.diggerTrackId === null}
    <span class="mp-hint">local file — mix points stay in this session only</span>
  {/if}
</div>

<style>
  .marker-panel {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 6px;
    background: var(--surface2);
    border-radius: var(--radius-sm);
    font-size: calc(10px * var(--font-scale));
  }

  .mp-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .mp-title {
    font-family: var(--font-heading);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--text) 55%, transparent);
  }

  .mp-preview {
    font-family: var(--font-body);
    font-size: calc(10px * var(--font-scale));
    background: var(--surface);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 2px 6px;
    cursor: pointer;
  }
  .mp-preview:hover:not(:disabled) {
    border-color: var(--accent-deck);
    color: var(--accent-deck);
  }
  .mp-preview:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .mp-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .mp-label {
    min-width: 34px;
    color: color-mix(in srgb, var(--text) 60%, transparent);
  }

  .mp-time {
    font-variant-numeric: tabular-nums;
    color: var(--text);
    min-width: 74px;
  }

  .mp-zone {
    flex: 1;
    font-variant-numeric: tabular-nums;
    color: color-mix(in srgb, var(--text) 40%, transparent);
    font-style: italic;
  }

  .mp-btn {
    font-family: var(--font-body);
    font-size: calc(10px * var(--font-scale));
    background: var(--surface);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 1px 5px;
    cursor: pointer;
  }
  .mp-btn:hover:not(:disabled) {
    border-color: var(--accent-deck);
    color: var(--accent-deck);
  }
  .mp-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .mp-hint {
    color: color-mix(in srgb, var(--text) 35%, transparent);
    font-style: italic;
  }
</style>
