# Headless WebKitGTK probes (python3-gi)

Standalone probes that exercise WebKit features in a bare `WebKit2 4.1` GI webview —
the **same `libwebkit2gtk-4.1` library Tauri/wry links** — without building or
launching the app. Use them to answer "does this WebKitGTK do X on this machine?"
in seconds. Technique documented in `skills/verify-ui/SKILL.md` ("Lightweight
webview probes"); results that motivated them: `docs/design/webcodecs-video-path.md`
spike table (2026-07-25).

Run any of them like:

```sh
APPORT_DISABLE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
GST_PLUGIN_FEATURE_RANK=vaav1dec:0,vaapiav1dec:0,vah264dec:0,vaapih264dec:0 \
  xvfb-run -a python3 scripts/probes/<probe>.py
```

Always include `APPORT_DISABLE=1` — a probe that crashes WebKitWebProcess otherwise
pops Ubuntu's crash-report dialog on the user's real desktop. The other env vars
mirror `main.rs` so results reflect the app's real conditions.

| Probe | What it answers | 2026-07-25 result on this machine (WebKitGTK 2.52.3) |
|---|---|---|
| `webcodecs_probe.py` | WebCodecs feature flags + API surface (main thread & Worker) + `isConfigSupported` per codec | All present by default; h264/hevc/vp8/vp9/av1 supported; workers OK |
| `webcodecs_decode_only_probe.py` | Does `VideoDecoder` actually decode real H.264 annex-B AUs correctly? (host-encodes via GStreamer/x264, pixel-checks output, tests flush+keyframe reseek) | 60/60 frames, pixel-exact, reseek 5 ms |
| `webcodecs_perf_probe.py` | 1080p decode throughput; `texImage2D(VideoFrame)`→WebGL viability; `drawImage` fallback cost (`PROBE_W/H/N` env to change resolution) | 153–165 fps decode; texImage2D works (no SIGTRAP), 24 ms/f on llvmpipe — re-measure on real GPU; drawImage 6.7 ms/f |
| `encoder_crash_repro.py` | `VideoEncoder` crash triggers (`isconfig` / `configure` / `construct` arg) | `isConfigSupported` and `configure()` SIGABRT the web process; bare construction survives. Upstream draft: `docs/upstream/videoencoder-crash.md` |
| `offscreencanvas_webgl_capture_probe.py` | Can pixels be got **out of** a WebGL canvas? Tests `drawImage`, `createImageBitmap`, `OffscreenCanvas`+`transferToImageBitmap`, `readPixels`, `toDataURL`, plus a 2D-canvas control | 2026-08-02: every WebGL route FAILS (transparent / unsupported / `0x502`), 2D control PASSES, identical in both DMA-BUF arms |
| `webgl_readback_variants_probe.py` | Is *any* readback route intact? Attachment kinds (unsized RGBA / RGBA8 texture / RGBA8 renderbuffer), explicit `readBuffer`, PBO + `getBufferSubData`, `copyTexSubImage2D`-then-read — with a `LIBGL_ALWAYS_SOFTWARE=1` control arm | 2026-08-03: **all 6 FAIL on hardware, all 6 PASS on llvmpipe** → Mesa `crocus` bug, not WebKit. `docs/upstream/webgl-canvas-readback-broken.md` |
| `webgl_readpixels_diag_probe.py` | *Why* a readback failed: returned bytes alongside the GL error, `getError()` sanity, FB completeness, `IMPLEMENTATION_COLOR_READ_FORMAT/TYPE`, and a GPU-side blit control | 2026-08-03: `getError()` is honest, FB is complete with `SAMPLES=0`, draws/clears/blits all `0x0` — only `readPixels` fails, with a zeroed buffer |
| `imagebitmap_upload_probe.py` | Upload semantics for the output-window compositor: does `createImageBitmap(VideoFrame)` carry real pixels, and **per source type**, does the Y-flip come from `UNPACK_FLIP_Y_WEBGL` or from `imageOrientation`? | 2026-08-03: `createImageBitmap(VideoFrame)` **PASS on hardware too** (frames are in system memory); `UNPACK_FLIP_Y_WEBGL` **silently ignored for ImageBitmap**; `imageOrientation:'flipY'` PASS for a **canvas** source but **silently ignored for a `VideoFrame` source** (`orient/videoframe-flipY=FAIL`, same under llvmpipe and hardware — a WebKit bug, not a driver one). Only canvas + `imageOrientation` actually flips. |
| `video_frame_signal_probe.py` | Which *frame-change* signal does a legacy `<video>` expose? Plays a real file over HTTP and compares `currentTime`, `requestVideoFrameCallback`, `getVideoPlaybackQuality().totalVideoFrames` and `webkitDecodedFrameCount` over a fixed window, with a `setInterval` control for the frame clock | 2026-08-05: `currentTime` changes on **100 %** of ticks (gates nothing — this was the A2 bug); **rVFC is exposed with full metadata but its rate is unmeasurable** here (`rafTicks=1` against `intervalTicks=453` — a bare webview has no display-refresh source, on Xvfb *and* on the real display); `totalVideoFrames` advances at **exactly** the source frame rate (5.8/s on a 6 fps file, 24.8/s on a 25 fps one) and is decoder-driven, so it keeps working when the frame clock is starved. Chose A2's mechanism — `legacy-video-fallback-cost.md` |
| `webcodecs_vp9_av1_probe.py` | Does `VideoDecoder` here actually **decode** VP9 / AV1 — not just claim to? Demuxes a real library file through the same `parsebin ! <parser> ! capsfilter` chain `video_demux.rs` uses, builds the codec string the same way, then configures + decodes every AU (full run, `description` on/off, and a mid-keyframe seek run). `AV1_CAPS=` env to A/B the AV1 bitstream framing | 2026-08-05: **VP9 PASS** — `vp09.00.30.08`, 120/120 AUs → I420 640×480 in 42 ms, no `description` needed, `alignment=super-frame`. **AV1 FAIL** — `isConfigSupported` says `true`, then **0/120** frames with `EncodingError: Decode error`, in all four framings (`obu-stream`/`annexb` × `tu`/`frame`/`obu`), with and without `codec_data` as `description`. A GStreamer `av1enc`-encoded 320×240 control also decodes 0/12, so it is the decoder, not the file. ⚠️ **`isConfigSupported` cannot be trusted here — always probe a real decode.** Shipped VP9, refused AV1: `webcodecs-video-path.md` "Phase 7 results" |
| `output_window_compositor_probe.py` | End-to-end: loads the **real** `/output.html`, drives the **real** `outputBus.postFrame()` from a same-origin sender with a codec (`VideoFrame`) deck source, reads the composited pixels back out, and asserts orientation | 2026-08-03: `buffer=1920x1080 screenBottom=BLUE screenTop=RED glErr=0x0` — receiver boots, composites, right way up. Negative control: reintroducing the direct-from-`VideoFrame` bitmap flips it to `screenBottom=RED`. An earlier version hand-rolled its own bitmap from a canvas and passed while the app was upside down — a probe that reimplements the code under test only confirms its own assumptions. |

**Run the readback probes before designing anything that moves rendered content between
windows or processes.** They answered in minutes what three sessions of Bug A could not: the
first killed a proposed `OffscreenCanvas` rewrite of `compositor.ts` that this build cannot
support, and the second two moved the fault from WebKitGTK to the GPU driver — which changes
what a fix can even look like. They need no Xvfb and take seconds:

```sh
python3 scripts/probes/offscreencanvas_webgl_capture_probe.py
WEBKIT_DISABLE_DMABUF_RENDERER=1 python3 scripts/probes/offscreencanvas_webgl_capture_probe.py

python3 scripts/probes/webgl_readback_variants_probe.py                      # hardware
LIBGL_ALWAYS_SOFTWARE=1 python3 scripts/probes/webgl_readback_variants_probe.py   # control
```

⚠️ **Always run the `LIBGL_ALWAYS_SOFTWARE=1` arm before blaming WebKit for a rendering or
readback fault.** WebKit masks `RENDERER` (`"WebKit WebGL"`, and `"Apple GPU"` via
`WEBGL_debug_renderer_info`), so the GPU in use is invisible from inside the page and a driver
bug looks exactly like a browser bug. That one extra run is the difference between a filed
WebKitGTK report and the actual cause.

Prereqs (all present on this machine): `python3-gi`, `gir1.2-webkit2-4.1`, `Xvfb`,
GStreamer with `x264enc` (`gstreamer1.0-plugins-ugly`).

## Audio-stack probes (GStreamer/PipeWire, no webview)

Same `python3-gi` technique, but these exercise the *audio* stack directly — no WebKit,
no Xvfb, no env-var preamble. Run them plainly: `python3 scripts/probes/<probe>.py …`.

| Probe | What it answers | 2026-08-02 result on this machine (PipeWire 1.6.2 / GStreamer 1.28.2) |
|---|---|---|
| `pipewiresink_multisink_deadlock.py` | Does N `pipewiresink` elements in one process deadlock on PAUSED→PLAYING? (`SINK_FACTORY=pulsesink` to A/B) | `pipewiresink` ×1 0/6, ×2 4/6, ×3 6/6 deadlocked; `pulsesink` ×2 and ×3 both 0/6. Analysis: `docs/design/pipewiresink-play-hang.md` |

⚠️ A reproduced deadlock **hangs every PipeWire client on the machine** (including
`pw-cli`, `wpctl` and any music you have playing) until the probe process is killed. The
probe deliberately stays alive on failure so it can be inspected under `gdb`; kill it when
you're done. Pass a target node name from `wpctl status`, e.g.:

```sh
python3 scripts/probes/pipewiresink_multisink_deadlock.py \
  alsa_output.pci-0000_00_1b.0.analog-stereo 3
```
