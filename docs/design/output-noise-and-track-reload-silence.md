# Output window renders noise; second track load on a deck plays no audio; choppy audio

Status: **OPEN.** Three live-hardware bugs, none root-caused. Bug C (choppy audio) was
added in the 2026-08-02 follow-up session; that session's work was diagnostic rather than
corrective — see "2026-08-02 follow-up" below — because all three symptoms share one
root problem: **the logs cannot currently tell a working audio path from a broken one.**
Every symptom here presents as "pipeline reached `Playing`, no bus `ERROR`, correct
volume applied", which proves the graph was *built and started*, not that samples are
*moving*. That gap is now instrumented.

Originally: two independent live-hardware bugs surfaced back-to-back during 2026-08-02 live testing
(right after confirming the unrelated webcodecs black-screen fix in
`docs/design/webcodecs-video-not-rendering.md` — that one is fully resolved and not part
of this doc). Several fix attempts were made for both; none resolved the reported
symptom on live retest. Diagnostic instrumentation from this session is left in place
(uncommitted) to make the next session's first repro immediately informative instead of
starting from zero.

**Read `docs/design/webcodecs-video-not-rendering.md`'s "Lessons for next time" section
before continuing this investigation** — same project, same live-repro discipline
applies: a fix that compiles and matches the symptom on paper is not a fix until the
user re-observes the actual symptom gone.

## Current tree state (uncommitted)

```
 M src-tauri/src/audio/pipeline.rs   (Bug B: master_volume fix + load() diagnostic log;
                                      Bug C: instrument_queue_flow() + sink_buffer_times())
 M src/lib/renderer/outputBus.ts     (Bug A: bitmap.close() deferred by one frame)
 M src/output.ts                     (Bug A: ResizeObserver + debugLog instrumentation, kept)
 M src/App.svelte                    (Bug C: rAF heartbeat log spam -> stall-only logging)
```

All three are real, defensible changes independent of whether they fix the reported
symptoms — see each bug's section for why. Nothing here has been reverted. (Other
modified files in the working tree — `video_demux.rs`, `codecWorker.ts`,
`codecPlayer.ts`, the two webcodecs docs — belong to the already-resolved black-screen
bug and are unrelated to this doc.)

---

## Bug A: output window shows random-noise static instead of the composited frame

### Symptom

The control window's per-deck preview renders correctly (confirmed via screenshot — a
real, colorful video frame). The **output window** (`Cuemark — Output`, the fullscreen
compositor mirror meant for the projector/second display) shows solid RGB static across
part or all of its canvas instead. Two live screenshots this session showed two visually
different corruption shapes:

1. First occurrence: the *entire* output window was uniform colorful noise.
2. Second occurrence (after fix attempt 2 below): noise only in two horizontal bands
   near the top and bottom edges, with a correctly-black middle region.

Reopening the output window fresh (not just leaving the corrupted one open) does not
clear it — user confirmed "same behavior as before" after a clean reopen with both fixes
below already live.

### Architecture recap

`src/output.ts` is a **separate, minimal Tauri window/webview** — its own
`WebKitWebProcess`, not a second instance of `App.svelte`/`compositor.ts`. It has no
WebGL, no `Compositor`, no FBOs. It opens a `BroadcastChannel('cuemark-output')` and gets
a plain 2D canvas context; on each message it does `ctx.drawImage(bitmap, 0, 0, ...)`.

All WebGL compositing happens only in the main/control window. Frames are shipped out via
`src/lib/renderer/outputBus.ts`'s `postFrame(canvas)`: `createImageBitmap(canvas)` →
`channel.postMessage({ frame: bitmap })`, called once per composited frame from
`App.svelte`'s render loop (`compositor.ts:1320`).

### Correlation with the freeze-watchdog

Both observed noise incidents coincided with, or immediately followed, the
freeze-watchdog (`docs/design/freeze-watchdog.md`) detecting the `output` window's
heartbeat silent for ≥6s (a real freeze — the last heartbeat before each trigger reported
a healthy `lastRafMs`, so this isn't a false trigger) and running its full recovery
cascade: tier1 (eval reload) → tier2 (native reload) → tier3 (SIGKILL + reload all
windows). In both incidents this session, tier1 and tier2 **always** failed with
`window 'output' not found`, tier3's blind `SIGKILL` + `reload_all_windows()` "succeeded"
mechanically, and after 3 consecutive full cascades the watchdog gave up on `output`
specifically ("3 consecutive recovery sequences failed — giving up, leaving audio alone").

Two things worth flagging in `src-tauri/src/watchdog.rs`, not yet fixed:

- **tier1/tier2 vs tier3 asymmetry.** tier1/tier2 look up the window via
  `app.get_webview_window("output")`, which reliably fails in this scenario; tier3
  bypasses that lookup entirely via `app.webview_windows()` (the design doc explains why:
  attributing a killed `WebKitWebProcess` back to a specific window label isn't reliable).
  Net effect: tier1/tier2 are dead weight for `output` whenever this happens — every
  recovery for `output` silently skips straight to the SIGKILL tier.
- **tier3's kill is unconditional.** `kill_webkit_descendants()` kills *every* WebKit
  descendant process, not just the one attributed to the stuck window — so `output`'s
  tier3 likely also kills `main`'s `WebKitWebProcess` as collateral, even in cases where
  `main`'s own heartbeat looked fine going in.

Neither of these has been confirmed as the noise's root cause — they're plausible
contributors to *why respawns happen so aggressively*, not proven mechanisms for *why a
respawn produces garbage pixels*.

### RESOLVED 2026-08-02 (late) — the "freezes" were phantoms: a closed window the watchdog never forgot

**The `output` freezes driving this whole cascade were not freezes.** `watchdog.rs` had no
way to stop tracking a window: `Inner::windows` was only ever `insert`ed into and
`get_mut`'d, there was no `on_window_event` handler in `lib.rs`, and nothing anywhere
called `remove`. So **closing the output window was indistinguishable from it freezing** —
the entry lingered, stopped being fed, tripped `SILENCE_THRESHOLD` 6s later, and drove the
full recovery cascade against a window that was gone because the user closed it on purpose.

Captured live, unprompted, mid-session on `00b9129` while investigating something else:

```
23:33:45  [watchdog]   descendant pid=649924 comm=WebKitNetworkPr  etimes=2480s
23:33:45  [watchdog]   descendant pid=649941 comm=WebKitWebProces  etimes=2480s
                       ^^ only TWO descendants — output's web process is already gone
23:33:45  [watchdog] recovery tier1 (eval reload): window 'output'
23:33:45  [watchdog] tier1: window 'output' not found
23:33:48  [watchdog] tier2: window 'output' not found
23:33:53  [watchdog] recovery tier3 (SIGKILL + reload all windows): window 'output'
23:33:53  [watchdog] tier3: killed 2 WebKitWebProcess descendant(s)
23:33:59  [watchdog] TRIGGER: window 'main' silent for >= 6s — last stats: {…,"lastRafMs":0}
23:34:00  [watchdog] window 'main' heartbeat resumed after 7.5s silence
   … the same loop twice more, at 23:34:16 and 23:34:40 …
23:34:55  [watchdog] 'output': 3 consecutive recovery sequences failed — giving up
23:35:45  [watchdog] window 'output' heartbeat resumed after 126.4s silence   ← reopened
```

**`main` was killed three times in 62 seconds, and was perfectly healthy every time.** Its
`lastRafMs` at each manufactured trigger was `0`, `13`, `9` — the control window was
rendering fine and got its `WebKitWebProcess` SIGKILLed as collateral for a window that
did not exist. Each of those is a forced reload of the control surface mid-performance.

Corrections to the two bullets above, both of which this supersedes:

- **The tier1/tier2-vs-tier3 asymmetry does not exist.** In tauri 2.10.3 both lookups are
  keyed identically — `get_webview_window(label)` is `manager().get_webview(label)`
  filtered by `is_webview_window()`, and `webview_windows()` is that same filter over
  `manager().webviews()`. When tier1/tier2 logged `not found`, tier3's
  `reload_all_windows()` was not quietly succeeding where they failed; it had no `output`
  entry either and logged nothing only because it reports per-window *errors*. All three
  tiers agreed: the window was genuinely gone.
- **tier3's unconditional kill is real and is not fixable at that layer.** Attribution of a
  `WebKitWebProcess` to a window label isn't reliable across the sandbox's possible bwrap
  layer, so there is nothing to be selective with. The fix is upstream — never let a window
  that isn't genuinely frozen reach that tier.

**The reasoning that made these triggers look genuine was inverted.** This doc previously
argued "the last heartbeat before each trigger reported a healthy `lastRafMs`, so this
isn't a false trigger". A healthy final beat followed by silence is precisely the signature
of a **clean close**, not of a freeze — and `main`'s `lastRafMs: 0` above is a documented
false trigger with the healthiest possible last beat. Treat "healthy last heartbeat" as
evidence *against* a freeze, not for one.

**Fixes applied** (`watchdog.rs` + `lib.rs`):

1. `watchdog::forget_window(state, label)`, called from a `Builder::on_window_event`
   handler on `Destroyed`/`CloseRequested`. Reopening re-registers on the next heartbeat
   via the existing insert branch, so no re-add path is needed.
2. A belt-and-braces existence check in the poll loop: before spawning any recovery
   sequence, confirm the window is still there via `find_window()`; a label with no live
   webview is a closed window, so drop it and log rather than escalate. This needs no GTK
   event to fire, which matters because a missed event costs a SIGKILL of every WebKit
   process in the app. Deliberately performed outside the state lock — it reaches into
   Tauri's window manager, which takes its own locks, while `watchdog_heartbeat` already
   holds ours from inside a command handler.
3. `find_window()` replaces the bare `get_webview_window` in tier1/tier2, falling back to
   the `webview_windows()` map. Documented as belt-and-braces rather than a real second
   source, so the non-existent asymmetry isn't re-hypothesised later.

**What this does and does not settle for Bug A.** It removes the *precondition*: every
noise observation to date followed at least one watchdog-triggered SIGKILL + respawn, and
those respawns are now known to have been spurious. It does **not** demonstrate that the
noise is gone — nobody has looked at a screen since. If noise still appears on a first,
never-killed output window, the respawn hypothesis dies and the search moves to WebKit's
cross-process `ImageBitmap` path regardless.

### ROOT-CAUSED 2026-08-02 (late) — it was never an output-window bug

Everything above this line is framed around the output window. **That framing is wrong**, and
it is why three sessions of fixes missed. The compositor canvas in `App.svelte` has been
`display:none` since `ee91c54` (2026-04-27), so **nobody had ever looked at it**. Rendering it
visible (320x180, green border, bottom-right of the control window) showed the *identical*
corruption — noise band top, black middle, noise band bottom — in the **control** window.
`outputBus.ts` and `output.ts` were faithfully transporting an already-corrupt source. Both
prior fix attempts operated on a transport that was working correctly the whole time.

Three independent defects were tangled under one symptom:

| | Defect | Cause | Status |
|---|---|---|---|
| **A2** | Noise bands | `WEBKIT_DISABLE_DMABUF_RENDERER=1` corrupts the WebGL canvas | **Fixed** — retired as default in `main.rs` |
| **A1** | Output window receives blank frames | Snapshotting a WebGL canvas returns **transparent** on this WebKitGTK build | **Root-caused, unfixed** |
| **A3** | Video flashes then goes black | Deck FBO textures go empty; `composite()` still runs | **Open, new** |

**A2 — the workaround was the bug.** Same binary, one variable, user-confirmed live: with
`WEBKIT_DISABLE_DMABUF_RENDERER=1` the compositor canvas shows growing bands of
uninitialised memory; with it unset the same canvas is clean solid black. This is the second
condemnation of that line in one day — Bug E measured it costing ~26 points of main-thread
CPU and every rAF stall. Its premise died in `f6b94ea` (WebCodecs made `<video>` +
`drawImage(video)` non-default), so the trigger had been gone for months while the cost and
the corruption remained. Now off by default; `CUEMARK_DISABLE_DMABUF=1` restores it. The
legacy `<video>` fallback remains untested with DMA-BUF enabled — see `main.rs`.

**A1 — WebGL canvas snapshots return transparent here.** `createImageBitmap(canvas)` *and*
`drawImage(glCanvas, ...)` both yield fully transparent pixels while the same canvas
**displays** correctly on screen. Independent of DMA-BUF (reproduces in both arms). This is
why `output.ts` measured `centrePixel=rgba(0,0,0,0)` at frame #240 with video playing, even
though `composite()` clears to `rgba(0,0,0,1)` — an opaque clear that cannot survive as
transparent through a working capture.

**Probed 2026-08-02, and it is worse than "one broken call".**
`scripts/probes/offscreencanvas_webgl_capture_probe.py` reproduces this in a bare
`Gtk.Window` with no cuemark code at all — it is an upstream WebKitGTK bug, written up in
`docs/upstream/webgl-canvas-readback-broken.md`. Identical results in both DMA-BUF arms:

```
onscreen-drawImage         = FAIL(transparent)
onscreen-createImageBitmap = FAIL(transparent)   <- what postFrame() does today
offscreen-webgl2           = UNSUPPORTED(no webgl2 on OffscreenCanvas)
readPixels                 = FAIL(glError=0x502)
2d-drawImage               = PASS(rgba(255,0,0,255))
2d-createImageBitmap       = PASS(rgba(255,0,0,255))
```

**The `OffscreenCanvas` + `transferToImageBitmap()` fix proposed earlier is not available** —
this build has no `webgl2` context on `OffscreenCanvas`. Probing it cost minutes and saved a
structural rewrite of `compositor.ts` that could not have worked. (`transferControlToOffscreen()`
is not a workaround either: `transferToImageBitmap()` throws on a placeholder-backed canvas.)

What the 2D control case establishes: capture is **not** broken in general on this build, only
for WebGL-backed canvases. Remaining options, none started:

1. **2D-canvas compositing for the output path.** Known to work here. Costs the GLSL effect
   chain and the shader visualization layer, which are WebGL by construction — so it is a
   real feature regression, not a transparent fix.
2. **Composite inside the output window.** WebGL *display* works fine (the window renders
   correctly; only readback fails), so the output window could run its own compositor and
   never capture anything. Requires shipping decoded frames rather than composited bitmaps,
   and cross-process `VideoFrame` transfer over `BroadcastChannel` in WebKitGTK is unproven —
   probe before building.
3. **`docs/design/native-output-pipeline.md`** — GStreamer-native second output, no webview
   in the loop. CLAUDE.md requires an explicit decision; **do not start without one.**
4. **Report upstream and accept it on this machine.** The output window works on other
   systems; this is one WebKitGTK build on 2012 hardware.

**Caveat on this session's own instruments.** The `centreFB`/`centreVia2D` readings added to
`composite()` are **unreliable**: `gl.readPixels` on the default framebuffer fails with
`INVALID_OPERATION` (`0x502`) on this WebKit build in *both* DMA-BUF arms, and a failed
`readPixels` leaves the array zeroed — which masquerades as a transparent framebuffer.
An early reading of that error was briefly mistaken for a defect in the composite path; the
draws are clean (`errAfterDraw=0x0`). Trust the on-screen canvas, not those numbers.

**Machine context (this is not reproducible everywhere).** The user reports the output window
works on other systems. This one is a 2012 MacBook Pro Retina: Intel HD 4000 (Ivy Bridge) +
NVIDIA GK107M, 3840x2400 panel at `dpr=2`, Wayland, WebKitGTK 2.52.3. A1 in particular looks
specific to this WebKit/driver combination.

### ROOT-CAUSED 2026-08-03 — A1 is a **Mesa `crocus` driver** bug, and the noise is not corruption at all

Two findings, from `scripts/probes/webgl_readpixels_diag_probe.py` and
`scripts/probes/webgl_readback_variants_probe.py`. Full evidence:
`docs/upstream/webgl-canvas-readback-broken.md`.

**1. The layer was wrong. It is not WebKit.** Every GPU→CPU route out of a `webgl2` context
fails here — `readPixels` on the default framebuffer *and* on a framebuffer-complete,
`SAMPLES=0` user FBO (texture-backed, RGBA8-texture, and renderbuffer variants alike), with
an explicit `readBuffer()`, through a `PIXEL_PACK_BUFFER` + `getBufferSubData`, and after a
`copyTexSubImage2D` — all `INVALID_OPERATION` (`0x502`) with a zeroed buffer. Under
`LIBGL_ALWAYS_SOFTWARE=1`, **same build, same page, same calls, every one of them passes.**
The GPU in use is the Intel HD 4000 (gen7) on Mesa `crocus`; the NVIDIA card has no render
node and is not involved.

This kills the hypotheses this file spent three sessions on, and one it never reached:

- Not the multisample resolve. `antialias:false` gives `SAMPLES=0` and changes nothing, and
  a user FBO is never multisampled — so the earlier reading of `0x502` as "correct behaviour
  for a multisample FB" is wrong too.
- Not WebKit's GPU process: `UseGPUProcessForWebGL` is `false` by default in this build.
- Not compositing mode: reproduces under `WEBKIT_DISABLE_DMABUF_RENDERER=1` and
  `WEBKIT_DISABLE_COMPOSITING_MODE=1` alike.
- Not `getError()` lying: a drained context reports `NO_ERROR`, and clears, draws, FBO
  creation and `copyTexSubImage2D` are all `0x0`. Only `readPixels` fails.

**GPU→GPU works; only GPU→CPU is broken.** That is exactly why the canvas displays correctly
while every snapshot of it comes back transparent.

**2. The noise was never corruption — nothing was ever drawn.** `postFrame()` ships a
transparent bitmap; `output.ts` did `ctx.drawImage(frame, …)` under the default `source-over`
compositing, where a fully transparent source **writes nothing**; and `output.ts` never
cleared the canvas. So no pixel of that canvas had ever been written, and what was on screen
was its own uninitialised GPU-backed surface. The horizontal bands are untouched surface
tiles — which is also why "reopen the window fresh" never helped and why the shape changed
between reproductions for no apparent reason.

Fixed in `output.ts`: `clearRect()` before every `drawImage` (and after every resize), so an
empty transport now shows honest black instead of garbage. Plus `frameIsBlank()` — an 8x8
downscale + `getImageData` on the incoming bitmap, checked on the first frame and once a
second — which logs `blank=true/false` and shows a small dim corner indicator. **This is a
correct fix for the visible symptom and a real improvement in observability, but it does not
put video on the projector.** That needs a transport change; see below.

**3. `LIBGL_ALWAYS_SOFTWARE=1` is not the workaround.** It would move the entire 1920x1080
shader compositor onto llvmpipe on a 2012 CPU — far worse than the ~26 main-thread CPU points
that retiring `WEBKIT_DISABLE_DMABUF_RENDERER` just recovered (Bug E).

### Revised options for actually getting frames to the output window

The constraint is now precise, and narrower than "capture is broken": **never read back from
WebGL.** Anything that was in GPU memory cannot come out. Three things are known to work and
are load-bearing here:

- a plain 2D canvas captures fine (`drawImage`, `createImageBitmap`, `getImageData`);
- **`drawImage(VideoFrame, …)` onto a 2D canvas works** — `DeckCard.svelte`'s per-deck preview
  does exactly this and renders correctly on this machine. WebCodecs frames are decoded in
  software (libavcodec) into system memory, so they never touch the broken path;
- cross-process `ImageBitmap` transfer over `BroadcastChannel` works — the output window has
  been receiving correctly-sized bitmaps every frame all along. Only their contents were empty.

Given that, the earlier option list is superseded:

1. **~~2D-canvas compositing for the output path~~ — viable, and cheaper than it looked.**
   Compositing decks with `drawImage(VideoFrame)` + `globalAlpha` covers deck opacity and the
   crossfader, i.e. the core of the output. It still costs the GLSL effect chain and the
   visualization layer, so it remains a feature regression — but it is a small, contained
   change and it is the fastest route to a working projector.
2. **Composite inside the output window — CHOSEN AND BUILT 2026-08-03, see below.**
3. **`docs/design/native-output-pipeline.md`** — GStreamer-native second output, no webview
   in the loop. CLAUDE.md requires an explicit decision; **do not start without one.**
4. **Report upstream and accept it on this machine.** Now well-founded: the bug is in Mesa
   `crocus`, so this is one old GPU, and the output window genuinely does work elsewhere.

### BUILT 2026-08-03 — the compositor moved to the output window

Option 2, implemented. The contract and its rationale live in
`src/lib/renderer/outputProtocol.ts`; CLAUDE.md's "Rendering pipeline" has the diagram. In
short: the control window no longer composites or captures anything — it has **no WebGL
context at all** — and instead ships each deck's current frame as an `ImageBitmap` plus the
state needed to blend them. The output window runs the existing `Compositor` unchanged,
keeping the GLSL effect chain and the visualization layer.

| | |
|---|---|
| `src/lib/renderer/outputProtocol.ts` | New. Message contract: `frame` (per-deck bitmaps + opacities + viz uniforms/time/analysis), `viz` (shader source, on change only), `hello` (receiver asks for a full re-send) |
| `src/lib/renderer/outputBus.ts` | Rewritten as the sender: `VideoFrame`/`<video>` → `ImageBitmap` → `BroadcastChannel` |
| `src/output.ts` | Rewritten: owns a `Compositor`, uploads bitmaps into deck FBOs, renders viz, composites |
| `src/lib/renderer/fbo.ts` | `uploadImageBitmap()`; scratch canvas now lazy; **FBOs clear themselves on creation** |
| `src/App.svelte` | Compositor, its 1x1 hidden canvas and all FBO uploads removed; builds the per-deck source list instead |

**Three things this surfaced that were not obvious, all probe-verified:**

1. **`createImageBitmap(VideoFrame)` works on the real GPU.** WebCodecs decodes in software
   into system memory, so decoded frames never take the broken readback path.
   (`imagebitmap_upload_probe.py`) *Superseded in part:* it carries real pixels, but the
   sender still routes codec frames through a scratch canvas — see item 2.
2. **Orientation is silently ignored in two different places, and only one combination
   works.** `UNPACK_FLIP_Y_WEBGL` is ignored for `ImageBitmap` sources (no GL error, unflipped
   pixels), so `uploadImageBitmap()` sets no pixel-store flag and the sender decides
   orientation via `createImageBitmap(..., {imageOrientation:'flipY'})`. **That option is in
   turn ignored for a `VideoFrame` source** — honored only for a canvas. Shipping codec frames
   straight from the `VideoFrame` therefore put the projector upside down for real, live, on
   2026-08-03 (fixed same day: every source now goes through the scratch canvas). Both
   failures are WebKit-level, identical under llvmpipe and on hardware, and neither throws.
   This is the *third* time an orientation assumption has bitten this project — see
   `uploadVideoFrameFromCodec`'s doc comment for the first two.
3. **A freshly allocated `DeckFBO` contained undefined GPU memory.** `texImage2D(..., null)`
   allocates without defining contents, and an empty or not-yet-decoded deck is still
   composited at its own opacity — so the compositor could blit uninitialised memory to the
   projector. This is the *same* failure mode as the uninitialised 2D canvas that produced
   the original noise, in a second place nobody had looked. FBOs now clear to transparent
   black on creation. **Plausibly a contributor to the original Bug A noise reports** — it
   would have applied to the old control-side compositor identically.

**Verification — CONFIRMED LIVE 2026-08-03.** User-observed with video playing: the output
window shows the composited image, correct content, no noise. That is what makes Bug A fixed.

Getting there took one more round. The first live look was upside down (see the
`imageOrientation`/`VideoFrame` failure in item 2 above), *despite*
`scripts/probes/output_window_compositor_probe.py` passing its orientation assertion — because
that probe's sender hand-rolled a bitmap from a canvas instead of calling the real
`postFrame()`, so it exercised the one source type that works. **The probe now imports
`outputBus.ts` from the dev server and drives it with a `kind:'codec'` source, and it has been
verified in both directions**: reintroducing the direct-from-`VideoFrame` bitmap turns it red
(`screenBottom=RED`), the fix turns it green (`screenBottom=BLUE`). A green assertion that has
never been shown to fail proves nothing — which is precisely how this shipped upside down.

### Fix attempts (both real, neither resolved the symptom)

**Attempt 1 — `outputBus.ts`'s `bitmap.close()` race.** The sender was calling
`bitmap.close()` immediately after `channel.postMessage()` returned. Per spec that's
safe (structured clone happens synchronously before `postMessage` returns), but
WebKitGTK's `BroadcastChannel` here is genuinely cross-*process* (sender and receiver are
different `WebKitWebProcess`es) — a domain where this whole codebase has a long history
of WebKitGTK not honoring spec guarantees (see CLAUDE.md: custom URI scheme resolution,
direct video→`texImage2D`, VA-API DMA-BUF canvas corruption). Removed the `close()` call
entirely; let the bitmap be GC'd. **Live retest: noise persisted, but changed shape**
(uniform → edge-band pattern) — see attempt 2.

**Revised in the 2026-08-02 follow-up session — now a one-frame-deferred close, not no
close.** Dropping `close()` outright was not free, and it never demonstrated a benefit
(the noise survived it). These are full-output-resolution bitmaps — the live log above
confirms 1920×1080, ≈8MB each — produced from `App.svelte`'s `frame()` at up to 60fps
whenever anything is animating. Never closing them turns reclamation into a GC-timing
question at on the order of a hundred MB/s of external allocation, inside the *same*
`WebKitWebProcess` whose CPU the GStreamer streaming thread is already competing with.
That is a plausible contributor to Bug C, and not worth carrying indefinitely on an
unproven hunch. `postFrame()` now closes the *previous* frame's bitmap rather than the
current one: at most two are live at any moment, release is deterministic, and the
cross-process copy still gets a full frame of slack instead of zero. If the noise is ever
genuinely traced to this race, the correct next step is a receiver-side ack — not
removing `close()` again.

**Attempt 2 — `output.ts`'s canvas-sizing race.** The canvas buffer was sized from a
one-shot `window.innerWidth`/`window.innerHeight` read at script-top-level plus a
`window.addEventListener('resize', ...)` listener — exactly the pattern CLAUDE.md's
canvas-sizing gotcha warns against ("WebKitGTK does not reliably apply CSS/layout size
timing — always size via JS, and prefer `ResizeObserver`"). Theory: right after a forced
native window reload, GTK can still be settling the recreated window's layout when
`output.ts`'s top-level code runs, undersizing the canvas buffer with no further
`resize` event ever firing to correct it — leaving stale/uninitialized backing-store
pixels visible as noise at the edges. This matched the second screenshot's shape
unusually well (noise only at top/bottom edges, correct-looking content in the middle).
Replaced with a `ResizeObserver` on `document.body`. **Live retest: "same behavior as
before"** — did not fix it, though it's still a correct, spec-compliant sizing approach
worth keeping regardless.

### The key diagnostic finding: the JS data path is provably healthy

Both fixes shipped with permanent `debugLog()` instrumentation in `output.ts`: every
`resize()` call logs the observer's reported dimensions and the resulting canvas buffer
size; the message handler logs frame #1 and every 120th frame after, with the incoming
bitmap's dimensions alongside the canvas's. Live log from the most recent reproduction
(both fixes active):

```
[output] resize: width=1280 height=673 dpr=2 -> canvas=2560x1346
[output] frame #1: bitmap=1920x1080 canvas=2560x1346
[output] frame #120: bitmap=1920x1080 canvas=2560x1346
[output] frame #240: bitmap=1920x1080 canvas=2560x1346
```

Frames are arriving steadily, with correct, sane, unchanging dimensions, and
`drawImage()` is being called every time — **yet the user still saw noise on screen.**
This rules out both JS-layer hypotheses fairly conclusively: the bug is not in bitmap
lifecycle or canvas sizing. Whatever is producing the garbage pixels is happening
**below** the JS canvas API — most likely at the WebKit/GPU compositing or windowing
level (the same general class as the already-mitigated VA-API DMA-BUF corruption, though
that mitigation — `WEBKIT_DISABLE_DMABUF_RENDERER=1`, set process-wide in `main.rs`
before `cuemark_lib::run()` — should already apply to every `WebKitWebProcess` this app
spawns, `output` included; this was not re-verified experimentally this session, e.g. by
checking the actual env of the `output` window's spawned process).

### Open hypotheses / next steps

1. **Check whether the corruption reproduces on a *first*, never-killed output window
   open at all.** Every reproduction this session involved at least one prior
   watchdog-triggered SIGKILL+respawn cycle before the noise was observed. Untested: open
   the output window fresh at app startup, before any freeze/recovery has happened, and
   see if it's ever clean. If it's always clean until the first forced respawn, that
   strongly implicates the respawn path itself (GTK/Wayland surface not being fully torn
   down and recreated, vs. just reloading page content) rather than anything in steady-
   state rendering.
2. ~~**Verify `WEBKIT_DISABLE_DMABUF_RENDERER=1` actually reaches the `output` window's
   process env**~~ — **ANSWERED 2026-08-02 (late): it does, and it exonerates the env.**
   Read directly from `/proc/<pid>/environ` on a live app. A run launched *without* the
   A/B flag has `WEBKIT_DISABLE_DMABUF_RENDERER=1` present in the spawned
   `WebKitWebProcess`'s own environment, so the process-wide `set_var` in `main.rs` does
   propagate to every child. More decisively: in a two-window run, `main`'s web process and
   `output`'s web process have **byte-identical** environments — there is no env asymmetry
   between the window that renders correctly and the one that renders noise. Combined with
   the Bug E A/B note that Bug A was "present before and after" enabling GPU compositing,
   **the corruption occurs under both software and GPU compositing.** Bug A is not a
   DMA-BUF-class bug and not an env-propagation bug; stop treating the VA-API corruption
   precedent as a lead.
3. **Consider whether tier3's recovery for `output` should destroy-and-recreate the
   native window object, not just reload its page content** — if the corruption lives in
   the window's GPU-backed surface/compositor state rather than anything page-JS
   controls, a page reload wouldn't reset it but a full window recreation might.
4. ~~Fix the tier1/tier2 `get_webview_window` lookup gap in `watchdog.rs`~~ — **DONE
   2026-08-02 (late), though the gap was not what this item assumed.** There was no
   lookup gap; there was a closed window nobody had told the watchdog about. See "RESOLVED
   2026-08-02 (late)" above. The hoped-for side effect landed: spurious `output` cascades,
   and the tier3 kill-everything storms they caused, should now not fire at all.
5. `docs/design/native-output-pipeline.md` already documents this whole architecture as
   fragile by design ("today the output window is webview-fed via `BroadcastChannel` and
   dies with the control window") and proposes a structural rewrite (GStreamer-native
   second output, no webview in the loop at all). CLAUDE.md is explicit: **do not start
   that without an explicit decision** — but if this investigation stalls again, it's the
   documented escalation path, not a fix to reach for casually.

---

## Bug B: loading a second track onto a deck plays no audio

### Symptom

Load a track onto deck-0, play it — audio works correctly (confirmed earlier in this
same session). Load a **different** track onto the **same deck** afterward: the deck
plays (video decodes, transport UI behaves normally) but **no audio is audible**.
Reproduced twice, including after the fix attempt below.

### Architecture recap

`audio_load` (`src-tauri/src/audio/mod.rs`) reuses the **existing**
`DeckAudioPipeline` struct for that `deck_id` across a track swap (`mgr.pipelines.remove
(&deck_id)` returns `Some(existing)`, so `gain`/`vol`/`master_volume`/`rate`/`cue_gain`
struct fields persist correctly across the swap — they are not reset to defaults).
However, `DeckAudioPipeline::load()` (`pipeline.rs:417`) tears the whole GStreamer graph
down to `Null` and **rebuilds every element from scratch** on every call, including the
`volume` elements — nothing about the actual `volume`/`sink` GObjects is reused between
loads, only the Rust-side struct fields that get reapplied to the fresh elements.

### Fix attempt (real bug, confirmed NOT the cause)

While reading `load()`'s volume-application code, found a real inconsistency:
`apply_volume()` (the canonical helper used by `set_gain`/`set_volume`/
`set_master_volume_factor`, `pipeline.rs:1091`) applies `gain × vol × master_volume` to
every main-sink `volume` element. But `load()`'s own rebuild path
(`pipeline.rs:646-648`, and the parallel `cue_volume` line at `:673`) was applying
`gain × vol` only — **omitting `master_volume`**. Net effect (independent of this
session's symptom): if the user has master volume turned down, then loads a new track on
any deck, that deck's rebuilt pipeline would silently ignore the master-volume
attenuation until the next explicit master-volume nudge. Fixed both the main-sink and
cue-branch lines to match `apply_volume()`'s formula, and added a diagnostic log line
printing the exact gain/vol/master_volume/computed-volume applied on every `load()`.

**Live retest, log excerpt (both the first and the reported-silent second load, same
session):**

```
[audio/deck-0] load(): applying gain=1.000 vol=1.000 master_volume=1.000 -> volume=1.000 to 1 main sink(s)
...
[audio/deck-0] load(): applying gain=1.000 vol=1.000 master_volume=1.000 -> volume=1.000 to 1 main sink(s)
```

Full volume (`1.000`) applied cleanly on **both** loads. This rules out gain/volume/mute
as the cause of the silence definitively — the fix is real and worth keeping, but it is
not what's making the second track inaudible.

### What else was checked and ruled out

Comparing the two loads' full bus-message sequences (`pipeline.rs`'s GStreamer bus
handler output) line-for-line, both are structurally identical and clean:

```
sink: pulsesink device="alsa_output.usb-Guillemot_Corporation_DJControl_Starlight-00.analog-surround-40" ...
[bus/deck-N] pipeline: Null → Ready (pending Paused)
WARNING: No decoder available for type 'video/x-h264 ...'   ← expected/harmless, see below
first audio-fft: 32 bands  bass=0.000 mid=0.000 high=0.000
[bus/deck-N] pipeline: Ready → Paused (pending VoidPending)
[bus/deck-N] async-done  pos=0ms
duration=NNN.NNNs
...
[bus/deck-N] pipeline: Paused → Playing (pending VoidPending)
```

- **No GStreamer bus `ERROR` at any point**, either load.
- The "No decoder available for type video/x-h264" `WARNING` is expected and harmless —
  `DeckAudioPipeline` deliberately skips video-decoder factories via `autoplug-select`
  (see `docs/design/webcodecs-video-not-rendering.md`'s "Explicitly NOT the bug" section
  for the same warning investigated and ruled out there). It appears identically on
  every load, first or second.
- **Same output device string, verbatim, both loads** — not a device-selection
  regression between tracks.
- State transitions all complete (`Playing` reached both times) — not a stuck/blocked
  pipeline.

### Open hypotheses / next steps

Nothing below has been tested yet — this is where the next session should start:

1. **Device/hardware-level contention on rebuild.** The *same* physical USB audio node
   (`...DJControl_Starlight-00.analog-surround-40`) is torn down (`set_state(Null)` on
   the old pipeline) and a brand-new `pulsesink` targeting it is built moments later. If
   PipeWire/ALSA hasn't fully released the node before the new sink opens, the new sink
   could negotiate against a stale, duplicate, or otherwise inactive stream without
   GStreamer surfacing a bus `ERROR` — `pulsesink`'s failure modes for a busy/reused node
   aren't always fatal-and-loud. Check live with `pactl list sink-inputs` (or
   `pw-dump`) at the moment of the second load: is the new stream actually connected to
   the hardware sink, or sitting on a `null`/`monitor`/orphaned node?
2. **Narrow the trigger condition.** Does loading the *same* track twice onto the same
   deck reproduce it, or only a *different* track? Does it reproduce loading a second
   track onto a **fresh** deck (deck-1) rather than reusing deck-0? This distinguishes
   "any second `load()` on a pipeline that already tore something down once" from
   "specifically reusing the same deck_id."
3. **The `detached-pipeline IPC received` burst** logged during every load (dozens of
   entries within ~1-2s — `audio_get_position` polling racing the mid-load pipeline
   removal window, per `with_pipeline_detached`'s documented fail-fast behavior) hasn't
   been confirmed harmless beyond "matches the same pattern on the working first load
   too." Worth a closer read of whether any *other* command (not just position polls)
   could be silently dropped in that window and needed to actually complete the audio
   path.
4. Add a log line to `pipeline.rs` at the point audio buffers actually reach the main
   sink (e.g. a probe on the sink's sink pad, or GStreamer's own `stream-status`/
   `qos` bus messages) — everything currently logged confirms the pipeline *reached*
   `PLAYING` cleanly, not that data was actually flowing through to the hardware after
   that point. That gap (state-transition success vs. actual buffer flow) is exactly
   where a silent, non-erroring device-contention issue would hide.

---

## Bug C: audio playback is choppy

### Symptom

Reported 2026-08-02 (follow-up session), after the Bug A/B session above: "the audio
playback has gotten a bit choppy too… I think some of our fixes earlier reintroduced some
audio instability." Not yet characterized more precisely than that — **unknown whether it
is continuous or episodic, one deck or all decks, tied to rate changes/scratch or present
at rate 1.0.** Narrowing that is the first job of the next live repro; the instrumentation
below is there to make the answer fall out of the log rather than out of guesswork.

### Why nothing in the log answered this

`pw-top` sampled during the session showed both `cuemark` PipeWire nodes idle with
`ERR=0`, but nothing was playing at the time, so that measured nothing. The app's own log
was worse than useless: **every visible line in the tail of a 32KB live log was
`[frontend] [heartbeat] rAF alive`**, emitted once per second unconditionally by a debug
line in `App.svelte`'s `frame()`. Meanwhile there was **no audio-flow logging at all** —
`pipeline.rs` handles no QoS, `stream-status`, or xrun bus messages, and `pulsesink`
reports underflows only at `GST_DEBUG` level. So the log could report that a pipeline
reached `Playing` with the right volume on the right device while the audio was audibly
falling apart, and show nothing else. Both were fixed (see below).

### Prime suspect: the sink buffer is vestigially small

`make_sink()` sets `buffer-time=50ms` / `latency-time=10ms`. That 50ms was chosen in May
2026 (journal.md) to fix a *different* problem that **no longer exists**: rate changes
were implemented as FLUSH seeks then, and the sink's default 200ms of already-buffered
old-rate audio drained while the new segment started, producing the audible
"doubled/detuned" artifact. Rate changes now go through the `pitch` element's `tempo`
property with no seek and no flush at all (CLAUDE.md), so nothing requires a small buffer
anymore — but the value was carried forward unexamined, including across commit `23c8df6`
(2026-08-02, same day as the choppiness report), which switched `pipewiresink` →
`pulsesink`.

That switch is what makes it newly suspect. **`pipewiresink` ignored these properties
entirely** — it extends `GstBaseSink`, not `GstAudioBaseSink`, and took a
`node.latency=1024/48000` (~21ms) quantum instead. On `pulsesink` the same numbers really
are the PulseAudio/pipewire-pulse ringbuffer: 50ms of total slack, written 10ms at a time,
which leaves very little room for the GStreamer streaming thread to be late — and it will
be late, on a machine also running WebGL compositing and (since `f6b94ea` flipped the
default) a software WebCodecs H.264 decode, with VA-API decoders deliberately demoted to
rank 0 in `main.rs`. This is a hypothesis, not a diagnosis; it has not been tested by ear.

### Instrumentation added (this session)

- **`instrument_queue_flow()` (`pipeline.rs`)** — connects `output_queue`'s `underrun`
  signal, gated on `Playing` (via a lock-free `AtomicBool` set from the bus thread, *not*
  a `current_state()` query — these signals fire on the queue's streaming thread, and
  this project has already lost sessions to lock-ordering deadlocks in the audio path)
  and rate-limited to one line per 5s per deck:
  - `underrun` fires → upstream can't keep up (decode/soundtouch/CPU contention).
    Widening the sink buffer would only delay the symptom.
  - `underrun` silent, but audio still choppy → samples move through this queue fine and
    the gap is past it, i.e. in the sink's own ringbuffer → the `buffer-time` suspicion
    above.

  **`overrun` is deliberately not watched.** First pass at this instrumented it as "the
  sink stopped consuming", which is wrong: with a synced sink, upstream decode runs far
  faster than real time and backpressure holds this queue at or near its cap for the
  whole of healthy playback, so `overrun` fires continuously when nothing is wrong. An
  empty queue is the anomaly; a full one is the steady state.
- **`instrument_sink_flow()` (`pipeline.rs`)** — this is the probe Bug B's open step 4
  asked for, and it had to be a **sink-pad probe rather than a queue signal**, precisely
  because a stalled sink leaves `output_queue` *full* — indistinguishable from healthy
  playback from the queue's side. A `BUFFER` pad probe on each main sink's sink pad logs
  one line on the first buffer that reaches it, and one more if flow ever resumes after a
  gap >1s. Event-driven, not periodic, so it stays readable across a whole set. On a
  silent deck this splits Bug B in half: no line at all → nothing reached the sink, fault
  is upstream in the rebuilt graph; a line → audio *was* delivered and the fault is the
  sink/device (hypothesis 1).
- **`sink_buffer_times()` (`pipeline.rs`)** — `buffer-time`/`latency-time` are now read
  from `CUEMARK_SINK_BUFFER_MS` / `CUEMARK_SINK_LATENCY_MS`, **defaults unchanged at
  50/10**. The default was deliberately *not* changed: there is no evidence yet that the
  sink is the culprit rather than upstream starvation, and raising it costs real cue and
  scratch responsiveness. The env override exists so the value can be bisected by ear
  within one session instead of one rebuild per guess.
- **`App.svelte` rAF heartbeat** — no longer logs once per second unconditionally. It now
  logs only when consecutive `frame()` ticks are >1s apart, reporting the measured gap.
  Liveness is already sent to Rust every second by the `watchdog_heartbeat` invoke, so
  nothing is lost, and a stall now produces a positive line with a duration instead of an
  absence to be spotted in a wall of identical lines.

### RESOLVED 2026-08-02 — sink `buffer-time` 50ms → 200ms

**User-confirmed live: "All devices are sounding good now."** Default changed in
`sink_buffer_times()` to 200ms/20ms (`pulsesink`'s own defaults).

The decisive evidence was an accident of configuration: the user had **two main sinks
selected at once**, an onboard PCI codec and the USB DJ controller, fed from one `tee`.

```
[audio/deck-0/0]  pulsesink device="alsa_output.pci-0000_00_1b.0.analog-stereo"      ← clean
[audio/deck-0/1]  pulsesink device="...DJControl_Starlight-00.analog-surround-40"    ← jittery
```

Identical decode, identical soundtouch output, identical CPU, diverging only after the
`tee`. That eliminates every upstream cause by construction — CPU contention, decode,
soundtouch, and the `outputBus.ts` bitmap churn cannot make one branch jitter while
sparing its sibling. `instrument_queue_flow()` concurred: **zero underruns all session.**

Mechanism, measured with `pw-top`: both devices run a **2048-frame quantum (42.7ms at
48kHz)**, so the old `buffer-time=50ms` was **≈1.17 quanta** — one late wakeup from a
dropout, on any device. The Starlight crossed that threshold first because it also
negotiates `S24LE 4 44100` (48k→44.1k resampling) plus USB transfer scheduling, whereas
the CS4206 runs native `S32LE 2 48000` and retained just enough margin. At 200ms
(≈4.7 quanta) both devices measured **`err=0`** with zero underruns and zero sink-flow
gaps across ~106s of playback.

**Bug D (cue silencing master) did not reproduce under the same change** — cue was
switched ON mid-playback and all three expected PipeWire streams were present, where
previously only one existed. That is consistent with the same root cause (a sink failing
to establish its ringbuffer under a pathologically tight buffer), but it is one
non-reproduction of an intermittent bug, **not** proof. Leave Bug D open; if it recurs,
the branch tagging below now identifies which sink is missing.

### Next steps

1. Optionally bisect `CUEMARK_SINK_BUFFER_MS` downward from 200 — the buffer is pure
   added output latency and DJ cueing feels it. **Re-test any lower value on USB audio**,
   which is where 50ms broke; an onboard codec will not reveal the problem.
2. Bug D remains open pending recurrence — see its section.
2. **In the same repro, characterize the symptom** — continuous vs episodic, one deck vs
   all, rate 1.0 vs only during tempo/scratch. Bug C is currently one sentence of user
   report; nothing should be tuned before it is a description.
3. **Only if `underrun` stays silent**, A/B the sink buffer by ear:
   `CUEMARK_SINK_BUFFER_MS=200 CUEMARK_SINK_LATENCY_MS=20 cargo tauri dev` versus the
   50/10 default. If 200 is clean and 50 is not, bisect down to the smallest reliably
   clean value rather than keeping 200 — the buffer is pure added output latency and DJ
   cueing feels it.
4. **If `underrun` fires**, the target is CPU contention, not buffers. `pidstat` the
   `WebKitWebProcess` during the repro; the webcodecs path is decoding H.264 in software
   (VA-API decoders are rank-0'd in `main.rs`), the output window is doing a 1920×1080
   `createImageBitmap` + cross-process copy per frame, and `scripts/perf-idle-test.sh`
   exists for exactly this measurement.
5. Confirm the deferred-`close()` change in `outputBus.ts` (Bug A, attempt 1 revision)
   didn't itself change the choppiness either way — it reduces allocation pressure in the
   process that hosts the render loop, so it is a variable in this experiment.

---

## 2026-08-02 follow-up session (Bug C added; diagnostics, no root causes)

No root cause was found for any of the three bugs, and no live repro was run — the app
was running but idle. What changed: the three symptoms were re-read together, and the
common blocker turned out to be observability rather than any one mechanism. Every
symptom here looks identical in the logs ("reached `Playing`, no bus `ERROR`, correct
volume, correct device"), which establishes that the graph was *built and started* and
says nothing about whether samples are *moving*. Work done:

| Change | File | Why |
|---|---|---|
| `instrument_queue_flow()` | `audio/pipeline.rs` | First audio-flow signal in the app; partitions Bug C three ways and tests Bug B's hypothesis 1 |
| `sink_buffer_times()` + env override | `audio/pipeline.rs` | Makes the vestigial 50ms `buffer-time` bisectable by ear without a rebuild; documents why it's suspect |
| Deferred `bitmap.close()` | `renderer/outputBus.ts` | Restores deterministic release of ~8MB×60fps bitmaps without giving up the IPC slack; see Bug A attempt 1 |
| rAF heartbeat → stall-only | `App.svelte` | The log was ~100% heartbeat noise, which is what made the other two bugs hard to read |

Everything above compiles (`cargo check`, `npm run check` both clean). **None of it has
been verified against the live symptoms** — per
`docs/design/webcodecs-video-not-rendering.md`'s "Lessons for next time", a change that
compiles and matches the symptom on paper is not a fix until the user re-observes the
symptom gone.

---

## Bug D: no master audio at all when headphone cue is enabled (2026-08-02, live-confirmed)

### Symptom and the confirmed trigger

Main output completely silent during playback. **User A/B: toggling the deck's
headphone/cue button restores master audio immediately.** Main was routed to
`DJControl Starlight — Front` and cue to `DJControl Starlight — Rear` — the two halves of
one 4-channel node (`...DJControl_Starlight-00.analog-surround-40`). Choppiness (Bug C)
persists *even once audio returns*, so the two are separate faults.

### What the new instrumentation established

- **Zero `output_queue underrun` lines.** Upstream is healthy — this is not CPU
  starvation, which retires the leading Bug C hypothesis for this symptom.
- `main sink 0: first buffer reached the sink`, and continuous flow during playback (the
  only gaps logged line up exactly with pause spans). GStreamer *is* delivering buffers
  to the main sink.
- No bus `ERROR`, correct volume, correct device, hardware mixer unmuted (all 4 channels,
  61%). Every conventional check passes while the output is silent.
- `pw-dump` during a live 180s sample (play window captured at t=172–177): **only one real
  cuemark playback stream exists, while two `pulsesink`s were built** — plus a
  `'pulsesink probe'` node stuck `suspended` for all 180 samples. That probe stream is
  GStreamer's transient format-probe and should not persist; **one of the two sinks looks
  stuck at the probe stage and never creates its real stream.**

### Refuted hypothesis — recorded so it isn't retried

The obvious read was "two `pulsesink`s on one shared node collide", by analogy with the
`pipewiresink` hazard in `compute_cue_remap`'s doc comment. **`scripts/probes/pulsesink_shared_device_silence.py`
refutes it**: 1, 2 and 3 plain `pulsesink`s on this exact node all get running streams,
and so does the 2-sink case with the last sink 4-channel RL/RR-remapped to mirror
main+cue. So the collision is *not* inherent to sharing the node, and — importantly — two
decks on one output device are not broken by this.

That probe also corrected a **reasoning error worth not repeating**: the surviving stream
was identified as "the cue branch" from its 4 ports. Port count cannot tell these apart —
pipewire-pulse maps even a plain stereo stream onto all four of this device's ports, so
main and cue both present as FL/FR/RL/RR. The conclusion drawn from it was unsound.

### Fix applied so far (diagnostic only)

`make_sink()` now sets `stream-properties` `media.name = "cuemark <deck_id>"` (which
already encodes the branch: `deck-0/0` for main sink 0, `deck-0-cue` for cue). Until this,
every branch appeared in `pw-dump`/`pw-top`/`wpctl` as an identically-named `cuemark` node
carrying the track title, which is what made the ambiguity above possible at all.

### Next steps

1. Reproduce with cue enabled and read `pw-dump`: with the branches now named, **which**
   sink is missing its stream — `cuemark deck-0/0` or `cuemark deck-0-cue`? Everything
   below depends on that answer and nothing should be built before it.
2. If the *main* sink is the stuck one, the question is why a `valve`-gated sibling branch
   prevents it from completing `pulsesink` setup — the probe shows a bare sibling sink
   does not. Prime suspects are cuemark-specific topology the probe doesn't model: the
   cue branch's `async=false`, its `valve` (which starves the cue sink of caps entirely
   while cue is off), and clock provisioning between the two sinks.
3. `GST_DEBUG=pulsesink:5,audiobasesink:5` on a repro will say directly why the stuck
   sink never acquired its ringbuffer. Cheaper than more black-box graph sampling.

---

## Bug E: UI freeze near end of track — **re-diagnosed 2026-08-02 (evening): not a spin, not near-EOS, not in the WebCodecs path**

> **READ THIS FIRST — the framing below the line is superseded.** A live repro
> session with a per-thread CPU sampler and a `perf` capture established:
>
> 1. **There is no spin event.** Slicing `perf` samples to the exact rAF gaps shows
>    the main thread at 100% CPU *identically inside and outside* the gap, with no
>    discontinuity at either edge. The stalls are rAF **starvation on a permanently
>    saturated main thread**, not one long task blocking the loop.
> 2. **It is not an end-of-track bug.** Playing the last 68s of the exact incident
>    file to natural EOS was completely clean. The stalls appear during ordinary
>    two-deck playback, nowhere near EOS.
> 3. **All three suspects below are eliminated** — they live in the codec Worker
>    (~1% of CPU) and app JS (`[JIT]`, 1.4%).
> 4. **The main thread is at 84% of a core with a *single* deck playing.** The app
>    has no main-thread headroom in steady state; that is the actual bug.
>
> Full evidence, root condition and the A/B result: **"Bug E re-diagnosis"** below.
> The original framing is kept verbatim underneath it because the reasoning that
> produced it (`state=R`, `Δstime=0` ⇒ "tight userspace loop") is a *correct*
> inference from the watchdog line alone — it just isn't what was happening, and
> that gap is the lesson.

**Observed live 2026-08-02, ~17:46.** Fresh symptom, and the first freeze in this project
captured with positive evidence rather than inferred from an absence of log lines.

```
17:46:23  [heartbeat] rAF stalled 3003ms
17:46:30  [watchdog] descendant pid=224563 comm=WebKitWebProces state=R etimes=295s Δutime=103 Δstime=0
17:46:37  [bus/deck-0] EOS
17:46:45  window 'main' heartbeat resumed after 21.9s silence
17:46:53  recovery sequence for 'main' succeeded
```

**This is not the freeze mechanism `freeze-watchdog.md` and the `audio-debugging` skill
describe.** Those are *deadlocks* — a thread blocked on a lock, consuming no CPU. Here the
watchdog's own diagnostics report `state=R` with `Δutime=103` and `Δstime=0`: the
WebKitWebProcess was **runnable and burning ~1s of user CPU per sample window**, doing
work, not waiting. Treating this as "the freeze is back" and reaching for the deadlock
playbook would be a category error.

Two facts to build on:

- **It clusters around EOS** (stall begins ~14s before the `EOS` bus message; audio
  reaches end of track mid-freeze).
- **It is pure userspace compute** (`Δstime=0` — essentially no syscall time), so it is a
  tight loop in JS/WASM/WebKit's own code, not I/O or IPC.

Prime suspects, all in the WebCodecs path that became the default in `f6b94ea` and which
none of the freeze-watchdog work covered:

1. `codecWorker.ts`'s `pump()` / `fetchAus()` near the end of the AU list — a loop whose
   exit condition depends on `nextFeedIndex` vs available AUs could spin once it runs off
   the end instead of terminating.
2. `maybeStartLoopPrefetch()` — builds a *second* `VideoDecoder` when approaching the loop
   point. Near end-of-track it is plausible for this to fire repeatedly.
3. `codecPlayer.ts`'s `frames.sort()` on every pushed frame — cheap normally, but not if
   frames stop being drained while decode continues.

The recovery worked (tier3, 21.9s total), so this is a serious glitch rather than a hang —
but a 22s freeze mid-set is not survivable in performance, and the watchdog's SIGKILL is a
blunt instrument to be relying on.

**Next step**: reproduce by playing a track to its end and capture which of the three
above is looping — a `console.time`/counter in `pump()` would settle it quickly, or
`perf top -p <WebKitWebProcess pid>` during the spin (see the skill's CPU-profiling
section, which is the right tool here precisely *because* this one burns CPU).

---

## Bug E re-diagnosis (2026-08-02 evening) — chronic main-thread saturation in WebKit's software rasteriser

Live repro on the real desktop, real MIDI hardware, clean tree at `00b9129`, with
`scripts/probes/thread-cpu-sampler.sh` and `perf record -F 499` attached throughout.

### What reproduced

Six `[heartbeat] rAF stalled` events (1048–1237ms) plus `position-poll` latency of
p50 546ms / p90 810ms, during two-deck playback — the same signature as the incident.
Deck-0 was the *same file* that was playing when it froze (identified from the incident
log: `audioPos=288.4718` matches `219000972d411d6b-80498295.mp4`'s 288.485s duration
exactly), deck-1 the same audio-only `.wav`.

**`602c279` did not fix this.** The stalls reproduce with the `audioOnlyDecks` fix
present and active.

### The two measurements that reframed it

**1. Per-thread attribution (`scripts/probes/thread-cpu-sampler.sh`).** During the stall
windows:

| thread | CPU |
|---|---|
| **main thread** | **`state=R`, ~95–100% of a core** |
| `WebCore: Worker` (codec worker — `pump()`, `fetchAus()`, `maybeStartLoopPrefetch()`) | ~1% |
| `HeapHelper` / `ollector Thread` (JSC GC) | absent |
| `eoDecoder queue` (WebCodecs H.264 decode) | ~21% |

That alone retires suspects 1 and 2 (both run in the Worker) and rules out GC.

**2. `perf` samples sliced to the exact rAF gaps.** Convert the log's wall-clock stall
timestamps to `perf`'s monotonic clock (offset = `time.time() - /proc/uptime`), then
bucket main-thread samples per 100ms:

```
  t=93533.9  48 ################################################
  t=93534.0  49 #################################################   <<< rAF GAP starts
  ...
  t=93534.9  51 ##################################################  <<< rAF GAP
  t=93535.0  37 #####################################               <<< rAF GAP ends
  t=93535.1  47 ###############################################
```

At `-F 499`, ~50 samples/100ms **is** 100% CPU. The main thread is pinned flat before,
during and after the gap — **there is no event at the gap boundaries at all.** A
1-second rAF gap on a thread that is already 100% busy is starvation, not a spin.

### Where the main thread actually goes

`perf report --sort comm,dso` over the whole capture:

| | share of all samples |
|---|---|
| **main thread inside `libwebkit2gtk`** | **55%** (59% during stalls) |
| `eoDecoder queue` in `libavcodec` (decode) | 14% |
| `libjavascriptcoregtk` | 2.7% |
| **`[JIT]` — all of our JavaScript** | **1.4%** |

The hot region is a single 8KB span holding 17% of main-thread WebKit time. Symbols are
stripped (`nm -D` has only 2259 exports and resolves everything to
`WebProcessMain+0x28e…`), so it was identified by **disassembling it directly**:

```asm
movss  (%r8,%r14,4),%xmm4     ; gather 32-bit RGBA pixels at scattered indices
psrld  $0x8,%xmm10            ; unpack G
pand   %xmm12,%xmm10          ;   (xmm12 = 0xFF channel mask)
cvtdq2ps %xmm10,%xmm10        ; -> float
mulps  %xmm7,%xmm10           ; * 1/255
mulps  %xmm14,%xmm10          ; * per-tap coefficient from a 16-entry stack array
addps  %xmm10,%xmm9           ; accumulate, one running sum per channel
add    $0x10,%r9
cmp    $0x40,%r9
jne    <top>                  ; 16 taps
```

A 16-tap SIMD image-resampling filter. The second hotspot (5.1%) is `rep stos %eax,(%rdi)`
in a row loop — bulk surface fills. **Roughly a third of main-thread time is software 2D
rasterisation.**

### Root condition: a workaround whose premise died two architectures ago

`src-tauri/src/main.rs` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` process-wide, which
forces WebKit to composite the entire page on the CPU. Its stated reason:

> *"DMA-BUF surfaces from VA-API video decoding don't transfer to 2D canvas pixel reads
> in WebKitGTK — `drawImage(video)` produces colorful noise."*

That is a statement about `<video>` → `drawImage()` → 2D canvas. **Since `f6b94ea` made
WebCodecs the default, the video path is `VideoDecoder` → `texImage2D(VideoFrame)` — no
`<video>` element and no `drawImage(video)` anywhere on the default path.** The trigger
is gone; the cost is not. This is the same shape as `buffer-time=50ms` in this file's own
"Lessons" section, and it is the second instance of that pattern in one day.

### A/B result

Gated behind `CUEMARK_ENABLE_DMABUF=1` (default unchanged), following the
`CUEMARK_SINK_BUFFER_MS` precedent:

| arm | main thread | rAF stalls | polls >300ms | decode |
|---|---|---|---|---|
| 1 deck, software composite | 84% | — | — | 18% |
| 2 decks, software composite (**the stalling run**) | 87% | **6** | **297** | 21% |
| 2 decks, software composite (2nd window) | 88% | 0 | many | 16% |
| **2 decks, GPU composite** | **62%** | **0** | **54** | 21% |

~26 points off the main thread (≈30% of its load); rAF stalls to zero; decode unchanged,
confirming the freed time is compositing rather than decode. **User-confirmed live: no
visual corruption in the main window / deck previews.** Output-window corruption (Bug A)
was present before and after — unchanged, not caused by this.

### Still open — do not mark this fixed

1. **No same-binary control arm yet.** Every software-compositing row above came from the
   *previous* binary; the two differ only by the env gate, but this project's own rule is
   to A/B the same binary. Relaunch without `CUEMARK_ENABLE_DMABUF=1`, same two decks,
   output window closed (to match), 90s.
2. **The 22-second freeze was never reproduced** — only the ~1s stalls. They are the same
   starvation on the same saturated thread, but that is an argument, not a measurement.
   In particular the incident's `Δstime=0` is stricter than what reproduced here (~10–15%
   system time alongside), and nothing yet explains that difference.
3. **Whether GPU compositing reintroduces VA-API corruption on the paths that still use
   `<video>`** — the legacy fallback (any non-H.264 file, and audio-only files) — is
   untested. If it does, the right fix is codec-specific `GST_PLUGIN_FEATURE_RANK`
   demotions, not a process-wide renderer kill.
4. 62% of a core for two decks is better, not good. The remaining main-thread load is
   still mostly WebKit raster.

### Corrections to earlier entries in this file

- **The "identical 379ms position-poll across both decks" lead was an effect, not a
  cause.** That timer spans `invoke()` → *promise resolution*, and the resolution callback
  runs on the main thread — so a blocked main thread inflates it directly, and two decks
  reporting the same number is what one main-thread stall looks like from two in-flight
  promises. Confirmed by pairing in the recovered log: `took 1056ms` with
  `rAF stalled 1073ms`, `took 5808ms` with `rAF stalled 4419ms`. Not `AudioManager` mutex
  contention.
- **An `imageSmoothingQuality: "high" → "low"` A/B on `DeckCard`'s preview was
  inconclusive, not negative** — it was scored on main-thread CPU, which was *saturated in
  both arms*, so it could not move by construction. Reverted. Recorded because the mistake
  is easy to repeat: **a CPU-delta A/B is meaningless on a pegged resource**; score
  throughput (stall counts, poll latency) instead.
- **CLAUDE.md's `GST_PLUGIN_FEATURE_RANK` claim is out of date.** It states
  `vaav1dec:0,vaapiav1dec:0,vah264dec:0,vaapih264dec:0`; `main.rs` demotes only the two
  AV1 factories. H.264 hardware decode is live. (Fixed in CLAUDE.md.)

### Incidental finding for Bug A (not chased)

The output window's own log now reads:

```
[output] frame #1: bitmap=1920x1080 canvas=300x150
[output] resize: width=1280 height=673 dpr=2 -> canvas=2560x1346
```

**Frame #1 is drawn into a 300×150 canvas** — the intrinsic default from CLAUDE.md's
canvas-sizing gotcha — and the `ResizeObserver` only resizes *after*. Reassigning
`canvas.width/height` reallocates the backing store, so the first frames land in a buffer
that is then thrown away and replaced by an uninitialised one. That is a concrete,
untested mechanism for the uninitialised-looking edge bands, and it is upstream of both
fix attempts already recorded under Bug A (neither of which addressed draw-before-resize).

---

## Deferred: `alignment-threshold` as a gap cause (separate session)

Distinct from the multi-device clock drift in `sink_buffer_times()`'s doc comment, and
the fallback hypothesis if that one dies.

`GstBaseSink`/`GstAudioBaseSink` expose `alignment-threshold` (default **40ms**) and
`discont-wait` (default **1s**). When an incoming buffer's timestamp deviates from the
sink's expected next position by more than `alignment-threshold`, the sink stops silently
aligning samples and performs a **resync** — audible as a brief gap, playback continuing.

Why it is plausible here specifically: cuemark's audio graph does several things that
perturb timestamps upstream of the sink.

- `pitch` (soundtouch) emits variable-size output chunks (~82ms WSOLA window) and its
  timestamps are not sample-exact, especially at rates ≠ 1.0.
- `input_selector` switching between the normal branch and the scratch `appsrc` is a
  deliberate timestamp discontinuity.
- The seek-domain scaling fixed in `7b36333` shows this area has had real timestamp bugs.

**Discriminator against clock drift**: clock drift requires **two different physical
devices** (two hardware clocks). `alignment-threshold` resyncs do not — they occur with a
single device, and should correlate with **rate changes / scratch / seeks** rather than
with elapsed time. So: if gaps persist on a single output device, drift is excluded and
this is the candidate; if they also correlate with tempo-fader use, strongly so.

Investigate with `GST_DEBUG=audiobasesink:5` and grep for resync/discont decisions, then
try raising `alignment-threshold` (it is a plain property on every sink, same place
`sink_buffer_times()` is applied). Note that raising it trades gaps for latency slop, so
the real fix may instead be upstream timestamp correctness.

---

## Lessons from the 2026-08-02 sessions

Recorded because the same failure modes recurred several times in one day.

**1. A tuning constant outlives the architecture it was tuned for.** This is the single
most productive lens on this codebase's audio bugs, and it is probably what
"different architectural shifts fighting each other" actually is. `buffer-time=50ms` was
*correct* in May 2026: rate changes were FLUSH seeks, and a large sink buffer drained
old-rate audio into the new segment. Two architecture changes later — rate changes moved
to the `pitch` element (no seek, no flush) and the sink moved `pipewiresink`→`pulsesink`
(where the property is actually honored) — every premise behind the number was gone, but
the number stayed and became a bug. Nothing "fought"; an assumption died silently.

*Practice*: when a constant encodes an assumption, name the assumption in the comment, so
that when the assumption dies the constant is greppable. `sink_buffer_times()` and
`OUTPUT_QUEUE_STEADY_CAP_NS` now do this.

**2. Verify from the artifact, not from the intent.** Three wrong claims in one session,
all the same shape — asserting a state because the action that should have produced it was
taken:
- Reported "default is now 200ms" after editing only the **doc comment** and leaving the
  function body at `50_000`. `cargo check` passes because a wrong constant is still valid,
  and a `CUEMARK_SINK_BUFFER_MS=200` env var in the running shell masked it exactly as
  long as it was set. The regression surfaced only on a "clean" restart.
- Reported "no playback occurred" from a sampler that looped `pw-top -b -n 1`, which can
  only ever emit the priming batch.
- Identified a PipeWire stream as the cue branch by port count, which cannot distinguish
  the branches at all.

*Practice*: confirm from the runtime log line / measured output, never from "I made the
edit". For this file specifically, `sink: pulsesink ... buffer-time=` in the app log is
ground truth; the source is not.

**3. An instrument that can't see the failure will confidently deny it.** A sink-pad probe
cannot observe `slave-method=skew` corrections, because those happen *inside* the sink,
past the pad. Reading `instrument_sink_flow()`'s silence as evidence against clock drift
would be exactly wrong. Every probe needs its blind spot written down next to it.

**4. Probe before fixing, when the fix is structural.** The "two `pulsesink`s on one node
collide" theory was coherent, matched the symptom, and was **wrong** — refuted in minutes
by `scripts/probes/pulsesink_shared_device_silence.py` for far less than the cost of the
rewrite it implied. This project already had the habit (`pipewiresink_multisink_deadlock.py`);
it is worth keeping.

**5. The natural experiment beats instrumentation when it is available.** What actually
cracked the choppiness was the user having *two output devices selected at once*: one
`tee`, two sinks, one clean and one jittering. That excludes every upstream cause by
construction — no logging can be argued with in the way a theory can. Look for a
configuration where the difference isolates itself before building tooling.

**6. A shared premise inherits its error to every conclusion drawn under it.** Bug A's
investigation opened by treating the watchdog cascades as a *correlate* of the noise —
something that co-occurred with it and might explain it. Nobody audited whether the
cascades were themselves real, because the trigger came from an instrument built to detect
exactly that. Once the "freezes" turned out to be a closed window the watchdog never forgot
(see "RESOLVED 2026-08-02 (late)"), the correlation didn't just weaken — the entire framing
of "corruption follows a respawn" became a claim about respawns that should never have
happened. Two sessions of hypotheses were generated downstream of an unexamined premise.

*Practice*: when a chain of reasoning rests on a signal from your own tooling, spend the
cheap check on the signal before spending sessions on the chain. Here the check was two
minutes of `ps` and `/proc/<pid>/environ` on a live app, and it also disposed of the
DMA-BUF hypothesis (open item 2) as a side effect.

**7. Read-only forensics on a live process is undervalued here.** Both of this session's
findings came from `ps -eo pid,ppid,etimes` and `/proc/<pid>/environ` against an already-
running app — no rebuild, no restart, no instrumentation, nothing that could perturb the
state being examined. That matters more than usual in this project, because the most
valuable states (a never-respawned window, a wedged pipeline) are exactly the ones a
restart destroys. Before reaching for a new `debugLog`, ask what the running process
already exposes.

## Warning for whoever picks this up

Same caution as `docs/design/webcodecs-video-not-rendering.md`: don't leave the app
deadlocked while testing something else audio-related — see
`docs/design/pipewiresink-play-hang.md`. `pgrep -a cuemark` / `pgrep -af WebKit` before
trusting any external tool's view of process state, especially mid-investigation of Bug A
above, which involves the freeze-watchdog deliberately killing and respawning
`WebKitWebProcess`es as part of normal (if currently over-aggressive) operation.

Two additions from 2026-08-02 (late):

- **More than one `cuemark` can be running.** Two dev instances were live simultaneously
  during that session, with different `CUEMARK_ENABLE_DMABUF` settings — i.e. different
  *compositing paths* — writing to the same log file, where the second instance's start
  truncated it while the first kept writing at its old offset. `ps -eo pid,ppid,etimes,args`
  and `/proc/<pid>/environ` distinguish them; the `[build]` line alone does not, since both
  were the same SHA. Confirm which instance a log line came from before drawing anything
  from it.
- **Process state is perishable evidence — inventory it before you change anything.** The
  never-respawned output window that Bug A's decisive experiment needs existed on a live
  app at the start of that session and was destroyed a few minutes later by a spurious
  watchdog cascade, before anyone had looked at the screen. Rust edits are also hazardous
  here for the same reason: `cargo tauri dev` watches `src-tauri/` and will restart the app
  under you. If a running app is in a state you might want, record `ps`/`/proc` for it
  first. To type-check without contending for `src-tauri/target`'s lock (which has killed a
  dev server mid-rebuild before), point cargo elsewhere:
  `CARGO_TARGET_DIR=/tmp/<somewhere> cargo check`.
