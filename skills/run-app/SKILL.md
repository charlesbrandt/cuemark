---
name: run-app
description: Launch the cuemark Tauri dev app and monitor its output. Use when asked to run, start, or test the app, or before verifying a UI/audio change.
---

# Running Cuemark

## Environment notes

- No `tmux` or `screen` available in this environment — use background Bash + log file instead.
- `cargo tauri dev` starts the Vite dev server (port 1420) first, then compiles and launches the Rust binary. First launch after a clean checkout is slow (~5 min, 530 crates); subsequent launches reuse the incremental cache and finish in seconds.
- MIDI: Hercules Starlight absence at launch is normal — `[midi] Hercules Starlight not found` is not an error.
- **Digger proxy errors are normal**: `[vite] http proxy error: /queue … ECONNREFUSED 127.0.0.1:8200` just means the Digger media library service isn't running. The app degrades gracefully — drag-and-drop and manual load still work.
- **GTK theme warnings are harmless**: `Gtk-WARNING **: Theme parsing error: gtk.css:…` at launch is cosmetic, not a functional issue.
- **No screenshot tool available**: grim, scrot, gnome-screenshot, spectacle are all absent. Verify the app is running by checking for `WebKitWebProcess` in `ps aux` and confirming log lines (see "Confirm it's up" below). The app window will appear on the user's desktop.

## Prerequisites check

Before launching, verify cargo is on PATH:

```bash
. "$HOME/.cargo/env"   # source this if `cargo --version` fails
cargo --version
```

If Rust isn't installed at all: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path`

Required system packages (build will fail without these — see README for the full list):
```bash
sudo apt-get install -y \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev \
  libasound2-dev
```

**Also required, separately — GStreamer *runtime* plugins** (the build links fine
without these; the app compiles and launches, but playback silently fails at
runtime, which makes this easy to miss on a fresh machine):
```bash
sudo apt-get install -y \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
  gstreamer1.0-libav gstreamer1.0-pipewire
```
Verify before declaring a fresh-machine setup done:
```bash
gst-inspect-1.0 pitch    # soundtouch tempo element — from plugins-bad
```
**Symptom if `gstreamer1.0-plugins-bad` is missing**: tracks appear to load (filename
shows in the deck card) but nothing plays. Devtools console (right-click → Inspect
Element → Console) shows `GStreamer element 'pitch' not found` and `no pipeline
loaded` — the Rust `DeckAudioPipeline` fails to construct, so there's no audio *and*
no waveform. The `<video>` element also fails with `NotSupportedError` (code 4)
because `h264parse` (also in plugins-bad) is unavailable to WebKit's own internal
GStreamer pipeline, so the preview stays black too. Both symptoms share this one
root cause — don't chase them as separate bugs.
`libasound2-dev` is needed by the `alsa-sys` crate (pulled in by `midir` for MIDI on Linux); it's the most common missing package on fresh machines.

Also confirm the Tauri CLI is installed (`cargo tauri` is a cargo subcommand, not bundled with `cargo`):
```bash
cargo tauri --version || cargo install tauri-cli --version "^2"
```
Compiles from source — takes ~2 min.

## Launch

```bash
. "$HOME/.cargo/env"
export PATH="$HOME/.cargo/bin:$PATH"
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

Also confirm WebKit loaded the frontend:
```bash
ps aux | grep -E "WebKitWebProcess" | grep -v grep
```
A live `WebKitWebProcess` entry means the window is up and the frontend is running.

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

## Desktop launcher (GNOME — "Show Applications" / Super key)

This mirrors the Fieldnote pattern (CLAUDE.md "Desktop launcher" section) — no `.deb`
packaging, just a release binary + symlink + hand-written `.desktop` entry. One-time setup,
or repeat after any change meant for the launcher build (not needed for `cargo tauri dev`
iteration — that's separate from this).

```bash
. "$HOME/.cargo/env"; export PATH="$HOME/.cargo/bin:$PATH"
npm run tauri build -- --no-bundle    # release build, no installer packaging — ~1-2 min incremental, longer cold
ln -sf "$(pwd)/src-tauri/target/release/cuemark" ~/.local/bin/cuemark
mkdir -p ~/.local/share/icons/hicolor/{32x32,128x128}/apps
cp src-tauri/icons/32x32.png ~/.local/share/icons/hicolor/32x32/apps/cuemark.png
cp src-tauri/icons/128x128.png ~/.local/share/icons/hicolor/128x128/apps/cuemark.png
```

Then write `~/.local/share/applications/cuemark.desktop` (this file does not exist by
default — it must be created, not just refreshed):
```ini
[Desktop Entry]
Type=Application
Name=Cuemark
Comment=VJ / live A/V mixing software
Exec=cuemark
Icon=cuemark
Terminal=false
Categories=AudioVideo;Video;Audio;
```

Refresh caches so GNOME Shell picks it up:
```bash
update-desktop-database ~/.local/share/applications/
gtk-update-icon-cache -f -t ~/.local/share/icons/hicolor
```

**Verify without relying on the live desktop session** — `gtk-launch <name>` resolves and
runs a `.desktop` file exactly like the Shell would, and is scriptable:
```bash
DISPLAY=:0 timeout 5 gtk-launch cuemark
ps aux | grep "[t]arget/release/cuemark"   # confirm it actually started
```

No restart of `gnome-shell` is needed — new `.desktop` files in `~/.local/share/applications/`
are picked up automatically. Launch via the Windows/Super key → type "Cuemark".

**After any Rust or frontend change meant for the launcher build**: rerun
`npm run tauri build -- --no-bundle` — the symlink means no reinstall step, just relaunch
from the app grid (or `gtk-launch cuemark`) to pick up the new binary.
