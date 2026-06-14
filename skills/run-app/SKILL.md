---
name: run-app
description: Launch the cuemark Tauri dev app and monitor its output. Use when asked to run, start, or test the app, or before verifying a UI/audio change.
---

# Running Cuemark

## Environment notes

- No `tmux` or `screen` available in this environment — use background Bash + log file instead.
- `cargo tauri dev` starts the Vite dev server (port 1420) first, then compiles and launches the Rust binary. First launch after a clean checkout is slow (full Rust compile); subsequent launches reuse the incremental cache and finish in seconds.
- MIDI: Hercules Starlight absence at launch is normal — `[midi] Hercules Starlight not found` is not an error.

## Launch

```bash
cargo tauri dev > /tmp/cuemark-dev.log 2>&1 &
echo $! > /tmp/cuemark-dev.pid
echo "PID: $(cat /tmp/cuemark-dev.pid)"
```

Run this from `/home/account/repos/cuemark` with `run_in_background: true` so the shell doesn't block. The `run_in_background` task only captures the `echo` line — the real output goes to `/tmp/cuemark-dev.log`.

## Confirm it's up

Wait for both signals in the log before declaring the app ready:

```bash
grep -E "VITE.*ready|Running.*cuemark" /tmp/cuemark-dev.log
```

Expected output:
```
  VITE v6.4.2  ready in 657 ms
     Running `target/debug/cuemark`
```

## Monitor (persistent)

Set up a persistent Monitor on the log so errors and GStreamer events surface automatically:

```bash
tail -f /tmp/cuemark-dev.log | grep -E --line-buffered \
  "Error|error|WARN|warn|panic|thread.*main|audio|midi|MIDI|bus/|pipeline|crash|failed|gst|GST|IPC|tauri|vite|HMR|reload|rebuild"
```

Use `Monitor` tool with `persistent: true` and `timeout_ms: 3600000`.

## Stop the app

```bash
kill $(cat /tmp/cuemark-dev.pid) 2>/dev/null; rm -f /tmp/cuemark-dev.pid
```

**Always stop before making Rust changes** (`src-tauri/`). After editing Rust code: stop, make the edit, restart. `cargo tauri dev` auto-detects frontend changes and hot-reloads them without a restart.

## Lifecycle rules (from CLAUDE.md)

- Frontend changes (`.svelte`, `.ts`) → Vite hot-reloads instantly, no restart needed.
- Rust changes (`src-tauri/`) → must stop + restart; the old binary keeps running until the rebuild finishes and wins, so edits silently have no effect if you skip the restart.

## Reading the log

| Pattern | Meaning |
|---|---|
| `VITE … ready` | Frontend dev server up |
| `Running \`target/debug/cuemark\`` | Rust binary launched |
| `[midi] Hercules Starlight not found` | Normal — controller not plugged in |
| `[bus/<deck>] ERROR:` | GStreamer pipeline error — load audio-debugging skill |
| `[bus/<deck>] WARNING: No decoder available for type 'video/…'` | Normal — autoplug-select is correctly skipping video decoders in the audio pipeline |
| `[audio/<deck>] preroll still pending` | Pipeline deadlock — see CLAUDE.md async=false rule |
| `[analysis] peaks=N for /path/…` | Waveform analysis completed via Rust (expected on track load) |
| `HMR update` / `page reload` | Frontend hot-reload fired |
| `Watching … for changes` | Tauri watching Rust source; will rebuild on next `.rs` save |

## Known WebKitGTK quirks

- **Video canvas noise**: If deck preview shows random colored static instead of video, `WEBKIT_DISABLE_DMABUF_RENDERER=1` is missing from `main.rs`. This env var must be set before `cuemark_lib::run()` to prevent VA-API DMA-BUF surfaces from being misread by 2D canvas.
- **Port conflict on restart**: If `cargo tauri dev` fails to bind port 1420, a Vite child process is still running. Fix: `fuser -k 1420/tcp`.
