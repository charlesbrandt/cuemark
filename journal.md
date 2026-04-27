# 2026.04.25 17:59:39 — project initialized
Set up repo with todo.md / journal.md notes convention.

---

# 2026.04.26 — output window, drag-and-drop, video playback

## What shipped

**Output window** — second `WebviewWindow` opens at 1280×720 (not fullscreen by default so
it's usable on a single display). Press `F` to fullscreen once moved to the projector; `Esc`
to exit. Compositor frames posted via `BroadcastChannel('cuemark-output')` as `ImageBitmap`
— no Rust round-trip. `preserveDrawingBuffer: true` on the WebGL context lets
`createImageBitmap(canvas)` read the backbuffer after composite.

**OS drag-and-drop** — Tauri intercepts native file-drop before HTML5 DataTransfer is
populated (`e.dataTransfer` is always empty in the DOM handler). Fix: `onDragDropEvent()`
from `@tauri-apps/api/webview` gives the real filesystem paths + screen position.
`elementFromPoint` + `[data-deck-id]` attribute identifies the target deck.

**Video playback** — four separate bugs found and fixed:

1. **`$effect` never re-ran after mount** — `compositor` was a plain `let`, not `$state`.
   In Svelte 5, `$effect` only tracks reactive reads that actually execute. Because
   `if (!compositor) return` fired before `$session.decks` was ever read, Svelte never
   registered the session dependency and the effect stayed dead after mount. Fix: declare
   `compositor = $state(...)` and read `$session.decks` before the early-return guard.

2. **Video restarted on every effect run** — `v.src` (the DOM property) returns the
   absolute URL (`http://localhost:1420/media/...`) but `src` was a relative string
   (`/media/...`). They're never equal → `v.load()` called on every session change →
   video looped every ~30 s. Fix: compare with `v.getAttribute('src')` which returns
   the raw attribute value.

3. **Direct `video → texImage2D` crashes WebKitGTK** — calling
   `gl.texImage2D(..., videoElement)` triggers a SIGTRAP assertion failure in
   `libwebkit2gtk`. Fix: draw video onto an `HTMLCanvasElement` scratch buffer first
   (`drawImage(video, ...)`), then upload the canvas. Clean, stable path in WebKit.

4. **Video upside-down** — HTML canvas Y=0 is top; WebGL texture Y=0 is bottom.
   Fix: `gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)` around the `texImage2D` call.

**GStreamer / file serving** — GStreamer (WebKitGTK's media backend) cannot speak
WebKit custom URI schemes (`asset://`, `media://`) for `<video>` elements. `file://`
is blocked by same-origin policy when the page is served from `http:`. Solution: Vite
dev middleware serves local files as plain `http://localhost:1420/media/<abs-path>` with
Range support — GStreamer's `souphttpsrc` handles this perfectly. Production will use the
Rust `media://` custom scheme handler.
