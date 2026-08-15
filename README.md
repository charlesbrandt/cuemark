# Cuemark

VJ / live A/V mixing software for Linux. Two-deck video + audio mixer with MIDI controller
support, GPU compositing, and headphone cue routing.

Built with [Tauri](https://tauri.app) (Rust + WebKit), WebGL, and GStreamer/PipeWire for audio.

## Requirements

### Runtime

| Requirement | Notes |
|---|---|
| **PipeWire** | Audio routing. Standard on Ubuntu 22.04+, Fedora 34+. |
| **WirePlumber** | PipeWire session manager; provides `wpctl` (used for sink enumeration). |
| **GStreamer** (+ plugins) | Audio/video decode and playback. |

### Build

- **Rust** ≥ 1.75 — install via [rustup](https://rustup.rs). rustup writes
  `~/.cargo/env` but doesn't always wire it into a fresh shell's `~/.bashrc` —
  if `cargo --version` fails in a new terminal, add `. "$HOME/.cargo/env"` to
  `~/.bashrc` rather than sourcing it by hand every session.
- **Node.js** ≥ 18 + npm
- **Tauri CLI** — `cargo install tauri-cli`

## Linux: apt packages

Install all build and runtime dependencies in one shot:

```sh
# Tauri build dependencies (WebKit, GTK, SSL, icon rendering, system tray)
sudo apt-get install \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev

# GStreamer dev headers (required to compile the Rust GStreamer bindings)
sudo apt-get install \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev

# ALSA dev headers (required by the midir MIDI crate on Linux)
sudo apt-get install \
  libasound2-dev

# GStreamer runtime plugins
sudo apt-get install \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly \
  gstreamer1.0-libav \
  gstreamer1.0-pipewire

# PipeWire + WirePlumber (usually pre-installed on modern desktops)
sudo apt-get install \
  pipewire \
  pipewire-audio \
  wireplumber
```

> **Note**: `pactl` (from `pulseaudio-utils`) is **not** required. Cuemark uses
> `pw-dump` (from `pipewire-bin`) for device enumeration.

**Verify the runtime plugins actually landed** — the build compiles and the app
launches fine even if `gstreamer1.0-plugins-bad` is missing, since that's a runtime
plugin lookup, not a link-time dependency. The failure only shows up when you try to
play a track: it loads (filename shows in the deck card) but never plays, with no
error visible outside the WebKit devtools console. Confirm before reporting a fresh
install as working:
```sh
gst-inspect-1.0 pitch   # soundtouch tempo element, from plugins-bad
```
If this prints "No such element or plugin", re-run the `gstreamer1.0-plugins-bad`
install above.

### Development: headless UI verification (optional)

Lets an agent or CI drive the actual app window (click elements, read the DOM, take
screenshots of the canvas-rendered video/waveform) without a real display, via
[`tauri-driver`](https://github.com/tauri-apps/tauri/tree/dev/crates/tauri-driver)
(WebDriver) + Xvfb. Not needed to build or run cuemark normally — only for automated
visual verification. See `skills/verify-ui/SKILL.md` for the full workflow.

```sh
sudo apt-get install xvfb webkitgtk-webdriver
cargo install tauri-driver
```

> **Package name varies by distro release**: it's `webkitgtk-webdriver` on Ubuntu
> 26.04 (confirmed empirically 2026-08-04 — `webkit2gtk-driver` doesn't exist there
> and apt suggests the replacement). Older releases may still use
> `webkit2gtk-driver`; if the install fails with "no installation candidate",
> `apt-cache search webdriver` to find the right name for your release.

## Running

```sh
# Start the app in development mode (hot-reload frontend + Tauri window)
cargo tauri dev

# Type-check the frontend only
npm run check

# Type-check the Rust backend only
cd src-tauri && cargo check
```

## Logging

Backend logs (audio pipeline, MIDI, device enumeration, GStreamer bus messages) are always
written to `~/.local/share/com.cuemark.app/logs/cuemark.log`, regardless of how the app was
launched — `cargo tauri dev`, a release build, or the desktop launcher (even with no attached
terminal). Tail it live:

```sh
tail -f ~/.local/share/com.cuemark.app/logs/cuemark.log
```

## Hardware

Developed for the **Hercules DJControl Starlight** USB MIDI controller. Plug in before
launching — MIDI is detected at startup. See `CLAUDE.md` for the full control map and
calibration instructions.

## Architecture

See [`CLAUDE.md`](CLAUDE.md) for a full description of the rendering pipeline, data model,
MIDI architecture, and development phases.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).
