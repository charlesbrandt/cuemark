#!/usr/bin/env python3
"""Why does every gl.readPixels here raise INVALID_OPERATION — and does it still work?

`webgl_readback_matrix_probe.py` found `readPixels` failing with `INVALID_OPERATION`
(0x502) on a **texture-backed, framebuffer-complete, non-multisampled user FBO**
(`SAMPLES=0`). That is not a legal outcome under the WebGL 2 spec, which retires the
"WebKit's multisample resolve is broken" hypothesis and points somewhere lower.

Two possibilities remain, and they have opposite consequences:

  (a) `readPixels` genuinely fails -> no CPU-side route out of a WebGL canvas exists
      on this build; the output window needs a structurally different design.
  (b) `readPixels` **works** and the error flag is spurious -> the pixels are fine
      and cuemark can ship them today. Nothing in the earlier probes distinguished
      these, because both reported the error and discarded the buffer unread.

So this probe reports the returned bytes **regardless of the error flag**, and
separately establishes whether `getError()` is trustworthy at all (does a drained
context immediately re-raise?). It also varies what the earlier probes held fixed:
WebGL 1 vs 2, clear-only vs a real draw, and the implementation's own preferred
read format/type, in case RGBA/UNSIGNED_BYTE is being rejected on this driver.

Usage:
    python3 scripts/probes/webgl_readpixels_diag_probe.py
"""
import gi, os, sys

gi.require_version("WebKit2", "4.1")
gi.require_version("Gtk", "3.0")
from gi.repository import WebKit2, Gtk, GLib  # noqa: E402

JS = r"""
const R = [];
function note(s) { R.push(s); }
function hex(e) { return '0x' + e.toString(16); }
function drain(gl) { let n = 0; while (gl.getError() !== gl.NO_ERROR && n < 32) n++; return n; }
function px4(a) { return `rgba(${a[0]},${a[1]},${a[2]},${a[3]})`; }

function makeFbo(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { fb, tex, status: gl.checkFramebufferStatus(gl.FRAMEBUFFER) };
}

function probe(ver) {
  const W = 64, H = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const gl = c.getContext(ver, { preserveDrawingBuffer: true, antialias: false });
  if (!gl) { note(`${ver}: UNSUPPORTED`); return; }

  note(`${ver}: lost=${gl.isContextLost()} ver="${gl.getParameter(gl.VERSION)}" ` +
       `vendor="${gl.getParameter(gl.VENDOR)}" renderer="${gl.getParameter(gl.RENDERER)}"`);

  // Is getError() itself sane? A freshly drained context must report NO_ERROR.
  const drained = drain(gl);
  note(`${ver}: drain took ${drained} calls; immediately after drain getError=${hex(gl.getError())}`);

  // --- default framebuffer, clear only
  gl.viewport(0, 0, W, H);
  gl.clearColor(1, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.finish();
  note(`${ver}: after clear on default FB getError=${hex(gl.getError())}`);
  drain(gl);
  {
    const a = new Uint8Array(4);
    gl.readPixels(W >> 1, H >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a);
    // Report the BYTES as well as the error — this is the datum every previous probe dropped.
    note(`${ver}: readPixels(defaultFB) err=${hex(gl.getError())} bytes=${px4(a)}`);
  }

  // --- user FBO: status, preferred read format, clear, draw, readback
  drain(gl);
  const { fb, status } = makeFbo(gl, W, H);
  note(`${ver}: userFBO status=${hex(status)} complete=${status === gl.FRAMEBUFFER_COMPLETE} ` +
       `createErr=${hex(gl.getError())}`);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  drain(gl);
  const cf = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT);
  const ct = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
  note(`${ver}: userFBO IMPLEMENTATION_COLOR_READ_FORMAT=${hex(cf)} TYPE=${hex(ct)} ` +
       `(RGBA=${hex(gl.RGBA)} UNSIGNED_BYTE=${hex(gl.UNSIGNED_BYTE)}) queryErr=${hex(gl.getError())}`);

  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 1, 0, 1);   // green, distinguishable from the default FB's red
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.finish();
  note(`${ver}: after clear on userFBO getError=${hex(gl.getError())}`);
  drain(gl);
  {
    const a = new Uint8Array(4);
    gl.readPixels(W >> 1, H >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a);
    note(`${ver}: readPixels(userFBO,RGBA/UBYTE) err=${hex(gl.getError())} bytes=${px4(a)}`);
  }
  // Retry with whatever the implementation says it prefers, in case RGBA/UBYTE is refused.
  drain(gl);
  {
    const a = new Uint8Array(4);
    try {
      gl.readPixels(W >> 1, H >> 1, 1, 1, cf, ct, a);
      note(`${ver}: readPixels(userFBO,impl-preferred) err=${hex(gl.getError())} bytes=${px4(a)}`);
    } catch (e) { note(`${ver}: readPixels(userFBO,impl-preferred) THREW ${e}`); }
  }
  // A full-surface read, in case a 1x1 rect is the thing being rejected.
  drain(gl);
  {
    const a = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, a);
    const off = ((H >> 1) * W + (W >> 1)) * 4;
    let nonzero = 0;
    for (let i = 3; i < a.length; i += 4) if (a[i] !== 0) nonzero++;
    note(`${ver}: readPixels(userFBO,full ${W}x${H}) err=${hex(gl.getError())} ` +
         `centre=${px4(a.slice(off, off + 4))} nonzeroAlphaPx=${nonzero}/${W * H}`);
  }

  // Does the FBO's texture at least carry the right content *inside* GL? Sample it
  // back onto the default framebuffer with a trivial shader. If this shows green,
  // rendering and FBOs work fine and only host-side readback is broken.
  drain(gl);
  try {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, ver === 'webgl2'
      ? '#version 300 es\nconst vec2 p[3]=vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));\nout vec2 uv;\nvoid main(){uv=p[gl_VertexID]*.5+.5;gl_Position=vec4(p[gl_VertexID],0.,1.);}'
      : 'attribute vec2 a;varying vec2 uv;void main(){uv=a*.5+.5;gl_Position=vec4(a,0.,1.);}');
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, ver === 'webgl2'
      ? '#version 300 es\nprecision highp float;in vec2 uv;uniform sampler2D t;out vec4 o;void main(){o=texture(t,uv);}'
      : 'precision highp float;varying vec2 uv;uniform sampler2D t;void main(){gl_FragColor=texture2D(t,uv);}');
    gl.compileShader(fs);
    const pr = gl.createProgram();
    gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) {
      note(`${ver}: blit link failed: ${gl.getProgramInfoLog(pr)} | vs=${gl.getShaderInfoLog(vs)} | fs=${gl.getShaderInfoLog(fs)}`);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 1, 1);           // blue, so an unblitted surface is obvious
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(pr);
      if (ver !== 'webgl2') {
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(pr, 'a');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.finish();
      const drawErr = gl.getError();
      drain(gl);
      const a = new Uint8Array(4);
      gl.readPixels(W >> 1, H >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a);
      note(`${ver}: blit FBO->defaultFB drawErr=${hex(drawErr)} then readPixels ` +
           `err=${hex(gl.getError())} bytes=${px4(a)} (green => FBO content is real)`);
    }
  } catch (e) { note(`${ver}: blit THREW ${e}`); }
}

try { probe('webgl2'); } catch (e) { note('webgl2 THREW ' + e); }
try { probe('webgl'); } catch (e) { note('webgl THREW ' + e); }
document.title = 'RESULT ' + R.join(' ;; ');
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
        for line in t[7:].split(" ;; "):
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


print(f"WEBKIT_DISABLE_DMABUF_RENDERER={os.environ.get('WEBKIT_DISABLE_DMABUF_RENDERER', '(unset)')}")
GLib.timeout_add(200, poll)
GLib.timeout_add_seconds(20, timeout)
view.load_html("<body><script>" + JS + "</script></body>", "http://localhost/")
Gtk.main()
sys.exit(0 if done["v"] else 1)
