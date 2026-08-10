#!/usr/bin/env python3
"""Read a captured WAV of the *device monitor* and say what happened to the audio.

Why this exists
---------------
`docs/design/slow-jog-audio-inaudible.md` §4: every instrument inside the pipeline reads
healthy during the failing gesture (feeder `rms` continuous, delivery counters advancing,
`arrived%` ~0) and the user hears the audio fade out anyway. That combination means the
loss — if it is a loss at all — is somewhere no counter is looking, so the next move is to
capture the signal that actually reaches the device and look at it.

The doc's §6 said to use `audio_record_start/stop`. **That command is a stub**
(`src-tauri/src/audio/record.rs` logs and returns Ok; the encoder chain is "step 8"), so it
records nothing. Capturing the PipeWire monitor instead is strictly better anyway: it sits
*downstream of everything*, including the two-`pulsesink`s-on-one-device topology that is
`audio-dropout-mid-playback.md`'s H1, so a fault anywhere in the chain shows up here.

What it distinguishes
---------------------
The whole investigation turns on three outcomes, and one pass of this script separates them:

  gated   — `rms` collapses to the noise floor in stretches. The audio really is being
            muted. Join the gap timestamps against `[scratch-tel]` chunk numbers.
  pitched — full-band `rms` holds steady but `hp200` (energy above ~200 Hz) collapses and
            the zero-crossing rate drops with it. Nothing is muted; the content has been
            shifted down two-to-four octaves by a 0.07-0.20x cursor speed and is no longer
            reproducible by the speakers. **RMS is blind to frequency, which is exactly why
            the feeder's own `rms` field cannot see this** — it reads healthy either way.
  clean   — both hold steady. The loss is downstream of the monitor tap (analog, routing,
            the controller's own mixer) and no amount of Rust will find it.

Pure stdlib on purpose: this machine has no numpy, and a bug hunt should not start with a
package install. The band split is a one-pole high-pass, which is a crude filter and is
meant to be — a 2:1 swing in `hp200` is the signal, not a 1 dB one.

Usage
-----
    scripts/scratch-envelope.py capture.wav
    scripts/scratch-envelope.py capture.wav --start-epoch 1786...  --log /tmp/cuemark-dev.log

`--start-epoch` (written by `scripts/scratch-capture.sh`) puts the timeline into wall clock
so `[scratch-tel]` lines can be printed inline against the envelope.
"""

import argparse
import array
import calendar
import math
import os
import re
import sys
import time
import wave

SILENCE_DBFS = -60.0


def read_wav(path, channels):
    with wave.open(path, "rb") as w:
        n_ch = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)

    if width == 2:
        samples = array.array("h")
        full = 32768.0
    elif width == 4:
        samples = array.array("i")
        full = 2147483648.0
    else:
        sys.exit(f"unsupported sample width {width} bytes (want 16- or 32-bit PCM)")
    samples.frombytes(raw)
    if sys.byteorder == "big":
        samples.byteswap()

    picked = [c for c in channels if c < n_ch]
    if not picked:
        sys.exit(f"file has {n_ch} channels; none of {channels} exist")

    # Mono-sum the requested channels. For the 4.0 Starlight device, channels 0,1 are the
    # main output's FL/FR and 2,3 carry the cue branch (see compute_cue_remap() and the
    # FL/FR/RL/RR note in pipeline.rs make_sink()) — so the default 0,1 is "what the mains
    # are doing", and `--channels 2,3` asks the same question of the headphone feed.
    mono = [0.0] * (len(samples) // n_ch)
    scale = 1.0 / (full * len(picked))
    for i in range(len(mono)):
        base = i * n_ch
        acc = 0
        for c in picked:
            acc += samples[base + c]
        mono[i] = acc * scale
    return mono, rate, n_ch


def analyse(mono, rate, window_ms):
    """Per-window full-band RMS, >200 Hz RMS, and zero-crossing rate."""
    # One-pole high-pass at ~200 Hz, run once over the whole signal so window edges don't
    # each restart the filter state.
    fc = 200.0
    alpha = 1.0 / (1.0 + 2.0 * math.pi * fc / rate)
    hp = [0.0] * len(mono)
    prev_x = 0.0
    prev_y = 0.0
    for i, x in enumerate(mono):
        y = alpha * (prev_y + x - prev_x)
        hp[i] = y
        prev_x = x
        prev_y = y

    win = max(1, int(rate * window_ms / 1000.0))
    out = []
    for start in range(0, len(mono) - win + 1, win):
        end = start + win
        s_full = 0.0
        s_hp = 0.0
        crossings = 0
        prev = mono[start]
        for i in range(start, end):
            v = mono[i]
            s_full += v * v
            h = hp[i]
            s_hp += h * h
            if (v >= 0.0) != (prev >= 0.0):
                crossings += 1
            prev = v
        out.append(
            {
                "t": start / rate,
                "rms": math.sqrt(s_full / win),
                "hp": math.sqrt(s_hp / win),
                "zcr": crossings * rate / win,
            }
        )
    return out


def dbfs(v):
    return 20.0 * math.log10(v) if v > 1e-9 else -999.0


TEL_RE = re.compile(
    r"^\[(?P<ts>[\d-]+ [\d:.]+)\]\[.*?\] \[(?P<tag>scratch-tel|scratch)/(?P<deck>[^\]]+)\] (?P<body>.*)$"
)


def load_tel(log_path, t0_epoch, duration):
    """`[scratch-tel]` / feeder start-stop lines that fall inside the capture window."""
    if not (log_path and t0_epoch):
        return []
    events = []
    with open(log_path, "r", errors="replace") as f:
        for line in f:
            m = TEL_RE.match(line.strip())
            if not m:
                continue
            try:
                # ⚠️ Log stamps are **UTC**; `time.time()`, the capture filename and the
                # .epoch file are local. This was `time.mktime` (which parses as local) until
                # 2026-08-10, so on any machine not at UTC every line fell outside the window
                # and the join produced **nothing, silently** — no warning, no empty-result
                # notice, just an envelope with no telemetry beside it. The 21:11 take was
                # joined by hand before this was noticed. `timegm` is the local-independent
                # counterpart to `mktime`.
                st = calendar.timegm(time.strptime(m.group("ts")[:19], "%Y-%m-%d %H:%M:%S"))
            except ValueError:
                continue
            rel = st - t0_epoch
            if -1.0 <= rel <= duration + 1.0:
                events.append((rel, m.group("body")))
    return events


def bar(db, lo=-70.0, hi=0.0, width=34):
    frac = (max(db, lo) - lo) / (hi - lo)
    n = int(round(frac * width))
    return "#" * n + "." * (width - n)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("wav")
    ap.add_argument("--window", type=float, default=25.0, help="analysis window in ms (default 25)")
    ap.add_argument("--channels", default="0,1", help="channel indices to sum (default 0,1 = mains)")
    ap.add_argument("--start-epoch", type=float, default=None, help="unix time of the first sample")
    ap.add_argument("--log", default=None, help="cuemark log to join [scratch-tel] lines from")
    ap.add_argument(
        "--silence",
        type=float,
        default=None,
        help="dBFS below which a window counts as silent (default: 25 dB under this "
        "capture's own p90, floored at -75)",
    )
    ap.add_argument("--quiet", action="store_true", help="summary only, no per-window timeline")
    args = ap.parse_args()

    explicit_channels = any(a == "--channels" or a.startswith("--channels=") for a in sys.argv[1:])
    channels = [int(c) for c in args.channels.split(",") if c.strip() != ""]
    mono, rate, n_ch = read_wav(args.wav, channels)
    duration = len(mono) / rate
    wins = analyse(mono, rate, args.window)
    if not wins:
        sys.exit("capture too short to analyse")

    # Threshold relative to the take, not absolute. Measured 2026-08-10: the Starlight
    # sink's monitor idles at **-54 dBFS**, not at digital silence, so the -60 dBFS
    # absolute threshold this script first shipped with could never have flagged a gate on
    # the one device the bug happens on. Anything 25 dB under the take's own loud level is
    # inaudible next to it, whatever the floor happens to be.
    if args.silence is None:
        ranked = sorted(dbfs(w["rms"]) for w in wins)
        p90 = ranked[min(len(ranked) - 1, int(0.9 * len(ranked)))]
        args.silence = max(-75.0, p90 - 25.0)

    t0 = args.start_epoch
    if t0 is None:
        side = os.path.splitext(args.wav)[0] + ".epoch"
        if os.path.exists(side):
            t0 = float(open(side).read().strip())
    tel = load_tel(args.log, t0, duration)

    print(f"{args.wav}: {duration:.2f}s, {rate} Hz, {n_ch} ch, analysing channels {channels}")
    print(f"window {args.window:.0f}ms -> {len(wins)} windows; silence threshold {args.silence:.0f} dBFS\n")

    if not args.quiet:
        print("   t(s)   rms dBFS  hp200 dBFS   zcr Hz  level")
        ti = 0
        for w in wins:
            while ti < len(tel) and tel[ti][0] <= w["t"]:
                print(f"  ---- log +{tel[ti][0]:6.2f}s  {tel[ti][1][:150]}")
                ti += 1
            d = dbfs(w["rms"])
            h = dbfs(w["hp"])
            mark = "  <-- SILENT" if d < args.silence else ""
            print(f"  {w['t']:6.2f}   {d:8.1f}   {h:9.1f}  {w['zcr']:7.0f}  {bar(d)}{mark}")
        for rel, body in tel[ti:]:
            print(f"  ---- log +{rel:6.2f}s  {body[:150]}")
        print()

    silent = [w for w in wins if dbfs(w["rms"]) < args.silence]
    loud = [w for w in wins if dbfs(w["rms"]) >= args.silence]
    # Longest contiguous run of silent windows — a gate reads as one long run, ordinary
    # quiet passages in the music read as many short ones.
    #
    # ⚠️ Measured only over the *interior*, between the first and last window that carried
    # signal. A gate is a hole punched in program material; digital silence before the hand
    # starts moving and after it stops is the deck sitting paused, which is correct and is
    # not evidence of anything.
    #
    # This is not hypothetical: the 2026-08-10 21:11 take opened with 1.95s of true digital
    # silence (-999 dBFS) while the recorder ran and the user had not yet touched the wheel,
    # and this function reported `GATED` on it. Because that verdict is an `elif` ahead of
    # the `PITCHED` one, it *masked* the real answer — the same take reads `hp200 - rms =
    # -14.9 dB`, which is the pitched signature — and the wrong verdict was acted on.
    # Trailing silence is trimmed for the same reason: releasing the wheel ends the gesture.
    loud_idx = [i for i, w in enumerate(wins) if dbfs(w["rms"]) >= args.silence]
    longest = run = 0
    lead_silence = trail_silence = 0.0
    if loud_idx:
        first, last = loud_idx[0], loud_idx[-1]
        lead_silence = first * args.window / 1000.0
        trail_silence = (len(wins) - 1 - last) * args.window / 1000.0
        for w in wins[first : last + 1]:
            if dbfs(w["rms"]) < args.silence:
                run += 1
                longest = max(longest, run)
            else:
                run = 0

    print("SUMMARY")
    print(f"  silent windows : {len(silent)}/{len(wins)} ({100.0*len(silent)/len(wins):.0f}%)")
    print(
        f"  longest silence: {longest * args.window / 1000.0:.3f}s (interior only; "
        f"lead-in {lead_silence:.2f}s, tail {trail_silence:.2f}s excluded)"
    )
    if loud:
        rl = sorted(dbfs(w["rms"]) for w in loud)
        hl = sorted(dbfs(w["hp"]) for w in loud)
        zl = sorted(w["zcr"] for w in loud)
        p = lambda xs, q: xs[min(len(xs) - 1, int(q * len(xs)))]
        print(f"  rms   dBFS     : p10={p(rl,0.1):.1f} p50={p(rl,0.5):.1f} p90={p(rl,0.9):.1f}")
        print(f"  hp200 dBFS     : p10={p(hl,0.1):.1f} p50={p(hl,0.5):.1f} p90={p(hl,0.9):.1f}")
        print(f"  zcr   Hz       : p10={p(zl,0.1):.0f} p50={p(zl,0.5):.0f} p90={p(zl,0.9):.0f}")
        print(f"  hp200 - rms    : {p(hl,0.5) - p(rl,0.5):+.1f} dB at p50")
        print()
        print("READ IT AS")
        # Checked FIRST, because a capture of the wrong device reads as a perfectly
        # plausible "clean" envelope and there is nothing in the numbers alone to say
        # otherwise. On 2026-08-10 a take of the room (pw-record silently fell back to the
        # default source — the H1n mic — see scratch-capture.sh) scored p50=-53.5 dBFS with
        # continuous high-frequency content and was reported as CLEAN. It matched an idle
        # control take to within 0.7 dB, which is the only reason it was caught.
        #
        # A real take through the Starlight sits far louder and swings far more: the feeder
        # runs -15 to -22 dBFS and the gain stages below it are fixed. A quiet, flat capture
        # is a capture of nothing.
        floor_like = p(rl, 0.9) < -45.0 and (p(rl, 0.9) - p(rl, 0.1)) < 8.0
        if floor_like:
            print("  NO SIGNAL — this is a noise floor, not program material: loud-end level")
            print(f"  is only {p(rl,0.9):.1f} dBFS and the whole take spans {p(rl,0.9)-p(rl,0.1):.1f} dB.")
            print("  The recorder was almost certainly attached to the wrong node. Re-run via")
            print("  scripts/scratch-capture.sh, which pre-flights the link with pw-link and")
            print("  refuses to start. DO NOT read any verdict below this line.")
        elif longest * args.window / 1000.0 >= 0.15:
            print("  GATED — a contiguous silence of 150ms+ reached the device. Join its start")
            print("  time against [scratch-tel]: `arrived`/`ramps`/`snaps` in that second say")
            print("  whether the feeder muted, and a clean second there means it did not.")
        elif p(hl, 0.5) - p(rl, 0.5) < -12.0:
            print("  PITCHED — level holds but the energy is nearly all below 200 Hz, i.e. the")
            print("  content is shifted down and the speakers cannot reproduce it. This is not")
            print("  a gate and no gate constant will fix it; the lever is cursor speed.")
        else:
            print("  CLEAN — continuous level with real high-frequency content. Whatever the")
            print("  user hears is downstream of this tap (analog path, controller mixer,")
            print("  monitoring), not in the pipeline.")

    # The other channel pair, always, unless it was asked for explicitly.
    #
    # 🔴 This exists because the default very nearly buried the bug it was built to find.
    # On a 4.0 device the main output is FL,FR (0,1) and the cue/headphone output is RL,RR
    # (2,3) — and a listener on headphones is hearing 2,3. On 2026-08-10 this script analysed
    # 0,1 by default and returned **CLEAN** for a capture whose headphone channels were at
    # exact digital zero for thirteen straight seconds, which is the verdict the whole
    # investigation then reasoned from. Reporting one pair as "the" answer is what made a
    # correct measurement answer the wrong question.
    if n_ch >= 4 and not explicit_channels:
        other = [c for c in (0, 1, 2, 3) if c not in channels][:2]
        o_mono, _, _ = read_wav(args.wav, other)
        o_wins = analyse(o_mono, rate, args.window)
        o_ranked = sorted(dbfs(w["rms"]) for w in o_wins)
        o_p = lambda q: o_ranked[min(len(o_ranked) - 1, int(q * len(o_ranked)))]
        # Exact zero is not a quiet passage: nothing analog reaches -999 dBFS, so a pair
        # sitting there is being *written* silent by something upstream.
        dead = sum(1 for w in o_wins if w["rms"] <= 0.0)
        role = "cue/headphones" if 2 in other else "main"
        print()
        print(f"OTHER CHANNEL PAIR {other} ({role}) — checked because a listener may be on it")
        print(f"  rms dBFS : p10={o_p(0.1):.1f} p50={o_p(0.5):.1f} p90={o_p(0.9):.1f}")
        print(f"  digital-zero windows: {dead}/{len(o_wins)} ({100.0*dead/len(o_wins):.0f}%)")
        if dead > len(o_wins) * 0.1:
            print(f"  🔴 This pair is SILENT while the analysed pair is not. If the listener is")
            print(f"     on {role}, every verdict above is about an output nobody is hearing.")
            print(f"     Re-run with --channels {other[0]},{other[1]} and read that instead.")


if __name__ == "__main__":
    main()
