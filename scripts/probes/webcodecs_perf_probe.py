#!/usr/bin/env python3
"""WebCodecs perf + WebGL-upload probe at a given resolution (default 1080p).

- Host encodes N frames at WxH (x264, annex-B AUs).
- Page decodes all, measures throughput.
- Uploads the last VideoFrame into a WebGL texture via texImage2D (the path
  that SIGTRAPs for <video> elements in WebKitGTK) and readPixels-verifies it.
- Also times drawImage(VideoFrame) -> scratch canvas as the fallback path.

Env: PROBE_W, PROBE_H, PROBE_N.
"""
import gi, json, base64, os
gi.require_version('Gst', '1.0')
gi.require_version('WebKit2', '4.1')
gi.require_version('Gtk', '3.0')
from gi.repository import Gst, WebKit2, Gtk, GLib

W = int(os.environ.get("PROBE_W", 1920))
H = int(os.environ.get("PROBE_H", 1080))
N = int(os.environ.get("PROBE_N", 90))

Gst.init(None)
pipe = Gst.parse_launch(
    f"videotestsrc pattern=smpte num-buffers={N} "
    f"! video/x-raw,width={W},height={H},framerate=30/1,format=I420 "
    "! x264enc key-int-max=30 tune=zerolatency bitrate=8000 "
    "! video/x-h264,stream-format=byte-stream,alignment=au,profile=constrained-baseline "
    "! appsink name=sink sync=false")
sink = pipe.get_by_name("sink")
pipe.set_state(Gst.State.PLAYING)
chunks = []
while True:
    sample = sink.emit("pull-sample")
    if sample is None:
        break
    buf = sample.get_buffer()
    ok, mi = buf.map(Gst.MapFlags.READ)
    data = bytes(mi.data)
    buf.unmap(mi)
    key = not buf.has_flags(Gst.BufferFlags.DELTA_UNIT)
    pts = buf.pts // 1000 if buf.pts != Gst.CLOCK_TIME_NONE else len(chunks) * 33333
    chunks.append({"key": key, "ts": int(pts), "b64": base64.b64encode(data).decode()})
pipe.set_state(Gst.State.NULL)
print(f"host-encoded {W}x{H}: {len(chunks)} AUs, "
      f"{sum(len(c['b64']) for c in chunks)*3//4//1024} KiB total")

PAGE = r"""
<!doctype html><html><head><meta charset="utf-8"></head><body><script>
const CHUNKS = """ + json.dumps(chunks) + f"""; const W = {W}, H = {H};""" + r"""
const out = {};
function done() { document.title = "RESULT:" + JSON.stringify(out); }
function b64ToBuf(s) {
  const bin = atob(s); const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
async function run() {
  const frames = [];
  const dec = new VideoDecoder({ output: f => frames.push(f),
                                 error: e => (out.decErr = String(e)) });
  dec.configure({ codec: "avc1.42c028" });
  const t0 = performance.now();
  for (const c of CHUNKS)
    dec.decode(new EncodedVideoChunk({ type: c.key ? "key" : "delta",
                                       timestamp: c.ts, data: b64ToBuf(c.b64) }));
  await dec.flush();
  const t1 = performance.now();
  out.decoded = frames.length;
  out.decodeMsPerFrame = +((t1 - t0) / frames.length).toFixed(2);
  out.decodeFps = Math.round(1000 * frames.length / (t1 - t0));

  const last = frames[frames.length - 1];

  // Path A: texImage2D(VideoFrame) directly into WebGL (crashes for <video> — does VideoFrame work?)
  try {
    const glc = document.createElement('canvas'); glc.width = W; glc.height = H; document.body.appendChild(glc);
    const gl = glc.getContext('webgl2') || glc.getContext('webgl');
    if (!gl) { out.webgl = "no-context"; }
    else {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      const g0 = performance.now();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, last);
      const g1 = performance.now();
      // steady-state: upload 30 distinct frames
      const many = frames.slice(-31, -1);
      const s0 = performance.now();
      for (const f of many)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f);
      const steadyMs = (performance.now() - s0) / many.length;
      out.webglSteadyMsPerFrame = +steadyMs.toFixed(2);
      // readback via FBO to prove the texture has real content
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const px = new Uint8Array(4);
      gl.readPixels(Math.floor(W/8), Math.floor(H/2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      out.webgl = { uploadMs: +(g1 - g0).toFixed(2), pixel: [px[0], px[1], px[2]],
                    nonBlack: px[0] + px[1] + px[2] > 30 };
    }
  } catch (e) { out.webgl = "throw:" + String(e); }

  // Path B (fallback): drawImage(VideoFrame) -> 2d canvas, timed over 30 reps
  try {
    const c2 = new OffscreenCanvas(W, H);
    const ctx = c2.getContext('2d');
    const d0 = performance.now();
    for (let i = 0; i < 30; i++) ctx.drawImage(last, 0, 0);
    out.drawImageMsPerFrame = +((performance.now() - d0) / 30).toFixed(2);
  } catch (e) { out.drawImage = "throw:" + String(e); }

  for (const f of frames) f.close();
  done();
}
run().catch(e => { out.fatal = String(e && e.stack || e); done(); });
</script></body></html>
"""

win = Gtk.Window(); view = WebKit2.WebView(); win.add(view); win.show_all()
loop = GLib.MainLoop(); result = {}
def poll():
    t = view.get_title() or ""
    if t.startswith("RESULT:"):
        result["json"] = t[7:]; loop.quit(); return False
    return True
GLib.timeout_add(200, poll)
GLib.timeout_add_seconds(60, lambda: (loop.quit(), False)[1])
view.load_html(PAGE, "http://localhost/")
loop.run(); win.destroy()
print(json.dumps(json.loads(result["json"]), indent=2) if "json" in result else "TIMEOUT (web process likely crashed)")
