# Mesa `crocus`: all GPU→CPU readback from a WebGL context fails with `INVALID_OPERATION`

**Status**: root-caused 2026-08-03. **This is a Mesa `crocus` (Intel gen7 / Ivy Bridge)
defect, not a WebKitGTK one** — the earlier framing of this file was wrong and is corrected
below. Reproducers: `scripts/probes/webgl_readpixels_diag_probe.py` (diagnosis) and
`scripts/probes/webgl_readback_variants_probe.py` (route matrix, with a software control arm).

## Summary

On this machine, **every route that moves pixels out of a `webgl2` context into host memory
fails**, while the same context renders and displays correctly on screen:

- `gl.readPixels` returns a zero-filled buffer and raises `GL_INVALID_OPERATION` (0x502) —
  on the default framebuffer *and* on a framebuffer-complete, non-multisampled user FBO,
  using the implementation's own `IMPLEMENTATION_COLOR_READ_FORMAT`/`TYPE`.
- `createImageBitmap(canvas)`, `drawImage(glCanvas, …)` and `toDataURL()` all return
  correctly-sized, **fully transparent** results. None of them throw.

The same page, same calls, under `LIBGL_ALWAYS_SOFTWARE=1` (llvmpipe): **everything passes.**
That single A/B is what identifies the layer. WebKit is not at fault; it is asking the GL
driver for a readback that the driver refuses.

## Environment

| | |
|---|---|
| WebKitGTK | 2.52.3-0ubuntu0.26.04.2 (`libwebkit2gtk-4.1-0`) |
| Session | Wayland, GNOME |
| Display | 3840x2400, `devicePixelRatio = 2` |
| GPU in use | Intel HD 4000 (Ivy Bridge, gen7, `8086:0166`) → Mesa **`crocus`** |
| Other GPU | NVIDIA GK107M (`10de:0fd5`) — no render node present (`/dev/dri/renderD128` only), so not in use |
| Kernel | 7.0.0-28-generic |

Reproduces identically with and without `WEBKIT_DISABLE_DMABUF_RENDERER=1` and with
`WEBKIT_DISABLE_COMPOSITING_MODE=1`, so it is not a consequence of WebKit's compositing mode.
`UseGPUProcessForWebGL` is `false` by default in this build, so it is not a GPU-process
serialisation issue either.

## Observed

Route matrix, `webgl_readback_variants_probe.py`. Each case paints a known colour and reads
back the centre pixel; the two arms differ **only** in `LIBGL_ALWAYS_SOFTWARE`.

| route | hardware (`crocus`) | software (llvmpipe) |
|---|---|---|
| `readPixels`, unsized RGBA texture FBO | `FAIL` `glErr=0x502`, zeroed | `PASS` |
| `readPixels`, sized RGBA8 texture FBO | `FAIL` `glErr=0x502`, zeroed | `PASS` |
| `readPixels`, RGBA8 **renderbuffer** FBO | `FAIL` `glErr=0x502`, zeroed | `PASS` |
| `readPixels` after explicit `readBuffer(COLOR_ATTACHMENT0)` | `FAIL` `glErr=0x502` | `PASS` |
| `readPixels` → `PIXEL_PACK_BUFFER` → `getBufferSubData` | `FAIL` `readErr=0x502` | `PASS` |
| `copyTexSubImage2D` from default FB, then read that texture | copy `0x0`, read `FAIL` `0x502` | `PASS` |

And from `webgl_readpixels_diag_probe.py`, on hardware:

```
webgl2: lost=false ver="WebGL 2.0" vendor="WebKit" renderer="WebKit WebGL"
webgl2: drain took 0 calls; immediately after drain getError=0x0
webgl2: after clear on default FB getError=0x0
webgl2: readPixels(defaultFB) err=0x502 bytes=rgba(0,0,0,0)
webgl2: userFBO status=0x8cd5 complete=true createErr=0x0
webgl2: userFBO IMPLEMENTATION_COLOR_READ_FORMAT=0x1908 TYPE=0x1401 queryErr=0x0
webgl2: after clear on userFBO getError=0x0
webgl2: readPixels(userFBO,RGBA/UBYTE) err=0x502 bytes=rgba(0,0,0,0)
webgl2: readPixels(userFBO,full 64x64) err=0x502 nonzeroAlphaPx=0/4096
webgl2: blit FBO->defaultFB drawErr=0x0 then readPixels err=0x502
```

## Why this is a driver bug and not an application or WebKit bug

Each of these was checked, and each holds:

- **`getError()` is trustworthy.** A drained context reports `NO_ERROR`; clears, draws,
  shader compiles, FBO creation and `copyTexSubImage2D` all report `0x0`. The `0x502` is
  raised specifically by `readPixels`, not latched from something earlier.
- **The framebuffer is legal to read.** `checkFramebufferStatus` = `FRAMEBUFFER_COMPLETE`
  (`0x8cd5`), `SAMPLES` = 0, and the read used the format/type the implementation itself
  advertises. `INVALID_OPERATION` is not a spec-permitted outcome for that call.
- **It is not the multisample-resolve path.** The original hypothesis was that `antialias:
  true` made the default framebuffer multisampled (for which `readPixels` *is*
  `INVALID_OPERATION` in GL ES 3.0). Requesting `antialias: false` yields `SAMPLES=0` and
  changes nothing, and a user FBO is never multisampled in the first place.
- **GPU→GPU is fine; only GPU→CPU is broken.** `copyTexSubImage2D` off the default
  framebuffer succeeds with no error. Rendering, FBOs and texture sampling all work — this
  is why the on-screen canvas is correct.
- **Software rendering fixes every case.** Same WebKit build, same page, same calls.

## What still works, and is load-bearing for the fix

- A plain **2D canvas** captures fine: `drawImage`, `createImageBitmap`, `getImageData`.
- **`drawImage(VideoFrame, …)` onto a 2D canvas works** — this is what `DeckCard.svelte`'s
  per-deck preview does today, and it renders correctly on this machine. WebCodecs frames
  here are decoded in software (libavcodec) into system memory, so they never take the
  broken GPU→CPU path.
- Cross-process `ImageBitmap` transfer over `BroadcastChannel` works: cuemark's output
  window receives bitmaps with correct dimensions every frame; only their *contents* are
  empty, because the source capture was.

So the viable shape of a fix is "never read back from WebGL" — ship frames that were never
in GPU memory, and do any WebGL compositing on the display side.

## Impact

Any application that needs rendered WebGL content in host memory is broken on this GPU:
snapshots, screenshots, `ImageBitmap` transfer to another window or process, and pixel
assertions in tests. **Nothing raises** — `createImageBitmap`/`drawImage`/`toDataURL` return
well-formed transparent images and `readPixels` returns a zeroed buffer, so the failure is
invisible without asserting on pixel values.

In cuemark this presented as the output window (a second Tauri window fed composited frames
over a `BroadcastChannel`) showing garbage: the frames arriving there are fully transparent,
`drawImage` of a transparent source under `source-over` writes nothing, and the canvas was
never cleared — so what was on screen was the canvas's own uninitialised surface memory.
See `docs/design/output-noise-and-track-reload-silence.md`, Bug A.

## Notes

- `WEBGL_debug_renderer_info` reports `UNMASKED_RENDERER_WEBGL = "Apple GPU"` on Linux and
  `RENDERER` is WebKit's sanitised `"WebKit WebGL"`, so the GPU actually in use cannot be
  identified from inside the page. That masking is why this took so long to attribute — the
  `LIBGL_ALWAYS_SOFTWARE` A/B is the only in-page way to tell.
- Under `WEBKIT_DISABLE_DMABUF_RENDERER=1` the on-screen WebGL canvas *additionally* renders
  growing horizontal bands of uninitialised memory. That is a separate defect in the same
  area; it does not occur with the DMA-BUF renderer enabled, which is why that workaround was
  retired in `c5ae242`.
- `LIBGL_ALWAYS_SOFTWARE=1` is **not** a usable workaround for cuemark: it would move the
  whole 1920x1080 shader compositor onto llvmpipe on a 2012 CPU, which is far worse than the
  ~26 points of main-thread CPU that retiring `WEBKIT_DISABLE_DMABUF_RENDERER` recovered.

## Where to report

Mesa, `drivers/gallium/drivers/crocus` — not WebKitGTK. A minimal non-browser reproducer
(EGL + GLES3, render to an FBO, `glReadPixels`) should be written before filing, to remove
ANGLE and WebKit from the picture entirely; the probes here go through both.
