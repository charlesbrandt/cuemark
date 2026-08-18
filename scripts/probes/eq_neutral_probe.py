#!/usr/bin/env python3
"""Is the proposed EQ + sweep-filter chain transparent at its NEUTRAL settings?

Why this matters
----------------
Both `equalizer-nbands` (all band gains 0) and the two `audiocheblimit` sweep
filters (parked at bypass cutoffs) would sit in every deck's chain permanently,
between `input_selector` and `output_queue`. If either colours the signal at
rest, every deck inherits that colouration forever — and, in this codebase's
usual style, silently.

Method
------
Pure stdlib (this machine has no numpy — see scripts/scratch-envelope.py:32).
Push a steady sine at each test frequency through the chain, measure output RMS
against the same tone with no filter in the way, report the difference in dB.
That is a direct magnitude-response measurement, not an inference from noise.

A control arm (`lp500`) must show a large loss at high frequencies. If it reads
flat the measurement is broken, and every "flat" verdict here means nothing.
"""
import array
import atexit
import math
import pathlib
import shutil
import subprocess
import sys
import tempfile
import wave

RATE = 48000
# Renders go to a temp dir, not next to the script: this probe writes one WAV per
# (chain × frequency) — 70-odd files per run — and dropping those into scripts/probes/
# would bury the repo in untracked audio every time someone checks the tone stage.
OUT = pathlib.Path(tempfile.mkdtemp(prefix="cuemark-eq-probe-"))
atexit.register(shutil.rmtree, OUT, True)
FREQS = [30, 60, 125, 250, 500, 1000, 2000, 4000, 8000, 12000, 16000]

EQ_NEUTRAL = (
    "equalizer-nbands num-bands=3 "
    "band0::type=low-shelf band0::freq=250 band0::bandwidth=250 band0::gain=0 "
    "band1::type=peak band1::freq=1000 band1::bandwidth=1800 band1::gain=0 "
    "band2::type=high-shelf band2::freq=4000 band2::bandwidth=4000 band2::gain=0"
)
HP_BYPASS = "audiocheblimit mode=high-pass cutoff=20 poles=4"
LP_BYPASS = "audiocheblimit mode=low-pass cutoff=20000 poles=4"

CHAINS = {
    "eq_neutral":    EQ_NEUTRAL,
    "hp_bypass_20":  HP_BYPASS,
    "lp_bypass_20k": LP_BYPASS,
    "lp_bypass_23k": "audiocheblimit mode=low-pass cutoff=23000 poles=4",
    "full_neutral":  f"{EQ_NEUTRAL} ! {HP_BYPASS} ! {LP_BYPASS}",
    "CONTROL_lp500": "audiocheblimit mode=low-pass cutoff=500 poles=4",
}


def render(tag, freq, chain):
    """Render `freq` Hz through `chain`; return list of float samples (ch 0)."""
    path = OUT / f"probe_{tag}_{freq}.wav"
    launch = (
        f"audiotestsrc wave=sine freq={freq} volume=0.5 num-buffers=120 "
        f"samplesperbuffer=1024 is-live=false ! "
        f"audio/x-raw,format=F32LE,rate={RATE},channels=2,"
        f"channel-mask=(bitmask)0x3,layout=interleaved ! "
        + (chain + " ! " if chain else "")
        + f"audioconvert ! audio/x-raw,format=S16LE ! wavenc ! filesink location={path}"
    )
    r = subprocess.run(["gst-launch-1.0", "-q"] + launch.split(),
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  !! {tag} @ {freq}Hz failed: {r.stderr.strip()[:300]}", file=sys.stderr)
        return None
    with wave.open(str(path)) as w:
        raw = array.array("h")
        raw.frombytes(w.readframes(w.getnframes()))
    return [s / 32768.0 for s in raw[0::2]]


def rms(xs):
    # Skip the head: IIR filters need time to reach steady state, and a transient
    # averaged into the level would read as a response error that isn't there.
    xs = xs[RATE // 4:]
    if not xs:
        return 0.0
    return math.sqrt(sum(x * x for x in xs) / len(xs))


ref = {}
print("measuring reference (no filter)...", file=sys.stderr)
for f in FREQS:
    y = render("ref", f, "")
    if y is None:
        sys.exit(1)
    ref[f] = rms(y)

hdr = "chain".ljust(15) + "".join(f"{f:>7}" for f in FREQS)
print(hdr)
print("-" * len(hdr))
for name, chain in CHAINS.items():
    row, worst = [], 0.0
    for f in FREQS:
        y = render(name, f, chain)
        if y is None:
            row.append("   err")
            continue
        r = rms(y)
        db = 20 * math.log10(max(r, 1e-12) / max(ref[f], 1e-12))
        worst = max(worst, abs(db))
        row.append(f"{db:>+7.2f}")
    verdict = "FLAT" if worst < 0.5 else f"COLOURED ({worst:.1f}dB)"
    print(name.ljust(15) + "".join(row) + f"   {verdict}")
print("\n(dB deviation from unfiltered, per frequency. CONTROL_lp500 must be COLOURED.)")
