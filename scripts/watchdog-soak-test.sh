#!/usr/bin/env bash
# Full 10-minute false-positive soak gate for docs/design/freeze-watchdog.md phase 3,
# step 5 of the design doc's "Test plan" ("10 min of ordinary playback + MIDI burst...
# with recovery armed; assert zero watchdog triggers"). scripts/watchdog-test.sh only
# runs a ~15s smoke version of this; this script is the real thing, run separately
# before relying on recovery in prod.
#
# Drives the real compiled binary headlessly (tauri-driver + Xvfb, see
# skills/verify-ui/SKILL.md). Loads a track with loop:true (native <video> loop, since
# deck.loopIn/loopOut stay null) so playback runs continuously for the full duration
# without hitting EOS-driven pipeline pause. Every ~60s fires a 200-event MIDI-rate
# burst (mirrors latency-test.sh's load profile) to keep exercising the
# rAF/audioSync/IPC paths under load while the watchdog stays armed. Passes iff zero
# "[watchdog] TRIGGER" lines appear in the Rust log across the whole run.
#
# Requires: VITE_ENABLE_DEBUG_HOOK=1 cargo tauri build --debug --no-bundle
# (see skills/verify-ui/SKILL.md for full setup)
#
# Usage:
#   ./scripts/watchdog-soak-test.sh <video_file> [duration_seconds]
#   duration_seconds defaults to 600 (10 min).

set -euo pipefail
cd "$(dirname "$0")/.."

VIDEO_FILE="${1:?Usage: $0 <video_file> [duration_seconds]}"
DURATION="${2:-600}"
BINARY="$(pwd)/src-tauri/target/debug/cuemark"
DRIVER_PORT=4444
DISPLAY_NUM=99
LOG_FILE="$HOME/.local/share/com.cuemark.app/logs/cuemark.log"
BURST_INTERVAL=60

XVFB_PID=""
DRIVER_PID=""
SESSION=""
APP_PID=""

stop_app() {
  if [ -n "$SESSION" ]; then
    curl -s -X DELETE "http://localhost:$DRIVER_PORT/session/$SESSION" >/dev/null 2>&1 || true
    SESSION=""
  fi
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

if pgrep -f "^$BINARY\$" >/dev/null 2>&1; then
  echo "A cuemark instance at $BINARY is already running (stale from a prior run?)." >&2
  echo "Kill it first: pkill -KILL -f '^$BINARY\$'" >&2
  exit 1
fi

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1 (see skills/verify-ui/SKILL.md)" >&2; exit 1; }
}
require Xvfb; require curl; require jq; require pgrep
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

mkdir -p "$(dirname "$LOG_FILE")"
: > "$LOG_FILE" 2>/dev/null || true

Xvfb ":$DISPLAY_NUM" -screen 0 1280x900x24 >/tmp/cuemark-soak-xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1

DISPLAY=":$DISPLAY_NUM" tauri-driver --port "$DRIVER_PORT" --native-driver "$WEBKIT_DRIVER" \
  >>/tmp/cuemark-soak-driver.log 2>&1 &
DRIVER_PID=$!
sleep 1

SESSION=$(curl -s -X POST "http://localhost:$DRIVER_PORT/session" \
  -H "Content-Type: application/json" \
  -d "{\"capabilities\":{\"alwaysMatch\":{\"tauri:options\":{\"application\":\"$BINARY\"}}}}" \
  | jq -r '.value.sessionId')
if [ -z "$SESSION" ] || [ "$SESSION" = "null" ]; then
  echo "Failed to create session. Check /tmp/cuemark-soak-driver.log" >&2
  exit 1
fi
sleep 2
APP_PID=$(pgrep -f "^$BINARY\$" | head -1)
echo "Session: $SESSION  App PID: $APP_PID  duration=${DURATION}s"

js_sync() {
  local body
  body=$(jq -n --arg script "$1" '{"script":$script,"args":[]}')
  curl -s -X POST "http://localhost:$DRIVER_PORT/session/$SESSION/execute/sync" \
    -H "Content-Type: application/json" \
    -d "$body" | jq -r '.value // empty'
}

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

log_mark() { wc -c < "$LOG_FILE" 2>/dev/null || echo 0; }
log_since() { tail -c "+$(($1 + 1))" "$LOG_FILE" 2>/dev/null || true; }

escaped=$(printf '%s' "$VIDEO_FILE" | sed 's/\\/\\\\/g; s/"/\\"/g')
js_sync "window.__cuemarkDebug.updateDeck('deck-0', {source:{type:'video',filePath:\"$escaped\",duration:0},playing:false,loop:true});" >/dev/null
sleep 4
deck_src=$(js_sync "const d = window.__cuemarkDebug.getSession().decks.find(d=>d.id==='deck-0'); return d?.source?.filePath ?? null")
[ "$deck_src" = "$VIDEO_FILE" ] && pass "deck-0 source set" || fail "deck-0 source set (got '$deck_src')"
js_sync "window.__cuemarkDebug.updateDeck('deck-0', {playing:true});" >/dev/null
sleep 2

SOAK_MARK=$(log_mark)
START_TS=$(date +%s)
ELAPSED_AT_LAST_BURST=0
echo "=== Soaking for ${DURATION}s: ordinary playback + a MIDI-rate burst every ${BURST_INTERVAL}s ==="
while true; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START_TS))
  [ "$ELAPSED" -ge "$DURATION" ] && break
  REMAINING=$((DURATION - ELAPSED))
  WAIT=$((BURST_INTERVAL < REMAINING ? BURST_INTERVAL : REMAINING))
  sleep "$WAIT"
  NOW=$(date +%s)
  ELAPSED=$((NOW - START_TS))
  [ "$ELAPSED" -ge "$DURATION" ] && break
  echo "  [${ELAPSED}s] MIDI-rate burst (200 events)"
  js_sync "window.__cuemarkDebug.simulateMidiRateBurst('deck-0', 200, 5)" >/dev/null || true
done

sleep 8 # give the 6s silence threshold a full window past the last burst to prove clean
SOAK_LOG=$(log_since "$SOAK_MARK")
TRIGGERS=$(printf '%s' "$SOAK_LOG" | grep -c "\[watchdog\] TRIGGER" || true)
[ "$TRIGGERS" -eq 0 ] && pass "no TRIGGER across ${DURATION}s soak + periodic MIDI bursts" \
  || fail "no TRIGGER across ${DURATION}s soak + periodic MIDI bursts (saw $TRIGGERS)"

still_playing=$(js_sync "const d = window.__cuemarkDebug.getSession().decks.find(d=>d.id==='deck-0'); return d?.playing ?? false")
[ "$still_playing" = "true" ] && pass "deck-0 still playing at end of soak" || fail "deck-0 still playing at end of soak (got '$still_playing')"

echo
echo "========================================"
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -eq 0 ]
