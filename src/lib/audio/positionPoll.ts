/**
 * The master clock: one in-flight `audio_get_position` IPC per deck, turned into a content
 * position both video backends and the waveform consume. Extracted from App.svelte's
 * `frame()` unchanged — read docs/design/av-sync-architecture.md before touching any of
 * the arithmetic here; every branch is a previously-fixed drift or race.
 */
import { get } from "svelte/store";
import { audioGetPosition, audioSeek } from "./pipeline";
import { averageRateOverWindow } from "./audioSync";
import { recordPollSample, maybePingIpc } from "./pollStats";
import { session } from "../state/session";
import {
  setDeckAudioTime,
  getPendingSeekTarget,
  clearPendingSeekTarget,
  type CodecPlayerHandle,
} from "../renderer/seekBus";
import { isAudioOnlyDeck } from "../video/backendRegistry";
import { resyncLegacyVideoClock } from "../video/legacyVideo";
import type { Deck } from "../state/types";

// One in-flight audioGetPosition IPC per deck. Prevents stale out-of-order responses
// from snapping video.currentTime backward when GStreamer is mid-rate-change.
const pendingPos = new Map<string, boolean>();

// Per-deck state for content-position computation from GStreamer query_position.
// query_position returns stream time based on segment.rate=1.0 (the soundtouch tempo
// property doesn't issue a rate-seek, so the GStreamer segment rate never changes).
// That means audioPos advances at 1× wall-clock regardless of deck.playbackRate.
// We integrate per-frame deltas at deck.playbackRate to recover actual content position.
// Seek detection compares the audioPos delta against the WALL-CLOCK time that actually
// elapsed since the last poll (nowMs - prev.tsMs), not a fixed 500ms magnitude — since
// audioPos is literally wall-clock, a normal (non-seek) poll always has audioPos delta
// ≈ elapsed wall time, however long that gap was. A fixed magnitude threshold
// false-positives whenever an IPC round-trip is slow (observed >300ms under Mutex
// contention, see IPC latency baseline in memory) — a "seek" misdetection snaps
// contentPos to the raw unscaled audioPos, permanently drifting the displayed position
// ahead of the true (rate-scaled) content position for the rest of playback whenever
// rate != 1.0. After a REAL seek, GStreamer immediately returns the seek target, which
// IS the correct content position, so we use it directly as the new reference.
// `tsMs` (performance.now() at the moment this entry was computed) lets the next resolution
// ask audioSync.ts's rate-history log for the time-weighted average rate actually in effect
// across the gap, instead of a single instantaneous snapshot (see averageRateOverWindow).
const contentPosTracker = new Map<string, { audioPos: number; contentPos: number; tsMs: number }>();

/** Drop a deck's integration state — on teardown, or when a new file is loaded onto it. */
export function resetPositionTracking(deckId: string): void {
  contentPosTracker.delete(deckId);
}

/**
 * Issue this tick's position poll for one deck, if one isn't already in flight. Also polls
 * while scratching: scratch runs entirely with deck.playing=false (see jog_nudge in
 * handler.ts), so without that the pipeline's audio position moves correctly but the UI
 * (timestamp, waveform playhead) sits frozen at wherever it was when the gesture started.
 *
 * `v` and `codecPlayer` are passed in rather than looked up so the resolution below acts on
 * exactly the backend this tick saw, even if the deck is torn down mid-flight. Audio is the
 * master clock for BOTH backends — codec-path decks have no `v` but still need contentPos
 * fed to setDeckAudioTime (waveform) and to the codec player's clock, so this is gated on
 * `v || codecPlayer`, not `v` alone.
 */
export function pollDeckPosition(
  deck: Deck,
  v: HTMLVideoElement | undefined,
  codecPlayer: CodecPlayerHandle | undefined,
  scratching: boolean,
): void {
  if (!(deck.playing || scratching) || !(v || codecPlayer) || pendingPos.get(deck.id)) return;

  pendingPos.set(deck.id, true);
  const capturedDeckId = deck.id;
  const pollStartMs = performance.now();
  const pollStartEpochMs = Date.now();
  maybePingIpc(); // control arm — see pollStats.ts
  audioGetPosition(deck.id).then((sample) => {
    pendingPos.delete(capturedDeckId);
    const audioPos = sample.pos;
    recordPollSample(capturedDeckId, sample, pollStartEpochMs, performance.now() - pollStartMs, scratching);
    if (audioPos === null) return;
    const nowMs = performance.now();
    let contentPos: number;
    if (scratching) {
      // During scratch, position() (Rust side) returns the feeder's live PCM-buffer
      // cursor directly — already true content position. Scratch bypasses the pitch/tempo
      // element entirely (speed comes from how fast the feeder walks the buffer), so none
      // of the wall-clock/rate integration below applies here.
      contentPos = audioPos;
    } else {
      // Recover content position from wall-clock audioPos (see contentPosTracker comment).
      const prev = contentPosTracker.get(capturedDeckId);
      const wallElapsedSec = prev ? (nowMs - prev.tsMs) / 1000 : 0;
      if (prev && Math.abs((audioPos - prev.audioPos) - wallElapsedSec) < 0.5) {
        // Use the time-weighted average rate actually in effect across
        // [prev.tsMs, nowMs], not just the rate at resolution time. During
        // active tempo/pitch adjustment the rate can change several times within
        // one poll's round trip (~140-190ms, see IPC latency baseline); applying
        // only the latest snapshot to the whole span systematically overshoots
        // contentPos while the rate is climbing (and undershoots while falling) —
        // this is what made the waveform/video position drift ahead of the audio
        // whenever tempo/pitch was actively being adjusted.
        const currentRate = get(session).decks.find((d) => d.id === capturedDeckId)?.playbackRate ?? 1.0;
        const rate = averageRateOverWindow(capturedDeckId, prev.tsMs, nowMs, currentRate);
        contentPos = prev.contentPos + (audioPos - prev.audioPos) * rate;
      } else {
        // large jump = seek. audioPos is in the seek/output domain (same
        // domain query_position always reports in, regardless of rate) — a
        // seek issued at content time C now lands the pipeline at C/rate
        // (DeckAudioPipeline::seek() divides by rate before calling
        // GStreamer, since `pitch` scales seek positions by tempo — see
        // docs/design/rate-position-drift.md, "seek-domain scaling bug"),
        // so query_position reads back ≈ C/rate right after. Scale by the
        // current rate to recover the true content position; using a plain
        // snapshot (not averageRateOverWindow) is correct here because a
        // seek is a discontinuity — there's no meaningful "previous content
        // position" to integrate a rate change across.
        const seekRate = get(session).decks.find((d) => d.id === capturedDeckId)?.playbackRate ?? 1.0;
        contentPos = audioPos * seekRate;
      }
      // Filter out stale pre-seek IPC responses. On a heavy video, GStreamer
      // can take >1s to complete a seek, returning the pre-seek position the
      // whole time. If a seek is pending and contentPos is far from the seek
      // target, this IPC was in flight before the seek took effect — skip it.
      const seekTarget = getPendingSeekTarget(capturedDeckId);
      if (seekTarget !== undefined) {
        if (Math.abs(contentPos - seekTarget) > 0.5) return; // stale
        clearPendingSeekTarget(capturedDeckId); // seek complete
      }
    }
    contentPosTracker.set(capturedDeckId, { audioPos, contentPos, tsMs: nowMs });
    setDeckAudioTime(capturedDeckId, contentPos); // feeds waveform playhead — cheap, no WebKit cost
    // No v.currentTime writes at all during scratch — see the scratch-freeze
    // investigation in docs/design/pcm-buffer-playback.md, 2026-07-23. A 150ms
    // throttle (tried first) didn't help and measurably made a live-hardware
    // freeze worse (4.4s -> 12.3s), and debug instrumentation (rAF heartbeat +
    // idle-timer arm/fire timing) then proved the WebKit JS main thread itself
    // was frozen solid for ~7s after a gesture ended, with Rust completely idle
    // throughout and no single v.currentTime write ever measured >5ms — i.e. not
    // a slow synchronous write, but WebKit's own internal (non-Rust) video decode
    // pipeline blocking its main loop, apparently regardless of write frequency.
    // Video doesn't need frame-accurate tracking during a fast jog — audio (the
    // real cueing signal) is already exact via the independent PCM feeder — so
    // don't touch the video element's clock at all until scratch ends; the
    // non-scratch branch below then does one normal snap to resync it.
    //
    // Threshold widened 80ms -> 250ms (2026-07-24): this write is a <video> seek,
    // i.e. exactly the gst_element_send_event() call a live gdb backtrace caught
    // WebKitGTK's own main thread deadlocked inside (see "Ninth mechanism",
    // docs/design/pcm-buffer-playback.md) — a real bug in WebKitGTK's
    // MediaPlayerPrivateGStreamer, not something fixable on the cuemark/Rust side.
    // This resync fires on every position-poll resolution for as long as any deck
    // plays at a non-1.0 rate (not just during scratch), so it's the most frequent
    // source of these seeks. Widening the tolerance is a mitigation, not a fix —
    // it cuts how often the deadlock's trigger condition (a seek landing while the
    // video pipeline is mid-flight) can occur. 250ms of AV drift is imperceptible
    // for VJ visuals synced by eye to a beat, unlike e.g. lip-synced dialogue.
    if (!scratching && v && !isAudioOnlyDeck(capturedDeckId) && Math.abs(v.currentTime - contentPos) > 0.25) {
      resyncLegacyVideoClock(capturedDeckId, v, contentPos);
    }
    if (codecPlayer) {
      // Codec-path decks have no <video> ontimeupdate, so this poll is where
      // the deck's custom loop (loopIn/loopOut) re-anchors the audio clock —
      // mirrors the legacy v.ontimeupdate branch in legacyVideo.ts exactly, just
      // driven by the poll instead of a <video> event.
      const d = get(session).decks.find((dd) => dd.id === capturedDeckId);
      if (!scratching && d?.loop && d.loopIn !== null && d.loopOut !== null && contentPos >= d.loopOut) {
        codecPlayer.notifyLoopWrap(d.loopIn);
        audioSeek(capturedDeckId, d.loopIn).catch(console.error);
      } else {
        codecPlayer.setClock(contentPos, d?.playing ?? false);
      }
    }
  }).catch(() => { pendingPos.delete(capturedDeckId); });
}
