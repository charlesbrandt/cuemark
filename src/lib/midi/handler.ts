import { listen } from "@tauri-apps/api/event";
import { updateDeck, getDeck, setCrossfader, setMasterVolume, session } from "../state/session";
import { seekDeck, getDeckTime, quantizeToGrid } from "../renderer/seekBus";
import { nudgePhaseToMaster } from "../audio/phaseNudge";
import { syncRate, syncGain, syncVolume } from "../audio/audioSync";
import { audioScratch, audioStopScratch } from "../audio/pipeline";
import { cueGain, tempoRange } from "../audio/audioSettings";
import { get } from "svelte/store";

// Buffers the latest deck patch for continuous MIDI controls (rate, gain, volume)
// and flushes them once per rAF. This decouples the audio path (immediate, via syncRate/…)
// from the Svelte store update (display only — capped at 60fps to prevent 200 reactive
// re-renders/sec from saturating the JS thread and lagging the UI).
const _pendingPatches = new Map<string, Record<string, unknown>>();
let _patchFlushPending = false;

function queueDeckPatch(deckId: string, patch: Record<string, unknown>) {
  const existing = _pendingPatches.get(deckId) ?? {};
  _pendingPatches.set(deckId, { ...existing, ...patch });
  if (!_patchFlushPending) {
    _patchFlushPending = true;
    requestAnimationFrame(() => {
      _patchFlushPending = false;
      for (const [id, p] of _pendingPatches) {
        updateDeck(id, p as Parameters<typeof updateDeck>[1]);
      }
      _pendingPatches.clear();
    });
  }
}

// Same pattern for crossfader — setCrossfader() updates both deck volumes/opacities,
// which is expensive at 200/sec. Audio volume is synced directly; UI updates at rAF rate.
let _pendingCrossfader: number | undefined;
let _crossfaderFlushPending = false;

function queueCrossfader(value: number) {
  _pendingCrossfader = value;
  if (!_crossfaderFlushPending) {
    _crossfaderFlushPending = true;
    requestAnimationFrame(() => {
      _crossfaderFlushPending = false;
      if (_pendingCrossfader !== undefined) {
        setCrossfader(_pendingCrossfader);
        _pendingCrossfader = undefined;
      }
    });
  }
}

// Must match the Rust MidiAction enum (snake_case tag + camelCase fields from serde)
export interface MidiAction {
  type:
    | "deck_play_toggle"
    | "deck_opacity"
    | "deck_gain"
    | "deck_volume"
    | "deck_playback_rate"
    | "jog_nudge"
    | "crossfader"
    | "master_volume"
    | "cue_gain"
    | "cue_jump"
    | "hot_cue"
    | "hot_cue_set"
    | "loop_toggle"
    | "sync_toggle"
    | "headphone_cue"
    | "phase_nudge";
  deck_id?: string;
  value?: number;
  index?: number;
}

// Remap a MIDI-side deck ID ("deck-0"/"deck-1") to the configured software deck.
// The Rust map hardcodes "deck-0" for the left controller channel and "deck-1" for
// the right; midiMapping lets the user reassign without touching the Rust map.
function midiDeckId(hardcoded: string | undefined): string | undefined {
  if (!hardcoded) return hardcoded;
  const m = get(session).midiMapping;
  if (hardcoded === "deck-0") return m.left;
  if (hardcoded === "deck-1") return m.right;
  return hardcoded;
}

// Per-deck jog state: saves the rate that was active before jog started so it can be restored.
const jogBaseRate: Record<string, number> = {};
const jogTimers: Record<string, ReturnType<typeof setTimeout>> = {};

// Paused-deck jog scratch: true bidirectional audio scratch (segment-rate seek — pitch
// bends with speed/direction, like real vinyl) rather than a silent position-only scrub.
// See docs/design/jog-scratch-audio.md. Rate is derived from tick *velocity* (ticks per
// second over a short rolling window), not just the raw ±1 per-tick value, so a fast spin
// scratches faster than a slow one — a single tick's timing is too noisy to use directly.
const SCRATCH_TICK_WINDOW_MS = 120;
const SCRATCH_RATE_PER_TICK_PER_SEC = 0.35;
// GStreamer can't play a segment at rate≈0 (divide-by-zero in the segment math), so the
// magnitude floor keeps scratch audio always moving even when the wheel is barely turning.
const SCRATCH_MIN_RATE = 0.15;
// Fast-spin cap, comfortably inside soundtouch's own 0.1–4.0 range used elsewhere.
const SCRATCH_MAX_RATE = 3.0;
// Matches jogTimers' idle-reset window for the playing-branch nudge below.
const SCRATCH_IDLE_MS = 150;

const scratchTicks: Record<string, { t: number; value: number }[]> = {};
const scratchIdleTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const scratchActive = new Set<string>();

// Coalesces rapid jog ticks into one audioScratch() call per rendered frame. Each call is
// a real GStreamer FLUSH seek (there's no property to just "update the rate" for reverse
// playback — only a seek can change a running segment's rate), so it needs the same
// per-frame throttling as queueDeckPatch/queueCrossfader above, just applied to a rate
// instead of a store patch.
const _pendingScratchRate = new Map<string, number>();
let _scratchFlushPending = false;

function queueScratchRate(deckId: string, rate: number) {
  _pendingScratchRate.set(deckId, rate);
  if (!_scratchFlushPending) {
    _scratchFlushPending = true;
    requestAnimationFrame(() => {
      _scratchFlushPending = false;
      for (const [id, r] of _pendingScratchRate) audioScratch(id, r).catch(console.error);
      _pendingScratchRate.clear();
    });
  }
}

function stopScratch(deckId: string) {
  scratchActive.delete(deckId);
  delete scratchTicks[deckId];
  audioStopScratch(deckId).catch(console.error);
}

export async function startMidiListener(): Promise<() => void> {
  const unlisten = await listen<MidiAction>("midi-action", ({ payload: a }) => {
    const deckId = midiDeckId(a.deck_id);
    switch (a.type) {
      case "deck_play_toggle": {
        if (!deckId) break;
        const d = getDeck(deckId);
        if (d) {
          // Defensive: normal play() never re-seeks the segment rate, so if scratch is
          // somehow still active (its own 150ms idle timer hasn't fired yet) when play is
          // pressed, resuming would continue at the last scratch rate/direction instead of
          // forward at 1.0. In practice the idle timer will have already fired by the time
          // a discrete play-button press lands, but this closes the race unconditionally.
          if (!d.playing && scratchActive.has(deckId)) {
            clearTimeout(scratchIdleTimers[deckId]);
            stopScratch(deckId);
          }
          updateDeck(d.id, { playing: !d.playing });
        }
        break;
      }
      case "deck_gain":
        if (deckId && a.value !== undefined) {
          syncGain(deckId, a.value);              // audio: immediate
          queueDeckPatch(deckId, { gain: a.value }); // UI: rAF-throttled
        }
        break;
      case "deck_volume":
        if (deckId && a.value !== undefined) {
          syncVolume(deckId, a.value);
          queueDeckPatch(deckId, { volume: a.value });
        }
        break;
      case "deck_opacity":
        if (deckId && a.value !== undefined)
          updateDeck(deckId, { opacity: a.value }); // visual only — store is fine
        break;
      case "deck_playback_rate":
        if (deckId && a.value !== undefined) {
          // Rust always emits rate = 1.0 + delta*0.5 (±50% throw). Rescale delta to the
          // user-configured range so the full fader throw maps to exactly ±tempoRange%.
          const delta = (a.value - 1.0) / 0.5;
          const range = get(tempoRange) / 100;
          const scaled = 1.0 + delta * range;
          syncRate(deckId, scaled);               // audio: immediate, no Svelte overhead
          queueDeckPatch(deckId, { playbackRate: scaled }); // UI: rAF-throttled
        }
        break;
      case "crossfader":
        // Throttle to rAF — setCrossfader() recomputes volumes+opacities for all decks,
        // creating new Session+Deck objects and triggering full Svelte re-renders. At 100+
        // events/sec this saturates the JS thread. 16ms display lag is imperceptible for
        // a visual/audio fader sweep. Audio volume lag is tolerable at 60fps.
        if (a.value !== undefined) queueCrossfader(a.value);
        break;
      case "master_volume":
        if (a.value !== undefined) setMasterVolume(a.value);
        break;
      case "cue_gain":
        if (a.value !== undefined) cueGain.set(a.value);
        break;
      case "cue_jump": {
        if (!deckId) break;
        const d = getDeck(deckId);
        if (d) {
          seekDeck(d.id, d.cuePoint);
          updateDeck(d.id, { playing: false });
        }
        break;
      }
      case "loop_toggle": {
        if (!deckId) break;
        const d = getDeck(deckId);
        if (d) updateDeck(d.id, { loop: !d.loop });
        break;
      }
      case "hot_cue": {
        if (!deckId || a.index === undefined) break;
        const d = getDeck(deckId);
        if (!d) break;
        const t = d.hotCues[a.index];
        if (t !== undefined && !isNaN(t)) seekDeck(d.id, quantizeToGrid(d.id, t));
        break;
      }
      case "hot_cue_set": {
        if (!deckId || a.index === undefined) break;
        const d = getDeck(deckId);
        if (!d) break;
        const now = getDeckTime(deckId);
        if (now !== null) {
          const cues = [...d.hotCues];
          cues[a.index] = quantizeToGrid(d.id, now);
          updateDeck(d.id, { hotCues: cues });
        }
        break;
      }
      case "jog_nudge": {
        if (!deckId || a.value === undefined) break;
        const d = getDeck(deckId);
        if (!d) break;
        if (!d.playing) {
          // Paused: true bidirectional scratch audio — turning the wheel forward/backward
          // plays audio forward/backward at a speed matching the wheel, like a real
          // turntable, so a beat/transient can be found by ear. Rate comes from tick
          // velocity: track ticks in a short rolling window, sum their signed values, and
          // divide by the window's elapsed time to get ticks/sec, which scales into a
          // playback rate (sign = direction, magnitude = spin speed).
          const now = performance.now();
          const ticks = (scratchTicks[deckId] ??= []);
          ticks.push({ t: now, value: a.value });
          while (ticks.length > 1 && now - ticks[0].t > SCRATCH_TICK_WINDOW_MS) ticks.shift();

          // Floor of 1ms avoids a divide-by-near-zero spike on the very first tick in a
          // gesture (span would otherwise be 0ms) — the resulting rate gets clamped to
          // SCRATCH_MAX_RATE below regardless, so this just bounds that first-tick spike.
          const spanMs = Math.max(1, now - ticks[0].t);
          const ticksPerSec = (ticks.reduce((sum, tick) => sum + tick.value, 0) / spanMs) * 1000;

          const magnitude = Math.min(
            SCRATCH_MAX_RATE,
            Math.max(SCRATCH_MIN_RATE, Math.abs(ticksPerSec * SCRATCH_RATE_PER_TICK_PER_SEC)),
          );
          // Fall back to this tick's own direction when the window sums to ~0 (e.g. a
          // direction reversal mid-window), so the deck doesn't stall silently instead of
          // switching direction.
          const rate = Math.sign(ticksPerSec || a.value) * magnitude;

          scratchActive.add(deckId);
          queueScratchRate(deckId, rate);

          clearTimeout(scratchIdleTimers[deckId]);
          scratchIdleTimers[deckId] = setTimeout(() => stopScratch(deckId), SCRATCH_IDLE_MS);
          break;
        }
        if (!(deckId in jogBaseRate)) jogBaseRate[deckId] = d.playbackRate;
        // Offset from the saved base, not from d.playbackRate — the latter is already the
        // previous tick's nudged value, so adding to it compounds every event instead of
        // producing a bounded ±2% bend. A spinning wheel fires many ticks well inside the
        // 150ms idle-reset window, so compounding ran the rate to the 4.0 clamp in under a
        // second (audible pitch runaway + soundtouch buffer stress). See journal.md.
        const nudged = Math.max(0.25, Math.min(4.0, jogBaseRate[deckId] + a.value * 0.02));
        syncRate(d.id, nudged);                    // audio: immediate, no Svelte overhead
        queueDeckPatch(d.id, { playbackRate: nudged }); // UI: rAF-throttled — see deck_playback_rate
        // above and CLAUDE.md "session store is coarse-grained": a direct updateDeck() here
        // was firing a full Session/Deck rebuild + all-subscriber notify on every single MIDI
        // tick. A sustained jog spin (many ticks/sec, same as the tempo fader) queued reactive
        // work faster than the JS thread could drain it, freezing the UI while GStreamer audio
        // (separate Rust thread) kept playing uninterrupted.
        clearTimeout(jogTimers[deckId]);
        jogTimers[deckId] = setTimeout(() => {
          const base = jogBaseRate[deckId];
          delete jogBaseRate[deckId];
          if (base !== undefined) {
            syncRate(deckId, base);
            queueDeckPatch(deckId, { playbackRate: base });
          }
        }, 150);
        break;
      }
      case "sync_toggle": {
        if (!deckId) break;
        const d = getDeck(deckId);
        const s = get(session);
        const masterBpm = s.bpm;
        if (!d || d.bpm === null || masterBpm === null) {
          console.warn(`[sync_toggle] no-op — masterBpm=${masterBpm}, deck.bpm=${d?.bpm ?? 'no deck'}`);
          break;
        }
        updateDeck(d.id, { playbackRate: masterBpm / d.bpm });

        // Wait for WebKit's video-pipeline rebuild (triggered by the playbackRate write
        // above) to settle before seeking — see CLAUDE.md "Rate-then-seek ordering".
        setTimeout(() => nudgePhaseToMaster(d.id), 200);
        break;
      }
      case "headphone_cue": {
        if (!deckId) break;
        const d = getDeck(deckId);
        if (d) updateDeck(d.id, { cueEnabled: !d.cueEnabled });
        break;
      }
      case "phase_nudge": {
        if (!deckId) break;
        nudgePhaseToMaster(deckId);
        break;
      }
    }
  });
  return unlisten;
}
