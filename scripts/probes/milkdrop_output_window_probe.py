#!/usr/bin/env python3
"""Phase-6 end-to-end probe for Milkdrop (Butterchurn) in the REAL output window.

Loads the actual `output.html` + `src/output.ts` (from a Vite dev server, or from the built
`dist/` served through a custom `tauri://` URI scheme -- see "prod-like arm" below) into a plain
WebKitGTK WebView on Xvfb, and drives it with the same BroadcastChannel messages `outputBus.ts`
sends (`viz`, `frame`). No Tauri binary, no live app, no audio: this isolates the output window.

What it asserts (exit 0 only if all pass):
  isf      With an ISF plugin selected the Milkdrop code path is INERT: no <iframe> in the DOM,
           and neither the milkdrop `instance` chunk nor the `butterchurn` chunk was ever
           requested (PerformanceResourceTiming). `vizOk` arrives. Pixels are non-black.
  milkdrop A real preset (from a temp `npm pack butterchurn-presets`, NOT vendored) renders:
           the iframe is `sandbox="allow-scripts"` exactly, `vizOk` arrives, and a screenshot of
           the X screen (xwd, NOT WebGL readback -- readback is unusable on crocus and tells
           nothing about what is *displayed*) is non-black. PCM reaches the iframe (the frame's
           own `recv` counter climbs). Opacity is applied (computed CSS opacity) and opacity 0
           blanks the screen again.
  bad      A preset that is invalid JSON, one with a syntax error in its equations, and one with
           no `shapes`/`waves` each produce a `vizError` (visible in the panel + log), and a bad
           preset sent AFTER a good one leaves the good one rendering.
  churn    60 x (ISF -> Milkdrop -> ISF) switches with RSS of the WebKit processes before/after,
           and the iframe count returning to 0.

Arms: `--mode dev` loads http://127.0.0.1:<vite>/output.html; `--mode scheme` (default) loads the
`vite build` output through a registered `tauri` scheme, i.e. a `tauri://localhost` page that
embeds a `srcdoc` frame: the production mixed-scheme case, minus Tauri's own protocol handler.

Usage:  python3 scripts/probes/milkdrop_output_window_probe.py --presets DIR [--mode scheme|dev|both]
        DIR holds Butterchurn preset .json files (see docs/design/visualization-plugins.md, Phase 6).
        `scheme` needs `npx vite build` first. Starts its own Xvfb :97 (+ vite for dev); refuses
        to touch anything already listening on its ports.
"""
import argparse, glob, json, os, re, shutil, signal, socket, struct, subprocess, sys, tempfile, time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DISPLAY = ":97"
VITE_PORT = 1431
W, H = 1280, 720

SENDER_HTML = r"""<!doctype html><body><script>
const ch = new BroadcastChannel('cuemark-output');
const S = window.S = { log: [], alive: 0, state: { opacity: 1, params: {}, pcm: 'loud' }, n: 0 };
ch.onmessage = e => { const m = e.data; if (!m) return;
  if (m.kind === 'vizOk' || m.kind === 'vizError') S.log.push(m);
  else if (m.kind === 'alive') S.alive++;
  else if (m.kind === 'hello') S.hello = (S.hello||0) + 1; };
function pcm() {
  const st = S.state.pcm; if (st === 'none') return undefined;
  const a = new Uint8Array(3072); a.fill(128);
  if (st === 'loud') { const t = S.n / 6;
    for (let i = 0; i < 1024; i++) { const v = 128 + Math.round(100*Math.sin(i/9 + t) * Math.sin(i/300 + t/3));
      a[i] = v; a[1024+i] = v; a[2048+i] = 128 + Math.round(80*Math.sin(i/13 + t)); } }
  return a;
}
S.sendViz = p => ch.postMessage({ kind: 'viz', plugin: p });
setInterval(() => { S.n++;
  ch.postMessage({ kind: 'frame', decks: [], vizOpacity: S.state.opacity, vizParams: S.state.params,
    bindings: { bass: 0.5, mid: 0.3, high: 0.2 }, pcm: pcm(), time: S.n / 60, analysis: { bass: 0, mid: 0, high: 0 } });
}, 16);
</script></body>"""


def port_free(p):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", p)) != 0


def xwd_pixels():
    """Screenshot the whole X screen with xwd and return (w, h, rgb bytes)."""
    raw = subprocess.run(["xwd", "-root", "-display", DISPLAY], capture_output=True, check=True).stdout
    hdr = struct.unpack(">25I", raw[:100])
    hsize, w, h, bpp, bpl, ncol = hdr[0], hdr[4], hdr[5], hdr[11], hdr[12], hdr[19]
    rmask, gmask, bmask = hdr[14], hdr[15], hdr[16]
    assert bpp in (24, 32), f"unexpected xwd bits_per_pixel {bpp}"
    data = raw[hsize + ncol * 12:]
    return w, h, data, bpl, (rmask, gmask, bmask), bpp // 8


def _dbg(w, h, data, bpl, bp):
    if os.environ.get("PROBE_SHOT"):
        from PIL import Image
        Image.frombuffer("RGB" if bp == 3 else "RGBX", (w, h), data, "raw", "BGR" if bp == 3 else "BGRX", bpl, 1).convert("RGB").save(os.environ["PROBE_SHOT"] + "-%d.png" % int(time.time() * 1000))
    vals = {}
    for y in range(0, h, 40):
        for x in range(0, w, 40):
            px = int.from_bytes(data[y * bpl + x * bp:y * bpl + (x + 1) * bp], "little")
            vals[px] = vals.get(px, 0) + 1
    print("    [dbg] screen", w, h, "distinct", len(vals), sorted(vals.items(), key=lambda kv: -kv[1])[:5])


def screen_stats(x0=200, y0=100, x1=1080, y1=600):
    """Mean luma (0-255) and fraction of pixels brighter than 16, over a region that excludes
    output.html's small corner labels."""
    w, h, data, bpl, (rm, gm, bm), bp = xwd_pixels()
    n = lit = 0
    tot = 0
    if os.environ.get("PROBE_DEBUG"):
        _dbg(w, h, data, bpl, bp)
    for y in range(y0, min(y1, h), 4):
        row = data[y * bpl:(y + 1) * bpl]
        for x in range(x0, min(x1, w), 4):
            px = int.from_bytes(row[x * bp:(x + 1) * bp], "little")
            r, g, b = (px & rm) >> (rm & -rm).bit_length() - 1, (px & gm) >> (gm & -gm).bit_length() - 1, (px & bm) >> (bm & -bm).bit_length() - 1
            l = (r + g + b) / 3
            tot += l
            n += 1
            lit += l > 16
    return {"mean": round(tot / n, 1), "lit": round(lit / n, 3)}


def rss_kb(pid):
    try:
        for line in open(f"/proc/{pid}/status"):
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    except OSError:
        pass
    return 0


def webkit_rss():
    """Sum VmRSS (kB) of this process's WebKit* children, by name."""
    out = {}
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            ppid = int(open(f"/proc/{d}/stat").read().rsplit(")", 1)[1].split()[1])
            comm = open(f"/proc/{d}/comm").read().strip()
        except OSError:
            continue
        if ppid == os.getpid() and comm.startswith("WebKit"):
            out[comm] = out.get(comm, 0) + rss_kb(d)
    out["self"] = rss_kb(os.getpid())
    return out


def run(args, mode):
    import gi
    gi.require_version("WebKit2", "4.1")
    gi.require_version("Gtk", "3.0")
    from gi.repository import WebKit2, Gtk, GLib, Gio

    def pump(cond=None, secs=0.0, timeout=30):
        end = time.time() + (secs if cond is None else timeout)
        while time.time() < end:
            while Gtk.events_pending():
                Gtk.main_iteration_do(False)
            if cond is not None and cond():
                return True
            time.sleep(0.005)
        return cond is None

    def js(view, code, timeout=20):
        box = {}

        def cb(v, res, _):
            try:
                box["v"] = v.run_javascript_finish(res).get_js_value().to_string()
            except Exception as e:  # noqa: BLE001
                box["e"] = str(e)
        view.run_javascript(code, None, cb, None)
        if not pump(lambda: box, timeout=timeout):
            raise RuntimeError("js timeout: " + code[:80])
        if "e" in box:
            raise RuntimeError(box["e"] + " :: " + code[:80])
        return box["v"]

    dist = os.path.join(REPO, "dist")
    requested = []  # every path the tauri:// handler served (scheme arm)
    ctx = WebKit2.WebContext.new()
    origin = f"http://127.0.0.1:{VITE_PORT}"
    if mode == "scheme":
        origin = "tauri://localhost"
        mimes = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png"}

        def serve(req, *_):
            path = req.get_path().split("?")[0]
            requested.append(path)
            if path in ("/", ""):
                path = "/index.html"
            if path == "/sender.html":
                data, mime = SENDER_HTML.encode(), "text/html"
            else:
                fp = os.path.join(dist, path.lstrip("/"))
                if not os.path.isfile(fp):
                    data, mime = b"not found", "text/plain"
                else:
                    data, mime = open(fp, "rb").read(), mimes.get(os.path.splitext(fp)[1], "application/octet-stream")
            req.finish(Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(data)), len(data), mime)
        ctx.register_uri_scheme("tauri", serve)
        sm = ctx.get_security_manager()
        sm.register_uri_scheme_as_secure("tauri")
        sm.register_uri_scheme_as_cors_enabled("tauri")

    def mkview(w, h, x, y):
        v = WebKit2.WebView.new_with_context(ctx)
        s = v.get_settings()
        s.set_property("enable-webgl", True)
        s.set_property("enable-write-console-messages-to-stdout", True)
        win = Gtk.Window()
        win.set_decorated(False)
        win.set_default_size(w, h)
        win.move(x, y)
        win.add(v)
        win.show_all()
        return v, win

    out, w1 = mkview(W, H, 0, 0)
    snd, w2 = mkview(300, 120, 0, 760)
    if mode == "scheme":
        snd.load_uri("tauri://localhost/sender.html")
    else:
        snd.load_html(SENDER_HTML, origin + "/")
    pump(secs=1.0)
    out.load_uri(origin + "/output.html")
    pump(secs=3.0)

    results, fails = {}, []

    def check(name, ok, detail=""):
        results[name] = (bool(ok), detail)
        print(f"  [{'PASS' if ok else 'FAIL'}] {name} {detail}")
        if not ok:
            fails.append(name)

    def sender(code):
        return js(snd, code)

    def send_viz(pid, fmt, source):
        sender("S.log.length=0; S.sendViz(%s); 1" % json.dumps({"id": pid, "format": fmt, "source": source, "assets": {}}))

    def wait_report(pid, timeout=15):
        box = {}

        def poll():
            r = json.loads(sender("JSON.stringify(S.log)"))
            for m in r:
                if m.get("pluginId") == pid:
                    box["m"] = m
                    return True
            return False
        pump(poll, timeout=timeout)
        return box.get("m")

    def iframes():
        return int(js(out, "document.querySelectorAll('iframe').length"))

    def chunks():
        names = requested if mode == "scheme" else json.loads(js(out, "JSON.stringify(performance.getEntriesByType('resource').map(r=>r.name))"))
        return [n for n in names if re.search(r"butterchurn|/instance-", n)]

    def frame_stat():
        js(out, "window.__stat=null; if(!window.__l){window.__l=1; addEventListener('message',e=>{if(e.data&&e.data.type==='stat')window.__stat=e.data})};"
                "document.querySelector('iframe').contentWindow.postMessage({type:'stat'},'*'); 1")
        pump(lambda: js(out, "window.__stat?1:0") == "1", timeout=8)
        return json.loads(js(out, "JSON.stringify(window.__stat)"))

    plasma = open(os.path.join(REPO, "src/lib/renderer/builtin-isf/plasma.fs")).read()
    tunnel = open(os.path.join(REPO, "src/lib/renderer/builtin-isf/tunnel.fs")).read()
    presets = sorted(glob.glob(os.path.join(args.presets, "*.json")))
    assert len(presets) >= 2, "need at least two presets in --presets"
    P = [open(p).read() for p in presets]

    print(f"== arm: {mode} ({origin}) ==")
    print("output alive beacons:", sender("S.alive"))

    # ---- isf: the ISF path is unchanged and Milkdrop is inert ------------------------------
    send_viz("builtin:plasma", "isf", plasma)
    m = wait_report("builtin:plasma")
    pump(secs=1.5)
    st = screen_stats()
    check("isf/vizOk", m and m["kind"] == "vizOk", str(m))
    check("isf/no-iframe", iframes() == 0)
    check("isf/milkdrop-code-never-loaded", chunks() == [], str(chunks()))
    check("isf/pixels-non-black", st["lit"] > 0.2, str(st))

    # ---- milkdrop: renders, sandboxed, PCM arrives -----------------------------------------
    send_viz("milkdrop/a.json", "milkdrop", P[0])
    m = wait_report("milkdrop/a.json")
    pump(secs=3.0)
    st = screen_stats()
    sb = js(out, "document.querySelector('iframe').getAttribute('sandbox')")
    check("milkdrop/vizOk", m and m["kind"] == "vizOk", str(m))
    check("milkdrop/sandbox-attr-exact", sb == "allow-scripts", repr(sb))
    check("milkdrop/lazy-chunks-loaded-on-demand", len(chunks()) >= 1, str(chunks()))
    check("milkdrop/isf-layer-off-and-frame-is-the-picture", st["lit"] > 0.05 or st["mean"] > 8, str(st))
    s1 = frame_stat()
    pump(secs=1.5)
    s2 = frame_stat()
    check("milkdrop/pcm-reaches-iframe", s2["recv"] > s1["recv"] > 0, f"recv {s1['recv']} -> {s2['recv']}")
    check("milkdrop/rendering", s2["frames"] > s1["frames"] and not s2["err"], f"frames {s1['frames']} -> {s2['frames']} render p50={s2['renderP50']}ms p95={s2['renderP95']}ms")
    # PCM drives the preset: silence vs loud must give different pictures over a few samples
    def signature():
        sigs = []
        for _ in range(3):
            pump(secs=0.4)
            sigs.append(screen_stats(300, 150, 980, 550))
        return sigs
    sender("S.state.pcm='loud'; 1")
    loud = signature()
    sender("S.state.pcm='none'; 1")
    quiet = signature()
    sender("S.state.pcm='loud'; 1")
    print("    loud", loud, "\n    quiet", quiet)
    # opacity
    sender("S.state.opacity=0.5; 1")
    pump(secs=1.0)
    op = js(out, "getComputedStyle(document.querySelector('iframe')).opacity")
    check("milkdrop/opacity-applied", abs(float(op) - 0.5) < 0.01, op)
    sender("S.state.opacity=0; 1")
    pump(secs=1.5)
    st0 = screen_stats()
    check("milkdrop/opacity0-blanks-screen", st0["lit"] < 0.02, str(st0))
    sender("S.state.opacity=1; 1")
    pump(secs=1.5)

    # second preset with a blend
    sender("S.state.params={blendTime:2}; 1")
    send_viz("milkdrop/b.json", "milkdrop", P[1])
    m = wait_report("milkdrop/b.json")
    check("milkdrop/second-preset-vizOk", m and m["kind"] == "vizOk", str(m))
    check("milkdrop/still-one-frame", iframes() == 1)

    # ---- bad presets ------------------------------------------------------------------------
    good = json.loads(P[0])
    bad_syntax = dict(good, frame_eqs_str="this is ((( not javascript")
    bad_shape = {k: v for k, v in good.items() if k not in ("shapes", "waves")}
    for name, src in (("invalid-json", "{nope"), ("equation-syntax-error", json.dumps(bad_syntax)), ("missing-shapes", json.dumps(bad_shape))):
        pid = f"milkdrop/bad-{name}.json"
        send_viz(pid, "milkdrop", src)
        m = wait_report(pid)
        check(f"bad/{name}-surfaces-vizError", m and m["kind"] == "vizError", (m or {}).get("message", "no report")[:110] if m else "no report")
    # the last good preset (b) must still be on screen
    pump(secs=1.0)
    stb = screen_stats()
    check("bad/previous-good-preset-keeps-rendering", stb["lit"] > 0.05 or stb["mean"] > 8, str(stb))

    # bad preset as the FIRST preset of a fresh frame: nothing shown, error still reported
    send_viz("builtin:tunnel", "isf", tunnel)
    wait_report("builtin:tunnel")
    pump(secs=0.5)
    check("bad/frame-removed-when-leaving-milkdrop", iframes() == 0)
    send_viz("milkdrop/bad-first.json", "milkdrop", "{nope")
    m = wait_report("milkdrop/bad-first.json")
    check("bad/first-preset-error-reported", m and m["kind"] == "vizError", str(m))
    pump(secs=1.0)
    # (screen shows only the bare compositor here: decks:[] and no viz)

    # ---- churn ------------------------------------------------------------------------------
    send_viz("builtin:plasma", "isf", plasma)
    wait_report("builtin:plasma")
    pump(secs=2.0)
    before = webkit_rss()
    n_ok = 0
    for i in range(args.churn):
        if args.control:  # control arm: same churn with no Milkdrop at all (ISF <-> ISF)
            send_viz("builtin:ctl%d" % i, "isf", tunnel if i % 2 else plasma)
            m = wait_report("builtin:ctl%d" % i, timeout=10)
        else:
            send_viz("milkdrop/c%d.json" % i, "milkdrop", P[i % len(P)])
            m = wait_report("milkdrop/c%d.json" % i, timeout=10)
        if i % 20 == 19:
            print("    RSS after %d cycles: WebKitWebProcess %d MB" % (i + 1, webkit_rss().get("WebKitWebProces", 0) // 1024))
        n_ok += bool(m and m["kind"] == "vizOk")
        pump(secs=0.15)
        send_viz("builtin:plasma" if i % 2 else "builtin:tunnel", "isf", plasma if i % 2 else tunnel)
        wait_report("builtin:plasma" if i % 2 else "builtin:tunnel", timeout=10)
        pump(secs=0.1)
    pump(secs=2.0)
    after = webkit_rss()
    print("    RSS kB before:", before, "\n    RSS kB after: ", after)
    check(f"churn/{args.churn}-cycles-all-vizOk", n_ok == args.churn, f"{n_ok}/{args.churn}")
    check("churn/no-frames-left-behind", iframes() == 0)
    wp = "WebKitWebProces"
    growth = after.get(wp, 0) - before.get(wp, 0)
    results["churn/rss"] = (True, f"WebKitWebProcess {before.get(wp,0)//1024} -> {after.get(wp,0)//1024} MB ({growth//1024:+d} MB) over {args.churn} ISF<->Milkdrop round trips ({2*args.churn} switches)")
    print("  [INFO] " + results["churn/rss"][1])

    return fails, results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--presets", required=True)
    ap.add_argument("--mode", default="scheme", choices=["scheme", "dev", "both"])
    ap.add_argument("--churn", type=int, default=60)
    ap.add_argument("--control", action="store_true", help="churn ISF<->ISF only (RSS baseline with no Milkdrop)")
    args = ap.parse_args()
    modes = ["scheme", "dev"] if args.mode == "both" else [args.mode]
    if "dev" in modes and not port_free(VITE_PORT):
        sys.exit(f"port {VITE_PORT} in use; refusing")
    if "scheme" in modes and not os.path.isfile(os.path.join(REPO, "dist/output.html")):
        sys.exit("run `npx vite build` first")
    scratch = tempfile.mkdtemp(prefix="milkdrop-out-probe-")
    procs = []
    os.environ.pop("WAYLAND_DISPLAY", None)
    os.environ.update(GDK_BACKEND="x11", DISPLAY=DISPLAY, WEBKIT_DISABLE_DMABUF_RENDERER="1", **({"WEBKIT_DISABLE_COMPOSITING_MODE": "1"} if os.environ.get("PROBE_NOCOMP") else {}), CUEMARK_DISABLE_DMABUF="1",
                      XDG_DATA_HOME=scratch + "/d", XDG_CONFIG_HOME=scratch + "/c", XDG_CACHE_HOME=scratch + "/k")
    rc = 1
    try:
        procs.append(subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", "1280x900x24"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        time.sleep(1.5)
        if "dev" in modes:
            procs.append(subprocess.Popen(["npx", "vite", "--port", str(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], cwd=REPO,
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            for _ in range(60):
                if not port_free(VITE_PORT):
                    break
                time.sleep(0.5)
        all_fails = []
        for m in modes:
            # one arm per process: WebKit state (chunk cache, RSS) must not carry over
            r = subprocess.run([sys.executable, __file__, "--presets", args.presets, "--mode", "_" + m, "--churn", str(args.churn)] + (["--control"] if args.control else []))
            if r.returncode:
                all_fails.append(m)
        rc = 1 if all_fails else 0
        print("FAILED arms:" if all_fails else "ALL PASS", all_fails or "")
    finally:
        for p in reversed(procs):
            p.terminate()
        for p in procs:
            try:
                p.wait(5)
            except Exception:  # noqa: BLE001
                p.kill()
        shutil.rmtree(scratch, ignore_errors=True)
    sys.exit(rc)


def child():
    ap = argparse.ArgumentParser()
    ap.add_argument("--presets")
    ap.add_argument("--mode")
    ap.add_argument("--churn", type=int)
    ap.add_argument("--control", action="store_true")
    args = ap.parse_args()
    fails, _ = run(args, args.mode[1:])
    print("arm result:", "FAIL " + ", ".join(fails) if fails else "PASS")
    sys.stdout.flush()
    os._exit(1 if fails else 0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(1))
    if "--mode" in sys.argv and sys.argv[sys.argv.index("--mode") + 1].startswith("_"):
        child()
    else:
        main()
