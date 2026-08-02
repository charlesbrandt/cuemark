#!/usr/bin/env python3
"""Reproducer for the gst-plugin-pipewire multi-sink PAUSED->PLAYING deadlock.

Builds `audiotestsrc ! tee` fanning out to N `pipewiresink` elements in a single
process, takes the pipeline to PAUSED, waits, then calls set_state(PLAYING) on a
worker thread with a watchdog. With N >= 2 the call blocks forever inside
`pw_thread_loop_lock()` (see docs/design/pipewiresink-play-hang.md).

No cuemark code is involved — this is pure GStreamer + gst-plugin-pipewire.

Observed on Ubuntu 26.04 / PipeWire 1.6.2 / GStreamer 1.28.2 (2026-08-02):

    pipewiresink x1   0/6 deadlocked
    pipewiresink x2   4/6 deadlocked
    pipewiresink x3   6/6 deadlocked
    pulsesink    x2   0/6 deadlocked
    pulsesink    x3   0/6 deadlocked

The delay between PAUSED and PLAYING matters: with no delay the race is usually
won and the run survives, which is why a bare one-shot `gst-launch-1.0` pipeline
(which goes straight to PLAYING) never reproduces it.

Usage:
    pipewiresink_multisink_deadlock.py <target-node> [nsinks] [idle-secs]

    SINK_FACTORY=pulsesink  ... to A/B against the PulseAudio compat path.

Find a target node name with `wpctl status` / `pw-cli ls Node`.

Exit status: 0 = survived, 1 = deadlock reproduced.
"""
import os
import sys
import threading
import time

import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

Gst.init(None)

target = sys.argv[1]
nsinks = int(sys.argv[2]) if len(sys.argv) > 2 else 2
idle = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
factory = os.environ.get("SINK_FACTORY", "pipewiresink")

pipeline = Gst.Pipeline.new("repro")
src = Gst.ElementFactory.make("audiotestsrc")
src.set_property("is-live", False)
tee = Gst.ElementFactory.make("tee")
pipeline.add(src)
pipeline.add(tee)
src.link(tee)

for i in range(nsinks):
    queue = Gst.ElementFactory.make("queue")
    sink = Gst.ElementFactory.make(factory)
    if sink is None:
        raise SystemExit(f"element {factory} not available")
    if factory == "pipewiresink":
        sink.set_property("target-object", target)
    else:
        sink.set_property("device", target)
    # Mirror cuemark's topology: the cue sink is async=false so it stays out of preroll.
    if i > 0:
        sink.set_property("async", False)
    pipeline.add(queue)
    pipeline.add(sink)
    tee.request_pad_simple("src_%u").link(queue.get_static_pad("sink"))
    queue.link(sink)

pipeline.set_state(Gst.State.PAUSED)
pipeline.get_state(5 * Gst.SECOND)
time.sleep(idle)

done = threading.Event()


def go():
    pipeline.set_state(Gst.State.PLAYING)
    done.set()


threading.Thread(target=go, daemon=True).start()

if not done.wait(10):
    # Leave the process alive so it can be inspected with gdb; note that until it is
    # killed, every other PipeWire client on the machine will hang too.
    print(f"{factory} x{nsinks} idle={idle}: DEADLOCK (set_state(PLAYING) blocked >10s)")
    sys.exit(1)

time.sleep(1)
ok, pos = pipeline.query_position(Gst.Format.TIME)
pipeline.set_state(Gst.State.NULL)
print(f"{factory} x{nsinks} idle={idle}: ok (pos={pos / 1e9 if ok else -1:.2f}s)")
