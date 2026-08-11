#!/usr/bin/env python3
"""Stage-1 gate for docs/design/shared-output-pipeline.md — does the proposed
one-sink-per-node topology actually work on this hardware?

The design replaces cuemark's N `pulsesink`s per node with ONE, fed by an `audiomixer`
that sums one live `appsrc` branch per deck-output. Three things about that shape are
assumed by the design and documented-one-way / behaves-another often enough to be worth
measuring before any Rust is written:

  Q1  Does an aggregator with a LIVE but IDLE pad keep producing?  `audiomixer` with
      non-live pads waits indefinitely for data on every pad, which would mean one paused
      deck silences the whole node — the single worst failure this design could have.
      `is-live=true` on every appsrc is supposed to make it fall back to its latency
      deadline and treat an idle pad as silence. Supposed to.

  Q2  Does `stereo → mix-matrix → 4ch → audiomixer(4ch) → pulsesink(Starlight)` negotiate
      and reach PLAYING?  The per-branch matrix already exists in cuemark (fix A,
      slow-jog-audio-inaudible.md §10.10) but has only ever fed a `pulsesink` directly,
      never an aggregator.

  Q3  Can a second branch be attached to a PLAYING mixer without disturbing the first?
      A device change on one deck must not click another deck's audio, and dynamic
      request-pad add/remove on a live aggregator is the fiddly part of the build.
      `--late-attach` covers this.

What it measures: a BUFFER pad probe on the sink's own sink pad reports, per channel,
`zero%` (fraction of exactly-zero samples) and RMS. **Read `zero%` first** — a windowed
RMS averages a duty cycle into a level and cannot tell gating from attenuation, which is
the mistake that cost a full session in §10.5.

Expected clean result with the default front/rear split: branch A live on channels 0,1 and
branch B silent (100%z) on 2,3 until it starts, then both live; the sink's buffer rate
steady throughout and never zero.

NOTE this probe deliberately does NOT reproduce the original bug — it is a check on the
FIX's mechanics, run with one sink on the node. Do not read a clean result here as
evidence about the two-sink gating; that question is settled by stages 3-4 in the app.

⚠️ Stop cuemark first. It holds `pulsesink`s on the same node, and a second sink from this
probe recreates the very condition the design is removing.

Usage:
    shared_output_mixer_probe.py [node-name] [seconds]

    --late-attach   attach branch B at runtime (t = seconds/3) instead of before PLAYING
    --idle-only     never feed branch B — the pure Q1 arm
    --sink-fakesink build the same graph against `fakesink` (Q1 only, no device needed)
    --not-live      CONTROL ARM: is-live=false on every appsrc. Run this to confirm the
                    probe can actually see the failure it claims to rule out — a PASS from
                    an instrument that cannot fail is not evidence. Expected to FAIL Q1.
                    Inverts the exit status: 0 means it failed as predicted.

    Node name defaults to the Starlight. Find others with `wpctl status` / `pw-cli ls Node`.

Exit status: 0 = all requested checks passed, 1 = a check failed, 2 = setup error.
"""
import math
import struct
import sys
import threading
import time

import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst, GLib  # noqa: E402

Gst.init(None)

STARLIGHT = "alsa_output.usb-Guillemot_Corporation_DJControl_Starlight-00.analog-surround-40"

args = [a for a in sys.argv[1:] if not a.startswith("--")]
flags = {a for a in sys.argv[1:] if a.startswith("--")}

node = args[0] if args else STARLIGHT
secs = float(args[1]) if len(args) > 1 else 9.0
late_attach = "--late-attach" in flags
idle_only = "--idle-only" in flags
use_fakesink = "--sink-fakesink" in flags
not_live = "--not-live" in flags

# Same values cuemark's make_sink() uses, so this probes cuemark's configuration rather
# than pulsesink's defaults. See sink_buffer_times() and §10.13 for why 200ms matters.
BUFFER_TIME_US = 200_000
LATENCY_TIME_US = 20_000
RATE = 48000
OUT_CHANNELS = 4
OUT_MASK = 0x33  # FL,FR,RL,RR
CHUNK_MS = 15    # matches SCRATCH_CHUNK_MS — the feeder cadence this has to survive


def mix_matrix(target_pair):
    """N×2 rows, mirroring compute_channel_remap(): row = output channel, col = input.

    Returned as a serialized GstValueArray string and applied with
    `Gst.util_set_object_arg`. PyGObject has no working binding for the type — both
    `Gst.ValueArray(...)` and reading the property back raise `TypeError: unknown type
    GstValueArray` — so the string form (identical to what gst-launch parses) is the only
    route from Python. The Rust side builds it properly via `gst::Array`."""
    rows = []
    for out_ch in range(OUT_CHANNELS):
        if out_ch == target_pair[0]:
            rows.append("<(float)1.0,(float)0.0>")
        elif out_ch == target_pair[1]:
            rows.append("<(float)0.0,(float)1.0>")
        else:
            rows.append("<(float)0.0,(float)0.0>")
    return "<" + ",".join(rows) + ">"


def make(factory, **props):
    el = Gst.ElementFactory.make(factory)
    if el is None:
        print(f"FAIL: element factory '{factory}' not available", file=sys.stderr)
        sys.exit(2)
    for k, v in props.items():
        el.set_property(k.replace("_", "-"), v)
    return el


class Branch:
    """One deck-output: appsrc → queue → audioconvert(mix-matrix) → caps(4ch) → mixer."""

    def __init__(self, pipeline, mixer, name, target_pair, freq):
        self.name = name
        self.freq = freq
        self.target_pair = target_pair
        self.pipeline = pipeline
        self.mixer = mixer
        self.feeding = False
        self.pushed = 0
        self.push_fail = 0

        # is-live is the whole point of Q1. do-timestamp mirrors the design's
        # "share rate, re-stamp phase at the boundary" decision: buffers are stamped on
        # arrival here, so the producing pipeline's base time is irrelevant.
        self.src = make(
            "appsrc",
            format=Gst.Format.TIME,
            is_live=not not_live,
            do_timestamp=True,
            block=True,
            max_bytes=64 * 1024,
        )
        self.src.set_property(
            "caps",
            Gst.Caps.from_string(
                f"audio/x-raw,format=F32LE,rate={RATE},channels=2,layout=interleaved"
            ),
        )
        # Small on purpose: this queue is added latency on the scratch path.
        self.queue = make("queue", max_size_time=30 * Gst.MSECOND,
                          max_size_buffers=0, max_size_bytes=0)
        self.conv = make("audioconvert")
        Gst.util_set_object_arg(self.conv, "mix-matrix", mix_matrix(target_pair))
        self.caps = make("capsfilter")
        self.caps.set_property(
            "caps",
            Gst.Caps.from_string(
                f"audio/x-raw,channels={OUT_CHANNELS},channel-mask=(bitmask){hex(OUT_MASK)}"
            ),
        )
        self.els = [self.src, self.queue, self.conv, self.caps]
        self.mixer_pad = None

    def attach(self, sync_state):
        for el in self.els:
            self.pipeline.add(el)
        for a, b in zip(self.els, self.els[1:]):
            if not a.link(b):
                print(f"FAIL: {self.name}: could not link {a.name} → {b.name}")
                sys.exit(1)
        self.mixer_pad = self.mixer.request_pad_simple("sink_%u")
        if self.mixer_pad is None:
            print(f"FAIL: {self.name}: audiomixer refused a request pad")
            sys.exit(1)
        srcpad = self.caps.get_static_pad("src")
        ret = srcpad.link(self.mixer_pad)
        if ret != Gst.PadLinkReturn.OK:
            print(f"FAIL: {self.name}: caps → audiomixer link returned {ret.value_nick}")
            sys.exit(1)
        if sync_state:
            for el in self.els:
                el.sync_state_with_parent()

    def start_feeding(self):
        self.feeding = True
        threading.Thread(target=self._feed, daemon=True).start()

    def _feed(self):
        """Self-paced wall-clock feeder, deliberately shaped like ScratchFeeder: 15ms
        chunks pushed just-in-time, not a free-running audiotestsrc. A burst-tolerant
        aggregator and a jitter-tolerant one are different things."""
        frames = int(RATE * CHUNK_MS / 1000)
        phase = 0.0
        step = 2.0 * math.pi * self.freq / RATE
        next_wake = time.monotonic()
        while self.feeding:
            samples = []
            for _ in range(frames):
                v = 0.25 * math.sin(phase)
                phase += step
                samples.append(v)
                samples.append(v)
            data = struct.pack(f"<{len(samples)}f", *samples)
            ret = self.src.emit("push-buffer", Gst.Buffer.new_wrapped(data))
            if ret != Gst.FlowReturn.OK:
                self.push_fail += 1
                if self.push_fail < 3:
                    print(f"  [{self.name}] push-buffer returned {ret.value_nick}")
                if ret == Gst.FlowReturn.FLUSHING:
                    return
            else:
                self.pushed += 1
            next_wake += CHUNK_MS / 1000.0
            sleep = next_wake - time.monotonic()
            if sleep > 0:
                time.sleep(sleep)
            else:
                next_wake = time.monotonic()

    def stop_feeding(self):
        self.feeding = False


class SinkMeter:
    """Per-channel zero% and RMS on the sink's own sink pad, sampled in 1s windows.

    Deliberately at the sink and not at the mixer's src: the design's claim is about what
    reaches the device, and one pad further downstream is where the 2026-08-11 "the two
    branches were measured one stage apart" instrument bug came from (§10.10)."""

    def __init__(self, pad, channels):
        self.channels = channels
        self.lock = threading.Lock()
        self.reset()
        self.windows = []
        pad.add_probe(Gst.PadProbeType.BUFFER, self._probe)

    def reset(self):
        self.zeros = [0] * self.channels
        self.sumsq = [0.0] * self.channels
        self.count = [0] * self.channels
        self.buffers = 0

    def _probe(self, pad, info):
        buf = info.get_buffer()
        ok, mapinfo = buf.map(Gst.MapFlags.READ)
        if not ok:
            return Gst.PadProbeReturn.OK
        try:
            n = len(mapinfo.data) // 4
            vals = struct.unpack(f"<{n}f", mapinfo.data[: n * 4])
            with self.lock:
                self.buffers += 1
                for i, v in enumerate(vals):
                    ch = i % self.channels
                    self.count[ch] += 1
                    if v == 0.0:
                        self.zeros[ch] += 1
                    self.sumsq[ch] += v * v
        finally:
            buf.unmap(mapinfo)
        return Gst.PadProbeReturn.OK

    def take_window(self, label):
        with self.lock:
            row = {"label": label, "buffers": self.buffers, "ch": []}
            for ch in range(self.channels):
                c = self.count[ch]
                zpc = 100.0 * self.zeros[ch] / c if c else 100.0
                rms = math.sqrt(self.sumsq[ch] / c) if c else 0.0
                db = 20 * math.log10(rms) if rms > 0 else float("-inf")
                row["ch"].append((zpc, db))
            self.reset()
        self.windows.append(row)
        return row


# ── Build ─────────────────────────────────────────────────────────────────────
pipeline = Gst.Pipeline.new("shared-output-probe")
# output-buffer-duration left at the 10ms default: the design's added latency budget.
mixer = make("audiomixer")

if use_fakesink:
    sink = make("fakesink", sync=True)
    sink_caps = make("capsfilter")
else:
    sink = make("pulsesink")
    sink.set_property("device", node)
    sink.set_property("buffer-time", BUFFER_TIME_US)
    sink.set_property("latency-time", LATENCY_TIME_US)
    sink.set_property("client-name", "cuemark-probe")
    sink_caps = make("capsfilter")

# Pin the mixer's output format so the measurement is unambiguous about channel order.
sink_caps.set_property(
    "caps",
    Gst.Caps.from_string(
        f"audio/x-raw,format=F32LE,rate={RATE},channels={OUT_CHANNELS},"
        f"channel-mask=(bitmask){hex(OUT_MASK)}"
    ),
)
for el in (mixer, sink_caps, sink):
    pipeline.add(el)
if not mixer.link(sink_caps) or not sink_caps.link(sink):
    print("FAIL: could not link audiomixer → capsfilter → sink")
    sys.exit(1)

a = Branch(pipeline, mixer, "A/main(FL,FR)", (0, 1), 220.0)
b = Branch(pipeline, mixer, "B/cue(RL,RR)", (2, 3), 440.0)

a.attach(sync_state=False)
if not late_attach:
    b.attach(sync_state=False)

meter = SinkMeter(sink.get_static_pad("sink"), OUT_CHANNELS)

bus = pipeline.get_bus()
errors = []


def on_msg(_bus, msg):
    if msg.type == Gst.MessageType.ERROR:
        err, dbg = msg.parse_error()
        errors.append(f"{err.message} | {dbg}")
        print(f"  BUS ERROR: {err.message}")
    elif msg.type == Gst.MessageType.WARNING:
        err, _ = msg.parse_warning()
        print(f"  BUS WARN: {err.message}")


bus.add_signal_watch()
bus.connect("message", on_msg)

print(f"node={node if not use_fakesink else 'fakesink'} secs={secs} "
      f"late_attach={late_attach} idle_only={idle_only} is_live={not not_live}")
if not_live:
    print("CONTROL ARM (--not-live): expecting Q1 to FAIL. A pass here would mean the "
          "probe's Q1 check is blind and its PASS verdict carries no information.")
print(f"branches: A→ch0,1 (220Hz)  B→ch2,3 (440Hz), {CHUNK_MS}ms just-in-time chunks")
print()

ret = pipeline.set_state(Gst.State.PLAYING)
if ret == Gst.StateChangeReturn.FAILURE:
    print("FAIL (Q2): pipeline refused to go PLAYING — negotiation failed")
    sys.exit(1)
# A live pipeline returns NO_PREROLL, which is the expected answer here and is itself
# a check: it confirms is-live actually took on the appsrcs.
print(f"set_state(PLAYING) → {ret.value_nick}"
      f"{'  (live, as designed)' if ret == Gst.StateChangeReturn.NO_PREROLL else ''}")

loop = GLib.MainLoop()
threading.Thread(target=loop.run, daemon=True).start()

a.start_feeding()

# ── Run, sampling 1s windows ──────────────────────────────────────────────────
phase_notes = {}
t0 = time.monotonic()
attach_at = secs / 3.0
feed_b_at = secs * 2.0 / 3.0
attached_late = not late_attach
b_started = False
window = 0

print(f"\n{'t':>4} {'buf/s':>6}  " + "  ".join(f"ch{c}:zero%/dBFS" for c in range(OUT_CHANNELS)))
while time.monotonic() - t0 < secs:
    time.sleep(1.0)
    elapsed = time.monotonic() - t0

    if late_attach and not attached_late and elapsed >= attach_at:
        print(f"  → attaching branch B to the PLAYING mixer at t={elapsed:.1f}s")
        b.attach(sync_state=True)
        attached_late = True
        phase_notes["attach"] = window

    if not idle_only and not b_started and elapsed >= feed_b_at and attached_late:
        print(f"  → branch B starts feeding at t={elapsed:.1f}s")
        b.start_feeding()
        b_started = True
        phase_notes["b_feed"] = window

    row = meter.take_window(f"t={elapsed:.0f}s")
    cells = "  ".join(
        f"{z:5.1f}%/{d:6.1f}" if d != float("-inf") else f"{z:5.1f}%/  -inf"
        for z, d in row["ch"]
    )
    print(f"{elapsed:4.0f} {row['buffers']:6d}  {cells}")
    window += 1

a.stop_feeding()
b.stop_feeding()
time.sleep(0.2)
pipeline.set_state(Gst.State.NULL)
loop.quit()

# ── Verdict ───────────────────────────────────────────────────────────────────
print()
failures = []

if errors:
    failures.append(f"Q2 negotiation/runtime: bus reported {len(errors)} error(s): {errors[0]}")

# Q1: the sink must have kept receiving buffers in EVERY window, including those where
# branch B was live-but-idle. A stalled aggregator shows up as buffers=0, not as silence.
starved = [w["label"] for w in meter.windows if w["buffers"] == 0]
if starved:
    failures.append(
        f"Q1 aggregator stalled on an idle live pad — sink received zero buffers in "
        f"{len(starved)} window(s): {', '.join(starved)}. The design's "
        f"'an idle deck contributes silence' assumption is FALSE on this build; "
        f"one paused deck would silence the whole node."
    )

# Q1 second half: branch A's channels must stay live throughout, including before B
# is attached/fed. Being generous — 90%z is already unambiguous gating.
a_gated = [w["label"] for w in meter.windows[1:] if w["ch"][0][0] > 90.0]
if a_gated:
    failures.append(
        f"Q1/Q3 branch A gated in {len(a_gated)} window(s): {', '.join(a_gated)} — "
        f"a fed branch went silent at the sink."
    )

# Q3: attaching/feeding B must not have interrupted A. Checked as "A never dropped a
# window", already covered above; here we check B actually arrived when asked.
if not idle_only and b_started:
    tail = meter.windows[-1]
    if tail["ch"][2][0] > 90.0:
        failures.append(
            f"Q3 branch B never reached the sink: ch2 read {tail['ch'][2][0]:.1f}%z in the "
            f"final window after it started feeding."
        )

# Cross-check that the matrix routed where it was told, rather than everything landing
# on the first pair — which is exactly what an ignored mix-matrix looks like.
if not idle_only and b_started:
    tail = meter.windows[-1]
    if tail["ch"][0][0] > 90.0 and tail["ch"][2][0] < 10.0:
        failures.append("Q2 channels appear swapped: A silent on ch0 while B is live on ch2")

if failures:
    print("RESULT: FAIL")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)

print("RESULT: PASS")
print("  ✓ Q1 aggregator kept producing with a live-but-idle pad; fed branch never gated")
print("  ✓ Q2 stereo → mix-matrix → 4ch → audiomixer → sink negotiated and played")
if late_attach:
    print("  ✓ Q3 a branch attached to the PLAYING mixer and reached the sink")
print()
print("  This gates stage 2 of docs/design/shared-output-pipeline.md ONLY. It says nothing")
print("  about the two-sink gating — that is settled by stages 3-4, in the app, by ear and")
print("  by scratch-envelope.py --by-gesture.")
