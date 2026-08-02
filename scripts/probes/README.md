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
