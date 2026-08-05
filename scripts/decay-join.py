#!/usr/bin/env python3
"""Join scripts/decay-sample.sh's CSV against cuemark.log's [raf]/[aux-loop] lines.

The fps decay in docs/design/legacy-video-fallback-cost.md "2026-08-05 live verification"
is only diagnosable as a *correlation*: fps falls while every in-app metric stays flat, so
the evidence has to come from lining the outcome metric up against machine state sampled
from outside the webview. Doing that by eye across two files with different timestamp
formats is how a run gets misread.

Both sources are wall-clock stamped (the log at 1ms, the sampler at 1s), so the join is on
HH:MM:SS with the sampler row rounded to the nearest log flush.

Usage:
    scripts/decay-join.py /tmp/decay-sample.csv [logfile] [--since HH:MM:SS]

Reads ~/.local/share/com.cuemark.app/logs/cuemark.log by default.
"""
import csv
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

LOG_DEFAULT = Path.home() / ".local/share/com.cuemark.app/logs/cuemark.log"

# [2026-08-05 18:07:26.123][cuemark_lib][INFO] [frontend] [raf] n=293 (~58.6fps) | gap
#   p50=16 p90=17 max=17 | frame-dur p50=0 p90=0 max=1 | busy 1%
RAF_RE = re.compile(
    r"^\[(?P<date>\d{4}-\d{2}-\d{2}) (?P<time>\d{2}:\d{2}:\d{2})\.\d+\].*?"
    r"\[raf\](?P<arm> arm=\S+)? n=(?P<n>\d+) \(~(?P<fps>[\d.]+)fps\).*?"
    r"gap p50=(?P<gap50>-?\d+) p90=(?P<gap90>-?\d+) max=(?P<gapmax>-?\d+).*?"
    r"frame-dur p50=(?P<dur50>-?\d+).*?busy (?P<busy>\d+)%"
)
# [aux-loop] preview/deck-0@1195x672 n=310 drew=0 | dur ... | busy 6%
AUX_RE = re.compile(
    r"^\[(?P<date>\d{4}-\d{2}-\d{2}) (?P<time>\d{2}:\d{2}:\d{2})\.\d+\].*?"
    r"\[aux-loop\](?: arm=\S+)? preview/(?P<deck>\S+?) n=(?P<n>\d+) drew=(?P<drew>\d+).*?"
    r"busy (?P<busy>\d+)%"
)


def parse_log(path, since=None):
    """-> {HH:MM:SS: {fps, busy, gap90, drew, ...}} for every [raf] flush."""
    raf, aux = {}, {}
    with open(path, errors="replace") as fh:
        for line in fh:
            m = RAF_RE.match(line)
            if m:
                t = m.group("time")
                if since and t < since:
                    continue
                raf[t] = {
                    "fps": float(m.group("fps")),
                    "gap90": int(m.group("gap90")),
                    "gapmax": int(m.group("gapmax")),
                    "dur50": int(m.group("dur50")),
                    "busy": int(m.group("busy")),
                    "arm": (m.group("arm") or "").strip().replace("arm=", ""),
                }
                continue
            m = AUX_RE.match(line)
            if m:
                t = m.group("time")
                if since and t < since:
                    continue
                aux[t] = {"drew": int(m.group("drew")), "aux_busy": int(m.group("busy"))}
    for t, v in aux.items():
        if t in raf:
            raf[t].update(v)
    return raf


def nearest(raf, ts, window=3):
    """Log flushes land every ~5s, sampler rows every ~2s -- match within `window` sec."""
    try:
        base = datetime.strptime(ts, "%H:%M:%S")
    except ValueError:
        return None
    for off in range(0, window + 1):
        for sign in (0, -1, 1) if off else (0,):
            key = (base + timedelta(seconds=sign * off)).strftime("%H:%M:%S")
            if key in raf:
                return raf[key]
    return None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    since = None
    for a in sys.argv[1:]:
        if a.startswith("--since"):
            since = a.split("=", 1)[1] if "=" in a else None
    if not args:
        sys.exit(__doc__)
    csv_path = args[0]
    log_path = Path(args[1]) if len(args) > 1 else LOG_DEFAULT

    raf = parse_log(log_path, since)
    if not raf:
        sys.exit(f"no [raf] lines parsed from {log_path}"
                 + (f" since {since}" if since else ""))

    rows = list(csv.DictReader(open(csv_path)))
    hdr = (f"{'time':>8} {'el':>4} {'fps':>6} {'busy':>5} {'gap90':>6} {'drew':>5} "
           f"{'webRSS':>7} {'cueRSS':>7} {'webCPU':>7} {'temp':>5} {'MHz':>5} "
           f"{'thrD':>5} {'iowt':>5} {'swap':>6}")
    print(hdr)
    print("-" * len(hdr))

    first_web = first_cue = None
    for r in rows:
        m = nearest(raf, r["ts"])
        web = r.get("web_rss_mb") or ""
        cue = r.get("cuemark_rss_mb") or ""
        if web and first_web is None:
            first_web = int(web)
        if cue and first_cue is None:
            first_cue = int(cue)
        # RSS shown as delta from the run's first sample: absolute values are dominated by
        # startup allocation, and it is the *growth across the decay* that is the evidence.
        webd = f"{int(web) - first_web:+d}" if web else ""
        cued = f"{int(cue) - first_cue:+d}" if cue else ""
        fps = f"{m['fps']:.1f}" if m else "-"
        busy = f"{m['busy']}%" if m else "-"
        gap90 = str(m["gap90"]) if m else "-"
        drew = str(m.get("drew", "-")) if m else "-"
        print(
            f"{r['ts']:>8} {r['elapsed']:>4} {fps:>6} {busy:>5} {gap90:>6} {drew:>5} "
            f"{webd:>7} {cued:>7} {(r.get('web_cpu') or ''):>7} "
            f"{(r.get('pkg_temp_c') or ''):>5} {(r.get('avg_mhz') or ''):>5} "
            f"{(r.get('throttle_ms_d') or ''):>5} {(r.get('iowait_pct') or ''):>5} "
            f"{(r.get('swap_used_mb') or ''):>6}"
        )

    print()
    print(f"webRSS/cueRSS are MB deltas from the first sample "
          f"(web={first_web}MB cue={first_cue}MB at t=0).")
    print("thrD = ms spent thermally throttled during that interval. A nonzero column "
          "here while fps falls is the throttle verdict;")
    print("a climbing webRSS with thrD flat is the leak verdict.")


if __name__ == "__main__":
    main()
