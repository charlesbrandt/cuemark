#!/usr/bin/env python3
"""Probe WebKitGTK 4.1 (the exact library Tauri/wry uses) for WebCodecs support.

Phase 1: enumerate WebKitFeatureList for codec/media-related experimental flags.
Phase 2: load a data: page that exercises VideoDecoder/isConfigSupported in the
         main thread and in a Worker, reporting results via document.title polling.
Run under xvfb-run.
"""
import gi, json, sys
gi.require_version('WebKit2', '4.1')
gi.require_version('Gtk', '3.0')
from gi.repository import WebKit2, Gtk, GLib

# ---- Phase 1: feature flags ----
print("=== WebKitFeatureList (matching codec|media|webrtc) ===")
features = {}
try:
    flist = WebKit2.Settings.get_all_features()
    for i in range(flist.get_length()):
        f = flist.get(i)
        ident = f.get_identifier()
        features[ident] = f
        low = ident.lower()
        if any(k in low for k in ("codec", "media", "webrtc", "canvas", "offscreen")):
            print(f"  {ident}: default={f.get_default_value()} status={f.get_status().value_nick} cat={f.get_category()}")
except Exception as e:
    print("feature enumeration failed:", e)

PAGE = r"""
<!doctype html><html><head><meta charset="utf-8"></head><body><script>
const out = { main: {}, worker: null };
function done() { document.title = "RESULT:" + JSON.stringify(out); }

out.main.VideoDecoder = typeof VideoDecoder;
out.main.VideoEncoder = typeof VideoEncoder;
out.main.AudioDecoder = typeof AudioDecoder;
out.main.VideoFrame = typeof VideoFrame;
out.main.EncodedVideoChunk = typeof EncodedVideoChunk;
out.main.OffscreenCanvas = typeof OffscreenCanvas;
out.main.requestVideoFrameCallback =
  typeof HTMLVideoElement !== 'undefined' &&
  typeof HTMLVideoElement.prototype.requestVideoFrameCallback;

async function checkConfigs() {
  if (typeof VideoDecoder === 'undefined') return;
  const configs = [
    ["h264-avc",  { codec: "avc1.640028" }],
    ["h264-annexb",{ codec: "avc1.640028", avc: { format: "annexb" } }],
    ["hevc",      { codec: "hvc1.1.6.L123.B0" }],
    ["vp8",       { codec: "vp8" }],
    ["vp9",       { codec: "vp09.00.10.08" }],
    ["av1",       { codec: "av01.0.04M.08" }],
  ];
  out.main.supported = {};
  for (const [name, cfg] of configs) {
    try {
      const r = await VideoDecoder.isConfigSupported(cfg);
      out.main.supported[name] = r.supported;
    } catch (e) { out.main.supported[name] = "err:" + e.name; }
  }
}

function checkWorker() {
  return new Promise((resolve) => {
    try {
      const src = `
        const r = {
          VideoDecoder: typeof VideoDecoder,
          VideoFrame: typeof VideoFrame,
          OffscreenCanvas: typeof OffscreenCanvas,
        };
        if (typeof VideoDecoder !== 'undefined') {
          VideoDecoder.isConfigSupported({codec:"avc1.640028"})
            .then(s => { r.h264 = s.supported; postMessage(r); })
            .catch(e => { r.h264 = "err:"+e.name; postMessage(r); });
        } else postMessage(r);
      `;
      const url = URL.createObjectURL(new Blob([src], {type:"text/javascript"}));
      const w = new Worker(url);
      const t = setTimeout(() => { out.worker = "timeout"; resolve(); }, 4000);
      w.onmessage = (e) => { clearTimeout(t); out.worker = e.data; resolve(); };
      w.onerror = (e) => { clearTimeout(t); out.worker = "worker-error:" + e.message; resolve(); };
    } catch (e) { out.worker = "spawn-error:" + e.message; resolve(); }
  });
}

Promise.all([checkConfigs(), checkWorker()]).then(done).catch(e => {
  out.error = String(e); done();
});
</script></body></html>
"""

# ---- Phase 2: live page probe ----
def run_page(enable_experimental):
    result = {}
    win = Gtk.Window()
    view = WebKit2.WebView()
    settings = view.get_settings()
    label = "defaults"
    if enable_experimental:
        label = "experimental-on"
        try:
            for ident, f in features.items():
                low = ident.lower()
                if "webcodec" in low or "codec" in low:
                    settings.set_feature_enabled(f, True)
                    print(f"  [enabled] {ident}")
        except Exception as e:
            print("  enabling failed:", e)
    win.add(view)
    win.show_all()
    loop = GLib.MainLoop()

    def poll():
        t = view.get_title() or ""
        if t.startswith("RESULT:"):
            result["json"] = t[len("RESULT:"):]
            loop.quit()
            return False
        return True

    GLib.timeout_add(200, poll)
    GLib.timeout_add_seconds(15, lambda: (loop.quit(), False)[1])
    view.load_html(PAGE, "http://localhost/")
    loop.run()
    win.destroy()
    print(f"=== Page probe ({label}) ===")
    if "json" in result:
        print(json.dumps(json.loads(result["json"]), indent=2))
    else:
        print("  TIMEOUT - no result (page error?)")

run_page(False)
run_page(True)
