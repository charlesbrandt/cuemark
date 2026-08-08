#!/usr/bin/env python3
"""Does this WebKitGTK deliver **Pointer Events** for mouse input on a `<canvas>`?

Motivation: `WaveformCanvas.svelte`'s drag-to-scrub gesture (see
`docs/design/waveform-scrub.md`) is built on `pointerdown` + window-level
`pointermove`/`pointerup`. This project has repeatedly been bitten by web APIs that are
*present* on this WebKitGTK and silently do nothing (`UNPACK_FLIP_Y_WEBGL` for
`ImageBitmap`, `createImageBitmap(…, imageOrientation)` for `VideoFrame`,
`VideoDecoder.isConfigSupported` returning true for AV1 and then decoding zero frames), so
"the API exists" is not evidence that it works. A pointer API that exists but never fires
would leave the waveform inert with no error anywhere.

Two independent stages, because they can disagree and the disagreement is the interesting
part:

  api.*        Surface only: is `window.PointerEvent` a constructor, does a canvas expose
               `onpointerdown`, does `setPointerCapture` exist. Cheap, and decisive in the
               negative — if this fails, the gesture must be rebuilt on mouse events.
  synthetic.*  `dispatchEvent(new PointerEvent(...))`. Proves the listener wiring and the
               event shape (`clientX`, `button`), nothing about the platform.
  gdk.*        The real path: GDK button/motion events pushed into the WebView exactly as
               an X11 mouse would produce them, so WebKit's own platform → DOM translation
               is what is under test. This is the only stage that can distinguish "WebKit
               dispatches pointer events for mouse" from "the constructor exists".

A useful pass is `gdk.pointerdown/pointermove/pointerup` all non-zero **and** the
`pointermove` coordinates tracking the injected positions. `gdk.mouse*` fires as a control:
if mousedown arrives and pointerdown does not, Pointer Events are not wired to mouse input
here and the drag must be rebuilt on mouse events.

Usage:
    APPORT_DISABLE=1 xvfb-run -a python3 scripts/probes/pointer_events_probe.py

Seconds, no app, no media files.
"""
import json
import sys

import gi

gi.require_version("WebKit2", "4.1")
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, WebKit2, GLib  # noqa: E402

# Canvas geometry inside the page; the GDK stage aims at the middle of it.
CANVAS_X, CANVAS_Y, CANVAS_W, CANVAS_H = 20, 20, 400, 72

PAGE = r"""<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body { margin:0; padding:0; }
  #c { position:absolute; left:__CX__px; top:__CY__px;
       width:__CW__px; height:__CH__px; background:#123; touch-action:none; }
</style></head><body>
<canvas id="c" width="__CW__" height="__CH__"></canvas>
<script>
const c = document.getElementById('c');
const out = {
  api: {
    PointerEvent: typeof window.PointerEvent === 'function',
    onpointerdownInCanvas: ('onpointerdown' in c),
    setPointerCapture: (typeof c.setPointerCapture === 'function'),
    pointerType: null,
  },
  synthetic: { pointerdown: 0, pointermove: 0, pointerup: 0, clientX: null, button: null },
  gdk: { pointerdown: 0, pointermove: 0, pointerup: 0,
         mousedown: 0, mousemove: 0, mouseup: 0,
         moveXs: [], downX: null, upX: null },
};

// Stage flag: the same listeners serve both stages, so they must know which is running
// or the synthetic counts and the GDK counts would be indistinguishable.
let stage = 'synthetic';
function bump(name, e) {
  const b = out[stage];
  if (b[name] !== undefined) b[name]++;
  if (stage === 'synthetic') {
    if (name === 'pointerdown') { out.synthetic.clientX = e.clientX; out.synthetic.button = e.button; }
  } else {
    if (name === 'pointerdown') { out.gdk.downX = e.clientX; out.api.pointerType = e.pointerType; }
    if (name === 'pointerup') out.gdk.upX = e.clientX;
    if (name === 'pointermove' && out.gdk.moveXs.length < 12) out.gdk.moveXs.push(Math.round(e.clientX));
  }
}

// Mirrors the shipping gesture: down on the element, move/up on window (the pointer
// routinely leaves a 72px-tall canvas mid-drag).
c.addEventListener('pointerdown', e => bump('pointerdown', e));
window.addEventListener('pointermove', e => bump('pointermove', e));
window.addEventListener('pointerup', e => bump('pointerup', e));
// Control arm — if these fire while the pointer* ones do not, the platform delivers mouse
// input but not Pointer Events.
c.addEventListener('mousedown', e => bump('mousedown', e));
window.addEventListener('mousemove', e => bump('mousemove', e));
window.addEventListener('mouseup', e => bump('mouseup', e));

function runSynthetic() {
  if (!out.api.PointerEvent) return;
  const at = (t, x) => new PointerEvent(t, {
    clientX: x, clientY: __CY__ + 30, button: 0, buttons: t === 'pointerup' ? 0 : 1,
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
  });
  c.dispatchEvent(at('pointerdown', __CX__ + 10));
  window.dispatchEvent(at('pointermove', __CX__ + 40));
  window.dispatchEvent(at('pointerup', __CX__ + 40));
}
runSynthetic();
stage = 'gdk';

// Driver hooks: Python flips stages and collects via document.title.
window.__report = () => { document.title = "RESULT:" + JSON.stringify(out); };
document.title = "READY";
</script></body></html>"""


def main():
    settings = WebKit2.Settings()
    settings.set_enable_developer_extras(True)
    settings.set_enable_write_console_messages_to_stdout(True)
    view = WebKit2.WebView(settings=settings)
    win = Gtk.Window()
    win.set_default_size(640, 300)
    win.add(view)
    win.show_all()

    result = {}
    loop = GLib.MainLoop()
    state = {"phase": "loading"}

    def inject(evtype, x, y, button=0, pressed=False):
        """Push one GDK event at the WebView exactly as X11 input would."""
        gdkwin = view.get_window()
        if gdkwin is None:
            return False
        ev = Gdk.Event.new(evtype)
        seat = Gdk.Display.get_default().get_default_seat()
        pointer = seat.get_pointer()
        if evtype == Gdk.EventType.MOTION_NOTIFY:
            ev.motion.window = gdkwin
            ev.motion.x, ev.motion.y = float(x), float(y)
            ev.motion.x_root, ev.motion.y_root = float(x), float(y)
            ev.motion.state = Gdk.ModifierType.BUTTON1_MASK if pressed else 0
            ev.motion.time = Gdk.CURRENT_TIME
            ev.motion.set_device(pointer)
        else:
            ev.button.window = gdkwin
            ev.button.x, ev.button.y = float(x), float(y)
            ev.button.x_root, ev.button.y_root = float(x), float(y)
            ev.button.button = button
            ev.button.state = Gdk.ModifierType.BUTTON1_MASK if pressed else 0
            ev.button.time = Gdk.CURRENT_TIME
            ev.button.set_device(pointer)
        ev.set_screen(Gdk.Screen.get_default())
        Gtk.main_do_event(ev)
        return True

    def drive():
        """A press, three moves and a release across the canvas — a scrub in miniature."""
        cy = CANVAS_Y + 30
        x0 = CANVAS_X + 10
        inject(Gdk.EventType.MOTION_NOTIFY, x0, cy)
        inject(Gdk.EventType.BUTTON_PRESS, x0, cy, button=1)
        for dx in (15, 45, 90):
            inject(Gdk.EventType.MOTION_NOTIFY, x0 + dx, cy, pressed=True)
        inject(Gdk.EventType.BUTTON_RELEASE, x0 + 90, cy, button=1, pressed=True)
        # Let WebKit's own event queue drain before asking the page what it saw.
        GLib.timeout_add(600, collect)
        return False

    def collect():
        view.run_javascript("window.__report()", None, None, None)
        return False

    def on_title(v, _p):
        t = v.get_title() or ""
        if t == "READY" and state["phase"] == "loading":
            state["phase"] = "driving"
            GLib.timeout_add(400, drive)
        elif t.startswith("RESULT:"):
            result.update(json.loads(t[7:]))
            loop.quit()

    view.connect("notify::title", on_title)
    page = (PAGE.replace("__CX__", str(CANVAS_X)).replace("__CY__", str(CANVAS_Y))
                .replace("__CW__", str(CANVAS_W)).replace("__CH__", str(CANVAS_H)))
    view.load_html(page, "http://127.0.0.1/")
    GLib.timeout_add_seconds(20, lambda: (loop.quit(), False)[1])
    loop.run()
    win.destroy()

    if not result:
        print("no result — the page never reported (load or JS failure)", file=sys.stderr)
        return 2

    print(json.dumps(result, indent=2))
    api, syn, gdk = result["api"], result["synthetic"], result["gdk"]

    print("\n--- verdict ---")
    if not api["PointerEvent"]:
        print("FAIL: window.PointerEvent does not exist — rebuild the drag on mouse events.")
        return 1
    print("ok: PointerEvent constructor, onpointerdown on canvas, "
          f"setPointerCapture={api['setPointerCapture']}")
    if not (syn["pointerdown"] and syn["pointermove"] and syn["pointerup"]):
        print(f"FAIL: synthetic dispatch did not reach the listeners: {syn}")
        return 1
    print("ok: synthetic dispatch reaches element + window listeners")

    real = gdk["pointerdown"] and gdk["pointermove"] and gdk["pointerup"]
    mouse = gdk["mousedown"] and gdk["mousemove"] and gdk["mouseup"]
    if real:
        print(f"PASS: GDK mouse input produces real pointer events "
              f"(down/move/up = {gdk['pointerdown']}/{gdk['pointermove']}/{gdk['pointerup']}, "
              f"pointerType={api['pointerType']}, move Xs={gdk['moveXs']})")
        return 0
    if mouse:
        print(f"FAIL: GDK input produced mouse events but NOT pointer events "
              f"(mouse {gdk['mousedown']}/{gdk['mousemove']}/{gdk['mouseup']} vs "
              f"pointer {gdk['pointerdown']}/{gdk['pointermove']}/{gdk['pointerup']}) — "
              f"rebuild the drag on mouse events.")
        return 1
    print(f"INCONCLUSIVE: GDK injection produced no DOM events at all ({gdk}) — the "
          f"synthesis path, not the browser, is what failed. The api/synthetic stages "
          f"above still stand; confirm the drag by hand in the running app.")
    return 3


if __name__ == "__main__":
    sys.exit(main())
