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

- **Rust** ≥ 1.75 — install via [rustup](https://rustup.rs)
- **Node.js** ≥ 18 + npm
- **Tauri CLI** — `cargo install tauri-cli`

## Linux: apt packages

Install all build and runtime dependencies in one shot:

```sh
# GStreamer dev headers (required to compile the Rust GStreamer bindings)
sudo apt-get install \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev

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

## Running

```sh
# Start the app in development mode (hot-reload frontend + Tauri window)
cargo tauri dev

# Type-check the frontend only
npm run check

# Type-check the Rust backend only
cd src-tauri && cargo check
```

## Hardware

Developed for the **Hercules DJControl Starlight** USB MIDI controller. Plug in before
launching — MIDI is detected at startup. See `CLAUDE.md` for the full control map and
calibration instructions.

## Architecture

See [`CLAUDE.md`](CLAUDE.md) for a full description of the rendering pipeline, data model,
MIDI architecture, and development phases.
