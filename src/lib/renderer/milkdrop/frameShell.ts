/**
 * frameShell.ts — the document that runs inside the Milkdrop sandbox iframe.
 *
 * Milkdrop presets are JavaScript in disguise: Butterchurn turns every preset's equations
 * into functions with `new Function` on each `loadPreset`. The output window has Tauri IPC, so
 * that code runs in `<iframe sandbox="allow-scripts">` with NO `allow-same-origin`: an opaque
 * origin, no parent DOM access (`window.parent.document` throws), and — verified by
 * `scripts/probes/milkdrop_sandbox_iframe_probe.py` — no `__TAURI__`/`__TAURI_INTERNALS__`.
 *
 * ## Why srcdoc and not a URL (the production mixed-scheme question)
 * The spike left one case open: production's output window is `tauri://localhost`, and an
 * `http://127.0.0.1:<port>` child frame would be a cross-scheme embed that `media_server.rs`
 * would also have to serve with the right `Content-Type`. `srcdoc` sidesteps all of it: the
 * shell is a string handed to the frame, no network request, no scheme, no CORS, no route on
 * the media server. Butterchurn itself (192 KB minified) is *not* embedded in the shell: the
 * parent lazy-`import()`s it as a Vite `?raw` string only when a Milkdrop preset is first
 * selected and `postMessage`s the text in, where the shell runs it as an inline `<script>`.
 * A sandboxed frame has an opaque origin, so it could not fetch a same-origin file anyway.
 *
 * ## Protocol (all over `postMessage`; the parent checks `e.source === iframe.contentWindow`)
 * parent → frame
 *   `{type:'init', lib, width, height}`  run Butterchurn's source, create the visualizer
 *   `{type:'preset', id, preset, blend}` `preset` is the JSON *text*; `blend` seconds
 *   `{type:'pcm', a, b, c}`              three transferred Uint8Array(1024): mono, L, R
 *   `{type:'active', on}`                pause/resume rendering (opacity 0 = nothing to see)
 *   `{type:'stat'}`                      reply with counters (probe/test instrument)
 * frame → parent
 *   `{type:'shell'}`                     the shell script is up; send `init`
 *   `{type:'ready'}`                     visualizer created
 *   `{type:'presetOk', id}`              loadPreset returned without throwing
 *   `{type:'error', stage, message, id?}` stage: 'compile' | 'runtime'
 *   `{type:'stats', ...}` every 5 s      frame counters and render-time percentiles
 *
 * Butterchurn draws with its own WebGL2 context on this frame's canvas; nothing is ever read
 * back (readback is broken on the MacBook Pro's `crocus` driver). The frame is stacked above
 * the compositor canvas and opacity is the CSS opacity of the iframe element.
 */
export const FRAME_SHELL_HTML = String.raw`<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000;overflow:hidden;width:100%;height:100%}
canvas{display:block;width:100%;height:100%}</style></head><body><canvas id="c"></canvas>
<script>
(function () {
  var canvas = document.getElementById('c');
  var viz = null, currentId = null, loaded = false, active = true, dead = false;
  var pcm = null, pcmAt = 0, recv = 0, frames = 0, renderMs = [], lastStatAt = 0, lastErr = null;
  var silence = new Uint8Array(1024); silence.fill(128);
  function post(m) { parent.postMessage(m, '*'); }
  function fail(stage, e, id) {
    var message = (e && e.message) ? e.message : String(e);
    lastErr = message;
    post({ type: 'error', stage: stage, message: message.slice(0, 500), id: id });
  }
  canvas.addEventListener('webglcontextlost', function (ev) {
    ev.preventDefault(); dead = true; fail('runtime', 'WebGL context lost in the Milkdrop frame');
  });
  addEventListener('error', function (ev) { fail('runtime', ev.message || 'script error'); });

  function init(d) {
    try {
      var s = document.createElement('script');
      s.textContent = d.lib;
      document.head.appendChild(s);
      var B = window.butterchurn && (window.butterchurn.default || window.butterchurn);
      if (!B) throw new Error('butterchurn did not load in the frame');
      canvas.width = d.width; canvas.height = d.height;
      viz = B.createVisualizer(null, canvas, { width: d.width, height: d.height, pixelRatio: 1, textureRatio: 1 });
      post({ type: 'ready' });
      requestAnimationFrame(loop);
    } catch (e) { dead = true; fail('runtime', e); }
  }

  function loadPreset(d) {
    if (!viz) return;
    try {
      var obj = JSON.parse(d.preset);
      viz.loadPreset(obj, d.blend || 0);
      currentId = d.id; loaded = true;
      post({ type: 'presetOk', id: d.id });
    } catch (e) {
      // Keep whatever was already showing: a failed load leaves the previous preset running.
      fail('compile', e, d.id);
    }
  }

  function loop() {
    requestAnimationFrame(loop);
    if (!viz || !loaded || !active || dead) return;
    var t0 = performance.now();
    try {
      var fresh = pcm && (t0 - pcmAt) < 500;
      var a = fresh ? pcm.a : silence, b = fresh ? pcm.b : silence, c = fresh ? pcm.c : silence;
      viz.render({ audioLevels: { timeByteArray: a, timeByteArrayL: b, timeByteArrayR: c } });
    } catch (e) { dead = true; fail('runtime', e, currentId); return; }
    frames++;
    renderMs.push(performance.now() - t0); if (renderMs.length > 300) renderMs.shift();
    if (t0 - lastStatAt > 5000) { if (lastStatAt) post(stat('stats')); lastStatAt = t0; }
  }

  function stat(type) {
    var s = renderMs.slice().sort(function (x, y) { return x - y; });
    return { type: type, id: currentId, frames: frames, recv: recv, err: lastErr,
      renderP50: s.length ? +s[s.length >> 1].toFixed(2) : null,
      renderP95: s.length ? +s[Math.floor(s.length * 0.95)].toFixed(2) : null };
  }

  addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'pcm') { recv++; if (d.a && d.b && d.c) { pcm = d; pcmAt = performance.now(); } }
    else if (d.type === 'preset') loadPreset(d);
    else if (d.type === 'init') init(d);
    else if (d.type === 'active') active = !!d.on;
    else if (d.type === 'stat') post(stat('stat'));
  });
  post({ type: 'shell' });
})();
</script></body></html>`;
