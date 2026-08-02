#!/usr/bin/env bash
# Warn when the desktop-launcher binary is older than the code it was built from.
#
# The launcher build (~/.local/bin/cuemark) is separate from `cargo tauri dev` and
# nothing watches src-tauri/ for it — it only updates when someone runs
# `npm run tauri build -- --no-bundle`. It was caught a month stale on 2026-07-26,
# after a whole freeze diagnosis had been run against it. This is a *check*, not a
# forced rebuild: a release build is slow, and a rebuild imposed at a bad moment
# just gets skipped.
#
# Usage: scripts/check-launcher-staleness.sh [path-to-launcher]
# Exit:  0 fresh · 1 stale · 2 missing (not built yet)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHER="${1:-$HOME/.local/bin/cuemark}"

# Everything baked into the release binary: the Rust backend, plus the frontend that
# `tauri build` bundles into it. A change to any of these can make the launcher lie.
INPUTS=(src-tauri src index.html package.json vite.config.ts svelte.config.js tsconfig.json)

if [[ ! -e "$LAUNCHER" ]]; then
  echo "launcher: MISSING at $LAUNCHER"
  echo "  build it: (cd $REPO && npm run tauri build -- --no-bundle)"
  exit 2
fi

built=$(stat -Lc %Y "$LAUNCHER")
newest_commit=$(cd "$REPO" && git log -1 --format=%ct -- "${INPUTS[@]}" 2>/dev/null || echo 0)

# Uncommitted edits count too — they are exactly what an in-flight session is testing.
newest_file=$(cd "$REPO" && find "${INPUTS[@]}" \
  -path '*/node_modules' -prune -o -path '*/target' -prune -o \
  -type f -printf '%T@\n' 2>/dev/null | cut -d. -f1 | sort -rn | head -1)
newest_file=${newest_file:-0}

newest=$(( newest_commit > newest_file ? newest_commit : newest_file ))
fmt() { date -d "@$1" '+%Y-%m-%d %H:%M:%S'; }

if (( built < newest )); then
  age_h=$(( (newest - built) / 3600 ))
  echo "launcher: STALE by ${age_h}h — $LAUNCHER"
  echo "  built:   $(fmt "$built")"
  echo "  sources: $(fmt "$newest")"
  echo "  rebuild: (cd $REPO && npm run tauri build -- --no-bundle)"
  echo "  or confirm what is actually running:"
  echo "    grep '\\[build\\]' ~/.local/share/com.cuemark.app/logs/cuemark.log | tail -1"
  exit 1
fi

echo "launcher: fresh — built $(fmt "$built") (sources $(fmt "$newest"))"
exit 0
