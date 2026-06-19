---
name: verify-ui
description: Drive the actual cuemark app window headlessly via tauri-driver (WebDriver) + Xvfb — click elements, read the DOM, and screenshot the canvas-rendered video/waveform — without touching the user's real desktop session. Use when asked to visually verify a UI change (deck preview, waveform, compositor output) and no interactive display is available, or to avoid disturbing the user's live `:0`/`wayland-0` session.
---

# Headless UI verification (tauri-driver + Xvfb)

This drives the **real** webview (not a mock, not a unit test) inside an isolated
virtual display, so screenshots reflect actual WebGL/canvas rendering. It does not
replace `run-app` for normal dev-loop testing — use this specifically when you need
a screenshot or DOM-level assertion and don't want to touch the user's live session.

## One-time setup

Requires `sudo` — the user runs this themselves (see `README.md`):
```sh
sudo apt-get install xvfb webkit2gtk-driver
cargo install tauri-driver
```
Verify before starting a session:
```sh
which Xvfb tauri-driver
dpkg -L webkit2gtk-driver | grep WebKitWebDriver
```
If any of these are missing, stop and tell the user — don't try to work around it.

## 1. Build a real (non-dev-server) binary

`tauri-driver` launches the compiled binary directly — it does not go through
`cargo tauri dev`'s Vite dev server. **You must use `cargo tauri build`, not a plain
`cargo build`/`cargo build --release`.** `tauri.conf.json` has both `devUrl` and
`frontendDist` set; only the Tauri CLI's build pipeline clears `devUrl` before
compiling, so the binary loads `tauri://localhost` (the bundled `dist/`) instead of
trying to reach the Vite dev server. A plain `cargo build` — debug *or* release —
bakes in the unmodified config and the resulting binary tries to load
`http://localhost:1420/` regardless of profile, which fails with a blank
"Could not connect to localhost: Connection refused" page once nothing is serving
that port (confirmed empirically — this is not a guess).

```sh
cd /home/account/repos/cuemark
cargo tauri build --debug --no-bundle
# binary lands at src-tauri/target/debug/cuemark
# (the command itself prints "Info application at: ...")
```
Use `--no-bundle` to skip installer/AppImage generation — we only need the binary.
Drop `--debug` for a release-profile binary if needed (slower build, same fix).
Re-run after frontend or Rust changes — this binary is a separate build from
whatever `cargo tauri dev` produced, so a stale one will not reflect recent edits.
Sanity-check after launching a session: `GET /session/$SESSION/url` should report
`tauri://localhost`, not `http://localhost:1420/`.

## 2. Start the isolated display

Use a display number that is **not** `:0` / `wayland-0` (the user's real session):
```sh
Xvfb :99 -screen 0 1280x900x24 > /tmp/xvfb.log 2>&1 &
echo $! > /tmp/xvfb.pid
```

## 3. Start tauri-driver on that display

```sh
WEBKIT_DRIVER=$(dpkg -L webkit2gtk-driver | grep WebKitWebDriver)
DISPLAY=:99 tauri-driver --port 4444 --native-driver "$WEBKIT_DRIVER" > /tmp/tauri-driver.log 2>&1 &
echo $! > /tmp/tauri-driver.pid
sleep 1
```
`tauri-driver` proxies the W3C WebDriver protocol to `WebKitWebDriver`, which it
launches itself — it inherits `DISPLAY` from its own environment, so the app appears
on `:99`, not the real screen.

## 4. Create a session (this launches the app)

```sh
BINARY=/home/account/repos/cuemark/src-tauri/target/debug/cuemark
SESSION=$(curl -s -X POST http://localhost:4444/session \
  -H "Content-Type: application/json" \
  -d "{\"capabilities\":{\"alwaysMatch\":{\"tauri:options\":{\"application\":\"$BINARY\"}}}}" \
  | jq -r '.value.sessionId')
echo "session: $SESSION"
```

## 5. Drive it

**Screenshot** (the actual rendered webview, including WebGL canvases):
```sh
curl -s http://localhost:4444/session/$SESSION/screenshot \
  | jq -r '.value' | base64 -d > /tmp/cuemark-screenshot.png
```
Read the PNG back with the Read tool to actually look at it — a blank/black frame
is a failure, not a pass.

**Find + click an element** (CSS selector):
```sh
ELEMENT=$(curl -s -X POST http://localhost:4444/session/$SESSION/element \
  -d '{"using":"css selector","value":"button.play-btn"}' | jq -r '.value["element-6066-11e4-a52e-4f735466cecf"]')
curl -s -X POST http://localhost:4444/session/$SESSION/element/$ELEMENT/click -d '{}'
```

**Execute arbitrary JS in page context** (`/execute/sync`) — this is the way to
inspect or mutate Svelte state directly:
```sh
curl -s -X POST http://localhost:4444/session/$SESSION/execute/sync \
  -H "Content-Type: application/json" \
  -d '{"script":"return document.querySelectorAll(\".waveform-canvas\").length","args":[]}'
```

### Caveat: native dialogs and drag-and-drop are out of reach

WebDriver only controls the webview's DOM/JS — it cannot interact with the native
GTK "Open File" dialog or simulate OS-level drag-and-drop onto the window. Loading a
track for a screenshot test therefore can't go through the file picker or drag-drop
UI. The workaround is to call the session store directly via `/execute/sync`, but
that requires the store's mutators (`updateDeck`, etc.) to be reachable from `window`
— they currently are not exposed. If a test needs to load a real track, either:
- add a small dev-only hook (e.g. `window.__cuemarkDebug = { updateDeck }` in
  `App.svelte`, gated behind `import.meta.env.DEV`) the first time this is needed, or
- ask the user whether they want that hook added permanently for this purpose.
Don't add it speculatively — wait until a verification task actually needs it.

## 6. Tear down

Always clean up, even on failure — leftover processes hold the display and port:
```sh
curl -s -X DELETE http://localhost:4444/session/$SESSION
kill $(cat /tmp/tauri-driver.pid) 2>/dev/null; rm -f /tmp/tauri-driver.pid
kill $(cat /tmp/xvfb.pid) 2>/dev/null; rm -f /tmp/xvfb.pid
```

## Gotchas

- **`WebKitWebDriver` runs unsandboxed by default** — it disables WebKit's bubblewrap sandbox itself
  for automation purposes, regardless of `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS`. This means you
  cannot use a tauri-driver session to A/B test sandbox-related hypotheses (e.g. "does GPU device
  access fail under the sandbox?") — both the sandboxed and "unsandboxed" runs through this path behave
  identically because the sandbox is already off either way. For that kind of test, launch the real
  binary directly from a terminal instead (see `run-app` skill / `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS`).
- **Port 4444 already bound**: a previous `tauri-driver` didn't get killed —
  `fuser -k 4444/tcp` before starting a new one.
- **`WebKitWebDriver` version mismatch**: `webkit2gtk-driver` must match the
  installed `libwebkit2gtk-4.1-0` version or the driver handshake fails immediately.
  `apt-get upgrade webkit2gtk-driver` if cuemark's WebKit dependency is bumped.
- **One session at a time**: `tauri-driver` does not multiplex; creating a second
  session before deleting the first will hang or error.
- **GStreamer/audio still runs for real** inside Xvfb — if the verification task
  doesn't need audio, prefer testing decks with `shader` sources or check what
  happens with no PipeWire sink available rather than risk audio device contention
  with the user's real session.
- **Don't run a `cargo build`/`cargo check` concurrently with the `cargo tauri build`
  in step 1** — both write to the same `target/` directory, and a concurrent debug
  build racing the release/driver build observed a one-off "unresolved crate" error
  on a dependency that was present in `Cargo.toml` all along (transient cache
  corruption from the lock contention, not a real missing dependency). Retrying
  cleanly resolved it. If it happens, check no other cargo process is running
  before suspecting the code.
