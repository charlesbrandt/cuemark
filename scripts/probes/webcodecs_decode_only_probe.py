#!/usr/bin/env python3
"""Decode-ONLY WebCodecs probe (VideoEncoder crashes WebKitGTK 2.52.3 — avoid it).

Host side: GStreamer x264enc produces 60 annex-B access units (solid red frames).
Page side: VideoDecoder (annexb config, no description) decodes them; we count
frames, check pixels, time the decode, and test the flush()+keyframe reseek
pattern a scrub/seek would use.
"""
import gi, json, base64
gi.require_version('Gst', '1.0')
gi.require_version('WebKit2', '4.1')
gi.require_version('Gtk', '3.0')
from gi.repository import Gst, WebKit2, Gtk, GLib

Gst.init(None)

# ---- Encode 60 red frames to annex-B AUs on the host ----
pipe = Gst.parse_launch(
    "videotestsrc pattern=solid-color foreground-color=0xFFFF0000 num-buffers=60 "
    "! video/x-raw,width=320,height=240,framerate=30/1,format=I420 "
    "! x264enc key-int-max=30 tune=zerolatency "
    "! video/x-h264,stream-format=byte-stream,alignment=au,profile=constrained-baseline "
    "! appsink name=sink sync=false")
sink = pipe.get_by_name("sink")
sink.set_property("emit-signals", False)
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
print(f"host-encoded AUs: {len(chunks)} ({sum(1 for c in chunks if c['key'])} keyframes)")

PAGE_HEAD = r"""
<!doctype html><html><head><meta charset="utf-8"></head><body><script>
const CHUNKS = """ + json.dumps(chunks) + r""";
const out = {};
function done() { document.title = "RESULT:" + JSON.stringify(out); }
function b64ToBuf(s) {
  const bin = atob(s); const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
async function run() {
  const frames = [];
  const errs = [];
  const dec = new VideoDecoder({
    output: (f) => frames.push(f),
    error: (e) => errs.push(String(e)),
  });
  // annexb: no `description` in config per WebCodecs spec
  dec.configure({ codec: "avc1.42c01f" });
  const t0 = performance.now();
  for (const c of CHUNKS) {
    dec.decode(new EncodedVideoChunk({
      type: c.key ? "key" : "delta", timestamp: c.ts, data: b64ToBuf(c.b64),
    }));
  }
  await dec.flush();
  const t1 = performance.now();
  out.fed = CHUNKS.length;
  out.decoded = frames.length;
  out.errors = errs;
  out.decodeMs = Math.round(t1 - t0);
  if (frames.length) {
    const f = frames[frames.length - 1];
    out.frameSize = [f.displayWidth, f.displayHeight];
    out.format = f.format;
    const c = new OffscreenCanvas(320, 240);
    const ctx = c.getContext('2d');
    ctx.drawImage(f, 0, 0);
    const p = ctx.getImageData(160, 120, 1, 1).data;
    out.centerPixel = [p[0], p[1], p[2]];
    out.pixelsRed = p[0] > 200 && p[1] < 60 && p[2] < 60;
  }
  for (const f of frames) f.close();

  // Seek pattern: flush (reset) then decode from the mid-stream keyframe onward.
  const frames2 = [];
  const dec2 = new VideoDecoder({ output: f => { frames2.push(f.timestamp); f.close(); },
                                  error: e => errs.push("seek:" + String(e)) });
  dec2.configure({ codec: "avc1.42c01f" });
  const kf = CHUNKS.findIndex((c, i) => i > 0 && c.key);
  out.midKeyframeIndex = kf;
  if (kf > 0) {
    const t2 = performance.now();
    for (const c of CHUNKS.slice(kf)) {
      dec2.decode(new EncodedVideoChunk({
        type: c.key ? "key" : "delta", timestamp: c.ts, data: b64ToBuf(c.b64) }));
    }
    await dec2.flush();
    out.seekDecoded = frames2.length;
    out.seekDecodeMs = Math.round(performance.now() - t2);
  }
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
GLib.timeout_add_seconds(30, lambda: (loop.quit(), False)[1])
view.load_html(PAGE_HEAD, "http://localhost/")
loop.run(); win.destroy()
print(json.dumps(json.loads(result["json"]), indent=2) if "json" in result else "TIMEOUT (web process likely crashed)")
