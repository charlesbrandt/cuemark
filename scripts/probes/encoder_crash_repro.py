import gi, sys
gi.require_version('WebKit2', '4.1'); gi.require_version('Gtk', '3.0')
from gi.repository import WebKit2, Gtk, GLib

MODE = sys.argv[1] if len(sys.argv) > 1 else "construct"
if MODE == "isconfig":
    JS = """VideoEncoder.isConfigSupported({codec:'avc1.42001f',width:320,height:240})
             .then(r => { document.title = 'ISCONFIG:' + r.supported; })
             .catch(e => { document.title = 'ISCONFIG-ERR:' + e; });"""
elif MODE == "configure":
    JS = """const e = new VideoEncoder({ output: () => {}, error: (err) => { document.title='CB-ERR:'+err; } });
            try { e.configure({codec:'avc1.42001f',width:320,height:240,bitrate:1000000,framerate:30});
                  document.title = 'CONFIGURED'; }
            catch (err) { document.title = 'THREW:' + err; }"""
else:
    JS = """try { new VideoEncoder({ output: () => {}, error: () => {} });
                  document.title = 'CONSTRUCTED'; }
            catch (e) { document.title = 'THREW:' + e; }"""

PAGE = "<script>" + JS + "</script>"
win = Gtk.Window(); view = WebKit2.WebView(); win.add(view); win.show_all()
view.connect('web-process-terminated',
             lambda v, r: print('WEB PROCESS TERMINATED:', r.value_nick))
def poll():
    t = view.get_title()
    if t: print('TITLE:', t)
    return True
GLib.timeout_add(300, poll)
GLib.timeout_add_seconds(5, Gtk.main_quit)
view.load_html(PAGE, 'http://localhost/')
Gtk.main()
