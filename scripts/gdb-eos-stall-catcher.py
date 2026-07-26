#!/usr/bin/env python3
"""
Catches the 100%-reproducible near-end-of-track silent stall (docs/design/
webcodecs-video-path.md, "Phase 4 results" — the EOS-stall finding) live,
under gdb, and dumps full thread backtraces the moment it's caught.

Unlike scripts/gdb-stall-catcher.py (the older, ~50%-reproducible
scratch-feeder race), this bug reproduces every single time on the very
short local test file (5.6s), so one run is enough — no retry loop needed.

Requires: gdb, python3-pexpect. Launches gdb as the true parent of the test
binary (`gdb --args`) so ptrace works under this system's default
yama.ptrace_scope=1 with no sudo/sysctl changes — see skills/audio-debugging
"Catching an intermittent GStreamer-side stall live with gdb" for why
attaching to an already-running process needs root instead.

Usage:
    cd src-tauri && cargo test --no-run --lib   # ensure the test binary is built
    python3 scripts/gdb-eos-stall-catcher.py
"""
import pexpect
import sys
import re
import time
import os
import glob

TEST = "audio::pipeline::scratch_smoke_test::eos_stall_repro"


def find_binary():
    candidates = glob.glob(os.path.join(os.path.dirname(__file__), "..", "src-tauri",
                                         "target/debug/deps/cuemark_lib-*"))
    candidates = [c for c in candidates if not c.endswith(".d")]
    if not candidates:
        sys.exit("No test binary found -- run `cargo test --no-run --lib` in src-tauri first")
    return max(candidates, key=os.path.getmtime)


def main():
    bin_path = find_binary()
    print(f"Using test binary: {bin_path}")
    logdir = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "target", "gdb-stall-logs")
    os.makedirs(logdir, exist_ok=True)
    logpath = os.path.join(logdir, "gdb_eos_stall.log")
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

    pat = re.compile(rb"pos=Some\(([0-9.]+)\)")
    last_val = None
    consecutive_same = 0
    caught = False
    buf = b""
    start = time.time()

    while time.time() - start < 30:
        try:
            buf += child.read_nonblocking(size=4096, timeout=0.3)
        except pexpect.exceptions.TIMEOUT:
            pass
        except pexpect.exceptions.EOF:
            break

        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            sys.stdout.buffer.write(line + b"\n")
            sys.stdout.flush()
            m = pat.search(line)
            if not m:
                continue
            val = m.group(1)
            consecutive_same = consecutive_same + 1 if val == last_val else 0
            last_val = val
            if consecutive_same == 2 and not caught:
                caught = True
                print(f"\n[catcher] STALL caught at pos={val.decode()} -- interrupting and dumping "
                      f"all thread backtraces\n", flush=True)
                try:
                    child.sendintr()
                    child.expect_exact("(gdb)", timeout=10)
                    child.sendline("thread apply all bt")
                    child.expect_exact("(gdb)", timeout=20)
                    print(child.before.decode(errors="replace"))
                    child.sendline("info threads")
                    child.expect_exact("(gdb)", timeout=10)
                    print(child.before.decode(errors="replace"))
                except Exception as e:
                    print(f"[catcher] inspection failed: {e}", flush=True)
                finally:
                    try:
                        child.sendline("kill")
                        child.expect_exact("(gdb)", timeout=10)
                    except Exception:
                        pass
                break
        if caught:
            break
        if child.isalive() is False:
            break

    try:
        child.sendline("quit")
        child.expect_exact(pexpect.EOF, timeout=5)
    except Exception:
        pass
    logf.close()
    print(f"\n[catcher] done -- caught={caught} full log={logpath}")
    if not caught:
        sys.exit("Did not catch the stall -- unexpected, this bug should be 100% reproducible")


if __name__ == "__main__":
    main()
