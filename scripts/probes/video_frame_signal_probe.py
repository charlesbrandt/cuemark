#!/usr/bin/env python3
"""Which *frame-change* signal does a legacy `<video>` element expose on this WebKitGTK?

Motivation: `DeckCard.svelte`'s preview loop gates its `drawImage(video, …)` on
`video.currentTime !== lastDrawnTime`. On WebKitGTK `currentTime` advances
continuously rather than in frame steps, so that check never gates anything and a
6 fps file draws on all ~60 rAF ticks per second
(`docs/design/legacy-video-fallback-cost.md`, "Secondary finding" / A2).

This probe plays a **real** file in a bare `WebKit2 4.1` webview — the same library
Tauri/wry links — over plain HTTP (the app's own transport; `file://` and custom
schemes are unusable for `<video>` here, see CLAUDE.md) and reports, over a fixed
window:

  rafTicks              how many rAF turns happened
  uniqueCurrentTime     how many of them saw a *different* `video.currentTime`
                        → if this ≈ rafTicks, the shipping change-check is a no-op
  rvfc.supported        is `HTMLVideoElement.prototype.requestVideoFrameCallback` there
  rvfc.calls            how many times it actually fired (the real frame rate, if real)
  rvfc.uniqueMediaTime  distinct `metadata.mediaTime` values seen
  rvfc.presentedFrames  does `metadata.presentedFrames` advance by 1 per callback
  quality.*             `getVideoPlaybackQuality().totalVideoFrames` delta over the window
  webkitDecodedFrameCount  the older non-standard counter, same question

Expected shape of a *useful* answer: `uniqueCurrentTime == rafTicks` (check broken)
alongside some counter that advances at the file's real frame rate.

Usage:
    APPORT_DISABLE=1 xvfb-run -a python3 scripts/probes/video_frame_signal_probe.py [VIDEO...]

Defaults to the two files named in `legacy-video-fallback-cost.md` "How to reproduce".
`PROBE_SECONDS` (default 6) sets the measurement window.
"""
import functools
import http.server
import json
import os
import socketserver
import sys
import threading

import gi

gi.require_version("WebKit2", "4.1")
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, WebKit2, GLib  # noqa: E402

CACHE = os.path.expanduser("~/.local/share/com.cuemark.app/media_cache")
DEFAULT_FILES = [
    os.path.join(CACHE, "bf991bae5d40c8a2-9569484.mp4"),   # AV1  1920x1080@6
    os.path.join(CACHE, "d4f4826ea21dc657-14817724.webm"),  # VP9   640x480@25
]
SECONDS = float(os.environ.get("PROBE_SECONDS", "6"))


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    """`<video>` needs byte ranges; SimpleHTTPRequestHandler alone 200s the whole file."""

    def log_message(self, *a):  # silence
        pass

    def do_GET(self):
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            self.send_error(404)
            return
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        ctype = self.guess_type(path)
        with open(path, "rb") as f:
            if rng and rng.startswith("bytes="):
                spec = rng[6:].split("-")
                start = int(spec[0] or 0)
                end = int(spec[1]) if len(spec) > 1 and spec[1] else size - 1
                end = min(end, size - 1)
                f.seek(start)
                body = f.read(end - start + 1)
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            else:
                body = f.read()
                self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


PAGE = r"""<!doctype html><html><head><meta charset="utf-8"></head><body>
<video id="v" src="__SRC__" muted playsinline></video>
<script>
const SECONDS = __SECONDS__;
const v = document.getElementById('v');
const out = {
  src: "__SRC__",
  rafTicks: 0, uniqueCurrentTime: 0,
  rvfc: { supported: typeof v.requestVideoFrameCallback === 'function',
          calls: 0, uniqueMediaTime: 0, presentedFramesFirst: null,
          presentedFramesLast: null, mediaTimeFirst: null, mediaTimeLast: null,
          keys: null },
  quality: { supported: typeof v.getVideoPlaybackQuality === 'function',
             totalFirst: null, totalLast: null },
  webkitDecodedFrameCount: { supported: ('webkitDecodedFrameCount' in v),
                             first: null, last: null },
};
function finish(err) {
  out.error = err || null;
  out.videoWidth = v.videoWidth; out.videoHeight = v.videoHeight;
  out.readyState = v.readyState; out.currentTimeEnd = v.currentTime;
  if (out.quality.supported) out.quality.totalLast = v.getVideoPlaybackQuality().totalVideoFrames;
  if (out.webkitDecodedFrameCount.supported) out.webkitDecodedFrameCount.last = v.webkitDecodedFrameCount;
  document.title = "RESULT:" + JSON.stringify(out);
}

let lastCT = -1, lastMT = -1;
function raf() {
  try {
    out.rafTicks++;
    if (v.currentTime !== lastCT) { out.uniqueCurrentTime++; lastCT = v.currentTime; }
  } catch (e) { out.rafError = String(e); }
  requestAnimationFrame(raf);
}
// Control for the frame clock: a plain timer keeps ticking even when the page is not
// being composited, so `intervalTicks >> rafTicks` means "this environment has no
// display refresh source", not "rAF/rVFC are broken".
out.intervalTicks = 0;
setInterval(() => { out.intervalTicks++; }, 8);
function onFrame(now, md) {
  out.rvfc.calls++;
  if (out.rvfc.keys === null && md) out.rvfc.keys = Object.keys(md);
  if (md && typeof md.mediaTime === 'number') {
    if (md.mediaTime !== lastMT) { out.rvfc.uniqueMediaTime++; lastMT = md.mediaTime; }
    if (out.rvfc.mediaTimeFirst === null) out.rvfc.mediaTimeFirst = md.mediaTime;
    out.rvfc.mediaTimeLast = md.mediaTime;
  }
  if (md && typeof md.presentedFrames === 'number') {
    if (out.rvfc.presentedFramesFirst === null) out.rvfc.presentedFramesFirst = md.presentedFrames;
    out.rvfc.presentedFramesLast = md.presentedFrames;
  }
  v.requestVideoFrameCallback(onFrame);
}

const bail = setTimeout(() => finish("timeout waiting for playback"), (SECONDS + 12) * 1000);
v.addEventListener('error', () => finish("video error " + (v.error && v.error.code)));
v.addEventListener('playing', () => {
  if (out.quality.supported) out.quality.totalFirst = v.getVideoPlaybackQuality().totalVideoFrames;
  if (out.webkitDecodedFrameCount.supported) out.webkitDecodedFrameCount.first = v.webkitDecodedFrameCount;
  requestAnimationFrame(raf);
  if (out.rvfc.supported) v.requestVideoFrameCallback(onFrame);
  setTimeout(() => { clearTimeout(bail); finish(null); }, SECONDS * 1000);
}, { once: true });
v.play().catch(e => finish("play rejected: " + e.name + " " + e.message));
</script></body></html>"""


def run_one(port, url, seconds):
    """One webview, one file. Returns the parsed RESULT dict."""
    settings = WebKit2.Settings()
    settings.set_enable_developer_extras(True)
    settings.set_media_playback_requires_user_gesture(False)
    settings.set_enable_write_console_messages_to_stdout(True)
    view = WebKit2.WebView(settings=settings)
    win = Gtk.Window()
    win.set_default_size(800, 600)
    win.add(view)
    win.show_all()

    result = {}
    loop = GLib.MainLoop()

    def on_title(v, _p):
        t = v.get_title() or ""
        if t.startswith("RESULT:"):
            result.update(json.loads(t[7:]))
            loop.quit()

    view.connect("notify::title", on_title)
    page = PAGE.replace("__SRC__", url).replace("__SECONDS__", str(seconds))
    view.load_html(page, f"http://127.0.0.1:{port}/")
    GLib.timeout_add_seconds(int(seconds) + 25, lambda: (loop.quit(), False)[1])
    loop.run()
    win.destroy()
    return result


def main():
    files = sys.argv[1:] or DEFAULT_FILES
    files = [f for f in files if os.path.isfile(f)]
    if not files:
        print("no input files found", file=sys.stderr)
        return 2

    root = os.path.dirname(os.path.commonprefix(files)) or "/"
    handler = functools.partial(RangeHandler, directory=root)
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"serving {root} on 127.0.0.1:{port}\n")

    for f in files:
        url = f"http://127.0.0.1:{port}/{os.path.relpath(f, root)}"
        print(f"=== {os.path.basename(f)} ===")
        r = run_one(port, url, SECONDS)
        if not r:
            print("  NO RESULT (webview timed out)\n")
            continue
        print(json.dumps(r, indent=2))
        raf, uniq = r.get("rafTicks", 0), r.get("uniqueCurrentTime", 0)
        if raf:
            print(f"  -> currentTime changed on {uniq}/{raf} rAF ticks "
                  f"({100.0 * uniq / raf:.0f}%)  [100% == the change-check is a no-op]")
        rv = r.get("rvfc", {})
        if rv.get("supported"):
            print(f"  -> rVFC fired {rv.get('calls')} times in {SECONDS}s "
                  f"= {rv.get('calls', 0) / SECONDS:.1f}/s")
        else:
            print("  -> requestVideoFrameCallback NOT SUPPORTED")
        q = r.get("quality", {})
        if q.get("supported") and q.get("totalFirst") is not None:
            d = (q["totalLast"] or 0) - (q["totalFirst"] or 0)
            print(f"  -> getVideoPlaybackQuality().totalVideoFrames +{d} "
                  f"= {d / SECONDS:.1f}/s")
        w = r.get("webkitDecodedFrameCount", {})
        if w.get("supported") and w.get("first") is not None:
            d = (w["last"] or 0) - (w["first"] or 0)
            print(f"  -> webkitDecodedFrameCount +{d} = {d / SECONDS:.1f}/s")
        print()
    srv.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
