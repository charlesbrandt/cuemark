#!/usr/bin/env python3
"""End-to-end check of the output window's compositor, against the real output.html.

Since 2026-08-03 the output window composites for itself from per-deck `ImageBitmap`s
instead of receiving a composited snapshot (see `src/lib/renderer/outputProtocol.ts`).
This probe drives that path for real: it loads the **actual** `/output.html` from the
Vite dev server into one WebView, posts a synthetic frame message from a second
same-origin WebView, and then reads the composited result back out of the output
window's own WebGL canvas.

It answers the two questions a type-check cannot:

  1. **Does the receiver boot and composite at all?** Module loading, `Compositor`
     construction, `syncDecks`, `uploadImageBitmap` and `composite` all run in the real
     page, so an exception anywhere in that chain shows up as a missing/blank result.
  2. **Is the image the right way up?** This is the highest-risk part of the change.
     `UNPACK_FLIP_Y_WEBGL` is silently ignored for ImageBitmap sources on this build
     (`imagebitmap_upload_probe.py`), so orientation is instead set by the sender via
     `createImageBitmap(..., {imageOrientation:'flipY'})`. Getting it wrong renders the
     projector upside down — which has already happened once on this project, see
     `DeckFBO.uploadVideoFrameFromCodec`'s doc comment.

The synthetic frame is **red on top, blue on bottom**, so orientation is unambiguous.
`readPixels` row y=0 is the drawing buffer's *bottom*, so a correctly-oriented composite
reads BLUE there and an upside-down one reads RED.

⚠️ **Must be run with `LIBGL_ALWAYS_SOFTWARE=1`.** Reading pixels back out of a WebGL
canvas is broken on this machine's GPU (`docs/upstream/webgl-canvas-readback-broken.md`)
— which is the entire reason this architecture exists. On hardware every verdict here
would read `zeroed` regardless of correctness. Orientation and compositing semantics are
WebKit-level, not driver-level, so the software arm is authoritative for both.

Requires the Vite dev server (`npm run dev` or `cargo tauri dev`) on port 1420.

Usage:
    LIBGL_ALWAYS_SOFTWARE=1 python3 scripts/probes/output_window_compositor_probe.py
"""
import gi, os, sys

gi.require_version("WebKit2", "4.1")
gi.require_version("Gtk", "3.0")
from gi.repository import WebKit2, Gtk, GLib  # noqa: E402

ORIGIN = "http://localhost:1420"

# Sender page: same origin as output.html so the BroadcastChannel connects. Posts the
# synthetic frame repeatedly, so it does not matter whether the receiver finished loading
# first; it also answers the receiver's 'hello' by construction.
#
# It drives the **real** `outputBus.ts` postFrame() — imported from the dev server, which
# is why this page needs the ORIGIN base URI — rather than hand-rolling a bitmap. An
# earlier version built its own `createImageBitmap(canvas, {imageOrientation:'flipY'})`,
# which passed while the shipping app rendered upside down: the real sender was handing
# createImageBitmap a *VideoFrame*, for which that option is silently ignored. A probe that
# reimplements the code under test can only confirm its own assumptions.
#
# The deck source is therefore `kind:'codec'` — the default WebCodecs path, and the one
# that regressed.
SENDER_HTML = """
<body><script type="module">
import { postFrame } from '/src/lib/renderer/outputBus.ts';
const W = 320, H = 180;
const c = document.createElement('canvas');
c.width = W; c.height = H;
const g = c.getContext('2d');
g.fillStyle = 'rgb(255,0,0)'; g.fillRect(0, 0, W, H / 2);       // top half red
g.fillStyle = 'rgb(0,0,255)'; g.fillRect(0, H / 2, W, H / 2);   // bottom half blue

let sent = 0;
function tick() {
  const frame = new VideoFrame(c, { timestamp: sent * 1000 });
  // postFrame() consumes the source synchronously (drawImage into its scratch canvas),
  // so the frame can be released as soon as it returns.
  postFrame({
    decks: [{ id: 'deck-0', opacity: 1, source: { kind: 'codec', frame } }],
    vizSrc: null,
    vizOpacity: 0,
    vizUniforms: {},
    time: 0,
    analysis: { bass: 0, mid: 0, high: 0 },
  });
  frame.close();
  document.title = 'SENT ' + (++sent);
}
setInterval(() => { try { tick(); } catch (e) { document.title = 'SENDERR ' + e; } }, 250);
tick();
</script></body>
"""

# Evaluated inside the real output.html once frames have had time to arrive. Reads the
# composited result straight out of its WebGL canvas.
READBACK_JS = r"""
(function () {
  try {
    const c = document.getElementById('output');
    if (!c) return 'RESULT no-canvas';
    // Returns the page's existing context, with its preserveDrawingBuffer:true attribute.
    const gl = c.getContext('webgl2');
    if (!gl) return 'RESULT no-context';
    while (gl.getError() !== gl.NO_ERROR) {}
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const bottom = new Uint8Array(4), top = new Uint8Array(4);
    gl.readPixels((w / 2) | 0, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bottom);
    gl.readPixels((w / 2) | 0, h - 3, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, top);
    const err = gl.getError();
    const name = (p) => {
      if (p[3] === 0 && p[0] === 0 && p[1] === 0 && p[2] === 0) return 'zeroed';
      if (p[0] > 200 && p[2] < 60) return 'RED';
      if (p[2] > 200 && p[0] < 60) return 'BLUE';
      if (p[0] < 40 && p[1] < 40 && p[2] < 40) return 'BLACK';
      return `rgba(${p[0]},${p[1]},${p[2]},${p[3]})`;
    };
    const nosig = document.getElementById('nosignal');
    const waiting = nosig && getComputedStyle(nosig).display !== 'none';
    return `RESULT buffer=${w}x${h} screenBottom=${name(bottom)} screenTop=${name(top)}` +
           ` glErr=0x${err.toString(16)} stillWaitingForFrames=${waiting}`;
  } catch (e) { return 'RESULT threw ' + e; }
})()
"""

win = Gtk.Window()
box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
win.add(box)

# One WebKitWebContext for both views keeps them same-origin *and* lets the
# BroadcastChannel connect, exactly as the two real app windows do.
receiver = WebKit2.WebView()
sender = WebKit2.WebView.new_with_related_view(receiver)
for v in (receiver, sender):
    v.set_size_request(320, 180)
    box.pack_start(v, True, True, 0)
win.show_all()

state = {"done": False, "failed": None}

for v, tag in ((receiver, "receiver"), (sender, "sender")):
    v.connect(
        "web-process-terminated",
        lambda _v, r, tag=tag: (
            print(f"WEB PROCESS TERMINATED ({tag}): {r.value_nick}"),
            state.update(failed=f"{tag} process died"),
            Gtk.main_quit(),
        ),
    )

receiver.load_uri(f"{ORIGIN}/output.html")
sender.load_html(SENDER_HTML, f"{ORIGIN}/probe-sender.html")


def on_readback(view, result, _data):
    try:
        js = view.evaluate_javascript_finish(result)
        print(js.to_string().replace("RESULT ", ""))
        state["done"] = True
    except Exception as e:  # noqa: BLE001
        print(f"readback failed: {e}")
    Gtk.main_quit()


def do_readback():
    print(f"sender title: {sender.get_title()}")
    receiver.evaluate_javascript(READBACK_JS, -1, None, None, None, on_readback, None)
    return False


def timeout():
    if not state["done"]:
        print("TIMEOUT — no result")
        Gtk.main_quit()
    return False


sw = os.environ.get("LIBGL_ALWAYS_SOFTWARE")
print(f"LIBGL_ALWAYS_SOFTWARE={sw or '(unset)'}")
if not sw:
    print("WARNING: without LIBGL_ALWAYS_SOFTWARE=1 every pixel verdict below reads "
          "'zeroed' — readPixels is broken on this GPU. See the module docstring.")

# Give the dev server, module graph, GL context and a few frame messages time to settle.
GLib.timeout_add_seconds(6, do_readback)
GLib.timeout_add_seconds(20, timeout)
Gtk.main()
sys.exit(0 if state["done"] else 1)
