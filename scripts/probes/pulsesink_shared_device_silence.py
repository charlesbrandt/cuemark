#!/usr/bin/env python3
"""Reproducer for: N `pulsesink` elements in one process, all targeting the SAME
PipeWire/PulseAudio node, and only some of them actually get a playback stream.

Live symptom this came from (2026-08-02, docs/design/output-noise-and-track-reload-silence.md
Bug D): cuemark's main output and its headphone-cue branch were both routed to the two
halves of one 4-channel DJ controller node
(`...DJControl_Starlight-00.analog-surround-40`, main=FL,FR / cue=RL,RR). With cue
enabled, the master output went completely silent — while GStreamer reported everything
healthy: pipeline PLAYING, no bus ERROR, correct volume, and a BUFFER pad probe on the
main sink's own sink pad confirming buffers arrived continuously. `pw-dump` showed why:
only ONE real playback stream existed (the 4-channel cue one). The main sink's stream
never left GStreamer's `'pulsesink probe'` state. Toggling cue off restored master audio,
confirming the collision live.

This is the same *shape* as the `pipewiresink` multi-sink hazard already documented in
`pipewiresink_multisink_deadlock.py` / docs/design/pipewiresink-play-hang.md — two sinks
in one process on one shared node — but a different failure mode: `pipewiresink`
deadlocked loudly, `pulsesink` fails silently. The 2026-08-02 switch from pipewiresink to
pulsesink therefore did not remove that hazard, it only changed how it presents.

**The question this probe answers**, which decides the fix's shape: is the collision
specific to the *channel-remapped* cue branch (different channel counts on one node), or
does ANY second pulsesink on one node lose its stream? If the latter, then two decks
playing to one output device are broken for the same reason, and the fix has to be a
single shared sink (see `audio/mixer.rs`'s MasterMix stub), not just merging cue into main.

No cuemark code is involved — pure GStreamer + pulsesink.

Usage:
    pulsesink_shared_device_silence.py <target-node> [nsinks] [seconds]

    REMAP_LAST=1 ... make the last sink 4-channel with audio only in RL,RR, mirroring
                     cuemark's cue branch, instead of plain stereo like the others.

Find a target node name with `wpctl status` / `pw-cli ls Node`.

Exit status: 0 = every sink got a running stream, 1 = at least one sink was silent.
"""
import json
import os
import subprocess
import sys
import time

import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

Gst.init(None)

target = sys.argv[1]
nsinks = int(sys.argv[2]) if len(sys.argv) > 2 else 2
secs = float(sys.argv[3]) if len(sys.argv) > 3 else 6.0
remap_last = os.environ.get("REMAP_LAST") == "1"

# Same values cuemark's make_sink() uses, so this probes cuemark's actual configuration
# rather than pulsesink's defaults.
BUFFER_TIME_US = int(os.environ.get("BUFFER_TIME_US", 50_000))
LATENCY_TIME_US = int(os.environ.get("LATENCY_TIME_US", 10_000))


def pw_streams():
    """Real playback streams belonging to this process, as {node_id: (state, ports)}.

    Deliberately excludes GStreamer's `'pulsesink probe'` streams — those are format-probe
    streams, not audio, and counting them is exactly the mistake that makes this bug look
    like everything is fine.
    """
    try:
        dump = json.loads(subprocess.run(
            ["pw-dump"], capture_output=True, text=True, timeout=10).stdout)
    except Exception as e:  # pw-dump missing or PipeWire unreachable
        print(f"  (pw-dump unavailable: {e})")
        return {}
    ports = {}
    for o in dump:
        if o.get("type") == "PipeWire:Interface:Port":
            p = o["info"]["props"]
            ports.setdefault(p.get("node.id"), []).append(p.get("port.name"))
    out = {}
    for o in dump:
        if o.get("type") != "PipeWire:Interface:Node":
            continue
        info = o.get("info", {})
        p = info.get("props", {})
        if p.get("application.process.id") != os.getpid():
            continue
        if p.get("media.class") != "Stream/Output/Audio":
            continue
        if p.get("media.name") == "pulsesink probe":
            continue
        out[o["id"]] = (info.get("state"), sorted(ports.get(o["id"], [])))
    return out


pipeline = Gst.Pipeline.new("probe")
src = Gst.ElementFactory.make("audiotestsrc")
src.set_property("is-live", True)
src.set_property("freq", 440)
# Quiet on purpose: this probe is meant to be run against real DJ hardware, mid-session,
# quite possibly with headphones on someone's head. Audibility is not the measurement —
# pw_streams() is — so there is no reason for this to be loud.
src.set_property("volume", 0.03)
tee = Gst.ElementFactory.make("tee")
pipeline.add(src)
pipeline.add(tee)
src.link(tee)

for i in range(nsinks):
    q = Gst.ElementFactory.make("queue")
    conv = Gst.ElementFactory.make("audioconvert")
    sink = Gst.ElementFactory.make("pulsesink")
    sink.set_property("device", target)
    sink.set_property("buffer-time", BUFFER_TIME_US)
    sink.set_property("latency-time", LATENCY_TIME_US)
    sink.set_property("client-name", "cuemark-probe")
    # Mirror cuemark: only the primary sink participates in preroll.
    if i > 0:
        sink.set_property("async", False)
    for el in (q, conv, sink):
        pipeline.add(el)
    tee.link(q)
    q.link(conv)
    if remap_last and i == nsinks - 1:
        # cuemark's cue branch: an N-channel stream carrying audio only in the rear pair,
        # so PipeWire's 1:1 port connection lands it on the physical headphone output.
        caps = Gst.ElementFactory.make("capsfilter")
        caps.set_property("caps", Gst.Caps.from_string(
            "audio/x-raw,channels=4,channel-mask=(bitmask)0x33"))
        pipeline.add(caps)
        conv.link(caps)
        caps.link(sink)
    else:
        conv.link(sink)

print(f"target={target}  nsinks={nsinks}  remap_last={remap_last}  "
      f"buffer-time={BUFFER_TIME_US}us latency-time={LATENCY_TIME_US}us")

# PAUSED, settle, then PLAYING — the delayed transition is what exposed the pipewiresink
# variant of this hazard, so keep the same shape here.
pipeline.set_state(Gst.State.PAUSED)
pipeline.get_state(Gst.CLOCK_TIME_NONE)
time.sleep(0.5)
pipeline.set_state(Gst.State.PLAYING)
pipeline.get_state(Gst.CLOCK_TIME_NONE)

time.sleep(secs)
streams = pw_streams()
bus = pipeline.get_bus()
err = bus.poll(Gst.MessageType.ERROR, 0)
pipeline.set_state(Gst.State.NULL)

print(f"  bus ERROR: {err.parse_error()[0].message if err else 'none'}")
print(f"  real playback streams: {len(streams)} (expected {nsinks})")
for nid, (state, ports) in sorted(streams.items()):
    print(f"    node {nid}: state={state} ports={ports}")

ok = len(streams) == nsinks
print(f"  RESULT: {'OK' if ok else 'SILENT SINK(S) — collision reproduced'}")
sys.exit(0 if ok else 1)
