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
   * Rows are deliberately uniform (label · time · zone-figure · set-to-playhead · clear)
   * rather than bespoke per marker type: the whole point is one place with one grammar.
   * Since the four-point mix-zone vocabulary (2026-09-20, docs/design/mix-zones.md), each
   * zone is two rows — start and end — rather than doubling the button pair onto one row,
   * so this grammar covers all eight mix-point buttons with no special case.
   *
   * ⚠️ All four mix points write back to Digger through `setMixMarker`, which DELETES
   * every existing marker of that type before inserting — read that function's comment in
   * api.ts before changing it. Digger resolves each of the four mix-marker types as "first
   * marker of the type by position_ms", so an appended manual marker later in the track
   * silently loses to the auto-derived one, which is why phase 4 declined to ship a SET
   * OUTRO button at all.
   */
  import type { Deck } from "../lib/state/types";
  import { updateDeck } from "../lib/state/session";
  import { getDeckTime, quantizeToGrid } from "../lib/renderer/seekBus";
  import { setMixMarker, clearMixMarker, pushMarker, type MixMarkerType } from "../lib/digger/api";
  import { previewTransition, effectiveZones } from "../lib/digger/autoMix";
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

  // Which Deck field each of the four marker types writes to.
  const FIELD = {
    mix_in_start: "mixInStart",
    mix_in_end: "mixInEnd",
    mix_out_start: "mixOutStart",
    mix_out_end: "mixOutEnd",
  } as const satisfies Record<MixMarkerType, keyof Deck>;

  // A start's paired end, for the orphan rule in clearMix — null for the two end types,
  // which have no further pairing of their own.
  const PAIRED_END = {
    mix_in_start: "mix_in_end",
    mix_out_start: "mix_out_end",
    mix_in_end: null,
    mix_out_end: null,
  } as const satisfies Record<MixMarkerType, MixMarkerType | null>;

  function setMix(type: MixMarkerType) {
    const t = playhead();
    if (t === null) return;
    // Local first, Digger second: the deck must reflect the DJ's edit immediately (the
    // waveform zone shading and the next transition's duration both read the deck, not
    // Digger), and a Digger write is best-effort — a local file has no track id at all.
    updateDeck(deck.id, { [FIELD[type]]: t });
    debugLog(`[markers] deck-${deck.id} ${type} set to ${t.toFixed(2)}s (digger track ${deck.diggerTrackId ?? "none"})`);
    if (deck.diggerTrackId === null) return;
    const trackId = deck.diggerTrackId;
    withBusy(type, () => setMixMarker(trackId, type, t));
  }

  function clearMix(type: MixMarkerType) {
    // Clearing a zone's START also clears its END: `effectiveZones` already refuses to
    // trust an end with no start (it requires `inStart`/`outStart` before it will even
    // look at the end field), so leaving the end behind is a value that's already inert
    // to the engine but would silently reappear the moment a new start is set — the DJ
    // would have to separately notice and re-clear it. Clearing both is the simplest rule
    // that avoids surprising them twice.
    const pairedEnd = PAIRED_END[type];
    const patch: Partial<Deck> = { [FIELD[type]]: null };
    if (pairedEnd !== null) patch[FIELD[pairedEnd]] = null;
    updateDeck(deck.id, patch);
    debugLog(`[markers] deck-${deck.id} ${type} cleared${pairedEnd !== null ? " (zone end cleared too)" : ""}`);
    if (deck.diggerTrackId === null) return;
    const trackId = deck.diggerTrackId;
    withBusy(type, async () => {
      await clearMixMarker(trackId, type);
      if (pairedEnd !== null) await clearMixMarker(trackId, pairedEnd);
    });
  }

  function setCue() {
    const t = playhead();
    if (t === null) return;
    updateDeck(deck.id, { cuePoint: t });
    if (deck.diggerTrackId !== null) {
      pushMarker(deck.diggerTrackId, Math.round(t * 1000), "cue").catch((e) => debugLog(`[markers] cue push failed: ${e}`));
    }
  }

  // Zone figures come from the engine's own resolver (autoMix.ts's `effectiveZones`), not
  // raw `mixInEnd - mixInStart` / `mixOutEnd - mixOutStart`: a sub-2s zone, an outro inside
  // the first third or an intro past it is DISCARDED by the engine, and printing the raw
  // number for one made the panel claim a zone the transition would never use. This is the
  // one resolver both `transitionPlan` and this panel read, so they cannot disagree about
  // which markers count.
  const zones = $derived(effectiveZones({
    duration,
    mixInStart: deck.mixInStart,
    mixInEnd: deck.mixInEnd,
    mixOutStart: deck.mixOutStart,
    mixOutEnd: deck.mixOutEnd,
  }));

  // Shown on each zone's START row (the END row's figure column stays blank, like Cue/Loop):
  // the usable length when there is one, else the engine's own rejection reason, else
  // nothing at all when no marker is placed — `inRejected`/`outRejected` are null in both
  // the "usable" and "no marker" cases, so this single expression covers all three states.
  const inZoneText = $derived(zones.inLenSec !== null ? `${zones.inLenSec.toFixed(1)}s zone` : zones.inRejected ?? "");
  const outZoneText = $derived(zones.outLenSec !== null ? `${zones.outLenSec.toFixed(1)}s zone` : zones.outRejected ?? "");
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

  <!-- Each zone gets two rows (start, end) rather than doubling up the button pair on one
       row: the row grammar (label · time · zone-figure · ⦿ · ✕) then stays identical for
       every row in the panel, including these, instead of growing a special case just for
       the four-point rows. The zone figure is shown once, on the start row. -->
  <div class="mp-row">
    <span class="mp-label" title="Where this track becomes blendable — the incoming half of an auto transition">In start</span>
    <span class="mp-time">{fmt(deck.mixInStart)}</span>
    <span class="mp-zone">{inZoneText}</span>
    <button class="mp-btn" onclick={() => setMix("mix_in_start")} disabled={!deck.source || busy["mix_in_start"]} title="Set the mix-in start at the playhead (saved to Digger)">⦿</button>
    <button class="mp-btn" onclick={() => clearMix("mix_in_start")} disabled={deck.mixInStart === null || busy["mix_in_start"]} title="Clear the mix-in start (and its end, so the zone can't orphan half-placed — removes both in Digger too)">✕</button>
  </div>

  <div class="mp-row">
    <span class="mp-label" title="Where the mix-in zone ends — no fallback, unlike the outro's">In end</span>
    <span class="mp-time">{fmt(deck.mixInEnd)}</span>
    <span class="mp-zone"></span>
    <button class="mp-btn" onclick={() => setMix("mix_in_end")} disabled={!deck.source || busy["mix_in_end"]} title="Set the mix-in end at the playhead (saved to Digger)">⦿</button>
    <button class="mp-btn" onclick={() => clearMix("mix_in_end")} disabled={deck.mixInEnd === null || busy["mix_in_end"]} title="Clear the mix-in end (removes it in Digger too)">✕</button>
  </div>

  <div class="mp-row">
    <span class="mp-label" title="Where this track's outro starts — the outgoing half of an auto transition, and what the near-end trigger measures from">Out start</span>
    <span class="mp-time">{fmt(deck.mixOutStart)}</span>
    <span class="mp-zone">{outZoneText}</span>
    <button class="mp-btn" onclick={() => setMix("mix_out_start")} disabled={!deck.source || busy["mix_out_start"]} title="Set the mix-out start at the playhead (saved to Digger)">⦿</button>
    <button class="mp-btn" onclick={() => clearMix("mix_out_start")} disabled={deck.mixOutStart === null || busy["mix_out_start"]} title="Clear the mix-out start (and its end, so the zone can't orphan half-placed — removes both in Digger too)">✕</button>
  </div>

  <div class="mp-row">
    <span class="mp-label" title="Where the mix-out zone ends — no marker here means the track's own end">Out end</span>
    <span class="mp-time">{fmt(deck.mixOutEnd)}</span>
    <span class="mp-zone"></span>
    <button class="mp-btn" onclick={() => setMix("mix_out_end")} disabled={!deck.source || busy["mix_out_end"]} title="Set the mix-out end at the playhead (saved to Digger)">⦿</button>
    <button class="mp-btn" onclick={() => clearMix("mix_out_end")} disabled={deck.mixOutEnd === null || busy["mix_out_end"]} title="Clear the mix-out end (removes it in Digger too)">✕</button>
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
    /* Widened from 34px for "In start"/"Out start" (the four-point mix rows) — keeps the
       time/zone/button columns aligned across every row instead of just the short labels. */
    min-width: 54px;
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
