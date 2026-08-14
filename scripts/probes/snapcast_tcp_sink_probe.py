#!/usr/bin/env python3
"""Does cuemark's Snapcast sink produce the byte stream snapserver's `tcp://` source expects,
and does a stalled server leave the rest of the deck alone?

Stands in for snapserver: opens a TCP listener, runs the same element chain
`make_snapcast_sink()` builds (`audioconvert ! audioresample ! capsfilter(S16LE/48000/2) !
queue(leaky=downstream) ! tcpclientsink`), and measures what arrives. No app, no snapserver,
no media file — seconds to run.

Two arms, and **the second is the one worth running**:

  (default)  A server that reads normally. Asserts the stream is S16LE/48kHz/stereo by its
             byte rate (192000 B/s) and that it carries signal rather than digital silence.

  --stall    A server that accepts the connection and then never reads (~35s: see the
             --seconds default for why it cannot be shortened). This models the
             failure that actually threatens a live set — a wedged or dead snapserver, or a
             saturated link. The deck's `tee` has no per-branch queue, so backpressure from
             any one branch stalls *every* branch, including the booth monitor and the cue.
             The probe puts a `fakesink` branch on the same tee and asserts it keeps
             receiving buffers while the network branch is jammed. Without
             `leaky=downstream` on the queue this arm fails, which is the whole point of it.

  --stall --no-leaky
             The control arm for the arm above. Same jammed server, but the queue keeps its
             default (blocking) behaviour — i.e. the code as it would be *without* the fix.
             It must FAIL. An instrument that cannot register the fault it is checking for
             carries no information about it, and a `--stall` pass means nothing until this
             arm has been seen to fail at least once.

Usage:
    scripts/probes/snapcast_tcp_sink_probe.py [--stall [--no-leaky]] [--seconds N] [--port P]
"""

import argparse
import socket
import struct
import sys
import threading
import time

import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

# snapserver's default `sampleformat = 48000:16:2` → 48000 frames/s × 2ch × 2 bytes.
EXPECTED_BYTES_PER_SEC = 48000 * 2 * 2
RATE_TOLERANCE = 0.10  # ±10%: TCP delivery is chunky over a short window.

# Final observation window for the --stall arms, in seconds.
WINDOW = 2.0


class Server(threading.Thread):
    """Minimal stand-in for snapserver's tcp:// source."""

    def __init__(self, port: int, stall: bool):
        super().__init__(daemon=True)
        self.port = port
        self.stall = stall
        self.data = bytearray()
        self.connected = threading.Event()
        self.stop = threading.Event()
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        # ⚠️ Pin the receive buffer small, before accept(), so the accepted socket inherits
        # it and kernel autotuning is disabled. Without this a "stalled" reader is not
        # stalled at all for a long time: loopback socket buffers autotune into the
        # megabytes and quietly swallow ~13s of audio, so tcpclientsink never blocks and the
        # control arm cannot fail. Measured 2026-08-13 — the first version of this probe
        # passed its own control arm for exactly this reason.
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8192)
        self.sock.bind(("127.0.0.1", port))
        self.sock.listen(1)

    def run(self):
        conn, _ = self.sock.accept()
        self.connected.set()
        if self.stall:
            # Accept and then never read. The kernel receive buffer fills, the sender's send
            # buffer fills, and tcpclientsink's render() blocks — exactly a dead server.
            self.stop.wait()
            conn.close()
            return
        conn.settimeout(0.5)
        while not self.stop.is_set():
            try:
                chunk = conn.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if not chunk:
                break
            self.data.extend(chunk)
        conn.close()


def rms_s16(data: bytes) -> float:
    """RMS as a fraction of full scale, so silence is distinguishable from audio."""
    n = len(data) // 2
    if n == 0:
        return 0.0
    samples = struct.unpack(f"<{n}h", data[: n * 2])
    return (sum(s * s for s in samples) / n) ** 0.5 / 32768.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stall", action="store_true", help="server accepts then never reads")
    ap.add_argument("--no-leaky", action="store_true",
                    help="control arm: drop leaky=downstream, which must make --stall fail")
    ap.add_argument("--seconds", type=float, default=None,
                    help="observation seconds; defaults to 5 normally, 35 for --stall")
    ap.add_argument("--port", type=int, default=14953)
    args = ap.parse_args()
    if args.seconds is None:
        # ⚠️ 35s for the stall arms is not padding. Before a jammed socket can back up as far
        # as the tee, ~21s of audio has to fill the kernel send buffer (tcp_wmem max 4MB at
        # 192KB/s) on top of the branch queues. At 12s the control arm still read as "flowing"
        # — measured, twice. A shorter --stall run cannot fail and therefore proves nothing.
        args.seconds = 35.0 if args.stall else 5.0

    Gst.init(None)
    server = Server(args.port, args.stall)
    server.start()

    # The tee mirrors the deck's real output topology: no queue between the tee and the
    # network branch, which is what makes the leaky queue inside the sink chain load-bearing.
    desc = (
        "audiotestsrc is-live=true wave=sine freq=440 volume=0.5 ! "
        "audio/x-raw,format=F32LE,rate=48000,channels=2 ! tee name=t "
        "t. ! queue ! audioconvert ! audioresample ! "
        "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved ! "
        f"queue max-size-buffers=0 max-size-bytes=0 max-size-time=500000000 "
        f"{'' if args.no_leaky else 'leaky=downstream '}! "
        f"tcpclientsink host=127.0.0.1 port={args.port} sync=true "
        "t. ! queue ! fakesink name=booth sync=true"
    )
    pipeline = Gst.parse_launch(desc)
    booth = pipeline.get_by_name("booth")

    counts = {"booth": 0}
    booth.set_property("signal-handoffs", True)
    booth.connect("handoff", lambda *_: counts.__setitem__("booth", counts["booth"] + 1))

    pipeline.set_state(Gst.State.PLAYING)
    if not server.connected.wait(timeout=5):
        print("FAIL: tcpclientsink never connected")
        pipeline.set_state(Gst.State.NULL)
        return 1

    if args.stall:
        # ⚠️ Measure the **end** of the window, not the whole of it. Between the branch's
        # queues and the kernel's send/receive buffers, several seconds of audio are absorbed
        # before a jammed socket can back up as far as the tee — so a total taken across the
        # window counts the healthy opening seconds and reads as "still flowing" no matter
        # what. Counting the last WINDOW seconds instead asks the only question that matters:
        # is the booth still being served *now*, with everything long since full?
        # (Caught 2026-08-13: the --no-leaky control arm passed, which is what a probe that
        # cannot see its own fault looks like.)
        time.sleep(args.seconds)
        mid = counts["booth"]
        time.sleep(WINDOW)
        end = counts["booth"]
    else:
        time.sleep(args.seconds)

    pipeline.set_state(Gst.State.NULL)
    server.stop.set()
    time.sleep(0.3)

    if args.stall:
        drawn = end - mid
        # A live 48kHz pipeline hands off far more than this; the threshold only has to
        # separate "still flowing" from "stalled", and a stalled tee delivers exactly zero.
        expected_min = 5
        print(f"[stall arm] booth branch buffers in the final {WINDOW:.0f}s, after "
              f"{args.seconds:.0f}s of a jammed network sink: {drawn}")
        print(f"[stall arm] bytes accepted by the stalled server: {len(server.data)}")
        if drawn < expected_min and args.no_leaky:
            print("EXPECTED FAIL (control arm): without leaky=downstream a jammed network "
                  "sink stalls the whole deck — this is what the probe detects.")
            return 0
        if drawn < expected_min:
            print(
                f"FAIL: the booth branch received {drawn} buffers (< {expected_min}) while the "
                "network sink was blocked — a dead snapserver stalls the whole deck. Check "
                "leaky=downstream on the queue in make_snapcast_sink()."
            )
            return 1
        if args.no_leaky:
            print("UNEXPECTED PASS: the control arm was supposed to stall — the probe is not "
                  "measuring what it claims to.")
            return 1
        print("PASS: a stalled network server does not stall the rest of the deck")
        return 0

    got = len(server.data)
    rate = got / args.seconds
    ratio = rate / EXPECTED_BYTES_PER_SEC
    level = rms_s16(bytes(server.data))
    print(f"bytes={got} over {args.seconds}s → {rate:.0f} B/s "
          f"(expected {EXPECTED_BYTES_PER_SEC}, ratio {ratio:.3f})")
    print(f"rms={level:.4f} of full scale")

    ok = True
    if abs(ratio - 1.0) > RATE_TOLERANCE:
        print(f"FAIL: byte rate is {ratio:.3f}× the expected S16LE/48000/2 rate — the caps or "
              "the sink's sync property are wrong; snapserver would resample or desync.")
        ok = False
    if level < 0.01:
        print("FAIL: the stream is digital silence — bytes are flowing but carry no signal.")
        ok = False
    if ok:
        print("PASS: format and pacing match snapserver's tcp:// source expectations")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
