#!/usr/bin/env python3
"""Can per-deck frames be shipped as ImageBitmaps and uploaded to a WebGL texture?

Prerequisite probe for the output-window compositor (Bug A option 2 in
docs/design/output-noise-and-track-reload-silence.md). That design ships *decoded
frames* to the output window instead of a composited snapshot, precisely because
snapshotting WebGL is broken here (docs/upstream/webgl-canvas-readback-broken.md).
Two assumptions carry it, and neither was tested:

  1. **`createImageBitmap(VideoFrame)` returns real pixels.** WebCodecs frames are
     decoded in software into system memory, so they should never touch the broken
     GPU->CPU path — but "should" is what this project keeps getting wrong. If this
     works, the sender skips a scratch-canvas copy per deck per frame.
  2. **Y-flip semantics for an ImageBitmap upload.** `fbo.ts` uploads canvas and
     VideoFrame sources with `UNPACK_FLIP_Y_WEBGL=true` (canvas rows are top-down,
     GL texture rows are bottom-up). Whether that pixel-store flag applies to an
     ImageBitmap source, or whether the flip must instead be requested at
     `createImageBitmap(..., {imageOrientation:'flipY'})` time, decides which of the
     two the new upload path uses. Getting it wrong renders the output upside down —
     which has already happened once on this project (see `uploadVideoFrameFromCodec`'s
     doc comment, where a flip verified under llvmpipe was wrong on real hardware).

The source is a canvas whose **top half is red and bottom half is blue**, so the
orientation of the result is unambiguous. Each case uploads into a texture-backed
FBO and reads row y=0, which is the texture's *bottom* row:

    flip applied     -> y=0 reads BLUE  (canvas top row landed at the texture top)
    no flip applied  -> y=0 reads RED

Usage:
    LIBGL_ALWAYS_SOFTWARE=1 python3 scripts/probes/imagebitmap_upload_probe.py
    python3 scripts/probes/imagebitmap_upload_probe.py    # hardware: throws/errors only

⚠️ **Run the software arm for the pixel answers.** `readPixels` returns a zeroed
buffer on this machine's GPU, so the hardware arm can only report whether calls
*throw* or raise GL errors — every pixel verdict there will read as `zeroed`. The
flip semantics being probed are WebKit-level, not driver-level, so the software
arm is the authoritative one. (This is the reverse of the usual rule on this
project — normally llvmpipe results are the suspect ones.)
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

const W = 64, H = 64;

// Source: top half red, bottom half blue, in canvas (top-down) coordinates.
const src = document.createElement('canvas');
src.width = W; src.height = H;
{
  const g = src.getContext('2d');
  g.fillStyle = 'rgb(255,0,0)'; g.fillRect(0, 0, W, H / 2);
  g.fillStyle = 'rgb(0,0,255)'; g.fillRect(0, H / 2, W, H / 2);
}

const glc = document.createElement('canvas');
glc.width = W; glc.height = H;
const gl = glc.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
if (!gl) { document.title = 'RESULT no-webgl2'; throw new Error('no webgl2'); }

function makeFbo() {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { fb, tex };
}

// Upload `source` into a fresh FBO texture, then read the texture's bottom row.
function uploadAndRead(source, flipY) {
  const { fb, tex } = makeFbo();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  drain(gl);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
  let uploadErr = 0, threw = null;
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    uploadErr = gl.getError();
  } catch (e) { threw = String(e); }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  if (threw) return { threw };
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  drain(gl);
  const a = new Uint8Array(4);
  gl.readPixels(W >> 1, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a);   // y=0 == texture bottom row
  const readErr = gl.getError();
  return { uploadErr, readErr, px: a };
}

function colourOf(px) {
  if (px[3] === 0 && px[0] === 0 && px[1] === 0 && px[2] === 0) return 'zeroed';
  if (px[0] > 200 && px[2] < 60) return 'RED';
  if (px[2] > 200 && px[0] < 60) return 'BLUE';
  return `rgba(${px[0]},${px[1]},${px[2]},${px[3]})`;
}
function report(name, r, expect) {
  if (r.threw) { note(name, 'THREW', r.threw); return; }
  const c = colourOf(r.px);
  const errs = (r.uploadErr ? `uploadErr=${hex(r.uploadErr)} ` : '') +
               (r.readErr ? `readErr=${hex(r.readErr)} ` : '');
  const ok = c === expect;
  note(name, r.uploadErr ? 'GLERR' : (c === 'zeroed' ? 'UNREADABLE' : (ok ? 'PASS' : 'FAIL')),
       `${errs}bottomRow=${c} expected=${expect}`);
}

async function main() {
  // --- Baseline: the canvas upload path fbo.ts already uses. Anchors the expectations.
  report('canvas/flipY=true', uploadAndRead(src, true), 'BLUE');
  report('canvas/flipY=false', uploadAndRead(src, false), 'RED');

  // --- ImageBitmap from a canvas, with the pixel-store flag (what fbo.ts would do
  //     if an ImageBitmap were just another canvas-like source).
  try {
    const bmp = await createImageBitmap(src);
    report('bitmap/flipY=true', uploadAndRead(bmp, true), 'BLUE');
    const bmp2 = await createImageBitmap(src);
    report('bitmap/flipY=false', uploadAndRead(bmp2, false), 'RED');
    bmp.close(); bmp2.close();
  } catch (e) { note('bitmap-basic', 'THREW', e); }

  // --- ImageBitmap asked to flip at construction time, uploaded WITHOUT the flag.
  //     If this passes it is the preferable route: orientation is decided once, on
  //     the sender, and the upload path needs no pixel-store state at all.
  try {
    const bmp = await createImageBitmap(src, { imageOrientation: 'flipY' });
    report('bitmap/imageOrientation=flipY', uploadAndRead(bmp, false), 'BLUE');
    bmp.close();
  } catch (e) { note('bitmap/imageOrientation=flipY', 'THREW', e); }

  // --- VideoFrame -> ImageBitmap. Assumption 1.
  try {
    if (typeof VideoFrame === 'undefined') { note('videoframe', 'UNSUPPORTED'); }
    else {
      const vf = new VideoFrame(src, { timestamp: 0 });
      note('videoframe/ctor', 'OK', `${vf.displayWidth}x${vf.displayHeight} fmt=${vf.format}`);
      // Does the frame itself carry real pixels through a 2D canvas? (Known-good route,
      // and what DeckCard's preview does today.)
      const c2 = document.createElement('canvas');
      c2.width = W; c2.height = H;
      const g2 = c2.getContext('2d', { willReadFrequently: true });
      g2.drawImage(vf, 0, 0);
      const top = g2.getImageData(W >> 1, 2, 1, 1).data;
      note('videoframe/drawImage-2d', colourOf(top) === 'RED' ? 'PASS' : 'FAIL',
           `topRow=${colourOf(top)} expected=RED`);
      // The assumption under test: straight to an ImageBitmap, no canvas detour.
      const bmp = await createImageBitmap(vf);
      const c3 = document.createElement('canvas');
      c3.width = W; c3.height = H;
      const g3 = c3.getContext('2d', { willReadFrequently: true });
      g3.drawImage(bmp, 0, 0);
      const t2 = g3.getImageData(W >> 1, 2, 1, 1).data;
      note('videoframe/createImageBitmap', colourOf(t2) === 'RED' ? 'PASS' : 'FAIL',
           `topRow=${colourOf(t2)} expected=RED`);
      report('videoframe/bitmap-upload flipY=true', uploadAndRead(bmp, true), 'BLUE');
      bmp.close();
      vf.close();
    }
  } catch (e) { note('videoframe', 'THREW', e); }

  // --- Does `imageOrientation:'flipY'` actually apply, per source type? Read back
  //     through a 2D canvas rather than WebGL, so this section is authoritative on
  //     HARDWARE too (2D capture works here; readPixels does not). Top row of the
  //     result: BLUE means the flip was applied, RED means it was ignored.
  async function orient(name, src2, opts, expect) {
    try {
      const bmp = await createImageBitmap(src2, opts);
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      const top = colourOf(g.getImageData(W >> 1, 2, 1, 1).data);
      bmp.close();
      note(name, top === expect ? 'PASS' : 'FAIL', `topRow=${top} expected=${expect}`);
    } catch (e) { note(name, 'THREW', e); }
  }
  await orient('orient/canvas-none', src, undefined, 'RED');
  await orient('orient/canvas-flipY', src, { imageOrientation: 'flipY' }, 'BLUE');
  if (typeof VideoFrame !== 'undefined') {
    const vf1 = new VideoFrame(src, { timestamp: 0 });
    await orient('orient/videoframe-none', vf1, undefined, 'RED');
    vf1.close();
    const vf2 = new VideoFrame(src, { timestamp: 0 });
    await orient('orient/videoframe-flipY', vf2, { imageOrientation: 'flipY' }, 'BLUE');
    vf2.close();
  }

  document.title = 'RESULT ' + R.join(' | ');
}
main().catch(e => { document.title = 'RESULT fatal=' + e; });
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
