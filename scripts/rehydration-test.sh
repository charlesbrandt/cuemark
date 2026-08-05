#!/usr/bin/env bash
# Forced-reload rehydration test for docs/design/freeze-watchdog.md phase 2
# (session_sync/session_restore + adoption). This is the gate script named in the
# design doc's "Phases" section: load a track, let it play, force a webview reload
# (same mechanism as tier-1/2 watchdog recovery — the Rust process and its GStreamer
# pipelines never die), and assert the deck comes back with source/bpm/downbeat intact
# and the audio position continuous (not restarted from 0, not glitched) — i.e. the
# recovery path adopted the live pipeline instead of calling audioLoad() on it.
#
# Requires: VITE_ENABLE_DEBUG_HOOK=1 cargo tauri build --debug --no-bundle
# (see skills/verify-ui/SKILL.md for full setup)
#
# Usage:
#   ./scripts/rehydration-test.sh <video_file>
#
# Gate (design doc): 5/5 runs seamless, headless + real desktop. Run this script
# 5 times in a row (each is a full fresh launch) to satisfy the headless half.

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

cleanup() {
  [ -n "$SESSION" ] && curl -s -X DELETE "http://localhost:$DRIVER_PORT/session/$SESSION" >/dev/null 2>&1 || true
  [ -n "$DRIVER_PID" ] && kill "$DRIVER_PID" >/dev/null 2>&1 || true
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1 (see skills/verify-ui/SKILL.md)" >&2; exit 1; }
}
require Xvfb; require curl; require jq; require awk
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
fuser -k "$DRIVER_PORT/tcp" >/dev/null 2>&1 || true

Xvfb ":$DISPLAY_NUM" -screen 0 1280x900x24 >/tmp/cuemark-rehydration-xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1

DISPLAY=":$DISPLAY_NUM" tauri-driver --port "$DRIVER_PORT" --native-driver "$WEBKIT_DRIVER" \
  >/tmp/cuemark-rehydration-driver.log 2>&1 &
DRIVER_PID=$!
sleep 1

SESSION=$(curl -s -X POST "http://localhost:$DRIVER_PORT/session" \
  -H "Content-Type: application/json" \
  -d "{\"capabilities\":{\"alwaysMatch\":{\"tauri:options\":{\"application\":\"$BINARY\"}}}}" \
  | jq -r '.value.sessionId')

if [ -z "$SESSION" ] || [ "$SESSION" = "null" ]; then
  echo "Failed to create session. Check /tmp/cuemark-rehydration-driver.log" >&2
  exit 1
fi
echo "Session: $SESSION"
sleep 2  # let onMount complete before calling __cuemarkDebug

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

echo
echo "=== Step 1: debug hook present ==="
HOOK_OK=$(js_sync "return typeof window.__cuemarkDebug !== 'undefined'")
check_eq "debug hook present" "$HOOK_OK" "true"

echo
echo "=== Step 2: load + play track on deck-0 ==="
ESCAPED_PATH=$(printf '%s' "$VIDEO_FILE" | sed 's/\\/\\\\/g; s/"/\\"/g')
js_sync "window.__cuemarkDebug.updateDeck('deck-0', {source:{type:'video',filePath:\"$ESCAPED_PATH\",duration:0},playing:false});" >/dev/null
sleep 4  # loadedmetadata, audioLoad, waveform analysis (bpm/downbeat auto-fit)
DECK_SRC=$(js_sync "const d = window.__cuemarkDebug.getSession().decks.find(d=>d.id==='deck-0'); return d?.source?.filePath ?? null")
check_eq "deck-0 source set" "$DECK_SRC" "$VIDEO_FILE"

js_sync "window.__cuemarkDebug.updateDeck('deck-0', {playing:true});" >/dev/null
sleep 3  # get well into playback before the reload

echo
echo "=== Step 3: capture pre-reload state ==="
PRE_BPM=$(js_sync "const d = window.__cuemarkDebug.getSession().decks.find(d=>d.id==='deck-0'); return d?.bpm ?? 'null'")
PRE_DOWNBEAT=$(js_sync "const d = window.__cuemarkDebug.getSession().decks.find(d=>d.id==='deck-0'); return d?.downbeat ?? 'null'")
PRE_PLAYING=$(js_sync "const d = window.__cuemarkDebug.getSession().decks.find(d=>d.id==='deck-0'); return d?.playing")
PRE_AUDIO_POS=$(js_sync "return window.__TAURI__.core.invoke('audio_get_position', {deckId:'deck-0'})")
PRE_VIDEO_T=$(js_sync "return window.__cuemarkDebug.getVideoTime('deck-0') ?? 0")
PRE_WALLCLOCK=$(date +%s.%N)
echo "  bpm=$PRE_BPM downbeat=$PRE_DOWNBEAT playing=$PRE_PLAYING audioPos=$PRE_AUDIO_POS videoT=$PRE_VIDEO_T"
check_eq "pre-reload deck is playing" "$PRE_PLAYING" "true"

# Let the 1s-debounced session_sync push land before we pull the rug out — otherwise
# the snapshot Rust holds could be from the pre-play (playing:false) mutation.
sleep 1.5

echo
echo "=== Step 4: force a webview reload (same mechanism as watchdog tier 1/2) ==="
# Fire-and-forget: resolve the WebDriver call immediately, THEN navigate on a timer.
# A bare `location.reload()` in a sync/async script would abort the page (and the
# in-flight HTTP response) before WebDriver gets a reply, which can hang or error the
# call — this ordering guarantees a clean response first.
js_async "
  const done = arguments[0];
  done('ok');
  setTimeout(() => location.reload(), 50);
" >/dev/null
RELOAD_WALLCLOCK=$(date +%s.%N)

echo
echo "=== Step 5: wait for rehydration ==="
HOOK_BACK="false"
for i in $(seq 1 20); do
  sleep 1
  RESULT=$(js_sync "return typeof window.__cuemarkDebug !== 'undefined'" 2>/dev/null || echo "")
  if [ "$RESULT" = "true" ]; then HOOK_BACK="true"; break; fi
done
check_eq "debug hook reappeared after reload" "$HOOK_BACK" "true"
if [ "$HOOK_BACK" != "true" ]; then
  echo "Debug hook never came back — aborting remaining checks for this run." >&2
  echo
  echo "========================================"
  echo "  Results: $PASS passed, $FAIL failed"
  echo "========================================"
  exit 1
fi
sleep 2  # let onMount's rehydration path finish: session_restore, video adoption, waveform re-fetch
POST_WALLCLOCK=$(date +%s.%N)

echo
echo "=== Step 6: verify recovery boot was detected ==="
RECENT_LOG=$(tail -c 20000 "$LOG_FILE" 2>/dev/null || echo "")
RECOVERY_LOGGED=$(printf '%s' "$RECENT_LOG" | grep -qE "\[recovery\] (rehydrating session|adopted deck-0)" && echo "true" || echo "false")
check_eq "recovery boot logged (rehydrating/adopted)" "$RECOVERY_LOGGED" "true"
ADOPTED_NOT_RELOADED=$(printf '%s' "$RECENT_LOG" | grep -q "\[recovery\] adopted deck-0" && echo "true" || echo "false")
check_eq "deck-0 was adopted (not audioLoad'd from scratch)" "$ADOPTED_NOT_RELOADED" "true"

echo
echo "=== Step 7: verify deck state survived ==="
POST_SRC=$(js_sync "const d = window.__cuemarkDebug.getSession().decks.find(d=>d.id==='deck-0'); return d?.source?.filePath ?? null")
check_eq "deck-0 source intact" "$POST_SRC" "$VIDEO_FILE"
POST_BPM=$(js_sync "const d = window.__cuemarkDebug.getSession().decks.find(d=>d.id==='deck-0'); return d?.bpm ?? 'null'")
check_eq "deck-0 bpm intact" "$POST_BPM" "$PRE_BPM"
POST_DOWNBEAT=$(js_sync "const d = window.__cuemarkDebug.getSession().decks.find(d=>d.id==='deck-0'); return d?.downbeat ?? 'null'")
check_eq "deck-0 downbeat intact" "$POST_DOWNBEAT" "$PRE_DOWNBEAT"
POST_PLAYING=$(js_sync "const d = window.__cuemarkDebug.getSession().decks.find(d=>d.id==='deck-0'); return d?.playing")
check_eq "deck-0 still playing" "$POST_PLAYING" "true"

echo
echo "=== Step 8: verify audio position is continuous (not reset, not glitched) ==="
POST_AUDIO_POS=$(js_sync "return window.__TAURI__.core.invoke('audio_get_position', {deckId:'deck-0'})")
ELAPSED=$(awk "BEGIN{printf \"%.2f\", $POST_WALLCLOCK - $PRE_WALLCLOCK}")
EXPECTED_POS=$(awk "BEGIN{printf \"%.2f\", $PRE_AUDIO_POS + $ELAPSED}")
echo "  preAudioPos=$PRE_AUDIO_POS postAudioPos=$POST_AUDIO_POS elapsedWallclock=${ELAPSED}s expected~=${EXPECTED_POS}"
# Generous tolerance (±2s): covers the reload/rehydration window itself (audio kept
# playing in Rust the whole time) plus test-script sleep imprecision, while still
# clearly distinguishing "continuous" from "reset to 0" or "stuck".
POS_OK=$(awk "BEGIN{d=($POST_AUDIO_POS-$EXPECTED_POS); if(d<0)d=-d; print (d<2.0)?\"true\":\"false\"}")
check_true "audio position continuous (within 2s of expected)" "$POS_OK"
NOT_ZERO=$(awk "BEGIN{print ($POST_AUDIO_POS > 1.0) ? \"true\" : \"false\"}")
check_true "audio position not reset to 0" "$NOT_ZERO"

echo
echo "=== Step 9: verify adopted <video> element points at live position ==="
POST_VIDEO_T=$(js_sync "return window.__cuemarkDebug.getVideoTime('deck-0') ?? 0")
echo "  postAudioPos=$POST_AUDIO_POS postVideoT=$POST_VIDEO_T"
VIDEO_DIFF=$(awk "BEGIN{d=($POST_VIDEO_T-$POST_AUDIO_POS); if(d<0)d=-d; printf \"%.2f\", d}")
VIDEO_OK=$(awk "BEGIN{print ($VIDEO_DIFF < 1.5) ? \"true\" : \"false\"}")
check_true "video element adopted at live position (within 1.5s, diff=${VIDEO_DIFF}s)" "$VIDEO_OK"

echo
echo "=== Step 10: waveform canvas re-rendered (non-black) ==="
WAVEFORM_PIXELS=$(js_sync "
  const canvas = document.querySelector('.waveform-canvas');
  if (!canvas) return 0;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;
  const d = ctx.getImageData(0, 0, Math.max(canvas.width,1), Math.max(canvas.height,1)).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i] > 10 || d[i+1] > 10 || d[i+2] > 10) n++; }
  return n;
")
WAVEFORM_OK=$(awk "BEGIN{print ($WAVEFORM_PIXELS > 0) ? \"true\" : \"false\"}" 2>/dev/null || echo "false")
check_true "waveform has non-black pixels after rehydration ($WAVEFORM_PIXELS)" "$WAVEFORM_OK"

echo
echo "========================================"
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -eq 0 ]
