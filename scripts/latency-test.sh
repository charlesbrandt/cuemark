#!/usr/bin/env bash
# Automated latency and correctness test for Cuemark.
#
# Drives the real compiled binary headlessly via tauri-driver + Xvfb and walks
# the full deck workflow the developer would otherwise verify by hand:
#
#   1. Debug hook is present
#   2. Load a track on deck-0 via the hook
#   3. Waveform canvas renders non-black pixels
#   4. Playback advances the deck's position clock (video.currentTime on legacy,
#      codec frame pts on webcodecs — see BACKEND below)
#   5. audio_set_rate IPC round-trips: reports {min, p50, p99, max, mean} ms
#   6. MIDI-rate burst (200 events @ 200 Hz): reports CPU% + confirms pipeline survives
#
# Requires: VITE_ENABLE_DEBUG_HOOK=1 cargo tauri build --debug --no-bundle
# (see skills/verify-ui/SKILL.md for full setup)
#
# Usage:
#   ./scripts/latency-test.sh <video_file> [backend]
#
# backend: "legacy" (default) or "webcodecs" — forces deck-0's per-deck A/B
# override (docs/design/webcodecs-video-path.md phase 2) before loading. On
# webcodecs, steps 4/7/8's "video position" reads come from
# getCodecFramePts() (the decoded-frame clock) instead of getVideoTime() (no
# <video> element exists for this deck at all on that backend), and a final
# step confirms getLegacyVideoOpCounts('deck-0') stayed all-zero for the whole
# run — the standing proof-instrumentation from phase 3 that no legacy <video>
# DOM write ever reached this deck, including during the MIDI burst.

set -euo pipefail
cd "$(dirname "$0")/.."

VIDEO_FILE="${1:?Usage: $0 <video_file> [backend]}"
BACKEND="${2:-legacy}"
BINARY="$(pwd)/src-tauri/target/debug/cuemark"
DRIVER_PORT=4444
DISPLAY_NUM=99

XVFB_PID=""
DRIVER_PID=""
SESSION=""
# deck-0's cuemark:videoPathOverride as it was BEFORE this run, so the restore below can put
# it back. A JSON scalar: "legacy", "webcodecs", or null (no override). Empty string means
# "not captured yet" — the run aborted before step 1b and there is nothing to restore.
PRIOR_OVERRIDE=""

# Put deck-0's video-path override back to PRIOR_OVERRIDE. Safe to call more than once.
#
# 🔴 This is not tidiness — it is the whole reason this script cannot be run casually
# otherwise. cuemark:videoPathOverride is a persistentWritable (WebKit localStorage, keyed
# by ORIGIN), and every cuemark instance — this Xvfb one and the user's real desktop app —
# is the same origin `tauri://localhost` and shares one storage DB. So step 1b's
# setVideoPathOverride('deck-0', 'legacy') does not stay inside the test: it pins deck-0 of
# the user's actual app to the legacy <video> backend, permanently, across app restarts.
# That is exactly what happened on 2026-08-13 — a green 10/10 run of this script left the
# user's deck-0 on the legacy path, where it rendered colourful noise instead of video
# (the VA-API DMA-BUF drawImage(video) corruption documented at the top of
# src-tauri/src/main.rs, which the legacy path has never been checked against since GPU
# compositing became the default on 2026-08-02). It read as "the refactor broke video
# playback"; the refactor was innocent and the tests themselves were the cause.
restore_override() {
  [ -n "$SESSION" ] || return 0
  [ -n "$PRIOR_OVERRIDE" ] || return 0
  js_sync "window.__cuemarkDebug.setVideoPathOverride('deck-0', $PRIOR_OVERRIDE);" >/dev/null 2>&1 || true
  # Say so out loud. A silent restore is indistinguishable from no restore at all, which is
  # the failure mode this whole function exists to prevent — and on the abort path there is
  # no assertion to catch it (Step 10 never runs).
  echo "  [restore] deck-0 video-path override -> $PRIOR_OVERRIDE"
}

cleanup() {
  # Before the session is torn down — restore needs a live session to run JS in. Covers the
  # abort paths (a failed check, ^C, `set -e`); the happy path asserts it explicitly below.
  restore_override
  [ -n "$SESSION" ] && curl -s -X DELETE "http://localhost:$DRIVER_PORT/session/$SESSION" >/dev/null 2>&1 || true
  [ -n "$DRIVER_PID" ] && kill "$DRIVER_PID" >/dev/null 2>&1 || true
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1 (see skills/verify-ui/SKILL.md)" >&2; exit 1; }
}
require Xvfb; require curl; require jq; require pidstat; require awk
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

Xvfb ":$DISPLAY_NUM" -screen 0 1280x900x24 >/tmp/cuemark-latency-xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1

DISPLAY=":$DISPLAY_NUM" tauri-driver --port "$DRIVER_PORT" --native-driver "$WEBKIT_DRIVER" \
  >/tmp/cuemark-latency-driver.log 2>&1 &
DRIVER_PID=$!
sleep 1

SESSION=$(curl -s -X POST "http://localhost:$DRIVER_PORT/session" \
  -H "Content-Type: application/json" \
  -d "{\"capabilities\":{\"alwaysMatch\":{\"tauri:options\":{\"application\":\"$BINARY\"}}}}" \
  | jq -r '.value.sessionId')

if [ -z "$SESSION" ] || [ "$SESSION" = "null" ]; then
  echo "Failed to create session. Check /tmp/cuemark-latency-driver.log" >&2
  exit 1
fi
echo "Session: $SESSION"
sleep 2  # let onMount complete before calling __cuemarkDebug

# Synchronous JS execution (non-Promise scripts only).
# Uses jq --arg to safely encode the script string as valid JSON regardless of
# embedded quotes or backslashes.
js_sync() {
  local body
  body=$(jq -n --arg script "$1" '{"script":$script,"args":[]}')
  curl -s -X POST "http://localhost:$DRIVER_PORT/session/$SESSION/execute/sync" \
    -H "Content-Type: application/json" \
    -d "$body" | jq -r '.value // empty'
}

# Async JS execution — script must call arguments[0](result) when done.
# Used for Promise-returning debug hook methods. Default WebDriver script timeout is 30s.
js_async() {
  local body
  body=$(jq -n --arg script "$1" '{"script":$script,"args":[]}')
  curl -s -X POST "http://localhost:$DRIVER_PORT/session/$SESSION/execute/async" \
    -H "Content-Type: application/json" \
    -d "$body" | jq -r '.value // empty'
}

webkit_pid() {
  local main_pid
  main_pid=$(pgrep -f "^$BINARY\$" | head -1)
  [ -z "$main_pid" ] && return 1
  pgrep -P "$main_pid" -f WebKitWebProcess | head -1
}

# Deck-0's "video position" clock: v.currentTime on legacy (a real <video>
# element exists), or the codec player's currently-selected frame pts on
# webcodecs (no <video> element on this backend at all — see
# docs/design/webcodecs-video-path.md phase 2/3). Empty/null result on
# webcodecs usually means the worker hasn't decoded a frame yet; callers
# already sleep before reading.
video_pos() {
  if [ "$BACKEND" = "webcodecs" ]; then
    js_sync "return window.__cuemarkDebug.getCodecFramePts('deck-0')"
  else
    js_sync "return window.__cuemarkDebug.getVideoTime('deck-0')"
  fi
}


# ── rAF liveness preflight ───────────────────────────────────────────────────
# Every check below depends on the app's rAF loop running: it drives
# syncVideoElements (which creates the video backend and calls audio_load) and
# the position poll. If rAF never fires, the app still boots, onMount still
# completes and the debug hook still answers — the deck just never gets a
# backend, never loads audio, and every position read stays 0. That reads like a
# broken frontend and is not one.
#
# Confirmed on `mele` 2026-08-13: under Xvfb, with GPU compositing enabled (the
# default since 2026-08-02), requestAnimationFrame fires ZERO times. Setting
# CUEMARK_DISABLE_DMABUF=1 restores it (~89 ticks/s). See docs/environment.md.
raf_ticks() {
  js_sync "window.__rafProbe=0; const t=()=>{window.__rafProbe++; requestAnimationFrame(t);}; requestAnimationFrame(t); return 'armed'" >/dev/null
  sleep 1
  js_sync "return window.__rafProbe"
}
RAF_N=$(raf_ticks)
if [ -z "$RAF_N" ] || [ "$RAF_N" = "0" ]; then
  echo "ABORT: requestAnimationFrame fired 0 times in 1s — nothing this script measures can run." >&2
  echo "  Re-run with CUEMARK_DISABLE_DMABUF=1 (known-needed under Xvfb on mele; see docs/environment.md)." >&2
  exit 1
fi
echo "  rAF preflight: ${RAF_N} ticks/s"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass "$label"; else fail "$label (got '$got', want '$want')"; fi
}

check_nonzero() {
  local label="$1" val="$2"
  if [ -n "$val" ] && [ "$val" != "0" ] && [ "$val" != "null" ] && [ "$val" != "false" ]; then
    pass "$label ($val)"
  else
    fail "$label (got '$val')"
  fi
}

check_lt() {
  local label="$1" val="$2" limit="$3"
  local ok
  ok=$(awk "BEGIN{print ($val < $limit) ? \"true\" : \"false\"}")
  if [ "$ok" = "true" ]; then pass "$label (${val} < ${limit})"; else fail "$label (${val} >= ${limit})"; fi
}

echo
echo "=== Step 1: debug hook ==="
HOOK_OK=$(js_sync "return typeof window.__cuemarkDebug !== 'undefined'")
check_eq "debug hook present" "$HOOK_OK" "true"

echo
echo "=== Step 1b: force deck-0 to the ${BACKEND} backend ==="
# Explicit even for the legacy default: cuemark:videoPathOverride is a persistentWritable
# (WebKit localStorage, keyed by origin — survives app restarts, not just page reloads).
# A prior manual/debug session that toggled deck-0 to webcodecs leaves that override on
# disk; without forcing it back here, a "legacy" run silently inherits webcodecs instead
# (found live running phase 4 of docs/design/webcodecs-video-path.md — steps 4/7 "failed"
# with position stuck at 0 because getVideoTime() correctly returns null/0 for a deck with
# no <video> element at all, not because legacy playback was actually broken).
#
# Capture what the override was first, so restore_override() can put it back. This store is
# shared with the user's real app (see restore_override's comment) — leaving a `legacy`
# override behind here is a user-visible breakage, not a test artifact.
PRIOR_OVERRIDE=$(js_sync "const o=JSON.parse(localStorage.getItem('cuemark:videoPathOverride')||'{}'); return JSON.stringify(o['deck-0'] ?? null);")
[ -n "$PRIOR_OVERRIDE" ] || PRIOR_OVERRIDE="null"
echo "  prior deck-0 override: $PRIOR_OVERRIDE (will be restored on exit)"
js_sync "window.__cuemarkDebug.setVideoPathOverride('deck-0', '$BACKEND');" >/dev/null
echo "  override set (docs/design/webcodecs-video-path.md phase 2 A/B toggle)"

echo
echo "=== Step 2: load track on deck-0 ==="
# Escape the file path for embedding in a JSON string
ESCAPED_PATH=$(printf '%s' "$VIDEO_FILE" | sed 's/\\/\\\\/g; s/"/\\"/g')
js_sync "window.__cuemarkDebug.updateDeck('deck-0', {source:{type:'video',filePath:\"$ESCAPED_PATH\",duration:0},playing:false});" >/dev/null
sleep 3  # let <video> reach loadedmetadata, audioLoad complete, waveform analysis finish

DECK_SRC=$(js_sync "const d = window.__cuemarkDebug.getSession().decks.find(d=>d.id==='deck-0'); return d?.source?.filePath ?? null")
check_eq "deck-0 source set" "$DECK_SRC" "$VIDEO_FILE"

echo
echo "=== Step 3: waveform canvas renders ==="
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
check_nonzero "waveform has non-black pixels" "$WAVEFORM_PIXELS"

echo
echo "=== Step 4: playback advances the deck's position clock (${BACKEND}) ==="
js_sync "window.__cuemarkDebug.updateDeck('deck-0', {playing:true});" >/dev/null
sleep 2

T1=$(video_pos); T1=${T1:-0}; [ "$T1" = "null" ] && T1=0
sleep 1
T2=$(video_pos); T2=${T2:-0}; [ "$T2" = "null" ] && T2=0
echo "  position (${BACKEND}): $T1 → $T2"
ADVANCED=$(awk "BEGIN{print ($T2 > $T1) ? \"true\" : \"false\"}" 2>/dev/null || echo "false")
check_eq "position advancing" "$ADVANCED" "true"

echo
echo "=== Step 5: audio_set_rate IPC latency (20 sequential round-trips) ==="
# Sequential-await round-trips during active playback compete with RAF position-polling for the
# AudioManager Mutex, so p50/p99 here reflects lock contention rather than raw IPC speed.
# Real MIDI uses fire-and-forget (no await); the post-burst health check in step 6 is the
# meaningful latency signal. Threshold here is generous just to prove the channel isn't stuck.
IPC_STATS=$(js_async "
  const done = arguments[0];
  window.__cuemarkDebug.measureAudioIpc('deck-0', 1.0, 20).then(r => done(JSON.stringify(r))).catch(e => done(JSON.stringify({error: String(e)})));
")
echo "  $IPC_STATS"
IPC_P99=$(echo "$IPC_STATS" | jq -r '.p99 // 9999' 2>/dev/null || echo 9999)
check_lt "IPC p99 < 500 ms" "$IPC_P99" 500

echo
echo "=== Step 6: MIDI-rate burst (200 events @ 200 Hz) + CPU ==="
# The burst fires 200 setInterval calls at 5 ms each. Under CPU load from a heavy video
# the browser may throttle setInterval to 100–150 ms/tick, so the burst can take 20–30 s
# on high-bitrate content. Raise the WebDriver script timeout to 60 s for this step only,
# then restore it. Note: CPU and post-burst latency thresholds assume light DJ clips;
# heavy music videos (e.g. 4:50 H.264) will exceed the 80% CPU threshold — not a code bug.
curl -s -X POST "http://localhost:$DRIVER_PORT/session/$SESSION/timeouts" \
  -H "Content-Type: application/json" -d '{"script":60000}' >/dev/null

WEBKIT_PID=$(webkit_pid || echo "")
PIDSTAT_OUT=/tmp/cuemark-latency-pidstat.out

if [ -n "$WEBKIT_PID" ]; then
  # Sample CPU for 35 s to cover even a heavily throttled burst.
  pidstat -p "$WEBKIT_PID" 1 35 >"$PIDSTAT_OUT" 2>&1 &
  PIDSTAT_PID=$!
fi

BURST_JSON=$(js_async "
  const done = arguments[0];
  window.__cuemarkDebug.simulateMidiRateBurst('deck-0', 200, 5).then(r => done(JSON.stringify(r))).catch(e => done(JSON.stringify({error: String(e)})));
")
echo "  burst result: $BURST_JSON"

if [ -n "$WEBKIT_PID" ]; then
  wait "$PIDSTAT_PID" 2>/dev/null || true
  BURST_CPU=$(awk '/^Average:/{print $8}' "$PIDSTAT_OUT" 2>/dev/null || echo "N/A")
  echo "  WebKitWebProcess avg CPU during burst: ${BURST_CPU}%"
  if [ "$BURST_CPU" != "N/A" ]; then
    check_lt "CPU < 80% during burst" "$BURST_CPU" 80
  fi
fi

# Restore default 30 s timeout for remaining steps.
curl -s -X POST "http://localhost:$DRIVER_PORT/session/$SESSION/timeouts" \
  -H "Content-Type: application/json" -d '{"script":30000}' >/dev/null

# Wait for any queued burst IPC calls to drain before measuring post-burst health.
sleep 2

# Verify audio pipeline still responds after the burst
HEALTH=$(js_async "
  const done = arguments[0];
  window.__cuemarkDebug.measureAudioIpc('deck-0', 1.0, 5).then(r => done(JSON.stringify(r))).catch(e => done(JSON.stringify({error: String(e)})));
")
POST_P99=$(echo "$HEALTH" | jq -r '.p99 // 9999' 2>/dev/null || echo 9999)
echo "  post-burst IPC health: $HEALTH"
# Threshold matches step 5: sequential awaits always compete with RAF audioGetPosition
# for the AudioManager Mutex, so p99 reflects that contention, not burst damage.
check_lt "post-burst IPC p99 < 500 ms" "$POST_P99" 500

echo
echo "=== Step 7: position tracks content time at 2× rate ==="
# GStreamer query_position returns stream time based on segment.rate=1.0 (the soundtouch
# tempo property doesn't issue a rate-seek, so the segment rate never changes). At
# deck.playbackRate=2.0, content advances 2× faster than query_position reports. App.svelte
# compensates by integrating per-frame deltas at deck.playbackRate (contentPosTracker).
# This step confirms the compensation works: position should advance ~6s in 3 real seconds
# at 2× rate. A value near 3s indicates the wall-clock bug is present (unpatched).
#
# Rate-then-seek ordering: setting rate first lets the WebKitGTK pipeline rebuild (triggered
# by every v.playbackRate write) happen at the current stream position, THEN seeks cleanly.
# Reversing the order (seek-then-rate) causes the rebuild and GStreamer seek to race: WebKit
# re-reads the stream position mid-seek and can restore v.currentTime to the pre-seek value.
# After seeking, give the GStreamer seek extra time on heavy videos (may take >500ms to flush,
# re-preroll, and start returning the new position from query_position).
js_sync "window.__cuemarkDebug.updateDeck('deck-0', {playing: true, playbackRate: 2.0});" >/dev/null
sleep 0.2  # let WebKit rebuild settle before seeking (legacy) / rate has no pipeline effect at all (webcodecs)
js_sync "window.__cuemarkDebug.seek('deck-0', 0);" >/dev/null
sleep 1.2  # let GStreamer seek + preroll complete; pendingSeekTarget filters stale IPC responses
P_RATE2_START=$(video_pos); P_RATE2_START=${P_RATE2_START:-0}; [ "$P_RATE2_START" = "null" ] && P_RATE2_START=0
sleep 3
P_RATE2_END=$(video_pos); P_RATE2_END=${P_RATE2_END:-0}; [ "$P_RATE2_END" = "null" ] && P_RATE2_END=0
RATE2_ADV=$(awk "BEGIN{printf \"%.2f\", $P_RATE2_END - $P_RATE2_START}")
echo "  at 2×: $P_RATE2_START → $P_RATE2_END (+${RATE2_ADV}s in 3s real time; expect ~6s)"
RATE2_OK=$(awk "BEGIN{print ($RATE2_ADV >= 4.0 && $RATE2_ADV <= 9.0) ? \"true\" : \"false\"}")
check_eq "position advances ~6s in 3s at 2× rate (4–9s)" "$RATE2_OK" "true"
js_sync "window.__cuemarkDebug.updateDeck('deck-0', {playbackRate: 1.0});" >/dev/null
sleep 0.5  # let rate settle back to 1×

echo
echo "=== Step 8: waveform audio time matches ${BACKEND} position (${BACKEND}) ==="
# getDeckTime (what the waveform reads) and the deck's own position clock should both
# reflect content position (rate-corrected). A large difference means one of them is
# still tracking wall-clock time instead of content time. On legacy that's
# video.currentTime; on webcodecs it's the codec player's selected frame pts
# (getCodecFramePts) — same comparison, different position source per backend.
#
# Seek to a stable mid-video position and let one IPC round-trip complete before reading.
# This avoids the transient divergence right after a rate change: stale capturedRate
# (now fixed in App.svelte) and WebKit's internal pipeline rebuild from v.playbackRate
# writes can both cause brief mismatches within the first ~200ms post-rate-change
# (webcodecs has no v.playbackRate write at all, so this settle window mostly matters
# for legacy — kept the same on both for a fair comparison).
js_sync "window.__cuemarkDebug.seek('deck-0', 30.0);" >/dev/null
js_sync "window.__cuemarkDebug.updateDeck('deck-0', {playing: true, playbackRate: 1.0});" >/dev/null
sleep 1.0  # two IPC round-trips (~2 × 200ms) + margin to settle snap and audioTimes
VID_T=$(video_pos); VID_T=${VID_T:-0}; [ "$VID_T" = "null" ] && VID_T=0
AUD_T=$(js_sync "return window.__cuemarkDebug.getAudioTime('deck-0') ?? 0")
echo "  ${BACKEND}Position=$VID_T  audioTime(waveform)=$AUD_T"
WAVEFORM_DIFF=$(awk "BEGIN{printf \"%.3f\", ($VID_T > $AUD_T) ? $VID_T - $AUD_T : $AUD_T - $VID_T}")
WAVEFORM_OK=$(awk "BEGIN{print ($WAVEFORM_DIFF < 0.5) ? \"true\" : \"false\"}")
check_eq "waveform time within 500ms of ${BACKEND} position" "$WAVEFORM_OK" "true"

echo
echo "=== Step 9: MIDI state save I/O benchmark (100 atomic writes) ==="
# Calls the Rust midi_benchmark_save command directly, bypassing the 100ms debounce.
# This measures the worst-case per-write latency of the persist path so we can confirm
# that file I/O on the MIDI-adjacent code path won't affect audio thread timing.
# The MIDI callback itself never does I/O (it only sets an in-memory dirty flag);
# the flusher thread does the actual write every 100ms. This benchmark quantifies that cost.
SAVE_STATS=$(js_async "
  const done = arguments[0];
  window.__cuemarkDebug.benchmarkMidiSave(100).then(r => done(JSON.stringify(r))).catch(e => done(JSON.stringify({error: String(e)})));
")
echo "  $SAVE_STATS"
SAVE_P99=$(echo "$SAVE_STATS" | jq -r '.p99_ms // 9999' 2>/dev/null || echo 9999)
# Each write is ~200 bytes (6 keys). On a typical SSD fsync latency is 0.1–2ms;
# threshold is 20ms to accommodate slow mechanical drives or tmpfs under load.
check_lt "MIDI save p99 < 20 ms" "$SAVE_P99" 20

if [ "$BACKEND" = "webcodecs" ]; then
  echo
  echo "=== Step 10: legacy <video> op counts stayed zero for the whole run ==="
  # Standing zero-regression check from phase 3 (docs/design/webcodecs-video-path.md):
  # a webcodecs-backend deck must never reach a v.currentTime/v.playbackRate/play()/
  # pause() call site or hold a <video> element at all, including through this script's
  # own load/seek/rate-change/MIDI-burst steps above.
  OPCOUNTS=$(js_sync "return JSON.stringify(window.__cuemarkDebug.getLegacyVideoOpCounts('deck-0'));")
  echo "  $OPCOUNTS"
  CT=$(echo "$OPCOUNTS" | jq -r '.currentTime // -1')
  PR=$(echo "$OPCOUNTS" | jq -r '.playbackRate // -1')
  PP=$(echo "$OPCOUNTS" | jq -r '.playPause // -1')
  HV=$(echo "$OPCOUNTS" | jq -r '.hasVideoEl')
  check_eq "legacy currentTime writes == 0" "$CT" "0"
  check_eq "legacy playbackRate writes == 0" "$PR" "0"
  check_eq "legacy play/pause calls == 0" "$PP" "0"
  check_eq "no <video> element registered" "$HV" "false"
fi

echo
echo "=== Step 10: harness leaves no persisted state behind ==="
# Regression gate for the 2026-08-13 incident described on restore_override() above: this
# script's own step 1b writes deck-0's video-path override into localStorage, which is
# shared by origin with the user's real app, and used to leave it there. A green run that
# silently repins the user's deck to the legacy <video> backend is not a passing run.
#
# cleanup() also calls restore_override() for the abort paths, but a trap cannot be asserted
# on — so do the restore here, while checks can still fail, and verify it actually landed.
restore_override
AFTER=$(js_sync "const o=JSON.parse(localStorage.getItem('cuemark:videoPathOverride')||'{}'); return JSON.stringify(o['deck-0'] ?? null);")
echo "  deck-0 override: prior=$PRIOR_OVERRIDE  now=$AFTER"
check_eq "deck-0 video-path override restored to its pre-run value" "$AFTER" "$PRIOR_OVERRIDE"

echo
echo "========================================"
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -eq 0 ]
