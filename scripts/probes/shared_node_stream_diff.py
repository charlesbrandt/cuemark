#!/usr/bin/env python3
"""What is different about cuemark's two PipeWire streams when they share the Starlight node?

**The question this answers.** `docs/design/slow-jog-audio-inaudible.md` §10.11 left the fault
condition sharpened but the mechanism unnamed:

    two `pulsesink`s on one node  AND  that node is the Starlight  →  cue gates during a scratch
    either one alone                                              →  clean

Four device-level differences could each plausibly explain it (44100-only against a graph pinned
to 48000, so every stream is resampled; a full-speed **ASYNC** endpoint with a feedback endpoint
against **ADAPTIVE**; 4ch S24_3LE against 2ch S16_LE; `priority.driver = 1009`). Four candidates
and one bit of evidence is exactly the ratio that killed two earlier hypotheses on their first
controlled arm — so this does not test a hypothesis. It **reads both arms and diffs them.**

**Why this reading is possible now and was not before.** §10.11 produced the first matched pair
this investigation has had: arm 5 (both branches on the Starlight — gates) and arm 6 (both on
the USB CODEC, main volume 0 — clean) are the *same topology*, the *same code path* and the
*same gesture*, differing only in the device. A mechanism must predict the difference between
those two. Everything before this was a broken state with nothing to compare it against, which
is how six hypotheses got built out of readings that look identical in both states.

**What it samples**, per second, for the whole gesture:

- `pw-top -b` per node: **ERR** (the xrun counter — cumulative, so no sample is ever missed),
  **QUANT**/**RATE** (a change mid-gesture is a renegotiation), **WAIT**/**BUSY** and their
  per-quantum ratios (scheduling headroom).
- `pw-dump` per node: the negotiated `Format` (rate/format/channels/position) and the node
  `state`. A stream that drops out of `running` mid-gesture is the whole answer if it happens.

**Identifying the branches.** Both cuemark streams present to PipeWire as `NAME = cuemark`, so
pw-top alone cannot tell main from cue — that ambiguity produced a wrong conclusion once already
(see `make_sink()`'s `stream-properties` comment). This joins on the private `cuemark.branch`
key, which is why that key exists: `deck-0/0` is main sink 0, `deck-0-cue` is the cue branch.

**Traps, all of which produce a confident meaningless take:**

- 🔴 **A suspended or idle stream measures nothing.** The cue stream only runs with a deck
  loaded *and* cue enabled; the main stream needs the deck playing or a scratch in progress.
  The pre-flight refuses to start unless both are live, because a `state=idle` node reports
  `ERR 0` and a stable quantum forever and reads exactly like a healthy one.
- 🔴 **`ERR` is cumulative since the node started**, not per-sample. Always read the *delta*
  across the take, which is what the summary prints; the absolute value carries a whole
  session's history and means nothing on its own.
- ⚠️ **Both arms must be captured the same way** — same gesture style, same duration, deck in
  the same state. The comparison is the entire value of this probe; a take that differs from
  its partner in two ways answers nothing. Use `--label` and keep the two takes together.
- ⚠️ Absolute `WAIT`/`BUSY` values are load-dependent and this machine's frame rate oscillates
  on a multi-minute cycle (CLAUDE.md, "the VP9 decay was a measurement artifact"). Read them as
  a difference between arms captured close together, never as an absolute.

Usage:
    # arm 5 — both branches on the Starlight (the failing configuration)
    scripts/probes/shared_node_stream_diff.py 15 --label starlight-shared

    # arm 6 — both branches on the USB CODEC, main volume 0 (the working configuration)
    scripts/probes/shared_node_stream_diff.py 15 --label codec-shared

    # then
    scripts/probes/shared_node_stream_diff.py --compare /tmp/*starlight-shared*.json \
                                                        /tmp/*codec-shared*.json

While it counts down: deck loaded, cue on, vinyl scratch mode, and keep jogging for the whole
capture — slow steady turns, the kind that gate. The point is to sample *during* the fault.

Exit status: 0 = capture written, 1 = pre-flight refused (nothing was measured).
"""
import argparse
import json
import subprocess
import sys
import threading
import time

STREAM_CLASS = "Stream/Output/Audio"
BRANCH_KEY = "cuemark.branch"


# ── discovery ────────────────────────────────────────────────────────────────


def pw_dump(ids=None):
    cmd = ["pw-dump"] + [str(i) for i in (ids or [])]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=15).stdout
        return json.loads(out) if out.strip() else []
    except Exception as e:
        print(f"  (pw-dump failed: {e})")
        return []


def discover():
    """cuemark's live streams plus the device node each one is targeting.

    Returns (streams, devices) where streams is a list of dicts and devices maps
    node-name → {id, description, rate, position}.
    """
    dump = pw_dump()
    devices = {}
    for o in dump:
        info = o.get("info") or {}
        p = info.get("props") or {}
        if p.get("media.class") == "Audio/Sink":
            devices[p.get("node.name")] = {
                "id": o.get("id"),
                "description": p.get("node.description"),
                "position": p.get("audio.position"),
                "state": info.get("state"),
            }

    streams = []
    for o in dump:
        info = o.get("info") or {}
        p = info.get("props") or {}
        if p.get("media.class") != STREAM_CLASS:
            continue
        branch = p.get(BRANCH_KEY)
        if branch is None:
            continue  # not ours — some other app's playback stream
        streams.append({
            "id": o.get("id"),
            "branch": branch,
            "target": p.get("target.object") or p.get("node.target"),
            "state": info.get("state"),
            "format": format_of(o),
        })
    streams.sort(key=lambda s: s["branch"])
    return streams, devices


def format_of(node_obj):
    """Negotiated audio format of a node, as a flat dict, or {} if not negotiated.

    Defensive on shape: the `Format` param is absent entirely on a suspended node and its
    layout has changed across PipeWire versions. An unreadable format must degrade to {} and
    let the rest of the take stand, not raise — a take is expensive (it costs a live gesture).
    """
    params = ((node_obj.get("info") or {}).get("params") or {})
    fmts = params.get("Format") or []
    if not isinstance(fmts, list) or not fmts:
        return {}
    f = fmts[0] if isinstance(fmts[0], dict) else {}
    return {k: f.get(k) for k in ("format", "rate", "channels", "position") if k in f}


# ── pw-top sampling ──────────────────────────────────────────────────────────


PW_TOP_FIELDS = ["S", "ID", "QUANT", "RATE", "WAIT", "BUSY", "W/Q", "B/Q", "ERR"]


def is_header(line):
    """The `S ID QUANT …` column header.

    ⚠️ **Must not be detected by the first character.** pw-top's first column is the node's
    *state letter*, and `S` there means **suspended** — so `line.startswith("S ")` matches
    every suspended node's row as well as the header. That dropped those rows entirely and
    split one snapshot into several. Harmless for a node that is inactive anyway, but a
    watched node going suspended mid-gesture is exactly the event this probe is hunting, and
    silently discarding it would let `xrun_delta` join across the gap and charge the
    post-suspend counter jump to the take. Match on the second field instead.
    """
    parts = line.split()
    return len(parts) >= 2 and parts[0] == "S" and parts[1] == "ID"


def parse_pw_top_line(line):
    """One pw-top batch row → dict, or None for headers and unparseable rows.

    The row is 9 fixed columns then `FORMAT NAME`, where FORMAT may be empty and NAME may
    contain spaces. Only the fixed columns and the ID are load-bearing here, so the tail is
    kept whole rather than split on a guess.
    """
    parts = line.split()
    if len(parts) < len(PW_TOP_FIELDS) or is_header(line):
        return None
    row = dict(zip(PW_TOP_FIELDS, parts[: len(PW_TOP_FIELDS)]))
    try:
        row["ID"] = int(row["ID"])
        row["ERR"] = int(row["ERR"])
    except ValueError:
        return None
    row["TAIL"] = " ".join(parts[len(PW_TOP_FIELDS):])
    return row


def sample_pw_top(seconds, sink):
    """Run pw-top in batch for `seconds` iterations, appending each snapshot to `sink`."""
    proc = subprocess.Popen(
        ["pw-top", "-b", "-n", str(max(1, int(seconds)))],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    snapshot = []
    for line in proc.stdout:
        if is_header(line):
            if snapshot:
                sink.append({"t": time.time(), "rows": snapshot})
                snapshot = []
            continue
        row = parse_pw_top_line(line)
        if row:
            snapshot.append(row)
    if snapshot:
        sink.append({"t": time.time(), "rows": snapshot})
    proc.wait()


# ── capture ──────────────────────────────────────────────────────────────────


def preflight(streams, devices):
    """Refuse to measure a topology that cannot show the fault. Returns the arm's shape."""
    print("cuemark streams:")
    for s in streams:
        print(f"  {s['branch']:<14} node={s['id']:<5} state={s['state']:<10} → {s['target']}")
    if not streams:
        print("\n✗ No cuemark streams found. Is the app running with a deck loaded?")
        return None
    if len(streams) < 2:
        print("\n✗ Only one cuemark stream is live. This probe compares two streams on one "
              "node — load a deck, enable cue, and set both a main and a cue device.")
        return None

    idle = [s for s in streams if s["state"] != "running"]
    if idle:
        print("\n✗ Not every stream is running: "
              + ", ".join(f"{s['branch']}={s['state']}" for s in idle))
        print("  A suspended or idle node reports ERR 0 and a stable quantum forever, which is "
              "indistinguishable from a healthy one. Start playback (or hold a scratch) and "
              "enable cue, then re-run.")
        return None

    targets = {s["target"] for s in streams}
    shared = len(targets) == 1
    print(f"\ntopology: {len(streams)} streams over {len(targets)} device node(s) — "
          f"{'SHARED (the fault condition)' if shared else 'SPLIT (a known-clean arm)'}")
    for t in sorted(targets):
        d = devices.get(t, {})
        print(f"  {t}\n    {d.get('description')}  position={d.get('position')}")
    return {"shared_node": shared, "targets": sorted(targets)}


def select(streams, branch_filters):
    if not branch_filters:
        return streams
    return [s for s in streams if any(f in s["branch"] for f in branch_filters)]


def wait_for_running(branch_filters, timeout):
    """Poll until every selected stream is `running`, or give up after `timeout` seconds.

    The repro this probe exists for is a **paused** deck being jogged, whose sinks sit idle
    between gestures — so refusing outright on the first idle reading would reject the exact
    workflow being measured. Waiting lets the operator start the gesture and have the capture
    begin under it. Returns the streams as last seen, running or not; the pre-flight still has
    the final say.
    """
    deadline = time.time() + timeout
    prompted = False
    while True:
        streams, devices = discover()
        sel = select(streams, branch_filters)
        if sel and all(s["state"] == "running" for s in sel):
            return streams, devices
        if time.time() >= deadline:
            return streams, devices
        if not prompted:
            print(f"waiting up to {timeout:.0f}s for the streams to go `running` — "
                  "start jogging (or hit play), and keep going…")
            prompted = True
        time.sleep(0.5)


def capture(seconds, label, out_path, branch_filters=None, wait=20.0):
    streams, devices = wait_for_running(branch_filters, wait)
    if branch_filters:
        # A two-deck set has four cuemark streams and only some of them are the pair under
        # test; without this the pre-flight refuses on an idle deck that is not participating.
        kept = select(streams, branch_filters)
        dropped = [s["branch"] for s in streams if s not in kept]
        if dropped:
            print(f"(--branch: ignoring {', '.join(dropped)})")
        streams = kept
    shape = preflight(streams, devices)
    if shape is None:
        return 1

    watch = {s["id"]: s["branch"] for s in streams}
    for t in shape["targets"]:
        if t in devices:
            watch[devices[t]["id"]] = f"DEVICE {t}"

    print(f"\nCapturing {seconds}s — jog NOW, and keep jogging for the whole capture.")
    for i in range(3, 0, -1):
        print(f"  {i}…", flush=True)
        time.sleep(1)
    print("  GO")

    snapshots = []
    t_top = threading.Thread(target=sample_pw_top, args=(seconds, snapshots), daemon=True)
    t_top.start()

    node_samples = []
    deadline = time.time() + seconds
    while time.time() < deadline:
        # ⚠️ Full dump, filtered here — NOT `pw-dump <id> <id>`. Asking pw-dump for several
        # object ids at once returns an incomplete set on this PipeWire (observed live: two
        # ids in, one object out), which silently drops one branch's state for the whole take
        # and prints it as `state=?` — a missing measurement that reads like a finding.
        for o in pw_dump():
            if o.get("id") not in watch:
                continue
            info = o.get("info") or {}
            node_samples.append({
                "t": time.time(),
                "id": o.get("id"),
                "state": info.get("state"),
                "format": format_of(o),
            })
        time.sleep(0.5)
    t_top.join(timeout=seconds + 5)

    take = {
        "label": label,
        "seconds": seconds,
        "shape": shape,
        "watch": {str(k): v for k, v in watch.items()},
        "streams": streams,
        "devices": devices,
        "pw_top": snapshots,
        "node_samples": node_samples,
    }
    with open(out_path, "w") as f:
        json.dump(take, f, indent=1)
    print(f"\nwrote {out_path}")
    summarize(take)
    return 0


# ── summary + comparison ─────────────────────────────────────────────────────


def per_node(take):
    """node id → aggregated readings across the take.

    Two corrections that matter, both found by running this against a synthetic pair before
    trusting it on a live gesture:

    - **`xruns` counts only increments observed while the node was active in *both* samples.**
      `ERR` is cumulative since the node started, and an inactive node reports `0`, so a plain
      max−min charges the whole counter to the take the moment a suspended node wakes up. That
      read **588 xruns** on a device that had none during the window.
    - **`quant`/`rate` ignore `0`**, which is what an inactive node reports. Keeping it made
      every take show two distinct values and look like a mid-gesture renegotiation.
    """
    watch = {int(k): v for k, v in take["watch"].items()}
    agg = {}
    for snap in take["pw_top"]:
        for row in snap["rows"]:
            if row["ID"] not in watch:
                continue
            a = agg.setdefault(row["ID"], {
                "label": watch[row["ID"]], "err": [], "quant": set(),
                "rate": set(), "wq": [], "bq": [], "state": set(), "active": [],
            })
            active = row["QUANT"] != "0"
            a["err"].append(row["ERR"])
            a["active"].append(active)
            if active:
                a["quant"].add(row["QUANT"])
                a["rate"].add(row["RATE"])
            a["wq"].append(row["W/Q"])
            a["bq"].append(row["B/Q"])
    for s in take["node_samples"]:
        if s["id"] in agg:
            agg[s["id"]]["state"].add(s["state"])
            if s["format"]:
                agg[s["id"]].setdefault("format", set()).add(json.dumps(s["format"], sort_keys=True))
    for a in agg.values():
        a["xruns"] = xrun_delta(a["err"], a["active"])
    return agg


def xrun_delta(err, active):
    """Xruns accrued *during* the take: positive increments between consecutive active samples.

    Skips the step into and out of inactivity (where the counter jumps from 0 to a whole
    session's history, or back), and treats a decrease as a counter reset rather than negative
    xruns.
    """
    total = 0
    for i in range(1, len(err)):
        if active[i] and active[i - 1] and err[i] > err[i - 1]:
            total += err[i] - err[i - 1]
    return total


def fmt_row(label, a):
    quant = ",".join(sorted(a["quant"])) or "idle"
    rate = ",".join(sorted(a["rate"])) or "idle"
    states = ",".join(sorted(x for x in a["state"] if x)) or "?"
    wq = [x for x in a["wq"] if x not in ("---", "")]
    bq = [x for x in a["bq"] if x not in ("---", "")]
    return (f"  {label:<28} xruns={a['xruns']:<5} quant={quant:<12} rate={rate:<8} "
            f"state={states:<10} W/Q={wq[-1] if wq else '---':<7} B/Q={bq[-1] if bq else '---'}")


def summarize(take):
    print(f"\n── {take['label']} "
          f"({'SHARED node' if take['shape']['shared_node'] else 'SPLIT nodes'}, "
          f"{len(take['pw_top'])} snapshots) ──")
    agg = per_node(take)
    for _, a in sorted(agg.items(), key=lambda kv: kv[1]["label"]):
        print(fmt_row(a["label"], a))
        for f in sorted(a.get("format", [])):
            print(f"      format {f}")
    print("\n  xruns is a delta across the take (ERR is cumulative). A quant/rate set with more "
          "than one value is a renegotiation mid-gesture.")


def compare(path_a, path_b):
    a, b = (json.load(open(p)) for p in (path_a, path_b))
    for take in (a, b):
        summarize(take)

    print("\n── diff ──")
    agg_a, agg_b = per_node(a), per_node(b)
    by_label_a = {v["label"]: v for v in agg_a.values()}
    by_label_b = {v["label"]: v for v in agg_b.values()}

    for label in sorted(set(by_label_a) | set(by_label_b)):
        ra, rb = by_label_a.get(label), by_label_b.get(label)
        if not ra or not rb:
            print(f"  {label:<28} present only in {a['label'] if ra else b['label']}")
            continue
        xa, xb = ra["xruns"], rb["xruns"]
        marks = []
        if xa != xb:
            marks.append(f"xruns {xa} vs {xb}")
        if ra["quant"] != rb["quant"]:
            marks.append(f"quant {sorted(ra['quant'])} vs {sorted(rb['quant'])}")
        if ra["rate"] != rb["rate"]:
            marks.append(f"rate {sorted(ra['rate'])} vs {sorted(rb['rate'])}")
        if ra.get("format") != rb.get("format"):
            marks.append("format differs")
        if ra["state"] != rb["state"]:
            marks.append(f"state {sorted(ra['state'])} vs {sorted(rb['state'])}")
        print(f"  {label:<28} {'; '.join(marks) if marks else '(no difference in these fields)'}")

    print("\n⚠️  Read the branch rows against each other, not against the device row. The claim "
          "under test is about the two cuemark streams; the device node is context.")
    print("⚠️  'No difference in these fields' is a real result — it means the mechanism is not "
          "visible at this layer, and the next tap is below PipeWire (ALSA/USB), not another "
          "hypothesis at this one.")
    return 0


def main():
    ap = argparse.ArgumentParser(add_help=True, description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("seconds", nargs="?", type=float, default=15.0)
    ap.add_argument("--label", default="take", help="arm name, e.g. starlight-shared")
    ap.add_argument("--out", default=None)
    ap.add_argument("--branch", action="append", metavar="SUBSTR",
                    help="only measure branches whose cuemark.branch contains SUBSTR "
                         "(repeatable). Use in a two-deck set to select the pair under test; "
                         "an idle deck's streams would otherwise refuse the pre-flight.")
    ap.add_argument("--wait", type=float, default=20.0,
                    help="seconds to wait for the streams to go `running` before refusing "
                         "(default 20). The repro is a paused deck, whose sinks idle between "
                         "gestures — start jogging while this waits.")
    ap.add_argument("--compare", nargs=2, metavar=("A.json", "B.json"))
    args = ap.parse_args()

    if args.compare:
        return compare(*args.compare)

    out = args.out or f"/tmp/cuemark-nodediff-{args.label}-{time.strftime('%H%M%S')}.json"
    return capture(args.seconds, args.label, out, args.branch, args.wait)


if __name__ == "__main__":
    sys.exit(main())
