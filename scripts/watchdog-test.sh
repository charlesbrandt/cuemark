#!/usr/bin/env bash
# Phase 3 gate script for docs/design/freeze-watchdog.md ("Arm recovery tiers").
# Drives the real compiled binary headlessly (tauri-driver + Xvfb, see
# skills/verify-ui/SKILL.md) and exercises the Rust watchdog thread's tiered recovery
# (eval reload -> native reload -> SIGKILL+reload) against three freeze simulations:
#
#   1. `kill -STOP` the real WebKitWebProcess — closest cheap analog of mechanism A
#      (whole process parked). Tiers 1-2 are expected to no-op (a stopped process can't
#      run a queued eval or process a reload command); tier 3's SIGKILL is what actually
#      breaks it.
#   2. `__cuemarkDebug.freezeMainThread(0)` — JS main thread busy-loops forever. Same
#      "tiers 1-2 no-op, tier 3 breaks it" shape, but the process stays schedulable
#      (spinning at ~100% CPU on one core) rather than parked — exercises the other half
#      of the "process alive but wedged" freeze space.
#   3. `kill -KILL` the WebKitWebProcess directly (crash path) — the watchdog should
#      still detect silence and recover cleanly even though tiers 1-2 target an
#      already-dead process.
#
# Each scenario gets its OWN fresh app launch (own tauri-driver session, own Xvfb
# display stays shared but the app+session are torn down and restarted between
# scenarios). This was learned the hard way: chaining scenarios inside one WebDriver
# session doesn't work reliably once tier 3 SIGKILLs the WebKitWebProcess out from
# under it — the WebDriver session frequently doesn't survive/reconnect even though the
# Rust process, GTK window, and a freshly-spawned WebKitWebProcess are all fine and the
# recovery itself succeeded (confirmed via the Rust log). Relaunching per scenario
# avoids depending on WebDriver session survival for anything the watchdog itself
# doesn't need to survive.
#
# Then a false-positive check: normal playback + a MIDI-rate burst (mirrors
# latency-test.sh's load profile) with recovery armed, asserting zero watchdog TRIGGERs.
# This is a short smoke version of the design doc's step-5 gate (10 min); it is not a
# substitute for that longer soak run before declaring phase 1's false-positive gate met.
#
# Requires: VITE_ENABLE_DEBUG_HOOK=1 cargo tauri build --debug --no-bundle
# (see skills/verify-ui/SKILL.md for full setup)
#
# Usage:
#   ./scripts/watchdog-test.sh <video_file>

set -euo pipefail
cd "$(dirname "$0")/.."

VIDEO_FILE="${1:?Usage: $0 <video_file>}"
BINARY="$(pwd)/src-tauri/target/debug/cuemark"
DRIVER_PORT=4444
DISPLAY_NUM=99
LOG_FILE="$HOME/.local/share/com.cuemark.app/logs/cuemark.log"

XVFB_PID=""
DRIVER_PID=""
SESSION=""
APP_PID=""

stop_app() {
  if [ -n "$SESSION" ]; then
    curl -s -X DELETE "http://localhost:$DRIVER_PORT/session/$SESSION" >/dev/null 2>&1 || true
    SESSION=""
  fi
  # Tier 3 recovery SIGKILLs WebKitWebProcess descendants but never the app itself, and
  # tauri-driver doesn't reliably reap its spawned app on session teardown — kill our
  # launched instance explicitly so it never lingers into the next scenario's (or next
  # run's) pid attribution.
  if [ -n "$APP_PID" ]; then
    pkill -KILL -P "$APP_PID" >/dev/null 2>&1 || true
    kill -KILL "$APP_PID" >/dev/null 2>&1 || true
    APP_PID=""
  fi
  [ -n "$DRIVER_PID" ] && { kill "$DRIVER_PID" >/dev/null 2>&1 || true; DRIVER_PID=""; }
  fuser -k "$DRIVER_PORT/tcp" >/dev/null 2>&1 || true
}

cleanup() {
  stop_app
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Refuse to run alongside a leftover cuemark instance from a prior aborted run — pid
# attribution below assumes exactly one process matches $BINARY at a time.
if pgrep -f "^$BINARY\$" >/dev/null 2>&1; then
  echo "A cuemark instance at $BINARY is already running (stale from a prior run?)." >&2
  echo "Kill it first: pkill -KILL -f '^$BINARY\$'" >&2
  exit 1
fi

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1 (see skills/verify-ui/SKILL.md)" >&2; exit 1; }
}
require Xvfb; require curl; require jq; require awk; require pgrep
. "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$PATH"
require tauri-driver

if [ ! -x "$BINARY" ]; then
  echo "Binary not found at $BINARY." >&2
  echo "Build it first: VITE_ENABLE_DEBUG_HOOK=1 cargo tauri build --debug --no-bundle" >&2
  exit 1
fi
if ! grep -q '__cuemarkDebug' dist/assets/*.js 2>/dev/null; then
  echo "WARNING: debug hook not found in dist/ — rebuild with VITE_ENABLE_DEBUG_HOOK=1" >&2
fi

# The binary has lived in two differently-named Debian packages (webkit2gtk-driver,
# then webkitgtk-webdriver), and `dpkg -L` on the wrong one aborts the whole script
# under `set -e` with a bare dpkg-query error that looks nothing like the real problem.
# Ask the PATH first; fall back to either package name.
WEBKIT_DRIVER="$(command -v WebKitWebDriver \
  || dpkg -L webkitgtk-webdriver 2>/dev/null | grep -E '/WebKitWebDriver$' \
  || dpkg -L webkit2gtk-driver 2>/dev/null | grep -E '/WebKitWebDriver$')"
[ -n "$WEBKIT_DRIVER" ] || { echo "WebKitWebDriver not found (see skills/verify-ui/SKILL.md)" >&2; exit 1; }

# Start with a clean log file so `log_since` markers (byte offsets) are unambiguous —
# a stale multi-run log makes "no TRIGGER since marker X" checks fragile across reruns.
mkdir -p "$(dirname "$LOG_FILE")"
: > "$LOG_FILE" 2>/dev/null || true

Xvfb ":$DISPLAY_NUM" -screen 0 1280x900x24 >/tmp/cuemark-watchdog-xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1

# Launches a fresh app instance + WebDriver session, sets $SESSION/$APP_PID. Call
# stop_app first if a previous instance is still up.
start_app() {
  fuser -k "$DRIVER_PORT/tcp" >/dev/null 2>&1 || true
  DISPLAY=":$DISPLAY_NUM" tauri-driver --port "$DRIVER_PORT" --native-driver "$WEBKIT_DRIVER" \
    >>/tmp/cuemark-watchdog-driver.log 2>&1 &
  DRIVER_PID=$!
  sleep 1

  SESSION=$(curl -s -X POST "http://localhost:$DRIVER_PORT/session" \
    -H "Content-Type: application/json" \
    -d "{\"capabilities\":{\"alwaysMatch\":{\"tauri:options\":{\"application\":\"$BINARY\"}}}}" \
    | jq -r '.value.sessionId')

  if [ -z "$SESSION" ] || [ "$SESSION" = "null" ]; then
    echo "Failed to create session. Check /tmp/cuemark-watchdog-driver.log" >&2
    exit 1
  fi
  sleep 2 # let onMount complete before calling __cuemarkDebug

  # Unambiguous: stop_app always kills the previous instance by exact pid before this
  # is called again, and the top-level guard above confirmed nothing else was running
  # at script start.
  APP_PID=$(pgrep -f "^$BINARY\$" | head -1)
  if [ -z "$APP_PID" ]; then
    echo "Could not find launched cuemark process for $BINARY" >&2
    exit 1
  fi
  echo "Session: $SESSION  App PID: $APP_PID"
}

js_sync() {
  local body
  body=$(jq -n --arg script "$1" '{"script":$script,"args":[]}')
  curl -s -X POST "http://localhost:$DRIVER_PORT/session/$SESSION/execute/sync" \
    -H "Content-Type: application/json" \
    -d "$body" | jq -r '.value // empty'
}

js_async() {
  local body
  body=$(jq -n --arg script "$1" '{"script":$script,"args":[]}')
  curl -s -X POST "http://localhost:$DRIVER_PORT/session/$SESSION/execute/async" \
    -H "Content-Type: application/json" \
    -d "$body" | jq -r '.value // empty'
}

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
check_eq() {
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass "$label"; else fail "$label (got '$got', want '$want')"; fi
}
check_true() {
  local label="$1" cond="$2"
  if [ "$cond" = "true" ]; then pass "$label"; else fail "$label"; fi
}

# Byte-offset marker into $LOG_FILE, so each scenario only inspects log lines written
# during that scenario rather than the whole run's history.
log_mark() { wc -c < "$LOG_FILE" 2>/dev/null || echo 0; }
log_since() { tail -c "+$(($1 + 1))" "$LOG_FILE" 2>/dev/null || true; }

# Resolve the WebKitWebProcess child of *our* launched instance ($APP_PID). Direct
# child only (`-P`) — good enough for this sandboxed headless launch; the Rust watchdog
# itself walks the full descendant tree in case a bwrap layer is interposed elsewhere.
webkit_pid() {
  pgrep -P "$APP_PID" -f WebKitWebProcess | head -1
}

load_and_play() {
  local escaped
  escaped=$(printf '%s' "$VIDEO_FILE" | sed 's/\\/\\\\/g; s/"/\\"/g')
  js_sync "window.__cuemarkDebug.updateDeck('deck-0', {source:{type:'video',filePath:\"$escaped\",duration:0},playing:false});" >/dev/null
  sleep 4 # loadedmetadata, audioLoad, waveform analysis
  local deck_src
  deck_src=$(js_sync "const d = window.__cuemarkDebug.getSession().decks.find(d=>d.id==='deck-0'); return d?.source?.filePath ?? null")
  check_eq "deck-0 source set" "$deck_src" "$VIDEO_FILE"
  js_sync "window.__cuemarkDebug.updateDeck('deck-0', {playing:true});" >/dev/null
  sleep 3
}

echo
echo "=== Step 1: baseline — load + play, confirm no false trigger over ~8s ==="
start_app
HOOK_OK=$(js_sync "return typeof window.__cuemarkDebug !== 'undefined'")
check_eq "debug hook present" "$HOOK_OK" "true"
load_and_play
BASELINE_MARK=$(log_mark)
sleep 8
BASELINE_LOG=$(log_since "$BASELINE_MARK")
BASELINE_TRIGGERS=$(printf '%s' "$BASELINE_LOG" | grep -c "\[watchdog\] TRIGGER" || true)
check_eq "no TRIGGER during normal playback" "$BASELINE_TRIGGERS" "0"

# --- Shared scenario runner -------------------------------------------------
# Assumes start_app + load_and_play already ran for a fresh instance. Captures
# pre-freeze state via js_sync (session is still healthy at this point), applies
# `freeze_fn` to wedge the webview, then verifies recovery via the RUST LOG, not
# another round of js_sync/wait_for_hook.
#
# Why log-based, not WebDriver-based: discovered the hard way that once our Rust code
# (not a WebDriver command) triggers a real navigation on the window under an active
# tauri-driver session — eval("location.reload()"), native reload(), or a SIGKILL
# forcing WebKitGTK to respawn the process — the WebDriver session stops answering
# execute/sync reliably (or returns "invalid session id") even though the Rust log
# proves the page came back and rehydrated correctly. rehydration-test.sh's own
# location.reload() doesn't hit this because IT calls reload from *inside* an
# execute/async script (a WebDriver-issued command), which is a different code path
# from tauri-driver's/WebKitWebDriver's perspective than our watchdog dispatching
# eval()/reload() externally via the wry dispatcher. Net effect: this harness can't use
# js_sync to verify state after OUR reload, so it reads the authoritative source instead
# — the same Rust log rehydration-test.sh already gates phase 2's correctness against
# (TRIGGER, tier attempts, "recovery sequence succeeded", and the frontend's own
# "[recovery] adopted deck-0 at Xs playing=Y" debugLog line, which only fires from the
# exact onMount rehydration path phase 2's gate covers in full).
run_freeze_scenario() {
  local scenario_name="$1" freeze_fn="$2"

  echo
  echo "=== Scenario: $scenario_name ==="
  local pre_audio_pos pre_wallclock mark

  # `audio_get_position` returns a `PositionSample` OBJECT ({pos, entryMs, lockMs,
  # queryMs, exitMs}) since the IPC-leg instrumentation landed; it used to return a bare
  # number. This script kept treating it as a scalar and fed the whole JSON blob to awk,
  # which died with a syntax error *after* the scenario's real assertions had already
  # passed — i.e. the gate exited non-zero for a reason that had nothing to do with
  # recovery. Accept either shape (2026-08-05).
  pre_audio_pos=$(js_sync "return window.__TAURI__.core.invoke('audio_get_position', {deckId:'deck-0'})" \
    | jq -r 'if type=="object" then (.pos // empty) else (. // empty) end')
  pre_wallclock=$(date +%s.%N)
  echo "  pre-freeze: audioPos=$pre_audio_pos"

  # Let the 1s-debounced session_sync push land before wedging the page, same
  # rationale as rehydration-test.sh step 3.
  sleep 1.5
  mark=$(log_mark)

  "$freeze_fn"

  echo "  waiting for TRIGGER + tiered recovery in the Rust log (up to 90s)..."
  local recovered=false i
  for i in $(seq 1 90); do
    sleep 1
    if printf '%s' "$(log_since "$mark")" | grep -q "recovery sequence for 'main' succeeded"; then
      recovered=true
      break
    fi
  done
  check_true "$scenario_name: recovery sequence succeeded (Rust log)" "$recovered"
  if [ "$recovered" != "true" ]; then
    echo "  recovery never confirmed in log — skipping remaining checks for this scenario" >&2
    return
  fi

  local scenario_log
  scenario_log=$(log_since "$mark")
  check_true "$scenario_name: TRIGGER logged" \
    "$(printf '%s' "$scenario_log" | grep -q '\[watchdog\] TRIGGER' && echo true || echo false)"

  # "[recovery] adopted deck-0 at <pos>s playing=<bool>" is emitted by App.svelte's
  # rehydration path (frontend_log -> Rust log) the instant it adopts the live pipeline
  # instead of calling audioLoad — this is direct evidence the SAME deck/session
  # survived, not just that some page eventually loaded. Grab the WHOLE line (not just
  # the message) so we can read its own log timestamp below — "recovery sequence
  # succeeded" is logged well after adoption actually happened (it waits out the rest
  # of whichever tier's fixed wait budget), so timing this against *that* detection
  # point would overstate elapsed time and make position look discontinuous when it
  # isn't.
  local adopted_full_line
  adopted_full_line=$(printf '%s' "$scenario_log" | grep "\[recovery\] adopted deck-0" | tail -1)
  check_true "$scenario_name: deck-0 was adopted (not reloaded from scratch)" \
    "$([ -n "$adopted_full_line" ] && echo true || echo false)"

  if [ -n "$adopted_full_line" ]; then
    local adopted_pos adopted_playing adopted_ts adopted_epoch elapsed expected_pos pos_ok
    adopted_pos=$(printf '%s' "$adopted_full_line" | grep -oE 'at [0-9.]+s' | grep -oE '[0-9.]+')
    adopted_playing=$(printf '%s' "$adopted_full_line" | grep -oE 'playing=[a-z]+' | cut -d= -f2)
    check_eq "$scenario_name: deck-0 still playing" "$adopted_playing" "true"

    adopted_ts=$(printf '%s' "$adopted_full_line" | sed -E 's/^\[([^]]*)\].*/\1/')
    adopted_epoch=$(date -u -d "$adopted_ts" +%s.%N 2>/dev/null || echo "")
    if [ -n "$adopted_epoch" ] && [ -n "$pre_audio_pos" ]; then
      elapsed=$(awk "BEGIN{printf \"%.2f\", $adopted_epoch - $pre_wallclock}")
      expected_pos=$(awk "BEGIN{printf \"%.2f\", $pre_audio_pos + $elapsed}")
      echo "  post-recovery: adoptedPos=$adopted_pos elapsed=${elapsed}s (to adoption, not to log-detection) expected~=${expected_pos}"
      # Generous tolerance: audio never stopped in Rust across the whole scenario (the
      # entire point of this feature) — this just confirms it wasn't silently reset or
      # reloaded from position 0 by a stray audioLoad call during recovery.
      pos_ok=$(awk "BEGIN{d=($adopted_pos-$expected_pos); if(d<0)d=-d; print (d<3.0)?\"true\":\"false\"}")
      check_true "$scenario_name: audio position continuous across freeze+recovery" "$pos_ok"
    fi
  fi
}

freeze_kill_stop() {
  local pid
  pid=$(webkit_pid) || { echo "  could not find WebKitWebProcess pid" >&2; return 1; }
  echo "  kill -STOP $pid"
  kill -STOP "$pid"
}
stop_app
start_app
load_and_play
run_freeze_scenario "kill-STOP (mechanism-A analog)" freeze_kill_stop

freeze_main_thread() {
  # Fire-and-forget via execute/async, resolving immediately: freezeMainThread(0) never
  # returns (busy-loops forever), so a sync/await call here would itself hang the test.
  js_async "
    const done = arguments[0];
    done('ok');
    setTimeout(() => window.__cuemarkDebug.freezeMainThread(0), 20);
  " >/dev/null
}
stop_app
start_app
load_and_play
run_freeze_scenario "freezeMainThread(0) (wedged-but-alive analog)" freeze_main_thread

freeze_kill_kill() {
  local pid
  pid=$(webkit_pid) || { echo "  could not find WebKitWebProcess pid" >&2; return 1; }
  echo "  kill -KILL $pid"
  kill -KILL "$pid"
}
stop_app
start_app
load_and_play
run_freeze_scenario "kill-KILL (crash path)" freeze_kill_kill

echo
echo "=== Step 5: false-positive check — MIDI-rate burst with recovery armed ==="
stop_app
start_app
load_and_play
FP_MARK=$(log_mark)
js_sync "window.__cuemarkDebug.simulateMidiRateBurst('deck-0', 200, 5)" >/dev/null &
BURST_PID=$!
wait "$BURST_PID" || true
sleep 10 # give the 6s silence threshold a full window past the burst to prove clean
FP_LOG=$(log_since "$FP_MARK")
FP_TRIGGERS=$(printf '%s' "$FP_LOG" | grep -c "\[watchdog\] TRIGGER" || true)
check_eq "no TRIGGER during/after MIDI-rate burst" "$FP_TRIGGERS" "0"
echo "  NOTE: this is a short smoke check (~15s), not the design doc's full 10-minute"
echo "  false-positive soak gate — run that separately before relying on this in prod."

echo
echo "========================================"
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -eq 0 ]
