#!/usr/bin/env bash
# Automated idle/load CPU regression test for Cuemark.
#
# Drives the real compiled binary headlessly via tauri-driver + Xvfb (see
# skills/verify-ui/SKILL.md) and samples WebKitWebProcess CPU% across a fixed
# set of scenarios (no decks, one paused video deck, one playing video deck,
# two paused video decks, one animating visualization layer). Useful for catching regressions
# like the one fixed 2026-06-21: continuous full-resolution frame
# upload/capture running every RAF tick regardless of playback state.
#
# Requires the dev-only window.__cuemarkDebug hook (App.svelte), which is
# only compiled in when VITE_ENABLE_DEBUG_HOOK=1 is set at build time —
# a normal `cargo tauri build` for real use does NOT include it.
#
# Usage:
#   ./scripts/perf-idle-test.sh [video_file]
#
# If video_file is omitted, the script skips video-deck scenarios and only
# runs the empty-idle and shader-deck scenarios.

set -euo pipefail
cd "$(dirname "$0")/.."

VIDEO_FILE="${1:-}"
BINARY="$(pwd)/src-tauri/target/debug/cuemark"
DRIVER_PORT=4444
DISPLAY_NUM=99
SAMPLE_SECS=8
SETTLE_SECS=3

XVFB_PID=""
DRIVER_PID=""
SESSION=""

cleanup() {
  [ -n "$SESSION" ] && curl -s -X DELETE "http://localhost:$DRIVER_PORT/session/$SESSION" >/dev/null 2>&1 || true
  [ -n "$DRIVER_PID" ] && kill "$DRIVER_PID" >/dev/null 2>&1 || true
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required tool: $1 (see skills/verify-ui/SKILL.md setup)" >&2; exit 1; }
}
require Xvfb
require curl
require jq
require pidstat
. "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$PATH"
require tauri-driver

if [ ! -x "$BINARY" ]; then
  echo "Binary not found at $BINARY." >&2
  echo "Build it first: VITE_ENABLE_DEBUG_HOOK=1 cargo tauri build --debug --no-bundle" >&2
  exit 1
fi
if ! grep -q '__cuemarkDebug' dist/assets/*.js 2>/dev/null; then
  echo "WARNING: dist/ does not appear to contain the debug hook." >&2
  echo "Rebuild with: VITE_ENABLE_DEBUG_HOOK=1 cargo tauri build --debug --no-bundle" >&2
fi

# The binary has lived in two differently-named Debian packages (webkit2gtk-driver,
# then webkitgtk-webdriver), and `dpkg -L` on the wrong one aborts the whole script
# under `set -e` with a bare dpkg-query error that looks nothing like the real problem.
# Ask the PATH first; fall back to either package name.
WEBKIT_DRIVER="$(command -v WebKitWebDriver \
  || dpkg -L webkitgtk-webdriver 2>/dev/null | grep -E '/WebKitWebDriver$' \
  || dpkg -L webkit2gtk-driver 2>/dev/null | grep -E '/WebKitWebDriver$')"
[ -n "$WEBKIT_DRIVER" ] || { echo "WebKitWebDriver not found (see skills/verify-ui/SKILL.md)" >&2; exit 1; }

fuser -k "$DRIVER_PORT/tcp" >/dev/null 2>&1 || true

Xvfb ":$DISPLAY_NUM" -screen 0 1280x900x24 >/tmp/cuemark-perf-xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1

DISPLAY=":$DISPLAY_NUM" tauri-driver --port "$DRIVER_PORT" --native-driver "$WEBKIT_DRIVER" >/tmp/cuemark-perf-driver.log 2>&1 &
DRIVER_PID=$!
sleep 1

SESSION=$(curl -s -X POST "http://localhost:$DRIVER_PORT/session" \
  -H "Content-Type: application/json" \
  -d "{\"capabilities\":{\"alwaysMatch\":{\"tauri:options\":{\"application\":\"$BINARY\"}}}}" \
  | jq -r '.value.sessionId')

if [ -z "$SESSION" ] || [ "$SESSION" = "null" ]; then
  echo "Failed to start tauri-driver session. Check /tmp/cuemark-perf-driver.log" >&2
  exit 1
fi
echo "Session: $SESSION"
sleep 2 # let the app finish onMount before we start poking at __cuemarkDebug

js() {
  local body
  body=$(jq -n --arg script "$1" '{"script":$script,"args":[]}')
  curl -s -X POST "http://localhost:$DRIVER_PORT/session/$SESSION/execute/sync" \
    -H "Content-Type: application/json" \
    -d "$body" | jq -r '.value // empty'
}

# Resolve the WebKitWebProcess child of *this* launched binary, not any other
# cuemark instance that might be running on the user's real desktop.
webkit_pid() {
  local main_pid
  main_pid=$(pgrep -f "^$BINARY\$" | head -1)
  [ -z "$main_pid" ] && return 1
  pgrep -P "$main_pid" -f WebKitWebProcess | head -1
}

# Sample %CPU of the scenario's WebKitWebProcess over SAMPLE_SECS, after letting
# it settle for SETTLE_SECS first. Prints the average %CPU.
sample() {
  local label="$1"
  sleep "$SETTLE_SECS"
  local pid
  pid=$(webkit_pid) || { echo "$label: WebKitWebProcess not found" >&2; echo "0"; return; }
  local avg
  avg=$(pidstat -p "$pid" 1 "$SAMPLE_SECS" 2>/dev/null | awk '/^Average:/{print $8}')
  echo "${avg:-0}"
}

declare -a RESULTS_LABEL
declare -a RESULTS_CPU

run_scenario() {
  local label="$1"
  local cpu
  cpu=$(sample "$label")
  RESULTS_LABEL+=("$label")
  RESULTS_CPU+=("$cpu")
  echo "  -> ${cpu}% avg CPU"
}

echo "=== Scenario: empty (no decks loaded) ==="
js "window.__cuemarkDebug.updateDeck('deck-0', {source: null, playing: false}); window.__cuemarkDebug.updateDeck('deck-1', {source: null, playing: false});" >/dev/null
run_scenario "empty"

echo "=== Scenario: global visualization layer animating ==="
# Visualizations are a global Session.visualization layer (composited above all decks),
# not a per-deck DeckSource — there is no 'shader' deck source type anymore (see
# CLAUDE.md "Visualization layer"). Drive it via setVisualization()/setVisualizationOpacity().
SHADER='#version 300 es\nprecision highp float;\nuniform float u_time;\nout vec4 fragColor;\nvoid main(){ fragColor = vec4(0.5+0.5*sin(u_time), 0.0, 0.0, 1.0); }'
js "window.__cuemarkDebug.setVisualization({fragmentSrc: \"$SHADER\", uniforms: {}}); window.__cuemarkDebug.setVisualizationOpacity(1.0);" >/dev/null
run_scenario "visualization-layer-animating"
js "window.__cuemarkDebug.setVisualization(null); window.__cuemarkDebug.setVisualizationOpacity(0.5);" >/dev/null

if [ -n "$VIDEO_FILE" ]; then
  echo "=== Scenario: one video deck loaded, paused ==="
  js "window.__cuemarkDebug.updateDeck('deck-0', {source: {type:'video', filePath: '$VIDEO_FILE', duration: 0}, playing: false});" >/dev/null
  sleep 2 # let <video> reach loadedmetadata
  run_scenario "video-deck-paused"

  echo "=== Scenario: two video decks loaded, both paused (mirrors real-world bug repro) ==="
  js "window.__cuemarkDebug.updateDeck('deck-1', {source: {type:'video', filePath: '$VIDEO_FILE', duration: 0}, playing: false});" >/dev/null
  sleep 2
  run_scenario "two-video-decks-paused"
  js "window.__cuemarkDebug.updateDeck('deck-1', {source: null, playing: false});" >/dev/null

  echo "=== Scenario: one video deck playing ==="
  js "window.__cuemarkDebug.updateDeck('deck-0', {playing: true});" >/dev/null
  sleep 2
  run_scenario "video-deck-playing"
  js "window.__cuemarkDebug.updateDeck('deck-0', {source: null, playing: false});" >/dev/null

  echo "=== Scenario: one webcodecs-path video deck playing (docs/design/webcodecs-video-path.md phase 2) ==="
  # No <video> element for this deck at all — decode runs in codecWorker.ts's Worker, off
  # the WebKitWebProcess main thread, so a regression here would show up as elevated CPU
  # from FBO-upload/compositor work, not video-element decode.
  js "window.__cuemarkDebug.setVideoPathOverride('deck-0', 'webcodecs'); window.__cuemarkDebug.updateDeck('deck-0', {source: {type:'video', filePath: '$VIDEO_FILE', duration: 0}, playing: false});" >/dev/null
  sleep 2 # let video_demux_load + CodecPlayer init settle
  js "window.__cuemarkDebug.updateDeck('deck-0', {playing: true});" >/dev/null
  sleep 2
  run_scenario "webcodecs-deck-playing"
  js "window.__cuemarkDebug.updateDeck('deck-0', {source: null, playing: false}); window.__cuemarkDebug.setVideoPathOverride('deck-0', null);" >/dev/null
else
  echo "(no video file given — skipping video-deck scenarios; pass one as \$1 to include them)"
fi

echo
echo "=== Results ==="
printf '%-32s %s\n' "scenario" "avg %CPU (WebKitWebProcess)"
for i in "${!RESULTS_LABEL[@]}"; do
  printf '%-32s %s\n' "${RESULTS_LABEL[$i]}" "${RESULTS_CPU[$i]}"
done
