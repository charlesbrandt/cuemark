#!/bin/bash
# Per-thread CPU sampler for the cuemark WebKitWebProcess + Rust process.
#
# WHY THIS EXISTS: the watchdog's own diagnostic (`state=R Δutime=103`) is
# process-wide, so it says "something in this process is spinning" and nothing
# about *what*. This attributes the CPU to a **named thread**, which is usually
# the whole diagnosis: main thread vs. `WebCore: Worker` (the codec worker) vs.
# `HeapHelper`/`ollector Thread` (JSC GC) vs. `eoDecoder queue` (WebCodecs
# decode) imply completely different fixes. It settled Bug E in one reading —
# see docs/design/output-noise-and-track-reload-silence.md.
#
# Needs no sudo, unlike perf/gdb, so it works before (or instead of) asking the
# user to lower perf_event_paranoid.
#
#   TS  pid/tid  comm  state  dU  dS   (dU/dS in ticks; 100 ticks = 1s CPU)
#
# Also emits an RSS line per sample so memory growth is visible alongside.
#
# GOTCHA: the sampling interval stretches under load (this loop stats ~25
# threads per pass), so **never compare mean ticks-per-sample between two
# runs** — normalise to ticks per wall-second using the first/last timestamp of
# the window. Comparing per-sample means across a 0.5s-interval arm and a
# 2.1s-interval arm silently reverses the answer.
#
# GOTCHA: it follows `pgrep ... | head -1`. With the output window open there
# are two WebKitWebProcesses; confirm which pid a window actually covers
# (`ps -o lstart=`) before trusting a cross-arm comparison.
OUT=${1:-/tmp/cuemark-threads.log}
INTERVAL=${2:-0.5}
declare -A PREV_U PREV_S

: > "$OUT"
while true; do
  WPID=$(pgrep -f "webkit2gtk-4.1/WebKitWebProcess" | head -1)
  RPID=$(pgrep -x cuemark | head -1)
  [ -z "$RPID" ] && RPID=$(pgrep -f "target/debug/cuemark$" | head -1)
  TS=$(date "+%H:%M:%S.%3N")

  for PID in $WPID $RPID; do
    [ -z "$PID" ] && continue
    [ -d "/proc/$PID" ] || continue
    PNAME=$(cat /proc/$PID/comm 2>/dev/null)
    RSS=$(awk '/VmRSS/{print $2}' /proc/$PID/status 2>/dev/null)
    echo "$TS RSS $PID $PNAME ${RSS}kB" >> "$OUT"
    for T in /proc/$PID/task/*/; do
      TID=$(basename "$T")
      read -r _ rest < "$T/stat" 2>/dev/null || continue
      # comm may contain spaces/parens: strip through the last ')'
      COMM=$(cat "$T/comm" 2>/dev/null)
      FIELDS=${rest##*)}
      set -- $FIELDS
      STATE=$1; UT=${12}; ST=${13}
      [ -z "$UT" ] && continue
      KEY="$PID.$TID"
      PU=${PREV_U[$KEY]:-$UT}; PS=${PREV_S[$KEY]:-$ST}
      DU=$((UT - PU)); DS=$((ST - PS))
      PREV_U[$KEY]=$UT; PREV_S[$KEY]=$ST
      if [ "$DU" -gt 0 ] || [ "$DS" -gt 0 ]; then
        echo "$TS CPU $PID/$TID $COMM state=$STATE dU=$DU dS=$DS" >> "$OUT"
      fi
    done
  done
  sleep "$INTERVAL"
done
