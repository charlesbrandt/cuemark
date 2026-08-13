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


def extract_pair(path, channels, out_path, gain_db=0.0):
    """Write the two analysed channels out as a plain 16-bit stereo WAV you can play.

    The whole point of capturing the device monitor is that it is the signal the listener
    actually hears — but every other output of this script is a *number about* that signal,
    and numbers are what sent this investigation to the wrong channel pair for a session.
    Being able to put the capture in your ears and confirm "yes, that is the dropout I
    heard" is the one check that cannot be fooled by a blind instrument.

    Deliberately NOT mono-summed (unlike read_wav): if the fault is ever asymmetric between
    L and R, a sum hides it, and a sum does not sound like what came out of the headphones.
    """
    with wave.open(path, "rb") as w:
        n_ch = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        raw = w.readframes(w.getnframes())

    if width == 2:
        samples = array.array("h")
        full = 32768.0
    elif width == 4:
        samples = array.array("i")
        full = 2147483648.0
    else:
        sys.exit(f"unsupported sample width {width} bytes")
    samples.frombytes(raw)
    if sys.byteorder == "big":
        samples.byteswap()

    picked = [c for c in channels if c < n_ch][:2]
    if not picked:
        sys.exit(f"file has {n_ch} channels; none of {channels} exist")
    if len(picked) == 1:
        picked = picked * 2

    g = 10.0 ** (gain_db / 20.0)
    n_frames = len(samples) // n_ch
    out = array.array("h", bytes(4 * n_frames))
    clipped = 0
    peak = 0.0
    for i in range(n_frames):
        base = i * n_ch
        for k, c in enumerate(picked):
            s = samples[base + c] / full
            a = -s if s < 0 else s
            if a > peak:
                peak = a
            v = int(s * 32768.0 * g)
            if v > 32767:
                v, clipped = 32767, clipped + 1
            elif v < -32768:
                v, clipped = -32768, clipped + 1
            out[2 * i + k] = v
    if sys.byteorder == "big":
        out.byteswap()

    with wave.open(out_path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(out.tobytes())
    return out_path, rate, n_frames / rate, clipped, peak


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


TEL_FIELDS = {
    "late%": r"late (\d+)%",
    "feeder_rms": r"rms=([\d.]+)",
    "arrived%": r"arrived (\d+)%",
    "coast%": r"coast (\d+)%",
    "snaps": r"snaps=(\d+)",
    "ramps": r"ramps=(\d+)",
    "rate_mean": r"rate mean=([\d.]+)",
    "rate_max": r"max=([\d.]+) \|",
    "targets/s": r"targets (\d+)/s",
    "gap_p50": r"gap p50=(\d+)",
    "gap_p90": r"p90=(\d+)",
    "gap_max": r"max=(\d+)ms",
    "cuesink_ms": r"cuesink=\d+/s\((-?\d+)ms\)",
}


def load_events(log_path, t0_epoch, duration):
    """Every scratch line in the window, at millisecond resolution.

    `load_tel()` truncates the stamp to whole seconds (`[:19]`), which is fine for printing
    a line beside a 25ms window but useless for measuring *from* a gesture boundary — a
    ±0.5s error swamps a survival time whose median is 0.54s.
    """
    if not (log_path and t0_epoch):
        return []
    out = []
    with open(log_path, "r", errors="replace") as f:
        for line in f:
            m = TEL_RE.match(line.strip())
            if not m:
                continue
            ts = m.group("ts")
            try:
                whole = calendar.timegm(time.strptime(ts[:19], "%Y-%m-%d %H:%M:%S"))
            except ValueError:
                continue
            frac = float("0" + ts[19:]) if len(ts) > 19 else 0.0
            rel = whole + frac - t0_epoch
            if -2.0 <= rel <= duration + 2.0:
                out.append((rel, m.group("tag"), m.group("body")))
    return out


def report_by_gesture(wins, events, silence, window_ms, duration):
    """Rank every gesture by how long its audio survived, and contrast the extremes.

    Why this exists: the failing state is already over-sampled — 13 gestures in one 30s
    take all died at a median 0.54s after `feeder start`. What is *not* characterised is
    the state where the audio keeps going, and no amount of extra failing capture will
    characterise it. So capture a mix, then let the survival time sort the gestures and
    show what differs between the ends. Nothing has to be marked by hand: `feeder
    start`/`stop` already bound every gesture in the log.
    """
    ges = []
    start = None
    for rel, tag, body in events:
        if tag != "scratch":
            continue
        if body.startswith("feeder start"):
            start = rel
        elif body.startswith("feeder stop") and start is not None:
            ges.append((start, rel))
            start = None
    if start is not None:  # gesture still running when the capture ended
        ges.append((start, duration))
    if not ges:
        print("BY GESTURE: no `feeder start/stop` lines in the window — pass --log, and")
        print("  check the capture has a .epoch sidecar so the join has a time origin.")
        return

    step = window_ms / 1000.0
    rows = []
    for a, b in ges:
        live = [w["t"] for w in wins if a <= w["t"] < b and dbfs(w["rms"]) >= silence]
        tel = [body for rel, tag, body in events if tag == "scratch-tel" and a <= rel < b]
        vals = {}
        for name, pat in TEL_FIELDS.items():
            got = [float(m.group(1)) for m in (re.search(pat, t) for t in tel) if m]
            vals[name] = sum(got) / len(got) if got else None
        rows.append(
            {
                "start": a,
                "dur": b - a,
                "onset": (live[0] - a) if live else None,
                "survived": (live[-1] - a) if live else 0.0,
                "audible": len(live) * step,
                "tail": (b - live[-1]) if live else b - a,
                "tel_n": len(tel),
                **vals,
            }
        )

    rows.sort(key=lambda r: -r["survived"])
    print("BY GESTURE — ranked by how long the audio survived after `feeder start`")
    hdr = f"  {'start':>6} {'dur':>5} {'onset':>6} {'survived':>8} {'audible':>7} {'tail':>5}"
    hdr += f" {'rate':>5} {'tgt/s':>5} {'gapp50':>6} {'gapmax':>6} {'arr%':>5} {'coast%':>6}"
    print(hdr)
    for r in rows:
        f = lambda k, w, p=1: (f"{r[k]:{w}.{p}f}" if r[k] is not None else "-".rjust(w))
        print(
            f"  {r['start']:6.2f} {r['dur']:5.2f} {f('onset',6,2)} {r['survived']:8.2f} "
            f"{r['audible']:7.2f} {r['tail']:5.2f} {f('rate_mean',5,3)} {f('targets/s',5,0)} "
            f"{f('gap_p50',6,0)} {f('gap_max',6,0)} {f('arrived%',5,0)} {f('coast%',6,0)}"
        )

    # The contrast is the whole point. With few gestures a "top third" is one gesture and
    # any difference between the ends is noise, so say the n rather than printing a
    # confident-looking table built from two samples.
    # 🔴 The guard that decides whether the contrast means anything at all. A gesture that
    # was audible for most of its length is a *working* one; if the take contains none,
    # then ranking it sorts failures by degree and the "sustained" column is just the
    # least-bad failure. Contrasting two failure modes looks exactly like contrasting
    # success against failure, and will happily flag a field that has nothing to do with
    # the fault. Say so before the table, not after it.
    working = [r for r in rows if r["dur"] > 0.3 and r["audible"] / r["dur"] >= 0.7]
    print(f"\n{len(working)}/{len(rows)} gestures stayed audible for 70%+ of their length")
    if not working:
        print("  🔴 NO WORKING GESTURE IN THIS TAKE. Every turn gated, so the contrast below")
        print("     ranks failures by degree — the 'sustained' column is the least-bad")
        print("     failure, not a success, and any field it flags may be unrelated to the")
        print("     fault. Re-capture including turns that sound CONTINUOUS to you; if none")
        print("     of them did, this take cannot answer what makes them work.")

    k = max(1, len(rows) // 3)
    best, worst = rows[:k], rows[-k:]
    print(f"\nCONTRAST — longest-surviving {k} vs shortest-surviving {k} of {len(rows)} gestures")
    print(f"  survived: {sum(r['survived'] for r in best)/k:.2f}s  vs  {sum(r['survived'] for r in worst)/k:.2f}s")
    print(f"  {'field':<12} {'sustained':>10} {'gated':>10} {'delta':>10}")
    for name in TEL_FIELDS:
        bv = [r[name] for r in best if r[name] is not None]
        wv = [r[name] for r in worst if r[name] is not None]
        if not bv or not wv:
            continue
        bm, wm = sum(bv) / len(bv), sum(wv) / len(wv)
        flag = "   <-- differs" if abs(bm - wm) > 0.25 * max(abs(bm), abs(wm), 1e-9) else ""
        print(f"  {name:<12} {bm:10.2f} {wm:10.2f} {bm-wm:+10.2f}{flag}")
    if len(rows) < 6:
        print(f"\n  ⚠️  Only {len(rows)} gestures — the contrast above is anecdote, not signal.")
        print("      Capture a longer run with many varied turns before reading it.")
    print("\n  `<-- differs` marks a >25% gap. It is a place to look, NOT a cause: with this")
    print("  many fields something always differs. Confirm it by driving that variable on")
    print("  purpose and predicting the survival time before you measure it.")


def bar(db, lo=-70.0, hi=0.0, width=34):
    frac = (max(db, lo) - lo) / (hi - lo)
    n = int(round(frac * width))
    return "#" * n + "." * (width - n)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("wav")
    ap.add_argument("--window", type=float, default=25.0, help="analysis window in ms (default 25)")
    ap.add_argument(
        "--channels",
        default="auto",
        help="channel indices to sum, e.g. 0,1 (mains) or 2,3 (cue/headphones). "
        "Default 'auto': analyse whichever pair actually carries signal.",
    )
    ap.add_argument(
        "--extract",
        metavar="OUT.wav",
        default=None,
        help="also write the analysed channel pair to OUT.wav as plain 16-bit stereo, "
        "so you can listen to the capture and confirm it matches what you heard",
    )
    ap.add_argument(
        "--extract-gain-db",
        type=float,
        default=0.0,
        help="gain applied to --extract only (the analysis is never scaled). The monitor "
        "tap sits at the cue branch's own level, which is far below a normal listening "
        "level; +12 to +20 is usually needed to audition it.",
    )
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
    ap.add_argument(
        "--by-gesture",
        action="store_true",
        help="rank each feeder start/stop gesture by how long its audio survived, and "
        "contrast the sustained ones against the gated ones (implies --quiet). Needs --log.",
    )
    args = ap.parse_args()

    explicit_channels = args.channels != "auto"

    # 'auto' — pick the pair that carries signal, and say so out loud.
    #
    # 🔴 Why this is the default. The fixed 0,1 default assumed the mains are always the
    # interesting pair, and twice that assumption made a correct measurement answer the
    # wrong question: on 2026-08-10 it reported CLEAN for a take whose headphone channels
    # were at digital zero, and later it reported "100% silent, longest silence 0.000s"
    # with no verdict at all for a take whose mains were *deliberately* faded out — the
    # entire signal was on 2,3 and the script never looked. Which pair is live is a
    # property of how the session is set up (fader position, cue routing), not something
    # a default can know, so measure it instead of assuming it.
    if not explicit_channels:
        probe = []
        for cand in ([0, 1], [2, 3]):
            if max(cand) >= wave.open(args.wav, "rb").getnchannels():
                continue
            c_mono, c_rate, _ = read_wav(args.wav, cand)
            c_wins = analyse(c_mono, c_rate, 100.0)  # coarse: only picking a pair
            if not c_wins:
                continue
            ranked = sorted(dbfs(w["rms"]) for w in c_wins)
            probe.append((ranked[min(len(ranked) - 1, int(0.9 * len(ranked)))], cand))
        if probe:
            probe.sort(reverse=True)
            channels = probe[0][1]
            desc = ", ".join(
                f"{c}={'-inf' if p < -900 else format(p, '.1f')} dBFS" for p, c in sorted(probe, key=lambda x: x[1])
            )
            role = "cue/headphones" if 2 in channels else "main"
            print(f"channel auto-pick: p90 by pair — {desc}")
            print(f"  -> analysing {channels} ({role}); pass --channels to override")
            # When both pairs are within a few dB the pick is essentially a coin toss, and
            # a coin toss presented as a decision is how this script sent a reader to the
            # wrong pair in the first place. Say when the choice carries no information.
            if len(probe) > 1 and abs(probe[0][0] - probe[1][0]) < 3.0:
                print(f"  ⚠️  The two pairs are within {abs(probe[0][0]-probe[1][0]):.1f} dB — this pick is near-arbitrary and")
                print(f"      BOTH outputs are live. Read the other pair too before concluding.")
            print()
        else:
            channels = [0, 1]
    else:
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
    if args.by_gesture:
        args.quiet = True

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
    else:
        # Every window is below threshold, so there is no loud population to take
        # percentiles of and every block above is skipped. Until 2026-08-10 that produced
        # a summary that just *stopped* after "longest silence: 0.000s" — no percentiles,
        # no verdict, no complaint — which reads like a clean run and is the opposite of
        # one. Say it.
        print("READ IT AS")
        print(f"  NO SIGNAL ON THIS PAIR — all {len(wins)} windows are below the threshold;")
        print("  this pair produced nothing for the whole take. That is expected when the")
        print("  fader or volume for that output is down (a deliberately-muted main is the")
        print("  usual reason) and it means nothing about the fault either way. Read the")
        print("  other pair below — 'longest silence: 0.000s' here is an artifact of there")
        print("  being no interior to measure, NOT evidence that nothing was gated.")

    if args.by_gesture:
        print()
        report_by_gesture(wins, load_events(args.log, t0, duration), args.silence, args.window, duration)

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
        # ⚠️ This used to assert "This pair is SILENT while the analysed pair is not"
        # unconditionally, from `dead` alone — so when the *analysed* pair was the dead one
        # it printed that sentence about the pair carrying all the audio and pointed the
        # reader back at the silence. Compare the two pairs before claiming a difference,
        # and take the auto-pick into account: once the pair is chosen *because* it is the
        # loud one, "the other pair is silent" is the arithmetic complement of that choice,
        # not news. A muted main is a normal way to isolate the cue branch for a take.
        # 🔴 "Mostly zero" and "dead" are NOT the same thing, and conflating them buried the
        # bug a third time. A pair at 32% digital-zero with a p90 of -16.9 dBFS is not a
        # muted output — it is a **live output being gated**, which is the entire fault
        # signature. The first version of this branch called that "silent, as expected"
        # because 32% > 10%. Decide on the pair's *level* first, and only then on how much
        # of it is zero.
        other_alive = o_p(0.9) > -60.0
        other_gated = other_alive and dead > len(o_wins) * 0.1
        if not other_alive and loud and explicit_channels:
            print(f"  🔴 This pair is SILENT while the analysed pair is not. If the listener is")
            print(f"     on {role}, every verdict above is about an output nobody is hearing.")
            print(f"     Re-run with --channels {other[0]},{other[1]} and read that instead.")
        elif not other_alive and loud:
            print(f"  Dead for the whole take — the auto-pick chose the live pair. Expected if")
            print(f"     {role} was faded out on purpose; otherwise ask why it produced nothing.")
        elif not other_alive and not loud:
            print(f"  🔴 BOTH pairs are dead for essentially the whole take. Nothing was")
            print(f"     captured. Check the recorder reached the right node (scratch-capture.sh")
            print(f"     pre-flights this) before reading any verdict above.")
        elif not loud:
            print(f"  🔴 THIS pair carries the signal and the analysed one does not.")
            print(f"     Re-run with --channels {other[0]},{other[1]} — or drop --channels")
            print(f"     entirely and let the auto-pick choose it.")
        elif other_gated:
            print(f"  🔴 This pair is LIVE ({o_p(0.9):.1f} dBFS at p90) but {100.0*dead/len(o_wins):.0f}% digitally zero —")
            print(f"     that is a gated output, not a muted one, and it is the fault signature.")
            print(f"     Re-run with --channels {other[0]},{other[1]} and read that pair properly.")
        else:
            print(f"  Both pairs are live and neither is mostly zero. The verdict above covers")
            print(f"     only the analysed pair; re-run with --channels {other[0]},{other[1]} for {role}.")

    if args.extract:
        path, ex_rate, ex_dur, clipped, peak = extract_pair(
            args.wav, channels, args.extract, args.extract_gain_db
        )
        headroom = 20.0 * math.log10(1.0 / peak) if peak > 0 else 0.0
        print()
        print(f"EXTRACTED channels {channels} -> {path}")
        print(f"  {ex_dur:.2f}s stereo 16-bit @ {ex_rate} Hz, gain {args.extract_gain_db:+.1f} dB")
        print(f"  source peak {20.0 * math.log10(peak) if peak > 0 else -999:.1f} dBFS "
              f"-> {headroom:.1f} dB of headroom before clipping")
        if clipped:
            # ⚠️ Clipping the audition file invents a distortion that is not in the
            # capture, and this file exists precisely to be trusted by ear. A listener
            # who hears crunch here would be hearing this script, not the bug.
            print(f"  🔴 {clipped} samples CLIPPED — this file now contains distortion the")
            print(f"     capture does not. Re-run with --extract-gain-db {math.floor(headroom):.0f} or less.")
        elif args.extract_gain_db == 0.0 and headroom > 6.0:
            print(f"  Quiet to audition as-is; up to --extract-gain-db {math.floor(headroom):.0f} is clip-free.")
        print(f"  Listen:  pw-play {path}")
        print("  If it does not sound like what you heard, the capture is wrong and no")
        print("  verdict above is worth reading — fix the capture before analysing again.")


if __name__ == "__main__":
    main()
