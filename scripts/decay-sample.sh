#!/usr/bin/env bash
# Sample the machine-level state that `busy%` and `frame-dur` structurally cannot see,
# while a deck plays, so the fps decay in
# docs/design/legacy-video-fallback-cost.md "2026-08-05 live verification" can be
# attributed to one of: our own leak, WebKit-internal growth, or the machine throttling.
#
# WHY AN EXTERNAL SAMPLER AND NOT MORE IN-APP INSTRUMENTATION
# The decay's whole signature is that every JS-observable metric stays flat while fps
# falls 4.5x. Adding another JS timer measures the same blind spot again. These three
# candidates each leave a distinct fingerprint *outside* the webview:
#
#   leak (ours or WebKit's) -> RSS climbs monotonically with the decay
#   thermal throttle        -> throttle counters tick, package temp high, MHz drops
#   memory pressure / swap  -> swap grows, iowait rises, available falls
#
# and exactly one of them is worth a multi-week rendering rewrite. This machine is a
# 2012 Ivy Bridge that has already logged 21633 core-throttle events since boot, so the
# throttle arm is not hypothetical and must be measured, not assumed away.
#
# USAGE
#   scripts/decay-sample.sh [seconds] [interval] [outfile]
#   scripts/decay-sample.sh 600 2 /tmp/decay.csv     # 10 min at 2s, the default run
#
# Start it BEFORE pressing play, so the run contains a pre-play baseline to difference
# against. It needs no app changes, no toolchain and no root; it only reads /proc and
# /sys. Join the result against the log with scripts/decay-join.py.

set -uo pipefail

DURATION="${1:-600}"
INTERVAL="${2:-2}"
OUT="${3:-/tmp/decay-sample.csv}"

CLK_TCK="$(getconf CLK_TCK 2>/dev/null || echo 100)"
PAGE_KB=4

# ---------------------------------------------------------------------------
# Cumulative counters. Every one of these is monotonic since boot, so a single
# reading says nothing -- only the delta across the decay window is evidence. They are
# re-read every sample and reported as per-interval deltas.
# ---------------------------------------------------------------------------
THROTTLE_DIR=/sys/devices/system/cpu/cpu0/thermal_throttle

read_counter() { cat "$1" 2>/dev/null || echo 0; }

pkg_temp_c() {
  for z in /sys/class/thermal/thermal_zone*/; do
    if [[ "$(cat "$z/type" 2>/dev/null)" == "x86_pkg_temp" ]]; then
      awk '{printf "%.1f", $1/1000}' "$z/temp" 2>/dev/null && return
    fi
  done
  echo ""
}

avg_mhz() {
  awk -F: '/cpu MHz/ {s+=$2; n++} END {if (n) printf "%.0f", s/n; else print ""}' /proc/cpuinfo
}

# Total jiffies across all CPUs, and the iowait field, from /proc/stat's summary line.
# Used to turn per-process jiffy deltas into a true point-in-time CPU%, which is what
# CLAUDE.md's "ps %cpu is a lifetime average" warning is about -- on a 2h-old process
# `ps` read 7% while the process was at 64%.
cpu_totals() {
  awk '/^cpu /{ tot=0; for(i=2;i<=NF;i++) tot+=$i; print tot, $6 }' /proc/stat
}

proc_jiffies() { # pid -> utime+stime, or empty if the pid is gone
  local st
  st="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  # Fields after the (comm) parenthesis: utime is 14, stime is 15 overall. comm can
  # contain spaces, so split on the last ')' rather than on whitespace.
  awk '{ n=split(substr($0, index($0,")")+2), f, " "); print f[12]+f[13] }' <<<"$st"
}

proc_rss_kb() { awk '/^VmRSS:/{print $2}' "/proc/$1/status" 2>/dev/null; }

# Re-discovered every sample on purpose: the freeze-watchdog can reload or kill the web
# process mid-run (it did exactly that during the 2026-08-05 set), which changes the pid.
# A sampler that resolved pids once would silently report zeros for the rest of the run
# and look like the process went quiet.
discover_pids() {
  CUEMARK_PID="$(pgrep -x cuemark | head -1)"
  WEB_PID=""
  NET_PID=""
  if [[ -n "$CUEMARK_PID" ]]; then
    while read -r p c; do
      case "$c" in
        WebKitWebProces*) WEB_PID="$p" ;;
        WebKitNetworkPr*) NET_PID="$p" ;;
      esac
    done < <(ps -eo pid=,comm= | awk '{print $1, $2}')
  fi
}

echo "[decay-sample] ${DURATION}s at ${INTERVAL}s -> $OUT" >&2
discover_pids
echo "[decay-sample] cuemark=$CUEMARK_PID web=$WEB_PID net=$NET_PID clk_tck=$CLK_TCK" >&2
if [[ -z "$CUEMARK_PID" ]]; then
  echo "[decay-sample] WARNING: no cuemark process found; sampling machine state only" >&2
fi

echo "ts,elapsed,cuemark_rss_mb,web_rss_mb,net_rss_mb,cuemark_cpu,web_cpu,net_cpu,pkg_temp_c,avg_mhz,core_throttle_d,pkg_throttle_d,throttle_ms_d,iowait_pct,swap_used_mb,mem_avail_mb" > "$OUT"

prev_tot=""; prev_iow=""
declare -A prev_pj
prev_core="$(read_counter "$THROTTLE_DIR/core_throttle_count")"
prev_pkg="$(read_counter "$THROTTLE_DIR/package_throttle_count")"
prev_tms="$(read_counter "$THROTTLE_DIR/core_throttle_total_time_ms")"

start="$(date +%s)"
end=$(( start + DURATION ))

while (( $(date +%s) < end )); do
  discover_pids
  # UTC, because tauri-plugin-log stamps cuemark.log in UTC and scripts/decay-join.py
  # joins the two on HH:MM:SS. Emitting local time here silently produced a join with
  # zero fps matches (caught in the smoke run) -- an empty column that looks exactly
  # like "the app logged nothing", which is the wrong conclusion to hand a reader.
  now_iso="$(date -u +%H:%M:%S)"
  elapsed=$(( $(date +%s) - start ))

  read -r tot iow < <(cpu_totals)
  dtot=0; diow=0
  if [[ -n "$prev_tot" ]]; then dtot=$(( tot - prev_tot )); diow=$(( iow - prev_iow )); fi
  prev_tot="$tot"; prev_iow="$iow"

  # nproc-scaled: a single saturated core on an 8-thread box reads 100%, matching
  # `top`'s per-process convention rather than /proc/stat's whole-machine one.
  #
  # Deliberately inlined rather than factored into a `c_cpu=$(cpu_pct …)` helper: command
  # substitution runs in a subshell, so the helper's write to prev_pj was discarded every
  # sample and every CPU column came out empty. Caught in the smoke run.
  ncpu="$(nproc)"
  c_cpu=""; w_cpu=""; n_cpu=""
  for spec in "cuemark:$CUEMARK_PID" "web:$WEB_PID" "net:$NET_PID"; do
    key="${spec%%:*}"; pid="${spec#*:}"
    [[ -z "$pid" ]] && continue
    cur="$(proc_jiffies "$pid" 2>/dev/null)" || continue
    [[ -z "$cur" ]] && continue
    prev="${prev_pj[$key]:-}"
    prev_pj[$key]="$cur"
    [[ -z "$prev" || "$dtot" -le 0 ]] && continue
    val="$(awk -v d=$(( cur - prev )) -v t="$dtot" -v n="$ncpu" 'BEGIN{printf "%.1f", (d/t)*100*n}')"
    case "$key" in
      cuemark) c_cpu="$val" ;;
      web)     w_cpu="$val" ;;
      net)     n_cpu="$val" ;;
    esac
  done

  c_rss="$(proc_rss_kb "$CUEMARK_PID")"; c_rss="${c_rss:+$((c_rss/1024))}"
  w_rss="$(proc_rss_kb "$WEB_PID")";     w_rss="${w_rss:+$((w_rss/1024))}"
  n_rss="$(proc_rss_kb "$NET_PID")";     n_rss="${n_rss:+$((n_rss/1024))}"

  cur_core="$(read_counter "$THROTTLE_DIR/core_throttle_count")"
  cur_pkg="$(read_counter "$THROTTLE_DIR/package_throttle_count")"
  cur_tms="$(read_counter "$THROTTLE_DIR/core_throttle_total_time_ms")"
  d_core=$(( cur_core - prev_core )); d_pkg=$(( cur_pkg - prev_pkg )); d_tms=$(( cur_tms - prev_tms ))
  prev_core="$cur_core"; prev_pkg="$cur_pkg"; prev_tms="$cur_tms"

  iow_pct=""
  if (( dtot > 0 )); then iow_pct="$(awk -v a="$diow" -v b="$dtot" 'BEGIN{printf "%.1f", a/b*100}')"; fi

  swap_used="$(awk '/^SwapTotal:/{t=$2}/^SwapFree:/{f=$2}END{printf "%d", (t-f)/1024}' /proc/meminfo)"
  mem_avail="$(awk '/^MemAvailable:/{printf "%d", $2/1024}' /proc/meminfo)"

  echo "$now_iso,$elapsed,${c_rss:-},${w_rss:-},${n_rss:-},${c_cpu:-},${w_cpu:-},${n_cpu:-},$(pkg_temp_c),$(avg_mhz),$d_core,$d_pkg,$d_tms,${iow_pct:-},$swap_used,$mem_avail" >> "$OUT"

  sleep "$INTERVAL"
done

echo "[decay-sample] done -> $OUT ($(( $(wc -l < "$OUT") - 1 )) samples)" >&2
