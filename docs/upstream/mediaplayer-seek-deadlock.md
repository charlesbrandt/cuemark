# [GStreamer] Permanent main-thread deadlock: currentTime seek during playback deadlocks against streaming thread's repaint handoff

**Summary**: Setting `video.currentTime` on a playing `<video>` element can
permanently deadlock the web process main thread inside
`MediaPlayerPrivateGStreamer`'s synchronous seek. Captured live via gdb on a hung
process: a classic AB-BA deadlock between the main thread (inside
`gst_element_send_event()` holding a GStreamer element mutex) and one of WebKit's own
internal GStreamer streaming threads (parked on a `WTF::ParkingLot` condition variable
waiting for the main thread's run loop to service a new-sample/repaint handoff).

WebKitGTK 2.52.3 (`libwebkit2gtk-4.1-0 2.52.3-0ubuntu0.24.04.1`), Ubuntu 24.04,
GStreamer 1.24.2, Wayland, `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

**Context**: the application is a VJ/live-mixing tool (Tauri 2 / WebKitGTK). A muted
`<video>` element is kept in sync with an external audio clock by periodically
assigning `video.currentTime` while the element plays at a non-1.0 `playbackRate`
(0.87–0.94 in the captured incident). The freeze is probabilistic — it appears to
require the seek to land while the internal pipeline is in a particular in-flight
state — but once it occurs it is permanent: the page's main thread never runs again
(rAF, timers, and external JS evaluation all dead), while the process sits at ~0% CPU
with every thread parked.

**Steps to reproduce** (statistical, not deterministic):
1. Play an H.264 `<video>` (served over local HTTP) with `playbackRate ≈ 0.87`.
2. Assign `video.currentTime` periodically during playback (the app did so whenever
   an external clock drifted > 80 ms from `currentTime`, i.e. every few seconds at
   this rate).
3. Within minutes to hours, the main thread deadlocks (observed ~2.5 minutes into
   playback in the captured incident).

**Evidence — thread backtraces from the hung process**
(`gdb -p <WebKitWebProcess pid> -batch -ex "thread apply all bt"`, 39 threads; key
frames below, full dump available on request):

- **Thread 1 (main)**: inside `gst_element_send_event()` → ~240 frames of
  `gst_pad_push_event` / `gst_pad_forward` / `gst_pad_event_default` fanning a seek
  event synchronously through the demux→decode→videoconvertscale graph, holding a
  GStreamer element mutex (`0x58c4e9653100`) for the duration.
- **Streaming thread `vqueue:src`** (WebKit-internal): mid `gst_pad_push_event`
  chain, reaches a `g_signal_emit` into WebKit's C++ layer and parks on a
  `WTF::ParkingLot` condition variable — waiting for the main thread's run loop to
  service the "new video sample ready → schedule repaint" handoff.
- **Four `pool-WebKitWebP` threads**: queued behind the same element mutex Thread 1
  holds, attempting `gst_bin_recalculate_latency`.

The main thread cannot complete the seek until the streaming thread acknowledges the
event; the streaming thread cannot proceed until the main thread's run loop is free —
and the main thread is blocked inside the very call preventing it from reaching that
run loop.

**Expected**: `currentTime` assignment during playback either completes or fails, but
never wedges the main thread; the sample-ready handoff to the main thread should not
be able to form a cycle with a main-thread-initiated synchronous pipeline event.

**Workaround in the app**: raising the drift threshold to 250 ms (fewer seeks) lowers
the incidence but cannot eliminate it; the app is migrating video playback off the
media element entirely.

**Related but distinct prior bugs** (checked before filing — none is a duplicate):
several GStreamer/WebKit deadlocks with a similar shape were fixed in 2024, all
before this WebKitGTK 2.52.3 build:
- Bug 260796 — qtdemux `gst_pad_pause_task` vs. `gst_download_buffer_wait_for_data`
  (fixed 2024-03)
- Bug 272912 — deadlock in `webKitWebSrcCreate` on non-flushing seeks (fixed 2024-04)
- Bug 285988 — deadlock rendering frames to canvas, OffscreenCanvas/mediastream
  (fixed 2025-01)

None of these match the mechanism here: this deadlock is a synchronous
`currentTime`-triggered `gst_element_send_event()` holding an element mutex, cycling
against a streaming thread parked on `WTF::ParkingLot` waiting for the *main thread's
run loop* to service a new-sample/repaint handoff — not a pad-task-pause or
web-src-creation lock. Flagging the prior fixes in case a triager recognizes this as
a regression of one of them; from the outside it looks like a new cycle.
