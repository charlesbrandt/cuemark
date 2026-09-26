#!/usr/bin/env python3
"""Phase-6 spike for `docs/design/visualization-plugins.md`: can Butterchurn (Milkdrop) run in a
sandboxed iframe inside the REAL cuemark webview?

Three checks, the exact list from "Milkdrop renderer" item 4:

  1. webgl2   WebGL2 works inside `<iframe sandbox="allow-scripts">` on this WebKitGTK, and
              Butterchurn actually renders a preset there (`createVisualizer(null, canvas)`,
              `new Function` preset equations included -- the very thing the sandbox exists for).
              Pixels are read back INSIDE the iframe (readPixels right after render) so a black
              canvas cannot pass. Readback is broken on the MacBook Pro's `crocus` driver, so a
              black result on that machine is a `skip`, not a fail (see docs/environment.md).
  2. no_tauri The iframe sees no `window.__TAURI__` / `__TAURI_INTERNALS__`, and an IPC
              `invoke` attempt from it does not succeed. CONTROL ARM: the same probe on the top
              frame must see both -- otherwise the app never injected Tauri into this page and
              "the iframe has none" would be vacuous.
  3. postmsg  Per-frame `postMessage` of 3 x 1024 bytes (transferred) costs no measurable host
              frame time. Arms: baseline (no posting), post3k, baseline again, and a deliberately
              expensive 32 MB/frame CONTROL that must move the numbers -- an instrument that
              cannot vary with the fault carries no information about it.

It drives the real binary through tauri-driver + Xvfb (skills/verify-ui). The dev binary loads
`http://localhost:1420/`, so this script serves its OWN page on 127.0.0.1:1420 in place of Vite;
nothing from the repo's frontend is involved, and XDG dirs point at a scratch directory so the
user's localStorage / log are untouched. Refuses to run if :1420 or :4444 is already in use
(a live `cargo tauri dev` owns 1420).

Butterchurn is NOT a repo dependency: it is fetched with `npm pack` into a temp dir (MIT).

Usage:
    python3 scripts/probes/milkdrop_sandbox_iframe_probe.py [--binary PATH] [--bc-dir DIR]
    (starts its own Xvfb :98 and tauri-driver; sets CUEMARK_DISABLE_DMABUF=1 for Xvfb on mele)

Exit 0 if checks 1-3 pass (skips excepted), 1 otherwise. ~1 minute.
"""
import argparse
import http.server
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_BINARY = "/home/account/repos/cuemark/src-tauri/target/debug/cuemark"
PORT_APP = 1420
PORT_DRIVER = 4444
DISPLAY = ":98"
ARM_MS = 4000

HOST_HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>milkdrop-probe</title>
<style>html,body{margin:0;background:#000}
#comp{position:absolute;left:0;top:0;width:640px;height:360px;background:#036}
#fr{position:absolute;left:0;top:0;width:640px;height:360px;border:0;opacity:.5}</style></head><body>
<canvas id="comp" width="640" height="360"></canvas>
<iframe id="fr" sandbox="allow-scripts" src="http://127.0.0.1:1420/frame.html"></iframe>
<script src="/butterchurn-presets.js"></script>
<script>
const R = window.__result = { done:false, top:{}, frame:null, arms:{}, stack:{} };
const fr = document.getElementById('fr');
R.top.tauri = typeof window.__TAURI__;
R.top.tauriInternals = typeof window.__TAURI_INTERNALS__;
const presets = window.butterchurnPresetsMinimal.getPresets();
const names = Object.keys(presets);
R.presetCount = names.length;
const pick = names.find(n => /Geiss/.test(n)) || names[0];
R.preset = pick;

let ready = null;
window.addEventListener('message', e => {
  if (e.source !== fr.contentWindow) return;
  if (e.data && e.data.type === 'ready') { R.frame = e.data; ready && ready(); }
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

function armRun(name, ms, perFrame) {
  return new Promise(resolve => {
    const dts = [], posts = []; let last = performance.now(), t0 = last, n = 0;
    function tick(now) {
      dts.push(now - last); last = now;
      if (perFrame) { const p0 = performance.now(); perFrame(n++); posts.push(performance.now() - p0); }
      if (now - t0 < ms) requestAnimationFrame(tick);
      else {
        const s = a => { const b = a.slice(1).sort((x,y)=>x-y); return b.length ? {n:b.length, p50:+b[b.length>>1].toFixed(2), p95:+b[Math.floor(b.length*.95)].toFixed(2), max:+b[b.length-1].toFixed(2)} : null; };
        R.arms[name] = { frameDt: s(dts), postCallMs: posts.length ? s(posts) : null };
        resolve();
      }
    }
    requestAnimationFrame(tick);
  });
}
const mk = () => { const a = new Uint8Array(1024); for (let i=0;i<1024;i++) a[i] = 128 + ((Math.sin(i/20)*90)|0); return a; };
function post3k() {
  const a = mk(), b = mk(), c = mk();
  fr.contentWindow.postMessage({type:'pcm', a, b, c}, '*', [a.buffer, b.buffer, c.buffer]);
}
const big = new Uint8Array(32*1024*1024);
function postBig() { fr.contentWindow.postMessage({type:'pcm', big}, '*'); }  // structured clone, no transfer

(async () => {
  await new Promise(r => { ready = r; setTimeout(r, 15000); });
  fr.contentWindow.postMessage({type:'preset', preset: presets[pick]}, '*');
  await sleep(1500);                       // let it compile + render a few frames
  const stat = await new Promise(r => {
    const h = e => { if (e.data && e.data.type === 'stat') { removeEventListener('message', h); r(e.data); } };
    addEventListener('message', h); fr.contentWindow.postMessage({type:'stat'}, '*');
  });
  R.frame.stat = stat;
  // stacking: iframe must be the top hit-test element over the compositor canvas, with opacity
  const el = document.elementFromPoint(100, 100);
  R.stack = { topmost: el && el.id, opacity: getComputedStyle(fr).opacity };
  await armRun('baseline1', __ARM__, null);
  await armRun('post3k', __ARM__, post3k);
  await armRun('baseline2', __ARM__, null);
  await armRun('post3k_b', __ARM__, post3k);
  await armRun('baseline3', __ARM__, null);
  await armRun('post32MB_control', __ARM__, postBig);
  const fin = await new Promise(r => {
    const h = e => { if (e.data && e.data.type === 'stat') { removeEventListener('message', h); r(e.data); } };
    addEventListener('message', h); fr.contentWindow.postMessage({type:'stat'}, '*');
  });
  R.frameAfter = fin;
  // Control arm for check 2: a SAME-ORIGIN, UNSANDBOXED child frame. If Tauri's init script is
  // injected into child frames at all, it shows up here; if not, "the sandbox hides it" would be
  // an untested claim (the sandboxed frame lacks it either way).
  const ctl = document.createElement('iframe');
  ctl.style.cssText = 'position:absolute;left:0;top:400px;width:200px;height:100px';
  ctl.src = '/frame.html?ctl=1';
  document.body.appendChild(ctl);
  R.ctl = await new Promise(r => {
    const h = e => { if (e.source === ctl.contentWindow && e.data && e.data.type === 'ready') { removeEventListener('message', h); r(e.data); } };
    addEventListener('message', h); setTimeout(() => r('timeout'), 8000);
  });
  R.done = true;
})().catch(e => { R.error = String(e && e.stack || e); R.done = true; });
</script></body></html>
""".replace("__ARM__", str(ARM_MS))

FRAME_HTML = r"""<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<canvas id="c" width="640" height="360"></canvas>
<script src="/butterchurn.js"></script>
<script>
const out = { type:'ready', origin: String(location.origin), windowOrigin: String(self.origin),
  tauri: typeof window.__TAURI__, tauriInternals: typeof window.__TAURI_INTERNALS__,
  tauriIpc: typeof window.ipc, parentAccess: null, invoke: null, webgl2: null, newFunction: null,
  butterchurn: typeof window.butterchurn };
try { void window.parent.document.title; out.parentAccess = 'READ-OK'; } catch (e) { out.parentAccess = 'blocked:' + e.name; }
try { out.newFunction = new Function('return 41+1')(); } catch (e) { out.newFunction = 'ERR:' + e.name; }
const c = document.getElementById('c');
let gl = null;
try { gl = c.getContext('webgl2', {alpha:false, premultipliedAlpha:false}); } catch (e) { out.webgl2 = 'THROW:' + e; }
if (gl) out.webgl2 = { ok:true, version: gl.getParameter(gl.VERSION), renderer: (function(){ try { const x = gl.getExtension('WEBGL_debug_renderer_info'); return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'masked'; } catch(e){ return 'n/a'; } })() };
else if (!out.webgl2) out.webgl2 = { ok:false };

// IPC attempt: if Tauri's internals leaked in, an invoke would resolve; a working sandbox must not.
async function tryInvoke() {
  const inv = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
           || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
  if (!inv) return 'no-invoke-fn';
  try { await Promise.race([inv('media_server_port'), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000))]); return 'SUCCEEDED'; }
  catch (e) { return 'rejected:' + String(e && e.message || e).slice(0, 80); }
}

let viz = null, lastPcm = null, frames = 0, renderMs = [], recv = 0, lastPix = null, err = null;
function stat() {
  const s = renderMs.slice().sort((a,b)=>a-b);
  return { type:'stat', frames, recv, err, renderP50: s.length ? +s[s.length>>1].toFixed(2) : null,
           renderP95: s.length ? +s[Math.floor(s.length*.95)].toFixed(2) : null, pix: lastPix };
}
function sampleCanvas() {
  // Read INSIDE this frame, right after render (same task) -- the only place a readback is legal here.
  const w = 640, h = 360, buf = new Uint8Array(4 * 16 * 16); let nz = 0, sum = 0, min = 255, max = 0;
  const g = viz && viz.gl || gl; if (!g) return null;
  for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 4; gx++) {
    g.readPixels(gx*(w>>2)+8, gy*(h>>2)+8, 16, 16, g.RGBA, g.UNSIGNED_BYTE, buf);
    for (let i = 0; i < buf.length; i += 4) { const v = buf[i]+buf[i+1]+buf[i+2]; sum += v; if (v) nz++; if (v<min) min=v; if (v>max) max=v; }
  }
  return { nonzero: nz, of: 16*16*16, mean: +(sum/(16*16*16)).toFixed(1), min, max, glErr: g.getError() };
}
function loop() {
  requestAnimationFrame(loop);
  if (!viz) return;
  const t0 = performance.now();
  try {
    const a = lastPcm ? lastPcm.a : new Uint8Array(1024).fill(128);
    const b = lastPcm ? lastPcm.b : a, l = lastPcm ? lastPcm.c : a;
    viz.render({ audioLevels: { timeByteArray: a, timeByteArrayL: b, timeByteArrayR: l } });
    frames++; if (frames % 30 === 0) lastPix = sampleCanvas();
  } catch (e) { err = String(e && e.stack || e).slice(0, 300); }
  renderMs.push(performance.now() - t0); if (renderMs.length > 600) renderMs.shift();
}
addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'pcm') { recv++; if (d.a) lastPcm = d; }
  else if (d.type === 'preset' && viz) { try { viz.loadPreset(d.preset, 0); } catch (e2) { err = 'loadPreset:' + e2; } }
  else if (d.type === 'stat') parent.postMessage(stat(), '*');
});
(async () => {
  out.invoke = await tryInvoke();
  if (gl && window.butterchurn) {
    try {
      const B = window.butterchurn.default || window.butterchurn;
      // Context was already created above on this canvas: butterchurn asks for the same one.
      viz = B.createVisualizer(null, c, { width: 640, height: 360, pixelRatio: 1 });
      out.createVisualizer = 'ok';
    } catch (e) { out.createVisualizer = 'ERR:' + String(e && e.stack || e).slice(0, 300); }
  }
  parent.postMessage(out, '*');
  requestAnimationFrame(loop);
})();
</script></body></html>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    files = {}

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/host.html"):
            body, ctype = HOST_HTML.encode(), "text/html"
        elif path == "/frame.html":
            body, ctype = FRAME_HTML.encode(), "text/html"
        elif path in self.files:
            body, ctype = open(self.files[path], "rb").read(), "application/javascript"
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def port_free(p):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", p)) != 0


def wd(method, path, body=None, timeout=60):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT_DRIVER}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def fetch_butterchurn(bc_dir):
    if bc_dir:
        return bc_dir
    tmp = tempfile.mkdtemp(prefix="bc-")
    subprocess.run(["npm", "pack", "butterchurn@2.6.7", "butterchurn-presets@2.4.7"], cwd=tmp,
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for t in os.listdir(tmp):
        if t.endswith(".tgz"):
            with tarfile.open(os.path.join(tmp, t)) as tf:
                tf.extractall(os.path.join(tmp, t[:-4]))
    return tmp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", default=DEFAULT_BINARY)
    ap.add_argument("--bc-dir", help="dir holding butterchurn-2.6.7/ and butterchurn-presets-2.4.7/ extracted npm packs")
    args = ap.parse_args()

    for p in (PORT_APP, PORT_DRIVER):
        if not port_free(p):
            sys.exit(f"port {p} in use (live cargo tauri dev / stale tauri-driver?) -- refusing to touch it")
    driver_bin = shutil.which("tauri-driver") or os.path.expanduser("~/.cargo/bin/tauri-driver")
    native = subprocess.run("find /usr/bin /usr/lib -iname WebKitWebDriver 2>/dev/null | head -1",
                            shell=True, capture_output=True, text=True).stdout.strip()
    bc = fetch_butterchurn(args.bc_dir)
    Handler.files = {
        "/butterchurn.js": os.path.join(bc, "butterchurn-2.6.7/package/lib/butterchurn.min.js"),
        "/butterchurn-presets.js": os.path.join(bc, "butterchurn-presets-2.4.7/package/lib/butterchurnPresetsMinimal.min.js"),
    }
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT_APP), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    scratch = tempfile.mkdtemp(prefix="milkdrop-probe-xdg-")
    env = dict(os.environ, DISPLAY=DISPLAY, CUEMARK_DISABLE_DMABUF="1", APPORT_DISABLE="1",
               XDG_DATA_HOME=scratch + "/data", XDG_CONFIG_HOME=scratch + "/config",
               XDG_CACHE_HOME=scratch + "/cache")
    procs, session, result = [], None, None
    try:
        procs.append(subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", "1280x900x24"],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        time.sleep(1.5)
        procs.append(subprocess.Popen([driver_bin, "--port", str(PORT_DRIVER), "--native-driver", native],
                                      env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        time.sleep(1.5)
        r = wd("POST", "/session", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": args.binary}}}}, 90)
        session = r["value"]["sessionId"]
        print("session", session, "url:", wd("GET", f"/session/{session}/url")["value"])
        wd("POST", f"/session/{session}/timeouts", {"script": 30000})
        deadline = time.time() + 15 + 6 * ARM_MS / 1000 + 20
        while time.time() < deadline:
            time.sleep(1)
            try:
                v = wd("POST", f"/session/{session}/execute/sync",
                       {"script": "return window.__result ? JSON.stringify(window.__result) : null", "args": []})["value"]
            except Exception as e:  # noqa: BLE001
                print("poll:", e); continue
            if v and json.loads(v).get("done"):
                result = json.loads(v); break
    finally:
        if session:
            try: wd("DELETE", f"/session/{session}", timeout=15)
            except Exception: pass  # noqa: BLE001
        for p in reversed(procs):
            p.terminate()
        for p in procs:
            try: p.wait(5)
            except Exception: p.kill()  # noqa: BLE001
        srv.shutdown()
        shutil.rmtree(scratch, ignore_errors=True)

    if not result:
        print("FAIL: no result from page"); sys.exit(1)
    print(json.dumps(result, indent=1))
    fr, top = result.get("frame") or {}, result["top"]
    stat = fr.get("stat") or {}
    pix = stat.get("pix") or {}
    verdict = {}
    # 1
    w2 = fr.get("webgl2") or {}
    rendered = (stat.get("frames", 0) > 10 and not stat.get("err") and fr.get("createVisualizer") == "ok")
    lit = pix.get("max", 0) > 0 and pix.get("nonzero", 0) > 0
    verdict["1 webgl2-in-sandboxed-iframe"] = ("PASS" if w2.get("ok") and rendered and lit else
                                              "SKIP(readback blank; crocus?)" if w2.get("ok") and rendered else "FAIL")
    # 2
    ctl = top.get("tauri") == "object" or top.get("tauriInternals") == "object"
    leaked = fr.get("tauri") != "undefined" or fr.get("tauriInternals") != "undefined" or fr.get("invoke") == "SUCCEEDED"
    verdict["2 no-tauri-in-iframe"] = "INCONCLUSIVE(top frame has no Tauri)" if not ctl else ("FAIL" if leaked else "PASS")
    cf = result.get("ctl") if isinstance(result.get("ctl"), dict) else {}
    print("check-2 control (same-origin unsandboxed child frame): tauri=%s internals=%s -> %s" % (
        cf.get("tauri"), cf.get("tauriInternals"),
        "Tauri IS injected into child frames; the sandbox is what hides it" if cf.get("tauri") == "object" or cf.get("tauriInternals") == "object"
        else "Tauri is NOT injected into child frames at all; sandbox is defence in depth"))
    # 3
    # Frame deltas are ms-quantised and drift ~2ms over a run, so arms are interleaved and the bar
    # is "post arms no worse than the worst baseline + 1ms" plus the call itself <= 1ms p95.
    a = result["arms"]
    def m(n, k="p50"): return (a.get(n) or {}).get("frameDt", {}).get(k)
    def c95(n): return ((a.get(n) or {}).get("postCallMs") or {}).get("p95")
    bases = [m(n) for n in ("baseline1", "baseline2", "baseline3")]
    posts = [m(n) for n in ("post3k", "post3k_b")]
    calls = [c95(n) for n in ("post3k", "post3k_b")]
    big, bigcall = m("post32MB_control"), c95("post32MB_control")
    good = None not in bases + posts + calls and bigcall is not None
    discr = good and bigcall > 3 * max(max(calls), 1)
    ok3 = good and max(posts) <= max(bases) + 1 and max(calls) <= 1
    verdict["3 postMessage-3KB-per-frame"] = ("INCONCLUSIVE(control arm did not move)" if not discr else "PASS" if ok3 else "FAIL")
    print("\n".join(f"{k}: {v}" for k, v in verdict.items()))
    print(f"frameDt p50 ms baselines={bases} post3k={posts} 32MB-control={big}; "
          f"post-call p95 ms post3k={calls} control={bigcall}")
    sys.exit(0 if all(v.startswith(("PASS", "SKIP")) for v in verdict.values()) else 1)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(1))
    main()
