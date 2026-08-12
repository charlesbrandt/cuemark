import { listen } from "@tauri-apps/api/event";
import { updateDeck, getDeck, setCrossfader, setMasterVolume, session } from "../state/session";
import { seekDeck, getDeckTime, quantizeToGrid, setScratching, isScratching, beginScrub, updateScrub, endScrub } from "../renderer/seekBus";
import { nudgePhaseToMaster } from "../audio/phaseNudge";
import { syncRate, syncGain, syncVolume } from "../audio/audioSync";
import { audioScratch, audioStopScratch } from "../audio/pipeline";
import { cueGain, tempoRange, scratchMode, jogSecondsPerRev } from "../audio/audioSettings";
import { noteScrubInput } from "../audio/scrubStats";
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
// Tick-velocity EMA for the playing-deck jog bend below — same shape as scratchVelocity,
// kept separate because the two branches (playing vs paused) run independently and a
// gesture switching between them mid-session must not inherit a stale reading.
const jogVelocity: Record<string, { lastT: number; emaTicksPerSec: number }> = {};

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

// ── Vinyl mode: position, not velocity ────────────────────────────────────────────
//
// Vinyl mode no longer estimates a rate from tick timing. The EMA above still serves
// shuttle mode, where free-running between ticks is the entire point, but it was the
// wrong control variable for vinyl — which is direct manipulation, and therefore about
// *how far the wheel turned*, not how fast. Three things made the old path's travel
// depend on delivery timing rather than on the user's hand:
//
//   1. queueScratchRate coalesces by overwrite, so a burst of ticks landing inside one
//      frame became a single rate update and the rest of the wheel motion was dropped.
//   2. USB MIDI delivers in bursts, collapsing (now - prev.lastT) onto SCRATCH_MIN_DT_MS
//      and saturating the computed rate at the mode's cap.
//   3. Nothing held an absolute reference, so every over- and undershoot accumulated for
//      the whole gesture with no way to correct.
//
// Accumulating ticks into an absolute target removes all three at once: N ticks move the
// track by exactly N ticks of travel whenever they arrive, and coalescing absolute
// targets discards nothing. See seekBus.ts's scrub section and scratch_to() in
// pipeline.rs. Shuttle mode is untouched below.

// Content seconds of travel per encoder tick. 33⅓rpm is 1.8s per revolution, so the
// vinyl-faithful value is 1.8 / (ticks per revolution).
//
// ✅ Calibrated live against the Starlight 2026-08-08, and the correctness question this
// constant was blocked on is settled: **the encoder reports plain ±1 deltas, not
// speed-scaled steps.** Two one-revolution gestures, ~3x apart in speed, both reported
// `maxAbs=1 values=[1]` across every message — 248 messages over 6.06s (41/s) slow,
// 276 over 2.11s (131/s) fast. So accumulating ticks into an absolute target is exact,
// and the design above is correct as built. (The suspicion recorded on
// SCRATCH_MODE_PARAMS.shuttle below was wrong; corrected there.)
//
// 256 ticks/revolution: bracketed by both measurements (-3.1% / +7.8%), a common encoder
// resolution, and well inside the error of judging "exactly one revolution" by hand —
// which is the only thing the 248-vs-276 spread measures, since the speed question is
// already answered by maxAbs. Re-run the [jog-cal/…] procedure in
// docs/design/waveform-scrub.md if the platter ever feels off-speed.
//
// ⚠️ Split in two on 2026-08-10, and the split is the point. The encoder resolution is a
// **measured hardware fact**; the seconds-per-revolution is a **taste setting** the user
// turns by ear (`jogSecondsPerRev`, see its doc comment and
// docs/design/slow-jog-audio-inaudible.md §6). Folding them into one constant is what let
// "the wheel feels wrong" and "the mapping is unfaithful" argue over the same number — and
// it invites a wrong hardware value to be hidden by a compensating taste value, which no
// later calibration would then be able to detect.
const VINYL_TICKS_PER_REV = 256;

/**
 * Seconds of content per encoder tick. Read per gesture rather than captured at module
 * load: this is A/B'd live by ear, and an HMR edit to re-read it would remount App.svelte
 * and tear the deck down (CLAUDE.md, "Dev server lifecycle"), which makes the comparison
 * cost a re-load and a re-play every time.
 */
function vinylSecPerTick(): number {
  return get(jogSecondsPerRev) / VINYL_TICKS_PER_REV; // default 1.8/256 = 0.00703
}

// Ends a vinyl gesture once ticks stop, handing the deck back to the normal branch.
// Longer than SCRATCH_IDLE_MS was for velocity mode's benefit is unnecessary here — the
// feeder already goes silent the moment the cursor reaches the target — so this stays on
// the same timer, now harmless mid-gesture because last_scratch_frame (pipeline.rs) makes
// a restart resume exactly where the previous gesture left off.
const vinylTarget: Record<string, number> = {};

// Per-gesture raw encoder tally, logged once when the gesture ends. This is the
// calibration instrument for VINYL_TICKS_PER_REV, and it has to live here rather than in
// midi.rs: that logger throttles continuous controls to one line per 500ms per key (see
// its log_throttle map), so the Rust log shows a jog wheel emitting a tidy ±1 every half
// second no matter how fast it is really spinning — which is exactly the measurement the
// calibration needs and exactly what is hidden.
//
// `absSum` is the number the procedure in docs/design/waveform-scrub.md consumes: rotate
// one revolution slowly, then quickly, and compare. Equal ⇒ the values are deltas since
// the last message, accumulation is exact, and absSum IS ticks-per-revolution.
// Unequal ⇒ they are speed-scaled and no single constant is correct. `maxAbs`/`values`
// answer the same question a second way in one pass: an encoder reporting plain deltas
// never emits anything but ±1.
const vinylTally: Record<string, { n: number; absSum: number; net: number; maxAbs: number; values: Set<number>; t0: number }> = {};

// Per-mode tuning — see scratchMode's doc comment in audioSettings.ts for the
// shuttle-vs-vinyl distinction.
const SCRATCH_MODE_PARAMS = {
  shuttle: {
    // Tunable sensitivity dial: still saturating to the cap on a fairly gentle spin
    // at 0.35 — lowered to leave more usable range below the cap before it saturates.
    // Retune here if it still saturates too early/late.
    //
    // ⚠️ The reason recorded here until 2026-08-08 was wrong: this comment claimed the
    // Hercules encoder "appears to report larger step values, not just ±1, as physical
    // speed increases". It does not. The [jog-cal/…] calibration (see VINYL_TICKS_PER_REV
    // above) measured `maxAbs=1 values=[1]` over 524 messages across two gestures ~3x
    // apart in speed. ticksPerSec grows exactly as fast as ticks counted per second — so
    // if this saturates early, that is the EMA divisor collapsing onto SCRATCH_MIN_DT_MS
    // under burst delivery, which is the documented reason velocity was abandoned for
    // vinyl mode. Shuttle keeps it deliberately (free-running between ticks is the point).
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

// ── Playing-deck jog bend: variable speed, not a fixed step ────────────────────────
//
// This is a different mechanism from vinyl/shuttle scratch above — the deck is already
// playing, so there is no paused feeder and no absolute position to servo to. What the
// jog wheel does here is bend the *rate* of audio that's already advancing, so unlike
// the "position, never rate" rule for the scratch feeder (see CLAUDE.md, "Direct
// manipulation" — that rule is specifically about the paused-deck scratch path), a rate
// really is the right control variable for this branch. It was, until now, just the
// wrong shape of one: every tick applied the same fixed ±0.02 offset from the base rate
// regardless of how fast the wheel was actually spinning (todo-20260808.md item 5: "the
// jog wheel currently speeds up playback by a fixed amount ... I would like it to
// respond similar to a vinyl control [with] variable speed adjustments"). Scaling the
// bend by tick velocity — the same EMA-of-ticks/sec estimate shuttle mode above already
// uses for this exact hardware/encoder — makes a gentle nudge barely bend pitch and a
// fast spin bend it further, up to JOG_BEND_MAX.
//
// Runaway stays bounded the same two ways it already was: the bend is recomputed from
// jogBaseRate every tick rather than compounding onto the previous nudge (see the
// comment at the call site — this was the 2026-07 fix, still load-bearing and
// unchanged), and the final Math.max/Math.min clamp below never lets soundtouch see
// outside [0.25, 4.0] regardless of what the EMA reads.
//
// ⚠️ Not yet live-calibrated against the Starlight in this (playing-deck) branch — the
// only measured tick rates on record are from the paused-deck vinyl calibration
// (docs/design/waveform-scrub.md's [jog-cal/…] procedure: ~41/s slow, ~131/s fast, full
// wheel revolutions). JOG_BEND_PER_TICK_PER_SEC is chosen so that range maps to roughly
// 4.5% bend at the slow end and saturates at JOG_BEND_MAX near the fast end — deliberately
// modest, since a "pitch bend while playing" is conventionally a small, quick nudge (a
// few percent) rather than a scratch-scale speed change. Re-tune both constants by ear
// once this can be tried on real hardware; nothing about the shape (EMA velocity → clamped
// bend, no compounding) should need to change, only these two numbers.
const JOG_BEND_PER_TICK_PER_SEC = 0.0011;
const JOG_BEND_MAX = 0.15;
// Seed for the very first tick of a gesture, before any inter-tick interval exists to
// measure — mirrors shuttle's params.minRate/params.ratePerTickPerSec seed above (a
// deliberately modest assumed rate, not a spike). Using a.value*1000 here (the naive
// "one tick in ~1ms" reading) would make the first tick of every gesture bend far
// harder than any sustained spin, before the EMA has a real reading to correct it.
const JOG_BEND_SEED_TICKS_PER_SEC = 20;

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
  delete scratchVelocity[deckId];
  const t0 = performance.now();
  const settled = () =>
    debugLog(`[scratch/${deckId}] audioStopScratch settled after ${(performance.now() - t0).toFixed(0)}ms (IPC round-trip)`);

  // Vinyl mode runs through the scrub bus, which owns the teardown (SNAP landing,
  // setScratching, audioStopScratch) — see the vinyl branch in jog_nudge.
  if (vinylTarget[deckId] !== undefined) {
    delete vinylTarget[deckId];
    const tally = vinylTally[deckId];
    if (tally) {
      delete vinylTally[deckId];
      const secs = (performance.now() - tally.t0) / 1000;
      // One line per gesture — see vinylTally for what each field is for.
      //
      // Reports **ticks/revolution**, not a seconds-per-tick, since 2026-08-10: that is the
      // hardware fact this gesture actually measures, and it is independent of the
      // `jogSecondsPerRev` taste setting. The old line printed `1.8/absSum`, which silently
      // assumed the default scale — so once that setting moves the number is wrong, and it
      // is wrong in a way that reads as a plausible calibration result. It also invited
      // reasoning from *uncontrolled* gestures: five sessions' worth of readings only ever
      // meant anything because someone turned the wheel exactly one revolution on purpose.
      // Measured ticks/rev across five such gestures: 243–276, hence VINYL_TICKS_PER_REV=256.
      //
      // `revs=` restates it as a sanity check: if that does not match what your hand did,
      // every other number on this line is uninterpretable. Say how far you turned.
      const ticksPerRev = tally.absSum;
      debugLog(
        `[jog-cal/${deckId}] msgs=${tally.n} absSum=${tally.absSum} net=${tally.net} ` +
        `maxAbs=${tally.maxAbs} values=[${[...tally.values].sort((a, b) => a - b).join(',')}] ` +
        `over ${secs.toFixed(2)}s (${(tally.n / Math.max(secs, 0.001)).toFixed(0)} msg/s) | ` +
        `if this was exactly ONE revolution, ticks/rev = ${ticksPerRev} ` +
        `(assumed ${VINYL_TICKS_PER_REV}); revs at that assumption = ` +
        `${(tally.absSum / VINYL_TICKS_PER_REV).toFixed(2)} | ` +
        `scale ${get(jogSecondsPerRev).toFixed(2)}s/rev → mean ` +
        `${((tally.absSum * (get(jogSecondsPerRev) / VINYL_TICKS_PER_REV)) / Math.max(secs, 0.001)).toFixed(2)}x`
      );
    }
    endScrub(deckId).then(settled);
    return;
  }
  setScratching(deckId, false);
  audioStopScratch(deckId).then(settled).catch(console.error);
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
          // turntable, so a beat/transient can be found by ear.
          const mode = get(scratchMode);
          if (mode === "vinyl") {
            // Accumulate ticks into an absolute position and let the feeder servo to it.
            // Seeded from the deck's current position on the first tick of a gesture;
            // every later tick is pure displacement, so burst delivery is irrelevant.
            // See vinylSecPerTick() above for why this replaced the velocity path.
            const base = vinylTarget[deckId] ?? getDeckTime(deckId) ?? 0;
            if (vinylTarget[deckId] === undefined) {
              beginScrub(deckId, base, true);
              vinylTally[deckId] = { n: 0, absSum: 0, net: 0, maxAbs: 0, values: new Set(), t0: performance.now() };
            }
            // Delivery instrumentation (scrubStats.ts). `null` because a MIDI tick arrives
            // over Tauri IPC and carries no platform event time — so this path reports
            // inter-event gaps but cannot separate "the wheel sent nothing" from "the tick
            // waited in a queue", which the pointer path can. Any gap here is therefore an
            // upper bound on delivery latency, not an attribution.
            noteScrubInput(deckId, null);
            const tally = vinylTally[deckId];
            tally.n++;
            tally.absSum += Math.abs(a.value);
            tally.net += a.value;
            tally.maxAbs = Math.max(tally.maxAbs, Math.abs(a.value));
            if (tally.values.size < 16) tally.values.add(a.value);
            // Store what updateScrub actually accepted, not what we asked for: at a track
            // boundary those differ, and keeping the raw sum would open a silent dead zone
            // as long as the overshoot. See updateScrub's doc comment.
            vinylTarget[deckId] = updateScrub(deckId, base + a.value * vinylSecPerTick());

            clearTimeout(scratchIdleTimers[deckId]);
            scratchIdleArmedAt[deckId] = performance.now();
            scratchIdleTimers[deckId] = setTimeout(() => stopScratch(deckId), SCRATCH_IDLE_MS);
            break;
          }
          // Shuttle: rate comes from tick velocity, tracked as an EMA of instantaneous
          // ticks/sec — see the SCRATCH_* constants above for why (a hard rolling window
          // was tried and discarded). Free-running between ticks is the point of this
          // mode, so velocity remains the right control variable for it.
          const params = SCRATCH_MODE_PARAMS[mode];
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
        // Bend magnitude tracks how fast the wheel is turning (EMA of ticks/sec — see
        // "Playing-deck jog bend" above), not a fixed step per tick.
        const jogNow = performance.now();
        const prevJog = jogVelocity[deckId];
        const jogInstTicksPerSec = prevJog
          ? (a.value / Math.max(SCRATCH_MIN_DT_MS, jogNow - prevJog.lastT)) * 1000
          : Math.sign(a.value) * JOG_BEND_SEED_TICKS_PER_SEC;
        const jogEmaTicksPerSec = prevJog
          ? prevJog.emaTicksPerSec * (1 - SCRATCH_EMA_ALPHA) + jogInstTicksPerSec * SCRATCH_EMA_ALPHA
          : jogInstTicksPerSec;
        jogVelocity[deckId] = { lastT: jogNow, emaTicksPerSec: jogEmaTicksPerSec };
        const bend = Math.max(-JOG_BEND_MAX, Math.min(JOG_BEND_MAX, jogEmaTicksPerSec * JOG_BEND_PER_TICK_PER_SEC));
        // Offset from the saved base, not from d.playbackRate — the latter is already the
        // previous tick's nudged value, so adding to it compounds every event instead of
        // producing a bounded bend. A spinning wheel fires many ticks well inside the
        // 150ms idle-reset window, so compounding ran the rate to the 4.0 clamp in under a
        // second (audible pitch runaway + soundtouch buffer stress). See journal.md.
        const nudged = Math.max(0.25, Math.min(4.0, jogBaseRate[deckId] + bend));
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
          delete jogVelocity[deckId]; // next gesture starts its EMA fresh, not mid-decay
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
