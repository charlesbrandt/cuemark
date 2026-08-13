#!/usr/bin/env bash
# Capture what actually reaches the output device while you perform one jog/scrub gesture,
# then say what happened to it.
#
# Why not audio_record_start/stop: `src-tauri/src/audio/record.rs` is a stub — start() logs
# a line, sets a flag and returns Ok, and the encoder chain is still "step 8". It writes no
# file. `docs/design/slow-jog-audio-inaudible.md` §6 assumed otherwise.
#
# Capturing the PipeWire monitor is the better tap regardless: it sits downstream of every
# stage including the two-pulsesinks-on-one-device topology (audio-dropout-mid-playback.md
# H1), so a loss anywhere in the chain lands in the file. The pipeline's own instruments
# stop at the appsrc and the sink pad, which is precisely the blind spot that made six
# hypotheses in a row read healthy while the fault was audible.
#
# 🔴 **`pw-record --target <sink>` alone captures the WRONG DEVICE, silently.**
# `--target` resolves against *sources*. A sink's node.name matches nothing, and pw-record
# then falls back to the **default source** without a word — on this machine that is the
# Zoom H1n microphone, so the take is a recording of the room. It burned one live gesture on
# 2026-08-10 and analysed as a clean, plausible, completely meaningless -54 dBFS envelope;
# it was caught only because the numbers matched an idle control take to within 0.7 dB.
# Capturing a sink monitor needs `-P '{ stream.capture.sink=true }'` as well, and this
# script pre-flights the link with `pw-link` and refuses to run the gesture if it is wrong.
# Do not remove that check: every failure mode here is silent, including this one.
#
# Usage:
#   scripts/scratch-capture.sh [seconds] [outfile]
#
# Then, while it counts down: deck paused, vinyl scratch mode, ONE slow steady
# one-direction turn for the whole capture. Do not play/pause first — that shifts the sink
# delivery margin ~175ms (slow-jog-audio-inaudible.md §3.4) and muddies the join.

set -uo pipefail

SECS="${1:-15}"
OUT="${2:-/tmp/cuemark-scratch-$(date +%H%M%S).wav}"
LOG="${CUEMARK_LOG:-/tmp/cuemark-dev.log}"
[ -f "$LOG" ] || LOG="$HOME/.local/share/com.cuemark.app/logs/cuemark.log"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE_SINK='{ stream.capture.sink=true }'

command -v pw-record >/dev/null || { echo "pw-record not found (pipewire-bin)." >&2; exit 1; }
command -v pw-link   >/dev/null || { echo "pw-link not found (pipewire-bin)." >&2; exit 1; }

# The device cuemark is actually routed to, taken from the log rather than assumed — the
# deck may be on the system default, and pulsesink falls back to it *silently* when a
# persisted device id no longer resolves (see make_sink()'s NOTE).
TARGET="$(grep -o 'pulsesink device="[^"]*"' "$LOG" 2>/dev/null | tail -1 | sed 's/.*device="//; s/"$//')"
if [ -z "$TARGET" ]; then
  echo "No 'pulsesink device=' line in $LOG — is the app running with a track loaded?" >&2
  exit 1
fi

echo "capture : $OUT"
echo "target  : $TARGET"
echo "log     : $LOG"
echo

# ---- pre-flight: prove the recorder attaches to THIS device's monitor ports ----------
PRE="$(mktemp -u /tmp/cuemark-preflight-XXXX.wav)"
pw-record -P "$CAPTURE_SINK" --target "$TARGET" --rate 48000 --channels 4 "$PRE" &
PRE_PID=$!
sleep 1.2
LINKS="$(pw-link -l 2>/dev/null | grep -A6 '^pw-record' | grep '|<-' | sed 's/.*|<- *//')"
kill "$PRE_PID" 2>/dev/null; wait "$PRE_PID" 2>/dev/null; rm -f "$PRE"

if [ -z "$LINKS" ]; then
  echo "PRE-FLIGHT FAILED: pw-record linked to nothing at all." >&2
  exit 1
fi
if ! grep -q "^${TARGET}:monitor_" <<<"$LINKS"; then
  echo "PRE-FLIGHT FAILED: the recorder attached to the wrong node." >&2
  echo "  wanted: ${TARGET}:monitor_*" >&2
  echo "  got   :" >&2
  sed 's/^/    /' <<<"$LINKS" >&2
  echo "Refusing to waste a gesture on a capture of something else." >&2
  exit 1
fi
echo "pre-flight OK — recorder attaches to $(grep -c . <<<"$LINKS") monitor port(s) of the target."
echo

echo "Deck PAUSED, vinyl scratch mode. One slow steady one-direction turn for the whole $SECS s."
echo "Starting in 3..."; sleep 1; echo "2..."; sleep 1; echo "1..."; sleep 1

date +%s.%N > "${OUT%.wav}.epoch"
timeout "$SECS" pw-record -P "$CAPTURE_SINK" --target "$TARGET" --rate 48000 --channels 4 "$OUT"
echo "GO -> done."
echo

[ -s "$OUT" ] || { echo "capture produced no data" >&2; exit 1; }
exec python3 "$HERE/scratch-envelope.py" "$OUT" --log "$LOG"
