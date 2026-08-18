# Windows/Mac support — feasibility and guidance for contributors

Status: 🔵 **NOT STARTED. Guidance only, no code changes.** Written 2026-08-17 at the
maintainer's request, for a contributor with Windows or Mac hardware to pick up — the author
has neither and cannot verify anything below directly. It was never the priority (this is a
Linux-first project, built and tested on the two machines `docs/environment.md` tracks) but the
question "is this even reachable" came up and deserved a real answer instead of a guess.

**Read this like any other doc in this directory: as a starting hypothesis, not settled fact.**
Every claim about WebView2/WKWebView or WASAPI/CoreAudio behavior below is inferred from what
the code does today plus general knowledge of those platforms — none of it has been probed on
real hardware, and this project's own history (AV1 `isConfigSupported` lying, the crocus
readback bug reading like a WebKit bug for weeks, "VP9 decay" that didn't exist) is a standing
argument against trusting an unmeasured claim about a rendering/media stack. Rerun the relevant
probe script from the table in the root `CLAUDE.md` before believing any specific behavior
carries over, and write your own `docs/design/<platform>-port.md` capturing what you actually
found — this doc only scopes the unknowns going in.

## Bottom line

Not fruitless. Tauri already targets Windows and macOS, and the two subsystems doing the heavy
lifting on Linux — GStreamer and `midir` — both have real backends there too. But two structural
pieces of this codebase are currently Linux-only with no fallback, and would need actual code,
not just a recompile:

1. **Audio device enumeration** shells out to `pw-dump`/`pactl` with no other backend — see
   below, this is a hard gap, not a degraded path.
2. **The WebView engine changes entirely** — WebView2 (Chromium) on Windows, WKWebView (Apple's
   own WebKit build, not WebKitGTK) on Mac — which invalidates most of the extensively-documented
   WebKitGTK workaround catalog in the root `CLAUDE.md`, for better or worse, unverified either way.

Everything else in the doc below is detail on those two points plus the smaller stuff.

## What already crosses over, and why

- **Tauri itself.** The Rust backend, IPC, window management, and the bundler all support
  Windows/macOS as first-class targets — this is not a fork of a Linux-only tool, `tauri.conf.json`
  already has `"targets": "all"`.
- **The local HTTP media server pattern** (`src-tauri/src/media_server.rs`, the Vite dev
  middleware). It's a plain `tiny_http` server on `127.0.0.1` handing out Range-request video —
  nothing in it is Linux-specific, and the reason it exists (WebKitGTK can't resolve custom URI
  schemes for `<video>`) is itself a WebKitGTK quirk, so it should be *unnecessary* to change and
  possibly unnecessary at all on Chromium/WKWebView — worth testing whether `asset://`/`file://`
  work there before assuming the HTTP indirection is still needed.
- **Snapcast network output** (`make_snapcast_sink()`, `parse_snapcast_device()` in
  `pipeline.rs`). Pure `tcpclientsink` over a TCP socket — no PipeWire, no platform audio API
  involved at all. Should port unchanged; the whole point of Route A over AirPlay (see
  `network-audio-output.md`) was avoiding platform-specific audio transport.
- **`midir` (MIDI)**. It wraps CoreMIDI on macOS and WinMM/WinRT on Windows, same crate, same
  API surface cuemark already calls in `midi.rs`. The Hercules Starlight is class-compliant USB
  MIDI, so it should enumerate on any OS — but device *name* strings are platform-dependent, and
  `midi.rs`'s matching logic (however it identifies "this is the Starlight") needs a read to
  confirm it doesn't assume a Linux-specific name format. Untested; check before trusting it.
- **The two Linux-only startup env vars are harmless elsewhere, not broken.**
  `WEBKIT_DISABLE_DMABUF_RENDERER` (`main.rs`) only means anything to WebKitGTK; setting it under
  WebView2/WKWebView is a no-op, not an error. Same for the `GST_PLUGIN_FEATURE_RANK`
  VA-API-decoder demotion — VA-API is a Linux/libva concept, so demoting `vaav1dec`/`vaapiav1dec`
  on a platform where those plugins don't exist is also a no-op. Neither needs an `#[cfg(target_os)]`
  guard for correctness, though a guard would avoid two pointless syscalls.

## Audio device enumeration — the hard gap, not a degraded path

`src-tauri/src/audio/devices.rs`'s `list_audio_devices()` has exactly two code paths: shell out
to `pw-dump` (PipeWire's own JSON dump), and if that fails, shell out to `pactl list sinks`
(PulseAudio / PipeWire's compat layer). **Neither exists on Windows or Mac.** There is no third
branch. Concretely, on those platforms today `list_audio_devices()` returns an empty `Vec` — the
device picker in Settings would simply show nothing, silently, with no error path (this codebase
has a documented pattern of exactly this kind of silent-empty failure — see
`silent-failure-inventory.md` — and this would be another instance of it if shipped as-is).

Two ways to close this, worth spiking both:

- **GStreamer's own `GstDeviceMonitor`/`GstDeviceProvider` API** is portable — it has real
  providers for WASAPI on Windows and CoreAudio on Mac, alongside the PipeWire one already in use
  implicitly via `pulsesink`. Replacing the `pw-dump`/`pactl` shell-outs with `gst::DeviceMonitor`
  would likely unify all three platforms behind one code path instead of three, and is probably
  the right long-term fix regardless of Windows/Mac — worth doing even if it's scoped down to
  "Linux only, but stop shelling out to two separate CLI tools."
- Or, minimally, add platform-gated enumeration using each OS's native API directly
  (`cpal`'s `Host`/`Device` enumeration is one existing Rust crate that already wraps
  WASAPI/CoreAudio/PipeWire/ALSA uniformly, if a dependency is acceptable) — more surface area but
  less GStreamer-internals risk.

Either way, **the device `id` format matters downstream**: `pipeline.rs`'s `make_sink()` treats
the id as a PipeWire node name it can hand straight to `pulsesink device=`, and the
`node@CH1,CH2!full_layout` encoding for multi-channel devices (`devices.rs`'s `stereo_pairs()`)
is PipeWire-channel-position-specific. A WASAPI/CoreAudio enumerator would need its own encoding,
and every call site that currently assumes "device id looks like a PipeWire node name" — grep
`make_sink`, `parse_snapcast_device`'s sibling in `devices.rs` — needs auditing, not just the
enumeration function itself.

## The sink itself — better news, already has a fallback, but an untested and weaker one

Unlike enumeration, `make_sink()` (`pipeline.rs`) already degrades: it tries
`gst::ElementFactory::make("pulsesink")` and, if that element doesn't exist (which it won't on
Windows/Mac — no PulseAudio/PipeWire plugin there), falls back to `autoaudiosink`, logging a
warning. `autoaudiosink` auto-probes the platform's default sink at pipeline build time, which
under the hood should resolve to `wasapisink`/`directsoundsink` on Windows and `osxaudiosink` on
Mac.

That fallback exists for the "PipeWire plugin not installed" case on Linux, not because anyone
designed it for cross-platform — so treat it as untested, not validated, and expect it to be
**functionally weaker** than the primary path even once it works:

- `autoaudiosink` has no generic `device` property in the sense `make_sink()` uses — it can't be
  pointed at a specific interface the way `pulsesink device=<node-name>` can, so explicit device
  selection (routing main vs. cue vs. a specific USB interface) needs a different property path
  per platform (`wasapisink`'s `device`, `osxaudiosink`'s `device`) once enumeration above exists
  to supply an id for it.
- `buffer-time`/`latency-time`/`stream-properties` are set unconditionally on the `pulsesink`
  branch only (`pipeline.rs` ~L1920-1953); the `autoaudiosink` branch instead hooks
  `child-added` to apply buffer/latency times to whatever real sink it picks (visible a few lines
  further down in the same function) — that pattern is the right shape to extend, but the actual
  numbers (`sink_buffer_times()`'s defaults, tuned against PipeWire's own quantum behavior — see
  "Slow-jog audio" and "pipewiresink-play-hang" in the root doc) are PipeWire-specific
  measurements and have no reason to be correct for WASAPI/CoreAudio's own buffering model.
  Re-measure, don't port the constant.
- `stream-properties`' `cuemark.branch` tagging (used to tell main/cue apart in `pw-dump`
  debugging) is meaningless off PipeWire — harmless to leave set, just won't do anything.

## The shared-output mixer (`OutputGraph`) — GStreamer-core parts probably fine, PipeWire-tuned parts need re-verification

`mixer.rs`'s `OutputGraph` (`audiomixer` + `appsrc` per branch + one sink per node) is built from
ordinary GStreamer elements — `audiomixer`, `appsrc`, `capsfilter`, `volume` — none of which are
platform-specific, and calls `make_sink()` for the actual output, inheriting whatever that
resolves to. So the *topology* should be portable. What was tuned against PipeWire specifically
and needs its own re-verification, not an assumed carry-over:

- **`is-live=true` on every `appsrc`** (`shared-output-pipeline.md`'s first load-bearing fact) —
  this is a GStreamer-core streaming semantic, not PipeWire-specific, so this one likely *does*
  carry over unchanged. Worth confirming with `shared_output_mixer_probe.py --not-live` on the
  new platform anyway, since "likely" isn't "measured."
- **The 171.3ms measured latency correction** in `position()` — this number came from PipeWire's
  own reported latency chain and has no reason to match WASAPI's or CoreAudio's. Must be
  re-measured per platform, not reused.
- **The gain-staging fix** (master volume belongs only to the node's `volume`, not doubled on the
  deck side) is architectural, not PipeWire-specific — should carry over as a design rule, but the
  regression it guards against is worth re-testing since the failure mode (−9dB, silent) was only
  caught by ear.
- **The permanent `audiotestsrc` keepalive** (stops the mixer stalling on an idle pad) is
  GStreamer-core, should be unaffected.

## The rendering engine swap: WebKitGTK → WebView2 / WKWebView

This is the part of the root `CLAUDE.md` most contributors will over-trust by default, so it's
worth being explicit: **Tauri's Linux backend is WebKitGTK; its Windows backend is WebView2
(Microsoft Edge, i.e. Chromium); its macOS backend is WKWebView, which is Apple's own WebKit
build** — related to WebKitGTK by shared upstream lineage, but a different port with different
graphics integration (CoreAnimation vs. GTK/Wayland/cairo), shipped on a different release
cadence, and historically the source of *different* WebKit-family bugs, not the same ones.

Concretely, this means:

- **Windows (Chromium/WebView2) is the biggest wildcard, in both directions.** Nothing in the
  WebKitGTK bug catalog necessarily applies — the crocus GPU-readback bug is a Mesa driver issue
  specific to the machine it was found on, not WebKit; the `ImageBitmap`/`VideoFrame` orientation
  double-bug, the `<video>` SIGTRAP-on-direct-`texImage2D`, the DMA-BUF compositor corruption are
  all WebKitGTK/Linux-graphics-stack findings with no a priori reason to reproduce on Chromium.
  Chromium's WebGL readback and WebCodecs implementations are generally considered mature and
  widely used, which is grounds for cautious optimism — but "generally mature elsewhere" is
  exactly the kind of unmeasured claim this project's own history warns against (`isConfigSupported`
  lied convincingly on WebKitGTK too). Rerun the probes; don't assume mature means correct here.
- **Mac (WKWebView) is a real WebKit, so some findings might carry over — untested which ones.**
  Apple's WebKit and the GTK port share the DOM/JS/CSS engine but not the platform graphics
  backend, and most of the bugs cuemark hit were graphics-backend-level (canvas readback,
  DMA-BUF, image orientation on GPU upload) rather than JS-engine-level. A reasonable prior is
  "JS/DOM-level workarounds might be unnecessary, GPU/compositor-level ones need independent
  verification" — but that's a prior, not a result.
- **WebCodecs is supported on both.** Safari (and by extension WKWebView) and Chromium
  (WebView2) both ship `VideoDecoder`. Since H.264/VP9 already default to the WebCodecs path on
  this codebase (`needsAvcRemux`, `video_demux.rs`) rather than the legacy `<video>` element, the
  *entire* legacy-path bug catalog — the WebKitGTK `<video>` performance cliff, the VA-API DMA-BUF
  noise, the AV1-renders-zero-frames bug — may simply not apply on Windows/Mac if WebCodecs works
  correctly there, which would be a genuine simplification rather than added cost. This is
  speculative and the single most valuable thing to verify early (see spike order below), since
  if true it removes most of the platform-specific graphics workaround surface rather than adding
  to it.
- 🛑 **Never use WebCodecs `VideoEncoder`** — this constraint is unrelated to the platform. It
  SIGABRTs specifically on WebKitGTK 2.52.3; whether it's safe on WebView2/WKWebView is unknown
  and irrelevant to re-test unless a Windows/Mac contributor specifically wants in-app recording —
  `record.rs` staying Rust-side sidesteps the question entirely regardless of platform.

The probe scripts that actually answer these questions, all listed with more detail in the root
`CLAUDE.md`'s probe table, are largely engine-agnostic already (they exercise browser APIs, not
Linux-specific ones) and are the right first thing to run unmodified against a new platform:
`webgl_readback_variants_probe.py`, `imagebitmap_upload_probe.py`,
`webcodecs_vp9_av1_probe.py`, `video_frame_signal_probe.py`,
`output_window_compositor_probe.py`. If any of them need Xvfb/X11-specific setup to run, that
harness scaffolding (not the test logic) is the part to port first.

## Packaging

Not investigated in any depth — flagged as a known unknown rather than analyzed:

- Tauri's bundler produces `.msi`/`.exe` (Windows) and `.dmg`/`.app` (macOS) out of the box
  (`"targets": "all"` in `tauri.conf.json`), but this has never been exercised for cuemark.
- **GStreamer itself must be present on the target machine or bundled**, and that story differs
  sharply by platform: Linux assumes system packages (`apt install libgstreamer1.0-dev …`, see
  root `CLAUDE.md`'s setup section); Windows has no equivalent system package manager convention
  and typically needs the official GStreamer MSVC/MinGW runtime installer bundled with the app,
  which is a substantial download; macOS commonly uses Homebrew's `gstreamer` formula for
  development, with its own bundling story for a distributable `.app`. None of this is started.
- Hardware video decode has platform-specific GStreamer plugins with no cross-platform
  equivalent to VA-API: Windows has `d3d11`-family decoders (DXVA), Mac has
  `applemediavtdec` (VideoToolbox). If either ever shows a VA-API-style corruption bug, the fix
  pattern this project already validated — a codec-specific `GST_PLUGIN_FEATURE_RANK` demotion,
  not killing hardware decode globally (see "AV1/VA-API bug" precedent) — is very likely the
  right template to reapply, but the specific plugin names and failure signature would need their
  own investigation from scratch.

## Suggested spike order

Roughly cheapest-and-most-informative first, so an early spike can kill the effort quickly if
something fundamental doesn't hold:

1. **`cargo tauri dev` boots at all** with the existing frontend unmodified. Validates the Rust
   toolchain, GStreamer dev headers, and Tauri's WebView2/WKWebView integration before touching
   any cuemark-specific code.
2. **Rerun the WebGL/WebCodecs probe scripts unmodified.** This is the single most informative
   spike — it settles whether the platform swap is a net simplification (WebCodecs "just works",
   most of the legacy-path/graphics workaround catalog becomes moot) or introduces its own new
   bug class needing its own investigation and its own design doc.
3. **One deck's audio through the fallback `autoaudiosink` path**, with `list_audio_devices()`
   stubbed to return a single hardcoded entry (deferring the real enumeration work) — proves out
   the `OutputGraph`/mixer topology on a native WASAPI/CoreAudio sink before spending time on
   device enumeration UI plumbing that depends on it.
4. **MIDI**: confirm `midir` enumerates and receives from a real class-compliant controller
   unchanged, and check `midi.rs`'s device-matching logic doesn't assume a Linux-shaped name.
5. **Device enumeration** — pick the `GstDeviceMonitor` vs. `cpal` direction from the "Audio
   device enumeration" section above, once 1-4 have de-risked everything downstream of it.
6. **Packaging** last — it's the least likely to reveal an architectural blocker and the most
   likely to just be tedious, so there's little value doing it before the above.

## What this doc is not

Not a commitment to build this, not a design for code that exists yet, and nothing here blocks
any in-flight work. If a contributor picks this up, the expectation (matching every other doc in
this directory) is to replace speculation with measurement as it happens — update this doc's
status line, or better, split concrete findings out into their own `docs/design/<topic>.md` the
way `network-audio-output.md`/`shared-output-pipeline.md` etc. did, and leave a pointer back here.
