#!/usr/bin/env python3
"""Is there ANY hardware-accelerated readback route that survives this GPU driver?

`webgl_readpixels_diag_probe.py` established the root condition: every WebGL
readback route fails with `INVALID_OPERATION` and a zeroed buffer on the hardware
GL stack, but **all of them pass under `LIBGL_ALWAYS_SOFTWARE=1`**. This is a Mesa
`crocus` (Intel HD 4000 / Ivy Bridge, gen7) defect surfaced through ANGLE, not a
WebKit defect. Software rendering "fixes" it but forfeits GPU compositing, which
was measured at ~26 points of main-thread CPU (see Bug E in
docs/design/output-noise-and-track-reload-silence.md) — not an acceptable trade.

So: does some *variant* of readback avoid whatever ANGLE validation or driver path
is rejecting the ordinary one? Each of these is a materially different code path:

  - attachment type/format: unsized RGBA texture (what fbo.ts uses today) vs sized
    RGBA8 texture vs an RGBA8 **renderbuffer**. ANGLE validates readability from the
    read buffer's format, and these three take different routes to it.
  - an explicit `readBuffer(COLOR_ATTACHMENT0)` before the read, in case the read
    buffer state is what is wrong rather than the format.
  - **PBO readback**: `readPixels` into a bound `PIXEL_PACK_BUFFER` (offset overload)
    followed by `getBufferSubData`. This is WebGL 2's asynchronous readback path and
    is implemented completely separately from the ArrayBufferView path — the most
    promising candidate, and if it works it is also *faster* than what we wanted
    originally, since it does not stall the GPU.
  - `copyTexSubImage2D` into a texture first, then read that, in case the default
    framebuffer specifically is unreadable.

Every case paints a known colour and reports the bytes it got back, so a PASS is
unambiguous. Run it on hardware; the software arm is the control.

Usage:
    python3 scripts/probes/webgl_readback_variants_probe.py
    LIBGL_ALWAYS_SOFTWARE=1 python3 scripts/probes/webgl_readback_variants_probe.py

A PASS on any row means outputBus.ts can be rewritten around that route and the
output window keeps full WebGL compositing (shaders and the visualization layer
included). All FAIL means the readback family is closed on this GPU and the choice
is between the options in the design doc.
"""
import gi, os, sys

gi.require_version("WebKit2", "4.1")
gi.require_version("Gtk", "3.0")
from gi.repository import WebKit2, Gtk, GLib  # noqa: E402

JS = r"""
const R = [];
function note(n, v, d) { R.push(`${n}=${v}${d ? '(' + d + ')' : ''}`); }
function hex(e) { return '0x' + e.toString(16); }
function drain(gl) { let n = 0; while (gl.getError() !== gl.NO_ERROR && n < 32) n++; }
function verdict(a, want) {
  if (a[3] === 0 && a[0] === 0 && a[1] === 0 && a[2] === 0) return ['FAIL', 'zeroed'];
  const ok = Math.abs(a[0] - want[0]) < 8 && Math.abs(a[1] - want[1]) < 8 &&
             Math.abs(a[2] - want[2]) < 8 && a[3] > 200;
  return [ok ? 'PASS' : 'ODD', `rgba(${a[0]},${a[1]},${a[2]},${a[3]})`];
}

const W = 64, H = 64;
const c = document.createElement('canvas');
c.width = W; c.height = H;
const gl = c.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
if (!gl) { document.title = 'RESULT no-webgl2'; throw new Error('no webgl2'); }

// Build an FBO whose colour attachment is of the requested kind.
function makeFbo(kind) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  if (kind === 'rbo-rgba8') {
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, H);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
  } else {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (kind === 'tex-rgba8') {
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  }
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  return { fb, status };
}

function paint(r, g_, b) {
  gl.viewport(0, 0, W, H);
  gl.clearColor(r / 255, g_ / 255, b / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.finish();
}

// --- 1-3: plain readPixels off each attachment kind
for (const kind of ['tex-rgba', 'tex-rgba8', 'rbo-rgba8']) {
  try {
    drain(gl);
    const { fb, status } = makeFbo(kind);
    if (status !== gl.FRAMEBUFFER_COMPLETE) { note(kind, 'FAIL', `fbStatus=${hex(status)}`); continue; }
    paint(0, 255, 0);
    drain(gl);
    const a = new Uint8Array(4);
    gl.readPixels(W >> 1, H >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a);
    const err = gl.getError();
    const [v, d] = verdict(a, [0, 255, 0]);
    note(kind, err ? 'FAIL' : v, err ? `glErr=${hex(err)} bytes=rgba(${a})` : d);
  } catch (e) { note(kind, 'THREW', e); }
}

// --- 4: explicit readBuffer() before the read
try {
  drain(gl);
  const { fb, status } = makeFbo('tex-rgba8');
  if (status !== gl.FRAMEBUFFER_COMPLETE) { note('explicit-readBuffer', 'FAIL', `fbStatus=${hex(status)}`); }
  else {
    paint(0, 255, 0);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    drain(gl);
    const a = new Uint8Array(4);
    gl.readPixels(W >> 1, H >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a);
    const err = gl.getError();
    const [v, d] = verdict(a, [0, 255, 0]);
    note('explicit-readBuffer', err ? 'FAIL' : v, err ? `glErr=${hex(err)}` : d);
  }
} catch (e) { note('explicit-readBuffer', 'THREW', e); }

// --- 5: PBO readback (readPixels -> PIXEL_PACK_BUFFER -> getBufferSubData).
//        Separate ANGLE code path, and asynchronous, so a PASS here is the best case.
try {
  drain(gl);
  const { fb, status } = makeFbo('tex-rgba8');
  if (status !== gl.FRAMEBUFFER_COMPLETE) { note('pbo-getBufferSubData', 'FAIL', `fbStatus=${hex(status)}`); }
  else {
    paint(0, 255, 0);
    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, W * H * 4, gl.STREAM_READ);
    drain(gl);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, 0);   // offset overload
    const rpErr = gl.getError();
    gl.finish();
    const out = new Uint8Array(W * H * 4);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
    const gErr = gl.getError();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const off = ((H >> 1) * W + (W >> 1)) * 4;
    const [v, d] = verdict(out.slice(off, off + 4), [0, 255, 0]);
    note('pbo-getBufferSubData', (rpErr || gErr) ? 'FAIL' : v,
         (rpErr || gErr) ? `readErr=${hex(rpErr)} getErr=${hex(gErr)}` : d);
  }
} catch (e) { note('pbo-getBufferSubData', 'THREW', e); }

// --- 6: copyTexSubImage2D off the DEFAULT framebuffer into a texture, then read
//        that texture through an FBO. Tests whether the default FB is specifically
//        the unreadable thing while attachments are fine.
try {
  drain(gl);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  paint(255, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
  gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, W, H);
  const copyErr = gl.getError();
  const fb2 = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb2);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  drain(gl);
  const a = new Uint8Array(4);
  gl.readPixels(W >> 1, H >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a);
  const err = gl.getError();
  const [v, d] = verdict(a, [255, 0, 0]);
  note('copyTexSubImage-then-read', (copyErr || err) ? 'FAIL' : v,
       (copyErr || err) ? `copyErr=${hex(copyErr)} readErr=${hex(err)}` : d);
} catch (e) { note('copyTexSubImage-then-read', 'THREW', e); }

// --- 7: control — is the whole context otherwise healthy? Draw and display work
//        everywhere; this just records it alongside the failures.
note('ctx', 'OK', `samples=${gl.getParameter(gl.SAMPLES)} lost=${gl.isContextLost()}`);

document.title = 'RESULT ' + R.join(' | ');
"""

win = Gtk.Window()
view = WebKit2.WebView()
win.add(view)
win.show_all()

view.connect("web-process-terminated",
             lambda v, r: (print("WEB PROCESS TERMINATED:", r.value_nick), Gtk.main_quit()))

done = {"v": False}


def poll():
    t = view.get_title() or ""
    if t.startswith("RESULT"):
        for line in t[7:].split(" | "):
            print(line.strip())
        done["v"] = True
        Gtk.main_quit()
        return False
    return True


def timeout():
    if not done["v"]:
        print("TIMEOUT — no result within 20s")
        Gtk.main_quit()
    return False


print(f"LIBGL_ALWAYS_SOFTWARE={os.environ.get('LIBGL_ALWAYS_SOFTWARE', '(unset)')}")
GLib.timeout_add(200, poll)
GLib.timeout_add_seconds(20, timeout)
view.load_html("<body><script>" + JS + "</script></body>", "http://localhost/")
Gtk.main()
sys.exit(0 if done["v"] else 1)
