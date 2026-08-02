import { listen } from "@tauri-apps/api/event";
import { updateDeck, getDeck, setCrossfader, setMasterVolume, session } from "../state/session";
import { seekDeck, getDeckTime, quantizeToGrid, setScratching, isScratching } from "../renderer/seekBus";
import { nudgePhaseToMaster } from "../audio/phaseNudge";
import { syncRate, syncGain, syncVolume } from "../audio/audioSync";
import { audioScratch, audioStopScratch } from "../audio/pipeline";
import { cueGain, tempoRange, scratchMode } from "../audio/audioSettings";
import { debugLog } from "../debugLog";
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

// Paused-deck jog scratch: true bidirectional audio scratch (PCM-buffer feeder branch —
// pitch bends with speed/direction, like real vinyl) rather than a silent position-only
// scrub. See docs/design/pcm-buffer-playback.md. Rate is derived from tick *velocity*,
// tracked as an exponential moving average (EMA) of instantaneous ticks/sec between
// consecutive MIDI events — not a hard rolling window summed over a fixed span. A hard
// window (sum of tick values over the last N ms, divided by the elapsed time since the
// oldest one still in the window) was tried first and discarded on real hardware: USB
// MIDI delivers ticks in bursts (several land in one JS macrotask, then a gap), so
// whenever the window happened to contain only one recent tick — which happens
// constantly during ordinary-speed scratching, not just at gesture start — the divisor
// collapsed toward zero and blew the computed rate up to SCRATCH_MAX_RATE. Flooring
// that divisor instead made *every* such tick register as SCRATCH_MIN_RATE, which is
// just as common a case and made the response feel laggy/stuttery, occasionally letting
// one stray tick's raw sign flip the perceived direction mid-gesture. An EMA blends each
// new instantaneous reading into a running estimate by SCRATCH_EMA_ALPHA instead of
// fully trusting (or fully discarding) any single inter-tick gap, so bursts and gaps
// both get smoothed without the signal collapsing to a floor/ceiling constant.
// Floors the inter-tick interval only enough to avoid a divide-by-near-zero when two
// ticks land in the same millisecond (OS timer granularity) — not a "minimum meaningful
// gap" like the old windowed approach needed, since the EMA below already absorbs burst
// noise on its own.
const SCRATCH_MIN_DT_MS = 4;
// Weight given to each new instantaneous reading when blending into the EMA; lower =
// smoother but slower to react to a genuine speed change.
const SCRATCH_EMA_ALPHA = 0.4;
// How long since the last tick before the whole scratch branch tears down and resyncs
// to normal playback (stop_scratch_feeder() in pipeline.rs) — NOT how long before audio
// goes quiet (that's hold_ms, handled entirely in the feeder thread, e.g. 40ms for
// vinyl). Deliberately much longer than any per-mode hold_ms: stop_scratch_feeder()
// runs a 130ms drain sleep plus two synchronous flush seeks (one ACCURATE, real decode
// work) while holding the single global AudioManager mutex every audio IPC call for
// every deck serializes behind. At the original 150ms, vinyl mode's natural usage —
// short, precise nudges separated by brief pauses — fired that expensive teardown on
// almost every pause between nudges, and overlapping ~200–500ms mutex-held windows
// piled up faster than they drained, making the whole app's audio IPC (position polls,
// rate syncs, everything) stall — observed as the app going unresponsive. Since hold_ms
// already makes the audio itself go silent/frozen almost immediately on any pause,
// there's no audible reason for the *pipeline teardown* to be nearly this eager; it
// only needs to fire once the user has genuinely let go, not on every micro-gap between
// precise nudges. Raised well above any hold_ms so this fires rarely instead of on
// every pause. (Pressing play immediately still tears down synchronously first — see
// the isScratching() check in deck_play_toggle below — so this doesn't add release lag
// when the user is done and moves on.)
const SCRATCH_IDLE_MS = 500;

// Per-mode tuning — see scratchMode's doc comment in audioSettings.ts for the
// shuttle-vs-vinyl distinction.
const SCRATCH_MODE_PARAMS = {
  shuttle: {
    // Tunable sensitivity dial: still saturating to the cap on a fairly gentle spin
    // at 0.35 (the Hercules encoder appears to report larger step values, not just
    // ±1, as physical speed increases, so ticksPerSec grows faster than a plain
    // "ticks counted per second" would suggest) — lowered to leave more usable range
    // below the cap before it saturates. Retune here if it still saturates too
    // early/late.
    ratePerTickPerSec: 0.15,
    // A rate of exactly 0 would freeze the feeder thread's buffer cursor entirely,
    // so the magnitude floor keeps scratch audio always moving even when the wheel
    // is barely turning — appropriate for shuttle's "always searching" character.
    minRate: 0.15,
    // Fast-spin cap, comfortably inside soundtouch's own 0.1–4.0 range used elsewhere.
    maxRate: 3.0,
    // Effectively "never decays within a real gesture" — the feeder keeps
    // free-running at the last rate between ticks, which is the whole point of
    // shuttle mode (fast cueing/searching, not direct position control).
    holdMs: 100_000,
  },
  vinyl: {
    // Much gentler scale than shuttle: vinyl mode is for slow, deliberate motion.
    ratePerTickPerSec: 0.05,
    // No "always moving" floor needed — holding the wheel still should mean silence,
    // like a stationary hand on a real record, not a slow idle crawl.
    minRate: 0.02,
    // Capped well below shuttle's ceiling — this mode isn't for fast searching.
    maxRate: 0.8,
    // Decays to silence/hold almost immediately once ticks stop arriving, so motion
    // tracks the wheel directly instead of free-running like shuttle mode does — see
    // the ScratchFeeder hold_ms comment in pipeline.rs for how this is implemented.
    holdMs: 40,
  },
} as const;

const scratchVelocity: Record<string, { lastT: number; emaTicksPerSec: number }> = {};
const scratchIdleTimers: Record<string, ReturnType<typeof setTimeout>> = {};
// Timestamp the idle timer was (re)armed, so the callback can report how late it
// actually fired vs. its SCRATCH_IDLE_MS deadline — a live "chokes up" diagnostic.
// A setTimeout firing exactly on schedule but audioStopScratch() still taking
// seconds to settle points at the IPC round-trip; a setTimeout firing itself
// hundreds of ms to seconds late points at the JS main thread being blocked by
// something else (e.g. a v.currentTime write storm) — see debugLog.ts.
const scratchIdleArmedAt: Record<string, number> = {};

// Coalesces rapid jog ticks into one audioScratch() call per rendered frame. Every call
// is still an IPC round-trip even though only the first one in a gesture does real setup
// (see audioScratch's doc comment), so this needs the same per-frame throttling as
// queueDeckPatch/queueCrossfader above, just applied to a rate instead of a store patch.
const _pendingScratchRate = new Map<string, { rate: number; holdMs: number }>();
let _scratchFlushPending = false;

function queueScratchRate(deckId: string, rate: number, holdMs: number) {
  _pendingScratchRate.set(deckId, { rate, holdMs });
  if (!_scratchFlushPending) {
    _scratchFlushPending = true;
    requestAnimationFrame(() => {
      _scratchFlushPending = false;
      for (const [id, { rate, holdMs }] of _pendingScratchRate) audioScratch(id, rate, holdMs).catch(console.error);
      _pendingScratchRate.clear();
    });
  }
}

function stopScratch(deckId: string) {
  const armedAt = scratchIdleArmedAt[deckId];
  if (armedAt !== undefined) {
    const lateBy = performance.now() - armedAt - SCRATCH_IDLE_MS;
    debugLog(`[scratch/${deckId}] idle timer fired ${lateBy.toFixed(0)}ms late (main thread gate)`);
  }
  setScratching(deckId, false);
  delete scratchVelocity[deckId];
  const t0 = performance.now();
  audioStopScratch(deckId)
    .then(() => debugLog(`[scratch/${deckId}] audioStopScratch settled after ${(performance.now() - t0).toFixed(0)}ms (IPC round-trip)`))
    .catch(console.error);
}

export async function startMidiListener(): Promise<() => void> {
  const unlisten = await listen<MidiAction>("midi-action", ({ payload: a }) => {
    const deckId = midiDeckId(a.deck_id);
    switch (a.type) {
      case "deck_play_toggle": {
        if (!deckId) break;
        const d = getDeck(deckId);
        if (d) {
          // Defensive: the Rust side only tears down the scratch feeder branch on
          // pause()/stop_scratch(), not play() — so if scratch is somehow still active
          // (its own 150ms idle timer hasn't fired yet) when play is pressed, audio_play
          // would leave the feeder thread still driving output instead of switching back
          // to the normal branch. In practice the idle timer will have already fired by
          // the time a discrete play-button press lands, but this closes the race
          // unconditionally.
          if (!d.playing && isScratching(deckId)) {
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
          queueDeckPatch(deckId, { playbackRate: scaled, syncLocked: false }); // UI: rAF-throttled
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
          // velocity, tracked as an EMA of instantaneous ticks/sec — see the SCRATCH_*
          // constants above for why (a hard rolling window was tried and discarded).
          // Scaling/floor/cap/hold-decay all come from SCRATCH_MODE_PARAMS, so shuttle
          // and vinyl share this exact velocity-tracking logic and only differ in how
          // it's turned into a rate and how long the feeder free-runs on it.
          const params = SCRATCH_MODE_PARAMS[get(scratchMode)];
          const now = performance.now();
          const prev = scratchVelocity[deckId];
          // No prior tick to diff against (gesture just started): seed the EMA so the
          // resulting magnitude comes out to the mode's floor rate rather than guessing
          // at a velocity from nothing — real ticks/sec takes over from the next tick.
          const instTicksPerSec = prev
            ? (a.value / Math.max(SCRATCH_MIN_DT_MS, now - prev.lastT)) * 1000
            : Math.sign(a.value) * (params.minRate / params.ratePerTickPerSec);
          const emaTicksPerSec = prev
            ? prev.emaTicksPerSec * (1 - SCRATCH_EMA_ALPHA) + instTicksPerSec * SCRATCH_EMA_ALPHA
            : instTicksPerSec;
          scratchVelocity[deckId] = { lastT: now, emaTicksPerSec };

          const magnitude = Math.min(
            params.maxRate,
            Math.max(params.minRate, Math.abs(emaTicksPerSec * params.ratePerTickPerSec)),
          );
          // Fall back to this tick's own direction when the EMA sums to ~0 (e.g. a
          // direction reversal), so the deck doesn't stall silently instead of switching.
          const rate = Math.sign(emaTicksPerSec || a.value) * magnitude;

          setScratching(deckId, true);
          queueScratchRate(deckId, rate, params.holdMs);

          clearTimeout(scratchIdleTimers[deckId]);
          scratchIdleArmedAt[deckId] = performance.now();
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
        queueDeckPatch(d.id, { playbackRate: nudged, syncLocked: false }); // UI: rAF-throttled — see deck_playback_rate
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
