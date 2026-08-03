# Native output pipeline: Rust-side video decode + compositing (shelved alternative)

Status: **shelved alternative — not chosen, deliberately documented.** This is the
"plan C" escalation path referenced by `webcodecs-video-path.md`. It was analyzed
during the 2026-07-25 architecture review and set aside because the WebCodecs path
gets most of the benefit at a fraction of the cost. Keep this doc current if that
calculus changes; the analysis here should not need re-deriving.

## When to reopen this

Any of:
- The WebCodecs path fails its Phase 1 (in-app decode broken in the real Tauri
  webview) or Phase 4 (soak reveals a new instability class in WebKitGTK's WebCodecs
  implementation — plausible: its `VideoEncoder` crashes the web process outright,
  so that code is not battle-hardened).
- Webview rendering itself becomes the bottleneck or a new freeze class appears in
  compositing/WebGL rather than media (the watchdog's diagnostics will show this:
  heartbeat dead with no media element involved).
- Output requirements outgrow the webview: multiple projector outputs, 4K@60,
  hardware-synced outputs, NDI/capture-card output — all much more natural in a
  native pipeline.
- WebKitGTK on the target distro regresses in a way that mitigation can't absorb.

### Assessed against this list on 2026-08-02 — still shelved

The Bug A investigation (`output-noise-and-track-reload-silence.md`) found a genuine
WebKitGTK graphics defect, so this doc was explicitly reconsidered. It comes closest to the
fourth trigger, but does not meet it:

- **The defect is external, single-host and non-blocking.** All GPU→CPU readback from a
  WebGL context fails on a 2012 MacBook Pro Retina — reproducible in a bare `Gtk.Window`
  with no cuemark code, and **root-caused 2026-08-03 to the Mesa `crocus` driver, not
  WebKitGTK**: every route passes under `LIBGL_ALWAYS_SOFTWARE=1`
  (`scripts/probes/webgl_readback_variants_probe.py`,
  `docs/upstream/webgl-canvas-readback-broken.md`). The output window works on the
  user's other systems. Rewriting the rendering stack to route around one machine's driver
  bug is a permanent cost against a temporary, external fault.
- **The symptom that felt structural wasn't.** The corruption — growing bands of
  uninitialised memory in the compositor canvas — was caused by
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`, a stale one-line workaround whose premise died in
  `f6b94ea`. Removing it fixed the corruption *and* ~26 points of main-thread CPU. That is
  the opposite of "mitigation can't absorb it".
- **Crucially, only *readback* is broken — display works.** So the cheap fix was to composite
  inside the output window and never read back at all, which needs no native pipeline. **That
  is now built** (2026-08-03; see Bug A's "BUILT" section and
  `src/lib/renderer/outputProtocol.ts`), which weakens the case for this doc further rather
  than strengthening it: the output window already runs its own `Compositor` fed by per-deck
  frames, so the webview path retains the full GLSL effect chain and visualization layer on
  the affected machine.

**What would still justify reopening**, unchanged by any of the above: wanting the projector
output to survive the control window dying, multiple outputs, 4K@60, or NDI/capture-card
output. Those are product decisions on their own merits — this bug is not an argument for
them.

## The idea

Remove the webview from the performance-critical output path **entirely**. Rust
owns video decode, compositing, effects, and the projector window; the webview
becomes a pure control surface (decks UI, waveforms, browser, MIDI status) fed by
low-rate preview thumbnails.

```
Rust, per deck:                         Rust, output stage:
  uridecodebin (video branch)             glvideomixer  ── one input pad per deck,
    ! glupload ! glcolorconvert ─────►      alpha per pad = deck.opacity
    (shares GstGLContext)                 ! glshader (effects / visualization layer)
                                          ! glimagesinkelement in a fullscreen
                                            GTK4/gtk4paintablesink window on display 2

  audio branch: unchanged — the existing DeckAudioPipeline (or merged into the same
  per-deck pipeline, sharing ONE GstClock with the video branch)

Webview (control window):
  session UI as today; deck previews = appsink-fed JPEG/RGBA thumbnails at ~10 fps
  over the existing loopback HTTP server, or a gtk4 paintable embedded beside the
  webview (Tauri window with native child widget) — decide at implementation time.
```

## What this buys (beyond what WebCodecs buys)

Everything the WebCodecs path buys — no `v.playbackRate`, no `v.currentTime` seeks,
both freeze mechanisms structurally impossible — **plus**:

- **True single-clock A/V**: audio and video branches in one GStreamer pipeline share
  one `GstClock`. There is no sync *code* at all — not even the WebCodecs path's
  "present frame whose pts ≤ audio clock" loop. Rate changes via one
  `pitch`/`videorate` arrangement; seeks are one pipeline seek handled by code we can
  gdb (a capability proven decisive twice in this project).
- **No frame-upload tax**: today every frame pays `drawImage` → `texImage2D`
  (~6–7 ms/frame at 1080p, measured 2026-07-25); WebCodecs keeps a similar cost.
  Native GL keeps frames on the GPU end-to-end (`glupload` once, zero-copy between
  elements sharing the GL context).
- **Retires the WebKit workaround stack wholesale**: `WEBKIT_DISABLE_DMABUF_RENDERER`,
  `GST_PLUGIN_FEATURE_RANK` demotions (VA-API could even be re-evaluated — the
  breakage was WebKit's DMA-BUF export path, and a native pipeline controls its own
  GL/VA interop), scratch-canvas intermediary, canvas-sizing rules for output.
- **Headroom**: hardware decode, 4K, multiple outputs, recording the *composited
  output* (video+audio) natively in `record.rs` — impossible today
  (`VideoEncoder` crashes the web process; canvas capture is CPU-prohibitive).
- Output keeps rendering even while the control webview is frozen/reloading —
  combined with `freeze-watchdog.md`, a webview incident becomes invisible to the
  audience (today the output window is webview-fed via `BroadcastChannel` and dies
  with the control window).

## Honest costs (why it wasn't chosen)

- **Effects/visualization port**: the compositor, per-deck FBOs, alpha compositing,
  and all GLSL visualizations live in `compositor.ts`/WebGL. GStreamer's `glshader`
  element runs custom fragment shaders, and the existing shaders are fragment-only —
  they mostly *port* rather than rewrite — but uniform plumbing (`u_time`,
  `u_bass/mid/high` from `AudioAnalysis`, custom uniforms), shader hot-swap on
  visualization change, and the FBO-per-deck composite order all need Rust
  re-implementation and re-verification. This is the single biggest chunk.
- **Preview round-trip**: deck/output previews must travel Rust→webview
  (thumbnail stream). Straightforward but new plumbing, and a place where naive
  implementation could reintroduce per-frame IPC load (the `perf-idle-test.sh`
  regression class).
- **Window management**: a native fullscreen GL output window on display 2 alongside
  Tauri's GTK windows — Wayland/X11 differences, GTK3 (Tauri's stack) vs GTK4
  (`gtk4paintablesink`) friction. Needs a spike of its own.
- **Every hard-won pipeline lesson re-applies**: preroll waits, state-change
  ordering, EOS handling, bus threads, `async=false` rules — now for N video
  branches too. The team knows how to do this now, but it is real, re-verifiable
  surface area.
- **Scratch/jog interplay**: video scratch would want the same PCM-buffer-style
  treatment (pre-decoded GOP walking) inside the Rust pipeline — a second design
  problem this path must eventually answer that WebCodecs answers in the worker.
- Estimated as a multi-week milestone vs. days-to-a-week-scale phases for WebCodecs.

## Relationship to the other tracks

- `freeze-watchdog.md` is a prerequisite-shaped investment either way: it moves the
  session-of-record into Rust, which this path also needs (a native output stage must
  know deck state without asking the webview).
- The WebCodecs path's Rust demux service (`video_demux.rs`) is **not** wasted work
  if this path is later taken — parse-only demux + AU index is exactly the front half
  of a native decode pipeline, and the keyframe index serves native seeking too.
- Decision record: 2026-07-25 review chose WebCodecs first because it (a) reuses the
  entire existing WebGL compositor/effects layer untouched, (b) was de-risked same-day
  by empirical probes (see `webcodecs-video-path.md` spike table), and (c) leaves this
  path fully open as the escalation.
