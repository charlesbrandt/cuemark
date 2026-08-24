import { listen } from "@tauri-apps/api/event";
import { updateDeck, getDeck, setCrossfader, setMasterVolume, setSnapToBeat, session } from "../state/session";
import { seekDeckExitingLoop, getDeckTime, quantizeToGrid, setScratching, isScratching, beginScrub, updateScrub, endScrub } from "../renderer/seekBus";
import { nudgePhaseToMaster } from "../audio/phaseNudge";
import { syncRate, syncGain, syncVolume, syncEq, syncFilter } from "../audio/audioSync";
import { audioScratch, audioStopScratch } from "../audio/pipeline";
import { cueGain, tempoRange, scratchMode, jogSecondsPerRev } from "../audio/audioSettings";
import { noteScrubInput } from "../audio/scrubStats";
import { debugLog } from "../debugLog";
import { pushMarker } from "../digger/api";
import { moveQueueSelection, loadSelectedQueueItem, showDiggerQueue } from "../digger/queueStore";
import { notifyManualCrossfaderTouch } from "../digger/autoMix";
import { get } from "svelte/store";

// Beat Loop pad ladder — index 0-7 (plain pad 1-4, then shift+pad 1-4). Longer lengths
// on the plain pads by preference (2026-08-22) — most loops in practice are the bigger
// ones, so shift is reserved for the shorter, more surgical lengths.
const LOOP_PRESET_BEATS = [4, 8, 16, 32, 0.25, 0.5, 1, 2];

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
  notifyManualCrossfaderTouch();
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

// Must match the Rust MidiEvent{source,profile,#[flatten] MidiAction} shape (snake_case
// tag + camelCase fields from serde). Deck-scoped actions carry `slot`, never a deck id
// — see slotDeck() below for why (docs/design/controller-mapping.md §3.2/§4).
export interface MidiAction {
  type:
    | "deck_play_toggle"
    | "deck_opacity"
    | "deck_gain"
    | "deck_volume"
    | "deck_playback_rate"
    | "jog_turn"
    | "crossfader"
    | "master_volume"
    | "cue_gain"
    | "cue_jump"
    | "hot_cue"
    | "hot_cue_set"
    | "loop_toggle"
    | "loop_preset"
    | "loop_in"
    | "loop_out"
    | "loop_halve"
    | "loop_double"
    | "beat_jump"
    | "snap_toggle"
    | "sync_toggle"
    | "headphone_cue"
    | "phase_nudge"
    | "deck_eq_low"
    | "deck_eq_mid"
    | "deck_eq_high"
    | "deck_filter"
    | "queue_cursor"
    | "queue_load";
  /** Which connection sent this — see spawn_listener's NEXT_SOURCE in midi/mod.rs. */
  source: number;
  /** Profile id ("hercules-starlight" / "pioneer-ddj-flx4" / …) — the key into
      Session.midiMapping, and what lets two live controllers route independently. */
  profile: string;
  slot?: number;
  value?: number;
  index?: number;
  beats?: number;
  /** queue_cursor only — raw signed wire ticks (unflipped, see decode.rs's QueueCursor doc comment). */
  delta?: number;
}

/**
 * Resolve a controller's (profile, slot) to a software deck id. Falls back to
 * slot-i -> decks[i] when the profile has no explicit routing yet (or the array is
 * shorter than this slot) — zero-config default routing, since there is deliberately
 * no per-controller settings UI beyond AudioSettings' single-profile L/R selects.
 * Replaces the old midiDeckId(), which only ever knew "deck-0"/"deck-1" (the
 * Starlight's own hardcoded channel labels) — this generalizes to any slot count on
 * any number of simultaneously-connected controllers.
 */
export function slotDeck(profile: string, slot: number | undefined): string | undefined {
  if (slot === undefined) return undefined;
  const s = get(session);
  return s.midiMapping[profile]?.[slot] ?? s.decks[slot]?.id;
}

// Per-deck jog state: saves the rate that was active before jog started so it can be restored.
const jogBaseRate: Record<string, number> = {};
const jogTimers: Record<string, ReturnType<typeof setTimeout>> = {};
// Tick-velocity EMA for the playing-deck jog bend below — same shape as scratchVelocity,
// kept separate because the two branches (playing vs paused) run independently and a
// gesture switching between them mid-session must not inherit a stale reading.
const jogVelocity: Record<string, { lastT: number; emaRevsPerSec: number }> = {};

// Paused-deck jog scratch: true bidirectional audio scratch (PCM-buffer feeder branch —
// pitch bends with speed/direction, like real vinyl) rather than a silent position-only
// scrub. See docs/design/pcm-buffer-playback.md. Rate is derived from tick *velocity*,
// tracked as an exponential moving average (EMA) of instantaneous revs/sec between
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

// ⚠️ Since the 2026-08-22 profile refactor, Rust emits `JogTurn.value` in
// **revolutions**, not raw ticks — each controller's own `jog_ticks_per_rev`
// (Starlight 256, FLX4 ~721.7 — controller-mapping.md §8.2) is divided out on the
// Rust side before this ever sees a value. So the vinyl branch below multiplies
// directly by `get(jogSecondsPerRev)` (read per gesture, not captured at module
// load — this is A/B'd live by ear, and an HMR edit to re-read it would remount
// App.svelte and tear the deck down, CLAUDE.md "Dev server lifecycle") with no
// per-controller division needed anymore; that constant (`VINYL_TICKS_PER_REV`)
// moved into each profile's TOML as a measured hardware fact instead.

// Ends a vinyl gesture once ticks stop, handing the deck back to the normal branch.
// Longer than SCRATCH_IDLE_MS was for velocity mode's benefit is unnecessary here — the
// feeder already goes silent the moment the cursor reaches the target — so this stays on
// the same timer, now harmless mid-gesture because last_scratch_frame (pipeline.rs) makes
// a restart resume exactly where the previous gesture left off.
const vinylTarget: Record<string, number> = {};

// Per-gesture raw revolution tally, logged once when the gesture ends. Reports
// **revolutions**, not ticks — since the 2026-08-22 profile refactor each controller's
// own ticks-per-revolution is already divided out in Rust (see vinylSecPerRev's doc
// comment), so there is no per-controller constant left to calibrate here. This still
// earns its keep as a "did the hand's motion round-trip sanely" sanity check: if
// `revs` doesn't match what your hand actually did, something upstream (the profile's
// `jog_ticks_per_rev`, or the encoding) is wrong.
const vinylTally: Record<string, { n: number; sumRevs: number; netRevs: number; t0: number }> = {};

// Per-mode tuning — see scratchMode's doc comment in audioSettings.ts for the
// shuttle-vs-vinyl distinction.
//
// ⚠️ Rescaled ×256 on 2026-08-22 (was "…PerTickPerSec", tuned against the Starlight's
// raw ticks): Rust now emits revolutions, so a value tuned per-tick has to be
// multiplied by the ticks-per-revolution it was implicitly tuned against (256, the
// Starlight's — the only controller these were ever tuned by ear on) to keep the exact
// same felt response now that the input unit changed. The Starlight's behaviour here
// is therefore numerically unchanged; the FLX4 (and any future controller) now shares
// the same feel automatically instead of inheriting whatever its own ticks-per-rev
// happens to be.
const SCRATCH_MODE_PARAMS = {
  shuttle: {
    // Tunable sensitivity dial — see the 2026-08-22 rescale note above.
    ratePerRevPerSec: 38.4, // was ratePerTickPerSec: 0.15
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
    ratePerRevPerSec: 12.8, // was ratePerTickPerSec: 0.05
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
// bend by tick velocity — the same EMA-of-revs/sec estimate shuttle mode above already
// uses for this exact hardware/encoder — makes a gentle nudge barely bend pitch and a
// fast spin bend it further, up to JOG_BEND_MAX.
//
// Runaway stays bounded the same two ways it already was: the bend is recomputed from
// jogBaseRate every tick rather than compounding onto the previous nudge (see the
// comment at the call site — this was the 2026-07 fix, still load-bearing and
// unchanged), and the final Math.max/Math.min clamp below never lets soundtouch see
// outside [0.25, 4.0] regardless of what the EMA reads.
//
// ⚠️ Rescaled ×256 alongside SCRATCH_MODE_PARAMS above (was "…PerTickPerSec"/
// "…TicksPerSec") — same reasoning: these were tuned by ear against the Starlight's
// raw ticks, so the rescale keeps that feel numerically identical now that Rust emits
// revolutions.
const JOG_BEND_PER_REV_PER_SEC = 0.2816; // was JOG_BEND_PER_TICK_PER_SEC: 0.0011
const JOG_BEND_MAX = 0.15;
// Seed for the very first tick of a gesture, before any inter-tick interval exists to
// measure — mirrors shuttle's params.minRate/params.ratePerRevPerSec seed above (a
// deliberately modest assumed rate, not a spike).
const JOG_BEND_SEED_REVS_PER_SEC = 0.078125; // was JOG_BEND_SEED_TICKS_PER_SEC: 20

const scratchVelocity: Record<string, { lastT: number; emaRevsPerSec: number }> = {};
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
  // setScratching, audioStopScratch) — see the vinyl branch in jog_turn.
  if (vinylTarget[deckId] !== undefined) {
    delete vinylTarget[deckId];
    const tally = vinylTally[deckId];
    if (tally) {
      delete vinylTally[deckId];
      const secs = (performance.now() - tally.t0) / 1000;
      debugLog(
        `[jog-cal/${deckId}] msgs=${tally.n} revs=${tally.sumRevs.toFixed(2)} net=${tally.netRevs.toFixed(2)} ` +
        `over ${secs.toFixed(2)}s (${(tally.n / Math.max(secs, 0.001)).toFixed(0)} msg/s) | ` +
        `scale ${get(jogSecondsPerRev).toFixed(2)}s/rev → mean ${(tally.sumRevs * get(jogSecondsPerRev) / Math.max(secs, 0.001)).toFixed(2)}x`
      );
    }
    endScrub(deckId).then(settled);
    return;
  }
  setScratching(deckId, false);
  audioStopScratch(deckId).then(settled).catch(console.error);
}

/**
 * End an in-flight scratch gesture right now, ahead of a transport change that must not
 * race it. Call before flipping `deck.playing`, from every play/pause affordance.
 *
 * The race this closes is not theoretical — it is the 2026-08-13 20:45 log event. A
 * gesture holds the pipeline in PLAYING and only relinquishes it when `SCRATCH_IDLE_MS`
 * expires; a play pressed inside that window reached Rust 165ms *before* `stop_scratch`
 * did, and `stop_scratch()` then paused the deck back down over the top of it. The user
 * saw the video race tens of seconds ahead (the position poll reading the pipeline's
 * post-resync position, see `DeckAudioPipeline::position()`) with no audio, until a
 * manual pause/play put it right. Rust now survives that ordering on its own — this keeps
 * the ordering correct in the first place, which is cheaper and also stops the feeder
 * driving output for an extra fraction of a second.
 *
 * Both IPCs are dispatched synchronously from here (`endScrub`/`audioStopScratch` issue
 * theirs before returning their promise), so a `updateDeck({ playing })` on the next line
 * is guaranteed to reach Rust behind the stop.
 */
export function flushScratch(deckId: string): void {
  if (!isScratching(deckId)) return;
  clearTimeout(scratchIdleTimers[deckId]);
  delete scratchIdleTimers[deckId];
  stopScratch(deckId);
}

export async function startMidiListener(): Promise<() => void> {
  const unlisten = await listen<MidiAction>("midi-action", ({ payload: a }) => {
    const deckId = slotDeck(a.profile, a.slot);
    switch (a.type) {
      case "deck_play_toggle": {
        if (!deckId) break;
        const d = getDeck(deckId);
        if (d) {
          // The Rust side only tears down the scratch feeder branch on
          // pause()/stop_scratch(), not play() — so if scratch is still active (its idle
          // timer hasn't fired yet) when play is pressed, audio_play would leave the
          // feeder thread still driving output instead of switching back to the normal
          // branch. Not defensive and not rare: the UI's own play button lacked this and
          // lost a play outright on 2026-08-13 — see flushScratch().
          if (!d.playing) flushScratch(deckId);
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
          seekDeckExitingLoop(d.id, d.cuePoint);
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
      case "loop_in": {
        if (!deckId) break;
        const d = getDeck(deckId);
        if (!d) break;
        const t = getDeckTime(deckId);
        if (t !== null) updateDeck(d.id, { loopIn: quantizeToGrid(d.id, t) });
        break;
      }
      case "loop_out": {
        if (!deckId) break;
        const d = getDeck(deckId);
        if (!d) break;
        const t = getDeckTime(deckId);
        if (t !== null) updateDeck(d.id, { loopOut: quantizeToGrid(d.id, t) });
        break;
      }
      case "loop_halve":
      case "loop_double": {
        // Halve/double the current loop's length in place, anchored at loopIn — same
        // fixed-anchor convention loop_preset (below) already uses. No-op if there's
        // no loop set yet.
        if (!deckId) break;
        const d = getDeck(deckId);
        if (!d || d.loopIn === null || d.loopOut === null) break;
        const width = d.loopOut - d.loopIn;
        const newWidth = a.type === "loop_halve" ? width / 2 : width * 2;
        updateDeck(d.id, { loopOut: d.loopIn + newWidth });
        break;
      }
      case "beat_jump": {
        // Seek-without-loop sibling of loop_preset: jump by a fixed beat count on this
        // deck's own grid, exiting any active loop (same as a hot-cue jump). Grid-forced
        // like loop_preset — a beat jump is a grid concept by definition, independent of
        // the SNAP toggle.
        if (!deckId || a.beats === undefined) break;
        const d = getDeck(deckId);
        if (!d || d.bpm === null) break;
        const now = getDeckTime(deckId);
        if (now === null) break;
        const target = now + (a.beats * 60) / d.bpm;
        seekDeckExitingLoop(d.id, quantizeToGrid(d.id, target, true));
        break;
      }
      case "snap_toggle":
        setSnapToBeat(!get(session).snapToBeat);
        break;
      case "loop_preset": {
        // Beat Loop pads (Loop pad-mode on the controller — same 4 physical pads as hot
        // cue, index 0-7 across plain+shift). Doubling ladder 1/4..32 beats is the
        // community-standard "Beat Loop" convention (Pioneer gear and most DJ software),
        // chosen live 2026-08-22 after capturing the pad-mode's raw MIDI bytes — the
        // controller doesn't report labels, only note numbers. Mirrors DeckCard's bar
        // preset buttons exactly: keep the existing loop-in if one is set (so repeated
        // presses just change length), else start from the current position.
        if (!deckId || a.index === undefined) break;
        const d = getDeck(deckId);
        if (!d) break;
        // Loop points are positions on this deck's own content timeline, so the beat
        // length must come from the deck's own bpm — the session/master bpm is a
        // different deck's tempo (or a manual tap) and using it here misaligns
        // loopOut whenever this deck isn't running at exactly that tempo.
        if (d.bpm === null) break;
        const beats = LOOP_PRESET_BEATS[a.index];
        if (beats === undefined) break;
        const beatSec = (beats * 60) / d.bpm;
        // force=true: a Beat Loop is a grid concept by definition, independent of
        // the global SNAP toggle (which governs hot cues / manual loop points).
        const inTime = d.loopIn ?? quantizeToGrid(d.id, getDeckTime(d.id) ?? 0, true);
        updateDeck(d.id, { loopIn: inTime, loopOut: inTime + beatSec, loop: true });
        break;
      }
      case "hot_cue": {
        if (!deckId || a.index === undefined) break;
        const d = getDeck(deckId);
        if (!d) break;
        const t = d.hotCues[a.index];
        // Mirrors DeckCard's plain click: jump if the slot is already set, else set it here
        // (shift+pad, "hot_cue_set", is for moving/overwriting an already-set slot). Without
        // this branch a plain pad press on an unset slot silently did nothing over MIDI —
        // reported live 2026-08-22 as "can't set a hot cue via the controller".
        if (t !== undefined && !isNaN(t)) {
          seekDeckExitingLoop(d.id, quantizeToGrid(d.id, t));
        } else {
          const now = getDeckTime(deckId);
          if (now !== null) {
            const quantized = quantizeToGrid(d.id, now);
            const cues = [...d.hotCues];
            cues[a.index] = quantized;
            updateDeck(d.id, { hotCues: cues });
            // Without this, a cue set from the controller never reaches Digger, and the
            // next track (re)load — which seeds deck.hotCues from Digger's stored markers
            // (DiggerQueue.svelte) — silently reverts it. Reported live 2026-08-22: cues
            // set via MIDI were gone after a reload; UI-set cues (DeckCard.svelte, which
            // already pushes) survived.
            if (d.diggerTrackId !== null) {
              pushMarker(d.diggerTrackId, Math.round(quantized * 1000), 'hot_cue', `Hot cue ${a.index + 1}`).catch(console.error);
            }
          }
        }
        break;
      }
      case "hot_cue_set": {
        if (!deckId || a.index === undefined) break;
        const d = getDeck(deckId);
        if (!d) break;
        const now = getDeckTime(deckId);
        if (now !== null) {
          const quantized = quantizeToGrid(d.id, now);
          const cues = [...d.hotCues];
          cues[a.index] = quantized;
          updateDeck(d.id, { hotCues: cues });
          if (d.diggerTrackId !== null) {
            pushMarker(d.diggerTrackId, Math.round(quantized * 1000), 'hot_cue', `Hot cue ${a.index + 1}`).catch(console.error);
          }
        }
        break;
      }
      case "jog_turn": {
        if (!deckId || a.value === undefined) break;
        const d = getDeck(deckId);
        if (!d) break;
        if (!d.playing) {
          // Paused: true bidirectional scratch audio — turning the wheel forward/backward
          // plays audio forward/backward at a speed matching the wheel, like a real
          // turntable, so a beat/transient can be found by ear.
          const mode = get(scratchMode);
          if (mode === "vinyl") {
            // Accumulate revolutions into an absolute position and let the feeder servo
            // to it. Seeded from the deck's current position on the first tick of a
            // gesture; every later tick is pure displacement, so burst delivery is
            // irrelevant. See the ⚠️ note above for the 2026-08-22 ticks-per-rev→revolutions
            // change that made this a direct `get(jogSecondsPerRev)` multiply.
            const base = vinylTarget[deckId] ?? getDeckTime(deckId) ?? 0;
            if (vinylTarget[deckId] === undefined) {
              beginScrub(deckId, base, true);
              vinylTally[deckId] = { n: 0, sumRevs: 0, netRevs: 0, t0: performance.now() };
            }
            // Delivery instrumentation (scrubStats.ts). `null` because a MIDI tick arrives
            // over Tauri IPC and carries no platform event time — so this path reports
            // inter-event gaps but cannot separate "the wheel sent nothing" from "the tick
            // waited in a queue", which the pointer path can. Any gap here is therefore an
            // upper bound on delivery latency, not an attribution.
            noteScrubInput(deckId, null);
            const tally = vinylTally[deckId];
            tally.n++;
            tally.sumRevs += Math.abs(a.value);
            tally.netRevs += a.value;
            // Store what updateScrub actually accepted, not what we asked for: at a track
            // boundary those differ, and keeping the raw sum would open a silent dead zone
            // as long as the overshoot. See updateScrub's doc comment.
            vinylTarget[deckId] = updateScrub(deckId, base + a.value * get(jogSecondsPerRev));

            clearTimeout(scratchIdleTimers[deckId]);
            scratchIdleArmedAt[deckId] = performance.now();
            scratchIdleTimers[deckId] = setTimeout(() => stopScratch(deckId), SCRATCH_IDLE_MS);
            break;
          }
          // Shuttle: rate comes from tick velocity, tracked as an EMA of instantaneous
          // revs/sec — see the SCRATCH_* constants above for why (a hard rolling window
          // was tried and discarded). Free-running between ticks is the point of this
          // mode, so velocity remains the right control variable for it.
          const params = SCRATCH_MODE_PARAMS[mode];
          const now = performance.now();
          const prev = scratchVelocity[deckId];
          // No prior tick to diff against (gesture just started): seed the EMA so the
          // resulting magnitude comes out to the mode's floor rate rather than guessing
          // at a velocity from nothing — real revs/sec takes over from the next tick.
          const instRevsPerSec = prev
            ? (a.value / Math.max(SCRATCH_MIN_DT_MS, now - prev.lastT)) * 1000
            : Math.sign(a.value) * (params.minRate / params.ratePerRevPerSec);
          const emaRevsPerSec = prev
            ? prev.emaRevsPerSec * (1 - SCRATCH_EMA_ALPHA) + instRevsPerSec * SCRATCH_EMA_ALPHA
            : instRevsPerSec;
          scratchVelocity[deckId] = { lastT: now, emaRevsPerSec };

          const magnitude = Math.min(
            params.maxRate,
            Math.max(params.minRate, Math.abs(emaRevsPerSec * params.ratePerRevPerSec)),
          );
          // Fall back to this tick's own direction when the EMA sums to ~0 (e.g. a
          // direction reversal), so the deck doesn't stall silently instead of switching.
          const rate = Math.sign(emaRevsPerSec || a.value) * magnitude;

          setScratching(deckId, true);
          queueScratchRate(deckId, rate, params.holdMs);

          clearTimeout(scratchIdleTimers[deckId]);
          scratchIdleArmedAt[deckId] = performance.now();
          scratchIdleTimers[deckId] = setTimeout(() => stopScratch(deckId), SCRATCH_IDLE_MS);
          break;
        }
        if (!(deckId in jogBaseRate)) jogBaseRate[deckId] = d.playbackRate;
        // Bend magnitude tracks how fast the wheel is turning (EMA of revs/sec — see
        // "Playing-deck jog bend" above), not a fixed step per tick.
        const jogNow = performance.now();
        const prevJog = jogVelocity[deckId];
        const jogInstRevsPerSec = prevJog
          ? (a.value / Math.max(SCRATCH_MIN_DT_MS, jogNow - prevJog.lastT)) * 1000
          : Math.sign(a.value) * JOG_BEND_SEED_REVS_PER_SEC;
        const jogEmaRevsPerSec = prevJog
          ? prevJog.emaRevsPerSec * (1 - SCRATCH_EMA_ALPHA) + jogInstRevsPerSec * SCRATCH_EMA_ALPHA
          : jogInstRevsPerSec;
        jogVelocity[deckId] = { lastT: jogNow, emaRevsPerSec: jogEmaRevsPerSec };
        const bend = Math.max(-JOG_BEND_MAX, Math.min(JOG_BEND_MAX, jogEmaRevsPerSec * JOG_BEND_PER_REV_PER_SEC));
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
      // ── EQ / filter continuous controls ──────────────────────────────────────
      // Rust has already mapped the raw wire value into a real dB value / filter
      // position (see eq_db_from_bipolar / filter_from_bipolar in midi/decode.rs), so
      // there is no range maths here to drift out of sync with the sliders.
      //
      // All three EQ cases follow the continuous-control discipline used by deck_gain
      // above: straight to GStreamer for audio, rAF-throttled into the store for
      // display. Putting a knob through the Svelte store at MIDI event rate is the
      // documented way to freeze this UI (see the jog-wheel gotchas in
      // skills/midi/SKILL.md).
      case "deck_eq_low": {
        if (!deckId || a.value === undefined) break;
        const d = getDeck(deckId);
        if (!d) break;
        const eq = { ...d.eq, low: a.value };
        syncEq(deckId, eq.low, eq.mid, eq.high); // audio: immediate
        queueDeckPatch(deckId, { eq });          // UI: rAF-throttled
        break;
      }
      case "deck_eq_mid": {
        if (!deckId || a.value === undefined) break;
        const d = getDeck(deckId);
        if (!d) break;
        const eq = { ...d.eq, mid: a.value };
        syncEq(deckId, eq.low, eq.mid, eq.high);
        queueDeckPatch(deckId, { eq });
        break;
      }
      case "deck_eq_high": {
        if (!deckId || a.value === undefined) break;
        const d = getDeck(deckId);
        if (!d) break;
        const eq = { ...d.eq, high: a.value };
        syncEq(deckId, eq.low, eq.mid, eq.high);
        queueDeckPatch(deckId, { eq });
        break;
      }
      case "deck_filter":
        if (deckId && a.value !== undefined) {
          syncFilter(deckId, a.value);
          queueDeckPatch(deckId, { filter: a.value });
        }
        break;
      case "queue_cursor":
        if (a.delta !== undefined) {
          moveQueueSelection(a.delta);
          showDiggerQueue.set(true); // auto-open — a cursor move nobody can see is dead UX
        }
        break;
      case "queue_load":
        if (deckId) {
          loadSelectedQueueItem(deckId);
          showDiggerQueue.set(true);
        }
        break;
    }
  });
  return unlisten;
}
