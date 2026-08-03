# WebKitGTK: capturing a WebGL canvas yields fully transparent pixels

**Status**: draft bug report. Reproducer: `scripts/probes/offscreencanvas_webgl_capture_probe.py`.

## Summary

On WebKitGTK 2.52.3, every route for reading pixels back out of a `webgl2` canvas returns
fully transparent data, while the same canvas **renders correctly on screen**. A plain 2D
canvas, captured by the identical calls in the same page, works. The defect is specific to
WebGL-backed canvases.

## Environment

| | |
|---|---|
| WebKitGTK | 2.52.3-0ubuntu0.26.04.2 (`libwebkit2gtk-4.1-0`) |
| Session | Wayland, GNOME |
| Display | 3840x2400, `devicePixelRatio = 2` |
| GPU | Intel HD 4000 (Ivy Bridge, `8086:0166`) + NVIDIA GK107M (`10de:0fd5`) — 2012 MacBook Pro Retina |
| Kernel | 7.0.0-28-generic |

Reproduces identically with and without `WEBKIT_DISABLE_DMABUF_RENDERER=1`, so it is not a
consequence of the software-compositing fallback.

## Observed

```
onscreen-drawImage           = FAIL(transparent)
onscreen-createImageBitmap   = FAIL(transparent)
offscreen-webgl2             = UNSUPPORTED(no webgl2 on OffscreenCanvas)
readPixels                   = FAIL(glError=0x502)
webgl-toDataURL              = FAIL(transparent)
2d-drawImage                 = PASS(rgba(255,0,0,255))
2d-createImageBitmap         = PASS(rgba(255,0,0,255))
```

Note that **none of the failing calls throw**. They return well-formed, correctly-sized,
fully transparent results, so application code cannot detect the failure without asserting
on pixel values.

Each case clears/fills to opaque red `(255,0,0,255)` and reads back the centre pixel.

## Expected

All six report `rgba(255,0,0,255)`. In particular:

- `createImageBitmap(glCanvas)`, `drawImage(glCanvas, ...)` and `toDataURL()` should all
  observe the drawing buffer's contents. The context is created with
  `preserveDrawingBuffer: true`, so the buffer must still be readable after the clear.
- `gl.readPixels(..., RGBA, UNSIGNED_BYTE, ...)` on the **default framebuffer** is
  unconditionally permitted by the WebGL spec; `INVALID_OPERATION` (`0x502`) should not
  occur. No `PIXEL_PACK_BUFFER` is bound and the coordinates are in range.

## Notes

- The drawing buffer reports the correct dimensions (`gl.drawingBufferWidth/Height`), the
  context reports `isContextLost() === false`, and the *draw* path raises no GL error — the
  error appears only on readback.
- The canvas displays correctly, so rendering itself is working; only capture fails.
- Under `WEBKIT_DISABLE_DMABUF_RENDERER=1` the on-screen WebGL canvas additionally renders
  growing horizontal bands of uninitialised memory. That is a separate, and arguably more
  serious, defect in the same area; it is what originally led here. It does **not** occur
  with the DMA-BUF renderer enabled.
- `WEBGL_debug_renderer_info` reports `UNMASKED_RENDERER_WEBGL = "Apple GPU"` on Linux,
  which appears to be WebKit's sanitised string rather than anything hardware-derived.
  Harmless, but it makes bug reports harder to triage — worth mentioning separately.

## Impact

This makes it impossible to move rendered WebGL content between windows/processes in a
GTK/WebKit application: the usual approach (render once, `createImageBitmap`, `postMessage`
to a second window) silently delivers blank frames rather than failing. Nothing raises, so
the failure is invisible without pixel-level assertions. In our case it presented as a
second display output showing a black screen while the source canvas was demonstrably
correct on the primary display.

## Reproducer

`scripts/probes/offscreencanvas_webgl_capture_probe.py` — python3-gi, no application code,
~20 lines of JS in a bare `Gtk.Window` + `WebKit2.WebView`. Prints one line per capture
route. Run it with and without `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
