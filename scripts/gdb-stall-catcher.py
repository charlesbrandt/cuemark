#!/usr/bin/env python3
"""
Catches the intermittent scratch-feeder delivery stall (see docs/design/
pcm-buffer-playback.md, "Sixth"/"Seventh mechanism") live, under gdb, and
dumps full thread backtraces + resolved symbols the moment it's caught.

Why gdb launched directly (`gdb --args <bin>`) rather than attaching to an
already-running process: this system's default `yama.ptrace_scope=1` only
allows a tracer to attach to its own descendants. Launching the target
under gdb from the start makes gdb the true parent, so ptrace works with no
sudo/sysctl changes. Attaching to an *already-running* arbitrary process
(e.g. the live cuemark app) instead needs `sudo sysctl kernel.yama.ptrace_scope=0`.

Requires: gdb, python3-pexpect (`pip install pexpect` or apt). Disables
debuginfod (`-iex "set debuginfod enabled off"`) -- without this gdb blocks
on an interactive y/n prompt on first run, which silently hangs any
scripted use of gdb against this binary.

Usage:
    cargo test --no-run --lib -p cuemark   # ensure the test binary is built
    python3 scripts/gdb-stall-catcher.py [run_label] [--max-attempts N]

Re-run a few times -- the stall reproduces roughly half the time.
"""
import pexpect
import sys
import re
import time
import os

BIN_GLOB_HINT = "target/debug/deps/cuemark_lib-*"
TEST = "audio::pipeline::scratch_smoke_test::scratch_second_gesture_reverse_repro"


def find_binary():
    import glob
    candidates = glob.glob(os.path.join(os.path.dirname(__file__), "..", "src-tauri", BIN_GLOB_HINT))
    if not candidates:
        sys.exit("No test binary found -- run `cargo test --no-run --lib` in src-tauri first")
    return max(candidates, key=os.path.getmtime)


def run_once(run_label: str, logdir: str) -> bool:
    """Returns True if a stall was caught this run."""
    bin_path = find_binary()
    logpath = os.path.join(logdir, f"gdb_stall_{run_label}.log")
    logf = open(logpath, "wb")

    env = dict(os.environ)
    env["DEBUGINFOD_URLS"] = ""

    child = pexpect.spawn(
        "gdb", ["-q", "-iex", "set debuginfod enabled off", "--args", bin_path,
                TEST, "--exact", "--ignored", "--nocapture"],
        timeout=30, encoding=None, dimensions=(200, 220), env=env,
    )
    child.logfile = logf
    child.expect_exact("(gdb)")
    child.sendline("set pagination off")
    child.expect_exact("(gdb)")
    child.sendline("run")

    last_total = None
    consecutive_same = 0
    caught = False
    start = time.time()
    buf = b""
    pat = re.compile(rb"sel_scratch_pad cumulative: total=(\d+)")

    while time.time() - start < 25:
        try:
            buf += child.read_nonblocking(size=4096, timeout=0.3)
        except pexpect.exceptions.TIMEOUT:
            pass
        except pexpect.exceptions.EOF:
            break

        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            m = pat.search(line)
            if not m:
                continue
            total = int(m.group(1))
            consecutive_same = consecutive_same + 1 if total == last_total else 0
            last_total = total
            if consecutive_same == 2 and not caught:
                caught = True
                print(f"[{run_label}] STALL caught -- dumping all thread backtraces + "
                      f"resolving appsrc0:src's frames", flush=True)
                try:
                    child.sendintr()
                    child.expect_exact("(gdb)", timeout=10)
                    child.sendline("thread apply all bt 8")
                    child.expect_exact("(gdb)", timeout=15)
                    child.sendline(
                        'python\nimport gdb\n'
                        'for t in gdb.selected_inferior().threads():\n'
                        '    if t.name == "appsrc0:src":\n'
                        '        t.switch(); break\nend'
                    )
                    child.expect_exact("(gdb)", timeout=10)
                    for fnum in range(6):
                        child.sendline(f"frame {fnum}")
                        child.expect_exact("(gdb)", timeout=10)
                        child.sendline("info symbol $pc")
                        child.expect_exact("(gdb)", timeout=10)
                    child.sendline("continue")
                    child.expect_exact("Continuing.", timeout=10)
                except Exception as e:
                    print(f"[{run_label}] inspection failed: {e}", flush=True)

        if child.isalive() is False:
            break

    try:
        child.sendline("quit")
        child.expect_exact(pexpect.EOF, timeout=5)
    except Exception:
        pass
    logf.close()
    print(f"[{run_label}] done -- caught={caught} log={logpath}", flush=True)
    return caught


def main():
    logdir = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "target", "gdb-stall-logs")
    os.makedirs(logdir, exist_ok=True)
    max_attempts = 6
    if "--max-attempts" in sys.argv:
        max_attempts = int(sys.argv[sys.argv.index("--max-attempts") + 1])
    for i in range(1, max_attempts + 1):
        if run_once(str(i), logdir):
            print(f"Caught on attempt {i}/{max_attempts}. See {logdir}/gdb_stall_{i}.log")
            return
    print(f"No stall reproduced in {max_attempts} attempts (it's ~50% per run -- try again).")


if __name__ == "__main__":
    main()
