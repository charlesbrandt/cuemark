# [GStreamer] Any WebCodecs VideoEncoder use crashes WebKitWebProcess (SIGABRT) during webkitvideoencoder element registration

**Summary**: On WebKitGTK 2.52.3 (Ubuntu 24.04, GStreamer 1.24.2), the first code
path that registers WebCodecs' internal `webkitvideoencoder` GStreamer element —
`VideoEncoder.isConfigSupported(...)` **or** `encoder.configure(...)` — aborts the
web process. GLib-GObject type-system criticals fire during element registration,
followed by a fatal `gst_register_core_elements: code should not be reached`
assertion. Bare construction (`new VideoEncoder({...})`) is lazy and does not crash
by itself.

Decoding (`VideoDecoder` — including its `isConfigSupported`) is fully functional on
the same build; this is specific to encoder element registration. 100% reproducible
(verified across repeated runs, with and without `WEBKIT_DISABLE_DMABUF_RENDERER=1`).

**Steps to reproduce** (any page, e.g. via the standalone harness below):

```js
// Either of these alone kills the web process:
VideoEncoder.isConfigSupported({ codec: "avc1.42001f", width: 320, height: 240 });
// or:
const e = new VideoEncoder({ output: () => {}, error: () => {} }); // survives...
e.configure({ codec: "avc1.42001f", width: 320, height: 240,
              bitrate: 1_000_000, framerate: 30 });                // ...this crashes
```

**Console output at crash**:

```
GLib-GObject-CRITICAL: g_param_spec_boxed: assertion 'G_TYPE_IS_BOXED (boxed_type)' failed
GLib-GObject-CRITICAL: validate_pspec_to_install: assertion 'G_IS_PARAM_SPEC (pspec)' failed
GLib-GObject-CRITICAL: g_param_spec_ref_sink: assertion 'G_IS_PARAM_SPEC (pspec)' failed
GLib-GObject-CRITICAL: g_param_spec_unref: assertion 'G_IS_PARAM_SPEC (pspec)' failed
GLib-GObject-CRITICAL: g_object_new_is_valid_property: object class 'GstPadTemplate' has no property named 'caps'
GLib-GObject-CRITICAL: g_object_new_is_valid_property: object class 'GstPadTemplate' has no property named 'caps'
GStreamer-WARNING: Element factory metadata for 'webkitvideoencoder' has no valid long-name field
(WebKitWebProcess): GStreamer-WARNING: Element factory metadata for 'bin' has no valid long-name field
**
GStreamer:ERROR:../gst/gst.c:617:gst_register_core_elements: code should not be reached
Bail out! GStreamer:ERROR:../gst/gst.c:617:gst_register_core_elements: code should not be reached
```

Apport records `WebKitWebProcess crashed with SIGABRT in ???()`, package
`libwebkit2gtk-4.1-0 2.52.3-0ubuntu0.24.04.1`.

**Analysis**: the `GstPadTemplate has no property named 'caps'` / `G_TYPE_IS_BOXED`
criticals during element registration are the classic signature of GStreamer's GObject
types being registered against a mismatched/uninitialized type table — as if the
`webkitvideoencoder` registration path runs against a different libgstreamer state
than the one `gst_init` populated (double registration, or registration before init in
this process). The subsequent failure to register even the core `bin` element
(`gst_register_core_elements`) suggests the type-system damage is global to the
process once the first registration fails.

**Environment**: reproduced both with default env and with
`WEBKIT_DISABLE_DMABUF_RENDERER=1` plus `GST_PLUGIN_FEATURE_RANK`
va-decoder demotions; identical result. Under Xvfb and on a real session.

**Standalone reproducer** (Python, python3-gi + gir1.2-webkit2-4.1; run with
`xvfb-run -a python3 repro.py` or on any display):

```python
import gi
gi.require_version('WebKit2', '4.1'); gi.require_version('Gtk', '3.0')
from gi.repository import WebKit2, Gtk, GLib

PAGE = """<script>
  VideoEncoder.isConfigSupported({codec:'avc1.42001f', width:320, height:240})
    .then(r => { document.title = 'SUPPORTED:' + r.supported; })
    .catch(e => { document.title = 'ERR:' + e; });
</script>"""

win = Gtk.Window(); view = WebKit2.WebView(); win.add(view); win.show_all()
view.connect('web-process-terminated',
             lambda v, r: print('WEB PROCESS TERMINATED:', r.value_nick))
GLib.timeout_add_seconds(5, Gtk.main_quit)
view.load_html(PAGE, 'http://localhost/')
Gtk.main()
```

Expected: title becomes `SUPPORTED:true` / `SUPPORTED:false`. Actual:
`web-process-terminated` (`crashed`) with the assertion output above; the promise
never settles.
