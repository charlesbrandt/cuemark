import { get, writable } from 'svelte/store';
import { audioSeek, audioScratchTo, audioStopScratch } from '../audio/pipeline';
import {
  beginScrubGesture,
  endScrubGesture,
  noteScrubDispatch,
  noteScrubDispatchResult,
  noteScrubFlushRan,
  noteScrubFlushScheduled,
  noteScrubThrottleSkip,
  noteScrubWentSilent,
} from '../audio/scrubStats';
import { session } from '../state/session';

// Which decks are mid-scratch-gesture right now. Scratch runs entirely while
// deck.playing is false, so consumers that gate continuous work on deck.playing
// (App.svelte's position poll, WaveformCanvas's redraw loop) need this to also cover
// scratch — otherwise the audio scrubs correctly but the UI (timestamp, waveform
// playhead) sits frozen at the pre-scratch position the whole gesture.
export const scratchingDecks = writable<Set<string>>(new Set());

export function setScratching(deckId: string, active: boolean): void {
  // Guard BEFORE calling update()/set(), not inside it: Svelte's writable store equality
  // check (safe_not_equal) treats any object/Set value as always "changed", even when the
  // callback returns the exact same reference — so a guard inside update() never actually
  // skips notification, it just skips the copy. Every setScratching() call (once per MIDI
  // jog tick, ~2-30+/sec depending on controller/gesture) was therefore notifying all
  // subscribers regardless of whether membership changed, re-running WaveformCanvas's
  // $effect (and its unthrottled draw() at the top, before the redraw-rate gate) at MIDI
  // tick rate — confirmed via isolated $effect probes during a live scratch gesture
  // (2026-07-23): scratchingOnlyRuns reached 265 across a gesture with ~10 real ticks.
  if (active === get(scratchingDecks).has(deckId)) return;
  scratchingDecks.update((s) => {
    const next = new Set(s);
    if (active) next.add(deckId); else next.delete(deckId);
    return next;
  });
}

export function isScratching(deckId: string): boolean {
  return get(scratchingDecks).has(deckId);
}

// Minimal shape codecPlayer.ts's CodecPlayer satisfies — kept structural here (rather than
// importing the class) so seekBus.ts, used by every deck-control call site (DeckCard hot
// cues/loop/cue-point), doesn't need to know about the WebCodecs path's implementation,
// only that a codec-path deck has a per-deck "backend" registered here instead of a
// <video> element. See docs/design/webcodecs-video-path.md phase 2.
export interface CodecPlayerHandle {
  seek(t: number): void;
  getFrameForTime(t: number): VideoFrame | null;
  setClock(contentPos: number, playing: boolean): void;
  setLoop(bounds: { inPos: number; outPos: number } | null): void;
  notifyLoopWrap(loopInPos: number): void;
  destroy(): void;
  readonly codedWidth: number;
  readonly codedHeight: number;
}
const codecPlayers = new Map<string, CodecPlayerHandle>();

export function registerCodecPlayer(deckId: string, player: CodecPlayerHandle): void {
  codecPlayers.set(deckId, player);
}

export function unregisterCodecPlayer(deckId: string): void {
  codecPlayers.delete(deckId);
}

export function getCodecPlayer(deckId: string): CodecPlayerHandle | undefined {
  return codecPlayers.get(deckId);
}

export function codecPlayerDeckIds(): string[] {
  return [...codecPlayers.keys()];
}

const els = new Map<string, HTMLVideoElement>();
// Audio clock positions updated by the RAF loop from GStreamer IPC.
// The waveform reads these rather than video.currentTime, which drifts between
// IPC-driven snaps when tempo ≠ 1.0.
const audioTimes = new Map<string, number>();
// When a seek is in flight, holds the target position (plus when it was issued) so the
// RAF loop can filter out stale pre-seek GStreamer position responses. Heavy videos can
// take >1s to complete a seek; during that time audioGetPosition returns the old position.
//
// Bug found live 2026-07-25 (matches the user's own "waveform position stopped tracking
// while audio/video kept playing" report, reproduced headlessly via seek-while-playing at
// non-1.0 rate): the distance check below (`> 0.5s away = stale, discard`) assumes a stale
// reading is BEHIND the target and a real post-seek reading will land close to it. That
// only holds for "seek then stay still." For "seek while playing" — the normal case — real
// playback keeps advancing the position past the target the moment the seek actually
// lands. If the very first post-seek reading arrives after the position has already moved
// more than 0.5s past the target (slow seek, or several seeks fired in quick succession),
// it gets wrongly discarded as "stale" — and since the target is never cleared, EVERY
// subsequent reading forever after does too, permanently freezing the waveform's cached
// position while GStreamer and the <video> element keep advancing underneath. Fix: give up
// on the distance check after SEEK_STALE_TIMEOUT_MS and accept whatever comes back next —
// a reading that old is far more likely to be a legitimate advanced position than a
// genuinely stale pre-seek one, and a wrong one-frame reading self-corrects on the next
// poll, unlike the permanent freeze this replaces.
const SEEK_STALE_TIMEOUT_MS = 1500;
const pendingSeekTarget = new Map<string, { time: number; setAtMs: number }>();

export function registerVideoEl(deckId: string, el: HTMLVideoElement) {
  els.set(deckId, el);
}

export function unregisterVideoEl(deckId: string) {
  els.delete(deckId);
  audioTimes.delete(deckId);
  pendingSeekTarget.delete(deckId);
  // A scrub target outranks the audio clock in getDeckTime(), so one left behind by a
  // deck torn down mid-gesture would pin the playhead there for good.
  scrubTargets.delete(deckId);
  scrubSilent.delete(deckId);
  pendingScrub.delete(deckId);
  lastSilentSeekMs.delete(deckId);
  // No-op unless a gesture was in flight, which is the case worth covering: a deck torn
  // down mid-drag would otherwise leave its samples behind for the next gesture to inherit.
  endScrubGesture(deckId);
}

export function seekDeck(deckId: string, time: number) {
  const el = els.get(deckId);
  if (el) el.currentTime = time;
  // Codec-path decks (no <video> element) route the same seek to their worker instead —
  // reset()+configure(), feed from the nearest keyframe <= target (see codecWorker.ts).
  codecPlayers.get(deckId)?.seek(time);
  // Delete rather than set: getDeckTime falls back to v.currentTime (which equals `time`
  // immediately after the seek above). Setting to `time` would block the fallback and
  // leave the waveform stuck at the seek position if the GStreamer IPC gets stuck in
  // the EOS→seek→play transition.
  audioTimes.delete(deckId);
  // Record seek target so the RAF loop can ignore stale pre-seek IPC responses.
  pendingSeekTarget.set(deckId, { time, setAtMs: performance.now() });
  audioSeek(deckId, time).catch(console.error);
}

export function setDeckAudioTime(deckId: string, t: number): void {
  audioTimes.set(deckId, t);
}

export function getDeckTime(deckId: string): number | null {
  // A live scrub target outranks everything: it is where the user is pointing *now*,
  // while every other source here is a measurement of where the audio has got to. The
  // position poll is a 140-190ms IPC round trip (see the IPC latency baseline), so
  // deferring to it during a drag would make the waveform visibly trail the pointer and
  // the gesture feel like it was fighting back. The audio servo trails the target
  // slightly instead, which is what a record does.
  const scrub = scrubTargets.get(deckId);
  if (scrub !== undefined) return scrub;
  // Prefer the audio clock (updated from GStreamer IPC each frame).
  // Falls back to video.currentTime when not playing (paused/stopped).
  const at = audioTimes.get(deckId);
  if (at !== undefined) return at;
  const el = els.get(deckId);
  if (el) return el.currentTime;
  // Codec-path decks (webcodecs) register no <video> element, so they have no
  // equivalent of the el.currentTime fallback above — which is what makes a legacy
  // deck's seekDeck() safe to call right after audioTimes.delete(): el.currentTime
  // already reads back the seek target immediately, before any IPC round-trip lands.
  // Without it, this returned null and every caller does `?? 0`, which visibly snaps
  // the waveform/playhead back to the start of the track for a frame or more. That
  // window opens on every silent (playing-deck) scrub: endScrub() calls
  // setDeckAudioTime(final) and then seekDeck(final) in the same tick, and seekDeck()
  // unconditionally deletes audioTimes again right after. Reported live 2026-08-08
  // ("dragging a playing track" briefly shows position back at the beginning, then
  // resumes near where it was). pendingSeekTarget already tracks the in-flight seek for
  // exactly this kind of staleness handling elsewhere in this file — reuse it as the
  // last-resort answer instead of falling through to null.
  const pending = pendingSeekTarget.get(deckId);
  if (pending !== undefined) return pending.time;
  return null;
}

// ── Scrub: direct-manipulation position control ────────────────────────────────────
//
// One path shared by the waveform drag (WaveformCanvas) and vinyl-mode jog (midi/
// handler.ts), because they are the same gesture arriving through different hardware:
// something the user is physically moving, whose *position* is the signal.
//
// Position, specifically — not velocity. Both inputs deliver their events in bursts
// (USB MIDI ticks; rAF-coalesced pointer moves), which is fatal to a velocity estimate:
// the inter-event interval it has to divide by is an artefact of delivery timing rather
// than of how far the user moved, and nothing downstream can correct the resulting error
// because no absolute reference exists. An absolute target has neither problem, and it
// makes the rAF coalescing below lossless — the newest target supersedes the older ones
// instead of discarding motion the way coalescing a *rate* does.

/** Live target per deck, in content seconds. Presence here means "a scrub is in progress". */
const scrubTargets = new Map<string, number>();
/**
 * Decks scrubbing silently — a playing deck (the audible path owns the paused scratch
 * topology), or one whose file has no PCM buffer. These route to seekDeck() instead.
 */
const scrubSilent = new Set<string>();
const pendingScrub = new Map<string, number>();
let scrubFlushPending = false;

/**
 * `hold_ms` backstop for position-mode scratch. In position mode silence comes from the
 * cursor reaching the target, not from this timer (see SCRATCH_TARGET_EPSILON_FRAMES in
 * pipeline.rs), so this only needs to be long enough never to fire mid-gesture — it is
 * purely insurance against a caller that stops updating without calling endScrub().
 */
const SCRUB_HOLD_MS = 1000;

/**
 * Minimum gap between seeks on the *silent* scrub path. The audible path needs no such
 * limit — after the first call `audio_scratch_to` is just an atomic store, so it is safe
 * at rAF rate — but a silent scrub issues a real FLUSH seek per update, and 60/s of those
 * on a playing deck is the seek congestion this pipeline has stalled on before (see the
 * scratch-vs-seek discussion in docs/design/jog-scratch-audio.md). Costs nothing visually:
 * getDeckTime() reports the target, so the playhead still tracks the pointer at full rate
 * and only the audio catches up in steps.
 */
const SILENT_SCRUB_SEEK_MS = 50;
const lastSilentSeekMs = new Map<string, number>();

/**
 * Begin a scrub at `anchorSecs` (normally the deck's current position). Deliberately
 * sends no IPC and moves nothing: a press that never turns into a drag must leave the
 * track exactly where it was.
 *
 * `audible` engages the PCM scratch feeder for turntable-style scrub audio, which
 * requires the paused scratch topology — pass false for a playing deck, and updates
 * become plain seeks with playback left running.
 */
export function beginScrub(deckId: string, anchorSecs: number, audible: boolean): void {
  scrubTargets.set(deckId, anchorSecs);
  // Delivery instrumentation: buffered in memory and emitted at endScrub/cancelScrub, so it
  // adds no IPC to the path it is timing. See scrubStats.ts for how to read the legs.
  beginScrubGesture(deckId, audible);
  if (audible) {
    scrubSilent.delete(deckId);
    // Wakes WaveformCanvas's redraw loop and App.svelte's position poll, both of which
    // gate on deck.playing — and an audible scrub runs entirely with playing=false.
    setScratching(deckId, true);
  } else {
    scrubSilent.add(deckId);
  }
}

/**
 * Move the live target. Clamped to the track, coalesced to one IPC call per frame.
 *
 * **Returns the clamped target**, which a caller accumulating its own displacement (the
 * vinyl jog) must feed back into its accumulator. Otherwise the two diverge at a track
 * boundary: jogging backward past 0:00 keeps driving the accumulator negative while the
 * real target sits pinned at 0, and jogging forward again then does nothing at all until
 * the accumulator has climbed back through however far it overshot — a silent dead zone
 * exactly as long as the overshoot, with the deck sitting still and `arrived` (silent).
 */
export function updateScrub(deckId: string, targetSecs: number): number {
  if (!scrubTargets.has(deckId)) return targetSecs;
  const deck = get(session).decks.find((d) => d.id === deckId);
  const duration = deck?.source?.type === 'video' ? deck.source.duration : 0;
  const clamped = Math.max(0, duration > 0 ? Math.min(duration, targetSecs) : targetSecs);
  scrubTargets.set(deckId, clamped);

  pendingScrub.set(deckId, clamped);
  if (scrubFlushPending) return clamped;
  scrubFlushPending = true;
  noteScrubFlushScheduled();
  requestAnimationFrame(() => {
    // Before the try/finally bookkeeping below: this closes the rafWait leg, and how long
    // this callback waited is exactly what a stalled rAF has to be able to report.
    noteScrubFlushRan();
    // Ahead of the loop (only the instrument line above precedes it, and that is pure
    // arithmetic that cannot throw): a throw from any one deck's dispatch below must not
    // leave this latched. It is a module-level flag, so a single missed reset wedges *every*
    // deck's scrub for the life of the page — updateScrub() would keep returning at the
    // `if (scrubFlushPending)` guard above, the feeder would stop receiving targets, and the
    // gesture would fall silent with no error anywhere.
    scrubFlushPending = false;
    for (const [id, target] of pendingScrub) {
      if (scrubSilent.has(id)) {
        const now = performance.now();
        if (now - (lastSilentSeekMs.get(id) ?? -Infinity) >= SILENT_SCRUB_SEEK_MS) {
          lastSilentSeekMs.set(id, now);
          noteScrubDispatch(id); // no promise to time on this path; ipc reads as `—`
          seekDeck(id, target);
        } else {
          noteScrubThrottleSkip(id);
        }
        // Dropping an intermediate seek is safe here and nowhere else in this file: the
        // target is absolute, so the next one supersedes it. endScrub() always issues the
        // final position unthrottled, so the deck cannot come to rest short of it.
      } else {
        const token = noteScrubDispatch(id);
        audioScratchTo(id, target, SCRUB_HOLD_MS)
          .then(() => noteScrubDispatchResult(id, token, true))
          .catch((err) => {
            noteScrubDispatchResult(id, token, false);
            // Chiefly "no PCM buffer decoded" — a file whose decode failed or hasn't
            // finished. Degrade to a silent seek scrub for the rest of the gesture rather
            // than dropping the user's input on the floor.
            console.warn(`[scrub/${id}] falling back to silent seek scrub:`, err);
            noteScrubWentSilent(id);
            scrubSilent.add(id);
            seekDeck(id, target);
          });
      }
    }
    pendingScrub.clear();
  });
  return clamped;
}

/**
 * End the gesture and settle the deck on the final target. With SNAP on, the landing
 * position is quantized to the deck's beat grid — the same treatment hot cues and clicks
 * already get via quantizeToGrid().
 */
export function endScrub(deckId: string): Promise<void> {
  const target = scrubTargets.get(deckId);
  if (target === undefined) return Promise.resolve();
  const wasSilent = scrubSilent.has(deckId);
  const final = quantizeToGrid(deckId, target);
  // Emits the whole gesture's buffered delivery timing in one burst. Deliberately here
  // rather than during the gesture — see scrubStats.ts's "nothing is logged during the
  // gesture". Before the stop IPC below, so the log lines cannot be delayed behind it.
  endScrubGesture(deckId);

  // Publish before clearing the target, so getDeckTime() hands straight over to the
  // audio clock at the final position instead of momentarily reading a stale one and
  // making the playhead jump back a frame before the next poll lands.
  setDeckAudioTime(deckId, final);
  scrubTargets.delete(deckId);
  scrubSilent.delete(deckId);
  pendingScrub.delete(deckId);
  lastSilentSeekMs.delete(deckId);

  if (wasSilent) {
    seekDeck(deckId, final);
    return Promise.resolve();
  }
  setScratching(deckId, false);
  // stop_scratch() resyncs the normal branch to wherever the feeder's cursor landed, so
  // an extra seek is only needed when SNAP moved the landing position off the cursor.
  // Sequenced after the stop rather than raced against it — the stop performs its own
  // flush seeks, and a seek issued into that window would be fighting them.
  const needsSeek = Math.abs(final - target) > 0.001;
  return audioStopScratch(deckId)
    .catch(console.error)
    .finally(() => { if (needsSeek) seekDeck(deckId, final); });
}

/**
 * Abandon a scrub without settling the deck anywhere — the press-that-was-really-a-click
 * path. Correct precisely because `beginScrub()` sends no IPC and moves nothing: if no
 * update ever followed, there is no feeder to stop and no position to land on, so this is
 * pure state cleanup and the caller is free to do something else entirely (a needle-drop
 * seek) with the same press.
 */
export function cancelScrub(deckId: string): void {
  if (!scrubTargets.has(deckId)) return;
  // A press that never moved recorded no samples, so this emits nothing — but it must still
  // run, or the gesture state would leak into the next one and inflate its input gaps.
  endScrubGesture(deckId);
  const wasSilent = scrubSilent.has(deckId);
  scrubTargets.delete(deckId);
  scrubSilent.delete(deckId);
  pendingScrub.delete(deckId);
  lastSilentSeekMs.delete(deckId);
  if (!wasSilent) setScratching(deckId, false);
}

/** True while a scrub gesture is in progress on this deck. */
export function isScrubbing(deckId: string): boolean {
  return scrubTargets.has(deckId);
}

/** The live scrub target in content seconds, or undefined when no scrub is in progress. */
export function getScrubTarget(deckId: string): number | undefined {
  return scrubTargets.get(deckId);
}

export function getVideoEl(deckId: string): HTMLVideoElement | undefined {
  return els.get(deckId);
}

// Returns the pending seek target if a seek is in progress AND still within
// SEEK_STALE_TIMEOUT_MS of being issued; undefined otherwise (no pending seek, or one
// old enough that the RAF loop should stop distance-filtering and trust the next
// reading — see the comment on pendingSeekTarget above).
export function getPendingSeekTarget(deckId: string): number | undefined {
  const pending = pendingSeekTarget.get(deckId);
  if (pending === undefined) return undefined;
  if (performance.now() - pending.setAtMs > SEEK_STALE_TIMEOUT_MS) {
    pendingSeekTarget.delete(deckId);
    return undefined;
  }
  return pending.time;
}

// Clears the pending seek flag once the first valid post-seek IPC arrives.
export function clearPendingSeekTarget(deckId: string): void {
  pendingSeekTarget.delete(deckId);
}

// Returns the deck's current beat phase in [0, 1) relative to its downbeat anchor.
// 0.0 = on the beat, 0.5 = halfway between beats.
// Returns null if downbeat or bpm is unset, or if no position is available.
export function getPhase(deckId: string): number | null {
  const deck = get(session).decks.find((d) => d.id === deckId);
  if (!deck || deck.downbeat === null || deck.bpm === null) return null;
  const t = getDeckTime(deckId);
  if (t === null) return null;
  const beatPeriod = 60 / deck.bpm;
  const raw = (t - deck.downbeat) / beatPeriod;
  return ((raw % 1) + 1) % 1; // always [0, 1) even when t < downbeat
}

// Quantizes t to the nearest beat on deck's grid when snapToBeat is on and the
// deck has a fitted grid (bpm + downbeat); otherwise returns t unchanged.
export function quantizeToGrid(deckId: string, t: number): number {
  if (!get(session).snapToBeat) return t;
  const deck = get(session).decks.find((d) => d.id === deckId);
  if (!deck || deck.bpm === null || deck.downbeat === null) return t;
  const period = 60 / deck.bpm;
  const k = Math.round((t - deck.downbeat) / period);
  return Math.max(0, deck.downbeat + k * period);
}
