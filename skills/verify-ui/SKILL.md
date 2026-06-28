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
dpkg -L webkit2gtk-driver | grep -E '/WebKitWebDriver$'
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
WEBKIT_DRIVER=$(dpkg -L webkit2gtk-driver | grep -E '/WebKitWebDriver$')
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

### Native dialogs and drag-and-drop are out of reach — use the debug hook instead

WebDriver only controls the webview's DOM/JS — it cannot interact with the native
GTK "Open File" dialog or simulate OS-level drag-and-drop onto the window. Loading a
track or toggling playback for a test therefore can't go through the file picker or
drag-drop UI.

`App.svelte`'s `onMount` exposes `window.__cuemarkDebug` for exactly this — call
session mutators and audio IPC helpers directly via WebDriver:

| Method | Sync/Async | Purpose |
|---|---|---|
| `updateDeck(id, patch)` | sync | Mutate session state (source, playing, rate, …) |
| `addDeck()` / `removeDeck(id)` | sync | Add or remove decks |
| `setVisualization(v)` / `setVisualizationOpacity(n)` | sync | Drive the global visualization layer |
| `getSession()` | sync | Read current session snapshot |
| `getVideoTime(deckId)` | sync | Returns `video.currentTime` for the deck's `<video>` element |
| `getAudioTime(deckId)` | sync | Returns `getDeckTime(deckId)` — the waveform's content-position clock (rate-corrected from GStreamer) |
| `seek(deckId, time)` | sync | Seeks the deck to `time` seconds; sets `pendingSeekTarget` to filter stale pre-seek GStreamer IPC responses; clears `audioTimes` so `getDeckTime` falls back to `v.currentTime` immediately |
| `measureAudioIpc(deckId, rate, reps=20)` | **async** | Sequential `audio_set_rate` round-trips → `{min,p50,p99,max,mean}` ms |
| `simulateMidiRateBurst(deckId, count=200, intervalMs=5)` | **async** | Fire-and-forget rate changes at MIDI speed → `{fired, durationMs}` |

Use `/execute/sync` for sync methods, `/execute/async` for the async ones (they return Promises):
```sh
# Sync example — load a track
curl -s -X POST http://localhost:4444/session/$SESSION/execute/sync \
  -H "Content-Type: application/json" \
  -d '{"script":"window.__cuemarkDebug.updateDeck(\"deck-0\", {source:{type:\"video\",filePath:\"/path/to.mp4\",duration:0}, playing:false}); return window.__cuemarkDebug.getSession().decks[0].source","args":[]}'

# Async example — measure IPC latency
curl -s -X POST http://localhost:4444/session/$SESSION/execute/async \
  -H "Content-Type: application/json" \
  -d '{"script":"const done=arguments[0]; window.__cuemarkDebug.measureAudioIpc(\"deck-0\",1.0,20).then(r=>done(JSON.stringify(r)))","args":[]}'
```

**This hook is gated behind `VITE_ENABLE_DEBUG_HOOK=1`, not just `import.meta.env.DEV`**
— `cargo tauri build --debug` (step 1 above) still runs `vite build`, which always sets
`DEV=false` regardless of the Rust profile. Without the env var the hook silently isn't
in `dist/`, `window.__cuemarkDebug` is `undefined` in the WebDriver session, and the
build for real use never has the hook at all. Build for testing with:
```sh
VITE_ENABLE_DEBUG_HOOK=1 cargo tauri build --debug --no-bundle
```
Sanity-check before trusting a test run: `grep -q '__cuemarkDebug' dist/assets/*.js`
should match.

Two scripts use this hook as their test driver:

- **`scripts/perf-idle-test.sh [video]`** — CPU regression. Mutates session state (load/play/pause
  decks, enable visualization layer) and samples `WebKitWebProcess` CPU% via `pidstat` across each
  scenario. Run after touching the render loop, `WaveformCanvas`, or `DeckCard` preview canvas.
- **`scripts/latency-test.sh <video>`** — Full deck workflow. Loads a track, waits for the waveform
  canvas to have non-black pixels, confirms `video.currentTime` advances, times `audio_set_rate` IPC
  round-trips (min/p50/p99/max/mean), fires a 200-event burst at 200 Hz while sampling CPU, then runs
  two position-correctness checks: step 7 verifies that position advances ~6 s in 3 real seconds at
  2× rate (catches the `contentPosTracker` wall-clock bug), and step 8 verifies that
  `getAudioTime`/`getVideoTime` agree within 500 ms (catches waveform drift from `seekBus.ts` stale
  values). Run after touching the MIDI handler, `audioSync.ts`, `seekBus.ts`, or the GStreamer audio
  pipeline.

## 6. Tear down

Always clean up, even on failure — leftover processes hold the display and port:
```sh
curl -s -X DELETE http://localhost:4444/session/$SESSION
kill $(cat /tmp/tauri-driver.pid) 2>/dev/null; rm -f /tmp/tauri-driver.pid
kill $(cat /tmp/xvfb.pid) 2>/dev/null; rm -f /tmp/xvfb.pid
```

## Gotchas

- **`dpkg -L webkit2gtk-driver | grep WebKitWebDriver` matches two lines**, not one — the
  binary (`/usr/bin/WebKitWebDriver`) and its man page (`/usr/share/man/man1/
  WebKitWebDriver.1.gz`, which also contains the string). `$WEBKIT_DRIVER` then holds both
  paths newline-joined, and `tauri-driver --native-driver "$WEBKIT_DRIVER"` fails immediately
  with `can not find the supplied binary path /usr/bin/WebKitWebDriver\n/usr/share/man/...`.
  Anchor the pattern: `grep -E '/WebKitWebDriver$'`.
- **Sampling CPU% for a perf comparison**: use `pidstat -p <pid> 1 <seconds>`, not `ps -p
  <pid> -o %cpu` — `ps`'s `%cpu` is averaged over the process's entire lifetime, so it drifts
  toward whatever the load was right after launch and takes a long time to reflect a change
  in current behavior. `pidstat`'s per-second samples (the `Average:` row's 7th data column,
  i.e. `awk '/^Average:/{print $8}'`) are point-in-time and correct for "what is this process
  doing right now."
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
  doesn't need audio, prefer leaving decks empty (no source loaded) or using only the
  global visualization layer (`Session.visualization` — no deck/audio involvement) rather
  than risk audio device contention with the user's real session. (Decks are video-only;
  there is no shader deck source anymore — visualizations are a separate global layer.)
- **Shell `js_sync`/`js_async` helpers must use `jq --arg` to build the JSON body** —
  embedding `$1` directly via `"{\"script\":\"$1\",\"args\":[]}"` breaks silently when
  the script contains `"` characters (e.g. `filePath:"..."`): those quotes aren't escaped
  in the JSON string, producing malformed JSON that WebDriver rejects without any error
  (the call just returns nothing). The affected helper and everything downstream fails
  quietly with empty values. Fix: use `jq -n --arg script "$1" '{"script":$script,"args":[]}'`
  to construct the body — `jq --arg` always produces valid JSON regardless of quotes or
  backslashes in the value. This applies to any shell WebDriver helper that takes a script
  string as a variable.
- **`/execute/async` Promise chains must include `.catch()`** — if the Promise rejects
  (e.g. `audio_set_rate` fails because no pipeline exists) and the `.then()` handler never
  calls `arguments[0](result)`, WebDriver waits until its script timeout (30 s default)
  before returning an error. Add `.catch(e => done(JSON.stringify({error: String(e)})))` to
  every async chain that calls `done` — this converts rejections into an immediate response
  instead of a 30-second hang.
- **Don't run a `cargo build`/`cargo check` concurrently with the `cargo tauri build`
  in step 1** — both write to the same `target/` directory, and a concurrent debug
  build racing the release/driver build observed a one-off "unresolved crate" error
  on a dependency that was present in `Cargo.toml` all along (transient cache
  corruption from the lock contention, not a real missing dependency). Retrying
  cleanly resolved it. If it happens, check no other cargo process is running
  before suspecting the code.
- **`latency-test.sh` step 7: rate-then-seek, not seek-then-rate.** When the test needs to both change
  `playbackRate` and seek, it must set the rate first (and pause ~200 ms for the WebKit pipeline rebuild
  to settle), then seek. If the seek fires while the rebuild is still running, the new WebKit pipeline
  re-reads GStreamer's position mid-seek (still the pre-seek value) and writes it back into `v.currentTime`,
  silently undoing the seek — `getVideoTime()` then returns the pre-seek position even after a full second
  of sleep. The `pendingSeekTarget` filter in the RAF loop is a safety net for programmatic seeks, but the
  correct fix for test scripts is ordering: rate change → settle → seek.
- **`latency-test.sh` step 6 burst timeout on heavy videos.** JS `setInterval` is throttled by the browser
  under CPU load; a heavy H.264 music video can slow 5 ms ticks to ~150 ms, making a 200-event burst take
  ~30 s. The script sets the WebDriver script timeout to 60 s before the burst call and restores it
  afterward. The CPU > 80% failure for heavy content is expected (video decoder alone uses ~70% CPU) — use
  a light DJ clip to verify the 80% threshold if needed.
- **Not just sandbox A/B testing — anything where main-thread responsiveness matters is unreliable
  through this path.** A 2026-06-20 session debugging a render-loop freeze (WebKit's own
  `WatchDogQueue` watchdog killing the renderer under CPU load — see `audio-debugging` skill) needed
  a direct terminal launch of the real binary (`run-app` skill's launcher section) specifically
  because `tauri-driver` automation changes timing/load characteristics enough that the bug may not
  reproduce the same way. When in doubt for *any* timing- or load-sensitive bug (not just sandbox
  questions), prefer a direct terminal launch over this skill and use the production `devtools`/
  `withGlobalTauri` setup to get a real devtools console on the actual binary instead.
