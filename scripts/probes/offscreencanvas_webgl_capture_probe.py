#!/usr/bin/env python3
"""Can this WebKitGTK build capture a WebGL canvas at all?

Bug A (docs/design/output-noise-and-track-reload-silence.md) left one defect
unfixed: on this machine, *snapshotting* a WebGL canvas yields fully transparent
pixels while the same canvas displays correctly on screen. Both
`createImageBitmap(canvas)` and `drawImage(glCanvas, ...)` are affected, in both
DMA-BUF arms. That is why the output window receives blank frames — `postFrame()`
in outputBus.ts ships a snapshot.

The proposed fix is to render the compositor into a standalone
`new OffscreenCanvas(1920,1080)` and ship frames via `transferToImageBitmap()`,
which never round-trips through a canvas snapshot. That rests on an untested
assumption: **that WebKitGTK supports a webgl2 context on an OffscreenCanvas at
all.** 2D OffscreenCanvas is long-supported; WebGL-in-OffscreenCanvas landed much
later and may be absent or flagged off in this build. Probing before rewriting the
compositor, per the "probe before fixing, when the fix is structural" lesson.

Each case clears to opaque red (1,0,0,1) and reads back the centre pixel. A
working capture must report r=255,a=255. Transparent (0,0,0,0) is the Bug A
signature; the point is to find a route that is not.

Usage:
    python3 scripts/probes/offscreencanvas_webgl_capture_probe.py
    CUEMARK_DISABLE_DMABUF=1 python3 scripts/probes/offscreencanvas_webgl_capture_probe.py

Interpreting it:
    offscreen-webgl2 ... PASS   -> the proposed fix is viable, implement it
    offscreen-webgl2 ... UNSUPPORTED/FAIL -> it is not; the remaining options are
        rendering the compositor directly inside the output window, or
        docs/design/native-output-pipeline.md (do NOT start without a decision)
    onscreen-*       ... FAIL   -> reproduces Bug A's snapshot failure, confirming
        the probe is actually exercising the broken path on this machine
"""
import gi, os, sys

gi.require_version("WebKit2", "4.1")
gi.require_version("Gtk", "3.0")
from gi.repository import WebKit2, Gtk, GLib  # noqa: E402

# Every case paints the same thing — an opaque red clear — then reports the centre
# pixel by whichever capture route it is testing. Same expected answer everywhere
# (255,0,0,255) makes the routes directly comparable.
JS = r"""
const RESULTS = [];
function note(name, verdict, detail) { RESULTS.push(`${name}=${verdict}${detail ? '(' + detail + ')' : ''}`); }

function clearRed(gl) {
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.clearColor(1, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.finish();
}
function verdictFor(d) {
  // Opaque red means the capture round-tripped. Transparent is the Bug A signature.
  if (d[3] === 0) return ['FAIL', 'transparent'];
  if (d[0] > 200 && d[3] > 200) return ['PASS', `rgba(${d[0]},${d[1]},${d[2]},${d[3]})`];
  return ['ODD', `rgba(${d[0]},${d[1]},${d[2]},${d[3]})`];
}
function readVia2D(src, w, h) {
  const probe = document.createElement('canvas');
  probe.width = 1; probe.height = 1;
  const p = probe.getContext('2d');
  p.drawImage(src, (w / 2) | 0, (h / 2) | 0, 1, 1, 0, 0, 1, 1);
  return p.getImageData(0, 0, 1, 1).data;
}

async function main() {
  const W = 320, H = 180;

  // --- Case 1: on-screen canvas + drawImage. Expected to FAIL on the affected
  // machine; if it passes, the probe is not reproducing Bug A and says nothing.
  try {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
    if (!gl) note('onscreen-webgl2', 'UNSUPPORTED');
    else { clearRed(gl); const [v, d] = verdictFor(readVia2D(c, W, H)); note('onscreen-drawImage', v, d); }
  } catch (e) { note('onscreen-drawImage', 'THREW', e); }

  // --- Case 2: on-screen canvas + createImageBitmap. This is exactly what
  // outputBus.ts postFrame() does today.
  try {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
    if (!gl) note('onscreen-createImageBitmap', 'UNSUPPORTED');
    else {
      clearRed(gl);
      const bmp = await createImageBitmap(c);
      const [v, d] = verdictFor(readVia2D(bmp, W, H));
      note('onscreen-createImageBitmap', v, d);
      bmp.close();
    }
  } catch (e) { note('onscreen-createImageBitmap', 'THREW', e); }

  // --- Case 3: the proposed fix. Standalone OffscreenCanvas + webgl2 +
  // transferToImageBitmap(), which never snapshots a canvas.
  try {
    if (typeof OffscreenCanvas === 'undefined') note('offscreen-webgl2', 'UNSUPPORTED', 'no OffscreenCanvas');
    else {
      const oc = new OffscreenCanvas(W, H);
      const gl = oc.getContext('webgl2', { preserveDrawingBuffer: true });
      if (!gl) note('offscreen-webgl2', 'UNSUPPORTED', 'no webgl2 on OffscreenCanvas');
      else {
        clearRed(gl);
        if (typeof oc.transferToImageBitmap !== 'function') {
          note('offscreen-transferToImageBitmap', 'UNSUPPORTED');
        } else {
          const bmp = oc.transferToImageBitmap();
          const [v, d] = verdictFor(readVia2D(bmp, W, H));
          note('offscreen-transferToImageBitmap', v, d);
          bmp.close();
        }
      }
    }
  } catch (e) { note('offscreen-transferToImageBitmap', 'THREW', e); }

  // --- Case 4: fallback route. gl.readPixels straight out of the drawing buffer,
  // then hand the bytes over as ImageData. Slower and CPU-side, but it bypasses
  // every canvas-snapshot path. Worth knowing whether it works, since readPixels
  // was seen failing with INVALID_OPERATION on the default framebuffer here.
  try {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
    if (!gl) note('readPixels', 'UNSUPPORTED');
    else {
      clearRed(gl);
      while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
      const px = new Uint8Array(4);
      gl.readPixels((W / 2) | 0, (H / 2) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const err = gl.getError();
      const [v, d] = verdictFor(px);
      note('readPixels', err ? 'FAIL' : v, err ? `glError=0x${err.toString(16)}` : d);
    }
  } catch (e) { note('readPixels', 'THREW', e); }

  // --- Case 4b: toDataURL on a WebGL canvas. Called out separately because
  // skills/verify-ui/SKILL.md recommends exactly this for reading back "main
  // compositor output" in automated checks — if it fails, that guidance is
  // silently producing blank verifications.
  try {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
    if (!gl) note('webgl-toDataURL', 'UNSUPPORTED');
    else {
      clearRed(gl);
      const url = c.toDataURL('image/png');
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const [v, d] = verdictFor(readVia2D(img, W, H));
      note('webgl-toDataURL', v, d);
    }
  } catch (e) { note('webgl-toDataURL', 'THREW', e); }

  // --- Case 5: control. Same capture calls against a plain 2D canvas. This
  // decides whether capture is broken *in general* on this build or only for
  // WebGL-backed canvases — i.e. whether a 2D compositing fallback is even an
  // option. If these PASS while the WebGL cases FAIL, the defect is specific to
  // getting pixels out of a WebGL drawing buffer.
  try {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = 'rgb(255,0,0)';
    g.fillRect(0, 0, W, H);
    const [v1, d1] = verdictFor(readVia2D(c, W, H));
    note('2d-drawImage', v1, d1);
    const bmp = await createImageBitmap(c);
    const [v2, d2] = verdictFor(readVia2D(bmp, W, H));
    note('2d-createImageBitmap', v2, d2);
    bmp.close();
  } catch (e) { note('2d-capture', 'THREW', e); }

  document.title = 'RESULT ' + RESULTS.join(' | ');
}
main().catch(e => { document.title = 'RESULT fatal=' + e; });
"""

win = Gtk.Window()
view = WebKit2.WebView()
win.add(view)
win.show_all()

# WebGL needs a real compositing path; a terminated web process is itself a result.
view.connect("web-process-terminated",
             lambda v, r: (print("WEB PROCESS TERMINATED:", r.value_nick), Gtk.main_quit()))

done = {"v": False}


def poll():
    t = view.get_title() or ""
    if t.startswith("RESULT"):
        print(t[7:])
        done["v"] = True
        Gtk.main_quit()
        return False
    return True


def timeout():
    if not done["v"]:
        print("TIMEOUT — no result within 15s")
        Gtk.main_quit()
    return False


print(f"WEBKIT_DISABLE_DMABUF_RENDERER={os.environ.get('WEBKIT_DISABLE_DMABUF_RENDERER', '(unset)')}")
GLib.timeout_add(200, poll)
GLib.timeout_add_seconds(15, timeout)
view.load_html("<body><script>" + JS + "</script></body>", "http://localhost/")
Gtk.main()
sys.exit(0 if done["v"] else 1)
