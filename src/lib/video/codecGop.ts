/**
 * GOP selection for the scrub frame-fill (docs/design/codec-frame-cache.md §3).
 *
 * Its own module rather than a function inside codecWorker.ts purely so it is testable:
 * codecWorker.ts installs `self.onmessage` at import time and cannot be loaded outside a
 * Worker.
 *
 * ⚠️ **This selects the GOP *containing* a position, not the one before it** (changed
 * 2026-08-13 after the first live run). The original reverse-only design asked for "the GOP
 * below everything held", which structurally could not serve a gesture that changed
 * direction: the primary decoder only ever covers forward-from-where-it-is-parked, and
 * during a scrub it does not move at all, so whichever direction it happened to cover was
 * the only one that worked. Asking for "the GOP the gesture is in" is direction-agnostic and
 * subsumes both cases. See §3, "Why this is not direction-specific".
 *
 * The one rule with a non-obvious failure mode is the length cap: every fill decodes its
 * whole GOP from the keyframe forward, because that is the only way to reach any frame
 * inside it, so GOP length *is* the entire CPU bill. Real files here run ~250 frames
 * (measured keyframe intervals of 8.34s and 10.0s); a single-keyframe encode would be
 * minutes of software decode and must be declined rather than attempted slowly.
 */
export interface Keyframe {
  auIndex: number;
  ptsUs: number;
}

export interface GopSelection {
  /** First AU to feed — always a keyframe. */
  startAu: number;
  /** One past the last AU of this GOP (next keyframe's index, or auCount). */
  endAu: number;
  /** The keyframe's presentation timestamp — the low edge of the region covered. */
  startPtsUs: number;
  /** Next keyframe's pts, or the track duration for the final GOP — the high edge. */
  endPtsUs: number;
}

export type GopRefusal = { refused: string };

export function isRefusal(r: GopSelection | GopRefusal): r is GopRefusal {
  return "refused" in r;
}

/**
 * The GOP containing `atUs`, or why there isn't one worth decoding.
 *
 * @param durationUs used as the final GOP's high edge; the subsample step is derived from
 *        the span, so a wrong value here makes the last GOP's retained frames unevenly
 *        spaced, nothing worse.
 * @param maxGopAus refuse GOPs longer than this many access units.
 */
export function gopContaining(
  keyframes: readonly Keyframe[],
  auCount: number,
  durationUs: number,
  atUs: number,
  maxGopAus: number,
): GopSelection | GopRefusal {
  let kfIdx = -1;
  for (let i = 0; i < keyframes.length; i++) {
    if (keyframes[i].ptsUs <= atUs) kfIdx = i;
    else break; // keyframes are pts-ascending, so the first one past the target ends it
  }
  if (kfIdx < 0) {
    // Before the first keyframe. Real files start one at pts 0, so this is either a
    // negative target (clamped elsewhere) or a demuxer that found nothing.
    if (keyframes.length === 0) return { refused: "no-keyframes" };
    return { refused: "before-first-keyframe" };
  }

  const kf = keyframes[kfIdx];
  const next = keyframes[kfIdx + 1];
  const endAu = next ? next.auIndex : auCount;
  const endPtsUs = next ? next.ptsUs : Math.max(kf.ptsUs + 1, durationUs);
  const gopAus = endAu - kf.auIndex;
  if (gopAus <= 0) return { refused: "empty-gop" };
  if (gopAus > maxGopAus) return { refused: `gop-too-long(${gopAus})` };

  return { startAu: kf.auIndex, endAu, startPtsUs: kf.ptsUs, endPtsUs };
}
