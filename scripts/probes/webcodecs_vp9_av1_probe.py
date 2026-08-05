#!/usr/bin/env python3
"""Does `VideoDecoder` on THIS WebKitGTK actually decode VP9 / AV1 access units
demuxed the way `src-tauri/src/video_demux.rs` demuxes them?

`isConfigSupported()` already answers "true" for `vp09.*` and `av01.*`
(`webcodecs_probe.py`), but that is a codec-string check, not a decode. This probe
closes the gap for `legacy-video-fallback-cost.md` work item A4:

  host side  — GStreamer `filesrc ! parsebin ! <vp9parse|av1parse|h264parse> ! appsink`,
               i.e. the exact element chain video_demux.rs uses, over a REAL library
               file. Builds the WebCodecs codec string from the negotiated caps with
               the same rules the Rust does.
  page side  — isConfigSupported, configure, decode every AU, flush; then repeat from a
               mid-stream keyframe (the seek pattern) and, for AV1/VP9, once WITHOUT any
               `description` and once WITH `codec_data` as `description`, because whether
               the sequence header is in-band decides if seeking works.

Usage:
    APPORT_DISABLE=1 xvfb-run -a python3 scripts/probes/webcodecs_vp9_av1_probe.py [FILE ...]

With no arguments it probes the two known-bad library files from
`legacy-video-fallback-cost.md` ("How to reproduce").
"""
import base64
import json
import os
import sys

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstApp", "1.0")
gi.require_version("WebKit2", "4.1")
gi.require_version("Gtk", "3.0")
from gi.repository import Gst, GstApp, Gtk, WebKit2, GLib  # noqa: E402  (gi requires the version pins first)

Gst.init(None)

MAX_AUS = 120  # enough for a mid-stream keyframe on a 25fps file without a huge data: page

# VP9 Annex-A level table: (level_code, max_luma_sample_rate, max_luma_picture_size).
VP9_LEVELS = [
    (10, 829440, 36864), (11, 2764800, 73728),
    (20, 4608000, 122880), (21, 9216000, 245760),
    (30, 20736000, 552960), (31, 36864000, 983040),
    (40, 83558400, 2228224), (41, 160432128, 2228224),
    (50, 311951360, 8912896), (51, 588251136, 8912896), (52, 1176502272, 8912896),
    (60, 1176502272, 35651584), (61, 2353004544, 35651584), (62, 4706009088, 35651584),
]


def vp9_level(width, height, fps):
    pic = max(1, width * height)
    rate = pic * (fps if fps > 0 else 30)
    for code, max_rate, max_pic in VP9_LEVELS:
        if pic <= max_pic and rate <= max_rate:
            return code
    return 62


AV1_PROFILES = {"main": 0, "high": 1, "professional": 2}


def av1_level_idx(level_str):
    """'4.0' -> seq_level_idx 8 (idx = (major-2)*4 + minor)."""
    try:
        major, minor = level_str.split(".")
        idx = (int(major) - 2) * 4 + int(minor)
        return idx if 0 <= idx <= 31 else 8
    except Exception:
        return 8


def demux(path, vp9_alignment="super-frame"):
    """filesrc ! parsebin ! <parser> ! capsfilter ! appsink — mirrors video_demux.rs."""
    pipeline = Gst.Pipeline.new("demux")
    src = Gst.ElementFactory.make("filesrc")
    src.set_property("location", path)
    parsebin = Gst.ElementFactory.make("parsebin")
    sink = Gst.ElementFactory.make("appsink")
    sink.set_property("sync", False)
    for e in (src, parsebin, sink):
        pipeline.add(e)
    src.link(parsebin)

    state = {"linked": False, "err": None, "gstname": None}

    def on_pad(_bin, pad):
        if state["linked"]:
            return
        caps = pad.get_current_caps() or pad.query_caps(None)
        name = caps.get_structure(0).get_name()
        if not name.startswith("video/"):
            return
        state["gstname"] = name
        parser, filter_caps = {
            "video/x-h264": ("h264parse", "video/x-h264,stream-format=byte-stream,alignment=au"),
            "video/x-vp9": ("vp9parse", f"video/x-vp9,alignment={vp9_alignment}"),
            "video/x-av1": ("av1parse", f"video/x-av1,{os.environ.get('AV1_CAPS', 'stream-format=obu-stream,alignment=tu')}"),
        }.get(name, (None, None))
        if parser is None:
            state["err"] = f"unsupported gst caps: {name}"
            state["linked"] = True
            return
        par = Gst.ElementFactory.make(parser)
        if parser == "h264parse":
            par.set_property("config-interval", -1)
        cf = Gst.ElementFactory.make("capsfilter")
        cf.set_property("caps", Gst.Caps.from_string(filter_caps))
        pipeline.add(par)
        pipeline.add(cf)
        par.link(cf)
        cf.link(sink)
        par.sync_state_with_parent()
        cf.sync_state_with_parent()
        pad.link(par.get_static_pad("sink"))
        state["linked"] = True

    parsebin.connect("pad-added", on_pad)
    pipeline.set_state(Gst.State.PLAYING)

    aus, caps_str = [], None
    import time

    deadline = time.time() + 60
    while len(aus) < MAX_AUS and time.time() < deadline:
        sample = sink.try_pull_sample(500 * Gst.MSECOND)
        if sample is None:
            if state["err"] or sink.is_eos():
                break
            continue
        if caps_str is None:
            caps_str = sample.get_caps().to_string()
        buf = sample.get_buffer()
        ok, mi = buf.map(Gst.MapFlags.READ)
        if not ok:
            continue
        aus.append({
            "key": not buf.has_flags(Gst.BufferFlags.DELTA_UNIT),
            "ts": int(buf.pts // 1000) if buf.pts != Gst.CLOCK_TIME_NONE else 0,
            "b64": base64.b64encode(bytes(mi.data)).decode(),
        })
        buf.unmap(mi)
    pipeline.set_state(Gst.State.NULL)
    if state["err"]:
        raise RuntimeError(state["err"])
    if not aus:
        raise RuntimeError("no access units demuxed")

    caps = Gst.Caps.from_string(caps_str)
    s = caps.get_structure(0)

    def gets(field, default=None):
        v = s.get_string(field) if s.has_field(field) else None
        return v if v is not None else default

    width = s.get_int("width")[1] if s.has_field("width") else 0
    height = s.get_int("height")[1] if s.has_field("height") else 0
    fps = 0.0
    if s.has_field("framerate"):
        ok, n, d = s.get_fraction("framerate")
        if ok and d:
            fps = n / d
    depth = s.get_uint("bit-depth-luma")[1] if s.has_field("bit-depth-luma") else 8

    name = state["gstname"]
    description_b64 = None
    if name == "video/x-vp9":
        profile = int(gets("profile", "0") or 0)
        codec = f"vp09.{profile:02d}.{vp9_level(width, height, fps):02d}.{depth:02d}"
    elif name == "video/x-av1":
        profile = AV1_PROFILES.get(gets("profile", "main"), 0)
        level = av1_level_idx(gets("level", "4.0"))
        tier = "H" if (gets("tier", "main") or "main").lower() == "high" else "M"
        codec = f"av01.{profile}.{level:02d}{tier}.{depth:02d}"
        if s.has_field("codec_data"):
            try:
                cd = s.get_value("codec_data")
                ok2, mi = cd.map(Gst.MapFlags.READ)
                if ok2:
                    description_b64 = base64.b64encode(bytes(mi.data)).decode()
                    cd.unmap(mi)
            except Exception as e:
                print(f"  (codec_data extraction failed: {e})")
    else:
        codec = "avc1.unknown"  # h264 control arm: string is derived in Rust from the SPS

    return {
        "path": path,
        "gstCaps": name,
        "codec": codec,
        "width": width,
        "height": height,
        "fps": round(fps, 2),
        "depth": depth,
        "aus": aus,
        "descriptionB64": description_b64,
        "capsStr": caps_str[:400],
    }


PAGE = r"""
<!doctype html><html><head><meta charset="utf-8"></head><body><script>
const FILES = __FILES__;
const out = [];
function b64(s){const b=atob(s),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a;}

async function decodeRun(codec, description, aus, label) {
  const r = { label, codec, description: !!description };
  try {
    const cfg = { codec };
    if (description) cfg.description = b64(description);
    try { r.isConfigSupported = (await VideoDecoder.isConfigSupported(cfg)).supported; }
    catch (e) { r.isConfigSupported = "err:" + e.name; }
    const frames = [], errs = [];
    const dec = new VideoDecoder({ output: f => { frames.push([f.displayWidth, f.displayHeight, f.format, f.timestamp]); f.close(); },
                                   error: e => errs.push(String(e)) });
    try { dec.configure(cfg); } catch (e) { r.configureThrew = String(e); return r; }
    const t0 = performance.now();
    for (const a of aus) {
      if (dec.state !== "configured") { r.decoderDiedAt = aus.indexOf(a); break; }
      try { dec.decode(new EncodedVideoChunk({ type: a.key ? "key" : "delta", timestamp: a.ts, data: b64(a.b64) })); }
      catch (e) { r.decodeThrew = String(e); break; }
    }
    try { await dec.flush(); } catch (e) { r.flushThrew = String(e); }
    r.ms = Math.round(performance.now() - t0);
    r.fed = aus.length;
    r.decoded = frames.length;
    r.errors = errs.slice(0, 3);
    if (frames.length) { r.firstFrame = frames[0]; r.lastFrame = frames[frames.length - 1]; }
    if (dec.state !== "closed") dec.close();
  } catch (e) { r.fatal = String(e && e.stack || e); }
  return r;
}

async function run() {
  for (const f of FILES) {
    const rec = { path: f.path, gstCaps: f.gstCaps, codec: f.codec,
                  size: [f.width, f.height], fps: f.fps, depth: f.depth,
                  auCount: f.aus.length, hasCodecData: !!f.descriptionB64, runs: [] };
    rec.runs.push(await decodeRun(f.codec, null, f.aus, "full/no-description"));
    if (f.descriptionB64) rec.runs.push(await decodeRun(f.codec, f.descriptionB64, f.aus, "full/description"));
    // Seek pattern: start from a mid-stream keyframe, no description.
    const kf = f.aus.findIndex((a, i) => i > 0 && a.key);
    rec.midKeyframeIndex = kf;
    if (kf > 0) rec.runs.push(await decodeRun(f.codec, null, f.aus.slice(kf), "seek/no-description"));
    out.push(rec);
  }
  window.__result = JSON.stringify(out);
  document.title = "DONE";  // titles truncate ~1KB here, so the payload comes back via evaluate_javascript
}
run().catch(e => { window.__result = JSON.stringify([{fatal: String(e && e.stack || e)}]); document.title = "DONE"; });
</script></body></html>
"""

DEFAULT_FILES = [
    os.path.expanduser("~/.local/share/com.cuemark.app/media_cache/d4f4826ea21dc657-14817724.webm"),
    os.path.expanduser("~/.local/share/com.cuemark.app/media_cache/bf991bae5d40c8a2-9569484.mp4"),
]


def main():
    paths = sys.argv[1:] or DEFAULT_FILES
    files = []
    for p in paths:
        if not os.path.exists(p):
            print(f"SKIP (missing): {p}")
            continue
        try:
            f = demux(p)
        except Exception as e:
            print(f"DEMUX FAILED {p}: {e}")
            continue
        print(f"demuxed {os.path.basename(p)}: {f['gstCaps']} {f['width']}x{f['height']}@{f['fps']} "
              f"depth={f['depth']} -> codec={f['codec']} aus={len(f['aus'])} "
              f"codec_data={'yes' if f['descriptionB64'] else 'no'}")
        print(f"  caps: {f['capsStr']}")
        files.append(f)
    if not files:
        sys.exit("nothing to probe")

    win = Gtk.Window()
    view = WebKit2.WebView()
    win.add(view)
    win.show_all()
    loop = GLib.MainLoop()
    result = {}

    def got(view_, res, _):
        try:
            v = view_.evaluate_javascript_finish(res)
            result["json"] = v.to_string()
        except Exception as e:
            result["json"] = json.dumps([{"fatal": f"evaluate_javascript: {e}"}])
        loop.quit()

    def poll():
        if (view.get_title() or "") == "DONE":
            view.evaluate_javascript("window.__result", -1, None, None, None, got, None)
            return False
        return True

    GLib.timeout_add(200, poll)
    GLib.timeout_add_seconds(120, lambda: (loop.quit(), False)[1])
    view.load_html(PAGE.replace("__FILES__", json.dumps(files)), "http://localhost/")
    loop.run()
    win.destroy()
    if "json" not in result:
        print("TIMEOUT (web process likely crashed)")
        sys.exit(1)
    print(json.dumps(json.loads(result["json"]), indent=2))


if __name__ == "__main__":
    main()
