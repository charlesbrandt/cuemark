# [GStreamer] Video element stalls near end-of-stream when playbackRate != 1.0 (fully buffered; streaming threads parked; main thread healthy)

**Summary**: With `playbackRate` slightly below 1.0 (observed at 0.87), a playing
`<video>` element can stop advancing near the end of the track and never reach
`ended`: `currentTime` freezes, `readyState` sticks at 2 (`HAVE_CURRENT_DATA`),
`networkState` sticks at 2 (`LOADING`), while `buffered` reports the **entire
duration** already buffered — ruling out any network cause. All of the element's
internal GStreamer streaming threads are parked in futex waits. The JS main thread
remains fully responsive throughout (distinguishing this from the seek deadlock
reported separately). At `playbackRate = 1.0` the identical scenario completes
cleanly every time.

WebKitGTK 2.52.3 (`libwebkit2gtk-4.1-0 2.52.3-0ubuntu0.24.04.1`), Ubuntu 24.04,
GStreamer 1.24.2, Wayland, `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

**Steps to reproduce** (~2 of 3 attempts at 0.87; 0 of many at 1.0):
1. Load an H.264 `<video>` (~4.5 min file, served over local HTTP with Range
   support), muted.
2. Set `playbackRate = 0.87`, seek near the end (e.g. 258 s of a ~264 s file), play.
3. Let it run to where the natural end should be. Failure mode: `currentTime` stops
   a few seconds before the end and never advances again; `ended` never fires; no
   `error` event; no console output.

**Observed state when stalled**:
- `currentTime`: frozen at a near-end value, indefinitely
- `paused = false`, `ended = false`, no media error
- `readyState = 2` (HAVE_CURRENT_DATA), `networkState = 2` (LOADING)
- `buffered`: single range `[0, duration]` — the file is fully downloaded
- Every internal GStreamer streaming thread for the element parked in futex waits;
  page main thread fully responsive (rAF and external JS execution keep working)

**Control**: the same file, same seek target, same code path at `playbackRate = 1.0`
reached `ended` cleanly on every attempt. The only changed variable is the rate.

**Analysis / hypothesis**: once `playbackRate != 1.0`, WebKit's `setRate` issues a
FLUSH|ACCURATE seek with `stop = GST_CLOCK_TIME_NONE` and the internal pipeline runs
with `segment.rate != 1.0`. The stall pattern (fully buffered, downstream waiting
forever near the segment boundary) suggests rate-scaled buffering/EOS bookkeeping in
a downstream element (possibly `multiqueue`'s time-level accounting) never resolves
to EOS at non-unity rates — one end condition fires in real time, the other is
computed in rate-scaled time and never fires.

**Impact**: for applications that keep long-running rate-adjusted video (DJ/VJ
software syncing video to a tempo-adjusted audio clock), every track that plays to
its natural end at an adjusted rate has a high chance of wedging the element; the
only recovery is resetting the element (`load()`).

**See also**: bug 320327 (WebCodecs `VideoEncoder` crash, same build) and bug 320329
(`currentTime` seek deadlock, same build) — separate defects found during the same
investigation.
