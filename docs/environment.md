# Environment / machine-capability facts

**Canonical reference for what a specific machine cuemark runs on can and can't do** —
GPU/driver capabilities, installed tooling, OS/package quirks. This is *not* a design
doc (no investigation narrative) and *not* project architecture — it's a fact sheet,
scoped per machine, meant to stop the same capability fact from being independently
(mis)stated in `CLAUDE.md`, `skills/*/SKILL.md`, and `docs/design/*.md` and drifting out
of sync in some copies while getting corrected in others. That already happened twice
(see "Why this doc exists" below) before this file existed.

## Identify which machine you're on before trusting anything below

```sh
hostname
lscpu | grep "Model name"
lspci 2>/dev/null | grep -iE "vga|3d|display"
lsb_release -a 2>/dev/null || cat /etc/os-release
```

Then read the matching section below. **A fact confirmed on one machine does not
transfer to another** — cuemark is developed and tested on at least two physically
different machines with materially different GPUs, and possibly a third. Don't assume
"this machine" in an older doc means whichever box you're currently on.

## Why this doc exists

Two real bugs, both from treating a machine-specific fact as a permanent, unscoped one:

1. `skills/verify-ui/SKILL.md` hardcoded a check for the `webkitgtk-webdriver` apt
   package. On a 24.04 machine that package doesn't exist — the binary ships in
   `webkit2gtk-driver` instead. The check silently reported "not installed" even
   though everything needed was present, so different sessions reached opposite
   conclusions about whether GUI automation worked, on what turned out to be **two
   different physical machines on two different Ubuntu releases**, never distinguished
   as such in the docs.
2. `CLAUDE.md` and several design docs asserted "this machine has no VA-API driver for
   any codec" as a blanket fact. It's true on the 2012 MacBook Pro (confirmed
   2026-08-05) and **false on `mele`** (confirmed 2026-08-12 — `mele` has a fully
   working VA-API stack, 12 registered GStreamer features). A large fraction of this
   project's VA-API/hardware-decode narrative was derived exclusively on the MacBook
   Pro and has not been re-validated on `mele`, which also runs the real app.

The pattern in both: a fact was true "as of a date, on a machine," got written down
without naming the machine, and a later session on a *different* machine inherited it
as if universal.

## Known machines

### 2012 MacBook Pro (Ivy Bridge)

The machine nearly every `docs/design/*.md` investigation and most of `CLAUDE.md`'s
environment-specific narrative was derived on.

| | |
|---|---|
| CPU | Intel i7-3615QM, Ivy Bridge, 4C/8T |
| GPU | Intel HD 4000 (Ivy Bridge, gen7) + Nvidia GK107M (disabled via `nouveau` blacklist; its HDA audio function still enumerates as ALSA card) |
| Model | MacBookPro9,1 or 10,1 — docs disagree/hedge on which; not confirmed to be two distinct units vs. one under-specified label |
| Display | 3840×2400 panel, `devicePixelRatio = 2` |
| Session | Wayland, GNOME |
| WebKitGTK | 2.52.3 (stable across the OS-version history below) |
| OS history | 24.04 (before 2026-08-02) → 26.04 "resolute", freshly installed (2026-08-02, reconfirmed 2026-08-04) → 24.04 again (from 2026-08-05 onward). **Why it moved is not documented anywhere** — could be a real reinstall, could be something else. Don't trust either version without re-running the identify commands above. |

**VA-API: ABSENT.** No `*_drv_video.so` under `/usr/lib/x86_64-linux-gnu/dri` (checked
2026-08-05: only d3d12/nouveau/r600/radeonsi/virtio_gpu), no `gstreamer1.0-vaapi`,
`gst-inspect-1.0 va` → 0 features. Everything decodes in software. Re-verify with:
```sh
find /usr/lib/x86_64-linux-gnu/dri -iname '*_drv_video.so'
dpkg -l gstreamer1.0-vaapi
gst-inspect-1.0 va
```
This is foundational to most of `docs/design/legacy-video-fallback-cost.md`,
`docs/design/codec-frame-cache.md`, and the AV1-refusal / VP9-cost sections of
`docs/design/webcodecs-video-path.md` — none of those conclusions are known to hold on
a machine that *does* have VA-API (see `mele` below).

**WebGL GPU→CPU readback: BROKEN.** Mesa `crocus` driver bug, not WebKit —
`createImageBitmap`, `readPixels`, `toDataURL`, `drawImage(glCanvas)` all fail silently
(transparent or `INVALID_OPERATION`) while on-screen display works fine. Verified via a
`LIBGL_ALWAYS_SOFTWARE=1` A/B (everything passes under software rendering). Full
writeup: `docs/upstream/webgl-canvas-readback-broken.md`. This is Ivy-Bridge/`crocus`
specific — not known to reproduce on other GPUs; re-run
`scripts/probes/webgl_readback_variants_probe.py` before assuming it applies elsewhere.

**`isConfigSupported` lies about AV1** — reports `true`, `VideoDecoder.decode()` then
fails on every frame. Verify: `scripts/probes/webcodecs_vp9_av1_probe.py`. Not known
whether this is WebKitGTK-version-specific or also ties to the absent VA-API path.

**WebKitWebDriver package name**: `webkitgtk-webdriver` when this machine is on Ubuntu
26.04 (confirmed 2026-08-04), presumably `webkit2gtk-driver` when on 24.04 (by analogy
with `mele`, not independently re-confirmed on this machine since 2026-08-05's OS
switch back). Always resolve the binary — see "Cross-machine facts" below.

**GUI-automation/screenshot tooling**: `xdotool`/`wmctrl`/`ydotool`/`wtype` and
`grim`/`scrot`/`gnome-screenshot`/`spectacle`/`import` all absent (per `run-app` and
`verify-ui` skills). `python3-gi` + `gir1.2-webkit2-4.1` + `Xvfb` + `tauri-driver` are
present and this is how headless verification works — see `verify-ui` skill.

### `mele` (Intel N150 mini-PC)

A second cuemark dev/test machine, not documented anywhere in this repo before
2026-08-12. Confirm it's still the box you're on: `hostname` should say `mele`.

| | |
|---|---|
| CPU | Intel N150 (Alder Lake-N) |
| GPU | Intel integrated, Alder Lake-N (Gen8+ media-driver class — a different Mesa/media-driver generation from the MacBook Pro's `crocus`) |
| OS | Ubuntu 24.04.4 LTS (confirmed 2026-08-12) |
| WebKitGTK | not yet recorded — check `dpkg -l libwebkit2gtk-4.1-0` |

**VA-API: PRESENT AND ACTIVE.** `iHD_drv_video.so` (Intel's modern media driver)
installed, plus `gstreamer1.0-vaapi`, `intel-media-va-driver`, `mesa-va-drivers` all
installed. `gst-inspect-1.0 va` → **12 registered features**, including a VP9 hardware
decoder. Confirmed 2026-08-12:
```sh
find /usr/lib/x86_64-linux-gnu/dri -iname '*_drv_video.so'   # → iHD_drv_video.so present
dpkg -l gstreamer1.0-vaapi intel-media-va-driver mesa-va-drivers
gst-inspect-1.0 va                                           # → 12 features
```

🟢 **PARTIALLY VALIDATED 2026-08-12** — three of the four open questions below were run
down with probes directly on `mele`. Full session details in each bullet; summary first:

- **WebGL GPU→CPU readback: WORKS on `mele`.** All 6 variants of
  `webgl_readback_variants_probe.py` PASS (plain `readPixels` off `tex-rgba`/`tex-rgba8`/
  `rbo-rgba8`, explicit `readBuffer`, PBO + `getBufferSubData`, `copyTexSubImage2D`).
  Confirmed this ran on real hardware, not Xvfb's software fallback, by checking the
  `WebKitWebProcess`'s open fds during the run — `/dev/dri/renderD128` was open. **The
  crocus-specific readback bug does not reproduce on Alder Lake-N's driver.** This
  opens up capabilities (compositor screenshotting, etc.) the MacBook Pro's
  GPU→CPU-readback-is-impossible narrative assumed closed — don't assume they're still
  closed on `mele` without a fresh reason to.
- **AV1 decode: still broken, same failure class as the MacBook Pro.**
  `webcodecs_vp9_av1_probe.py` against a real library file (`av01.0.08M.08`,
  1080×1080@25): `isConfigSupported()` reports `true`, `decode()`/`flush()` then fails
  with `EncodingError: Decode error` on every attempt — 0/120 frames, with and without a
  `description`. **`isConfigSupported` lying about AV1 is not MacBook-Pro/`crocus`
  specific** — it reproduces on a completely different GPU/driver generation, which
  points at a WebKitGTK-level bug rather than a driver-specific one. No cross-decode
  poisoning: VP9 decoded 120/120 frames normally in the same WebKit process immediately
  after the AV1 failure, unlike the old audio-pipeline bug's cross-track corruption.
- **VP9 decode: works cleanly via WebCodecs.** Same probe, real library file
  (`vp09.00.30.08`, 640×480@25): 120/120 frames decoded, correct `NV12` format, 56ms for
  120 AUs. No corruption observed in the decode itself.
- **Audio-pipeline AV1 handling: confirmed safe on `mele`'s VA-API stack.** Replicated
  `pipeline.rs`'s exact `autoplug-select` SKIP logic (factory-klass check — `"Decoder" in
  klass and "Video" in klass`, not a codec-string check) in a standalone GStreamer script
  against the same real AV1 file. Result: `vaav1dec` (klass `Codec/Decoder/Video/Hardware`)
  correctly skipped, zero pipeline errors, clean EOS, only the benign `WARNING: No decoder
  available for type 'video/x-av1…'` (matches the log-pattern table in the `run-app`
  skill). **Confirmed separately that the underlying VA-API AV1 decoder genuinely does
  fail on `mele`** — running the same script *without* the klass-based skip (i.e. letting
  `vaav1dec` run) reproduced `GstVaAV1Dec:vaav1dec0: no valid frames found`, the exact
  error the original `project_av1_vaapi_bug` memory describes. So the fragility that
  motivated the fix is real on this machine too, and the fix (codec-agnostic, klass-based,
  not a per-codec list) protects it here without modification.

Still open:
- **`main.rs`'s `GST_PLUGIN_FEATURE_RANK` demotion list (`vaav1dec:0,vaapiav1dec:0`
  only) is unverified against `mele`'s VA-API stack for the codecs it does NOT demote**
  (H.264, VP9 hardware decode through WebKit's own `<video>`-element/DMA-BUF path,
  as opposed to the WebCodecs path tested above). Not exercised this session.
- **A live-app rendering check did not complete cleanly and should not be read either
  way.** Loaded both a VP9 and an H.264 file into deck-0 of a real running instance
  (`tauri-driver` + Xvfb `:99`, debug hook) and the deck preview canvas stayed all-black
  for both (`getCodecFramePts('deck-0')` stayed `null`), even though `video_demux_load`
  itself returned correct metadata (10479 AUs, keyframe index) and the isolated decode
  probes above succeeded for the same files. Most likely a harness artifact — the driven
  instance ran unfocused (`document.hasFocus() === false`) alongside a second concurrent
  `cargo tauri dev` instance on the same box — but this was not isolated or confirmed
  either way before the session ended. **Don't cite this as a mele rendering bug or as
  proof rendering works; re-run with a single instance and an explicitly focused window
  before drawing a conclusion.**
- Full VP9/H.264/AV1 performance-number transfer (fps under load, CPU%, sustained-play
  behavior) — only single-decode-batch timing was checked here, not the sustained/live
  numbers `legacy-video-fallback-cost.md` and `codec-frame-cache.md` report.

Don't cite any VA-API/GPU-cost finding from `docs/design/*.md` as applying to `mele`
without re-running the relevant probe (`scripts/probes/`) on `mele` specifically first.

**WebKitWebDriver package**: `webkit2gtk-driver` (confirmed 2026-08-12; `apt-cache
policy webkitgtk-webdriver` shows no candidate at all on this box's 24.04).

**GUI-automation tooling**: `Xvfb`, `tauri-driver` (at `~/.cargo/bin/tauri-driver`),
`WebKitWebDriver`, `python3-gi`, `gir1.2-webkit2-4.1`, `gir1.2-gtk-3.0` all present
(confirmed 2026-08-12). `xdotool`/`wmctrl`/`ydotool`/`wtype` and screenshot tools
(`grim`/`scrot`/`gnome-screenshot`/`spectacle`) absent — same as the MacBook Pro.

### Framework laptop — unconfirmed

Recalled as occasionally used for cuemark testing but not independently confirmed, and
no hardware/OS specifics have been captured in any doc. If you're on one: run the
identify commands above, fill in a section here (CPU, GPU, OS, VA-API status via the
same commands as above), and note the date.

## Cross-machine facts (consistent so far, still worth re-verifying per machine)

These have been observed the same on every machine checked so far, but "checked so
far" currently means mostly the MacBook Pro — treat as likely-but-not-guaranteed to
hold on `mele`/other machines until independently re-run there.

| Fact | Verify | Full writeup |
|---|---|---|
| `WebKitWebDriver`'s providing apt package name is not stable — varies by distro release, and has been seen differently even within what looked like "the same machine" | `find /usr/bin /usr/lib -iname WebKitWebDriver` (resolve the binary, never hardcode a package name) | `skills/verify-ui/SKILL.md` |
| `UNPACK_FLIP_Y_WEBGL` silently ignored for `ImageBitmap` sources; `imageOrientation:'flipY'` silently ignored for `VideoFrame` sources (only honored for a canvas source) | `scripts/probes/imagebitmap_upload_probe.py` | `CLAUDE.md` "Rendering pipeline", `docs/design/webcodecs-video-path.md` |
| `VideoEncoder.isConfigSupported()`/`.configure()` SIGABRTs `WebKitWebProcess` on WebKitGTK 2.52.3 — 100% reproducible | `scripts/probes/encoder_crash_repro.py` (or just don't call it — never touch `VideoEncoder`) | `docs/upstream/videoencoder-crash.md` |
| WebKitGTK's GStreamer media backend can't resolve `media://`/`asset://` custom URI schemes for `<video>` elements — instant `FormatError`, no pipeline ever built | none given; described as confirmed empirically | `CLAUDE.md` "Tech stack", `audio-debugging` skill |
| Two `pipewiresink` elements in one process deadlock on PAUSED→PLAYING; `pulsesink` doesn't | `scripts/probes/pipewiresink_multisink_deadlock.py` | `docs/design/pipewiresink-play-hang.md` |
| Canvas CSS `width:`/`height:` not reliably applied inside a flex child in WebKitGTK (falls back to 300px intrinsic) — must size via `ResizeObserver` + `canvas.style.width/height` in JS | none given | `CLAUDE.md` "Canvas sizing rule" |
| F7/F8 never reach the webview on this desktop (F6 does) | none given | `CLAUDE.md`, `run-app` skill |
| Starlight jog wheel: `VINYL_SEC_PER_TICK = 1.8/256`, plain ±1 deltas, re-confirmed 243/247 ticks/revolution | `[jog-cal]` log-line procedure | `midi` skill, `docs/design/waveform-scrub.md` |

## How to use this doc

- Before citing a machine-capability fact from `CLAUDE.md`, a skill, or a design doc:
  check whether it names a machine. If it doesn't, and it's not in the "cross-machine"
  table above, treat it as scoped to whichever machine that doc's other context implies
  (usually the MacBook Pro, since that's most of the corpus) and re-verify if you're on
  a different one.
- When you establish a new fact on a machine, name the machine explicitly in whatever
  doc/skill you write it into — "this machine" is exactly the phrasing that caused both
  bugs above.
- New machines: add a section here following the same shape (identity table, VA-API
  status + verify commands, package-name quirks, tooling presence) the first time you
  confirm cuemark runs on one.
