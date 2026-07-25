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

**`which tauri-driver` can report missing when it's actually installed**: `cargo install`
puts the binary at `~/.cargo/bin/tauri-driver`, which isn't always on this shell's `PATH`
(confirmed empirically — a fresh bash session here had it absent). Before concluding it's
not installed, check `ls ~/.cargo/bin/tauri-driver` and invoke it by full path
(`/home/account/.cargo/bin/tauri-driver`) if found, rather than telling the user to
reinstall something that's already there.

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

## Lightweight webview probes without the app (python3-gi)

For "does this machine's WebKitGTK support/do X?" questions — feature detection,
API behavior, crash isolation, perf measurement of a web API — you don't need the
app, a build, or tauri-driver at all. A bare `WebKit2 4.1` GI webview loads the
**same `libwebkit2gtk-4.1` library** Tauri/wry links, so results transfer (verify
in-app before shipping anything that depends on them). This is how the WebCodecs
feasibility spike was run in minutes per question (2026-07-25 — see
`scripts/probes/README.md` and `docs/design/webcodecs-video-path.md`).

Pattern (full working examples in `scripts/probes/`):
- Python: `gi.require_version('WebKit2', '4.1')`, create `Gtk.Window` + `WebKit2.WebView`,
  `view.load_html(PAGE, "http://localhost/")`, run a `GLib.MainLoop`.
- Result channel: the page sets `document.title = "RESULT:" + JSON.stringify(out)`;
  Python polls `view.get_title()` on a `GLib.timeout_add`. No server, no WebDriver.
- Host-side GStreamer (`gi.require_version('Gst', '1.0')`) can prepare real test
  data in the same script (e.g. encode H.264 AUs to feed a decoder under test).
- Crash detection: connect `view.connect('web-process-terminated', ...)` — a probe
  that times out with no title is usually a dead web process.
- Run under `xvfb-run -a`, with the app's env (`WEBKIT_DISABLE_DMABUF_RENDERER=1`,
  the `GST_PLUGIN_FEATURE_RANK` demotions from `main.rs`) so behavior matches.
- **Always set `APPORT_DISABLE=1`** — a WebKitWebProcess crash inside the probe
  otherwise pops Ubuntu's "application stopped unexpectedly" dialog on the user's
  real desktop session (learned live 2026-07-25, twice).
- Feature-flag enumeration: `WebKit2.Settings.get_all_features()` lists every
  WebKit feature with default/status (`webcodecs_probe.py` does this) — the fast
  way to check whether an API needs a settings toggle before blaming its absence.
- **Never touch `VideoEncoder` in probe pages** (`isConfigSupported` or `configure`
  — instant web process SIGABRT on 2.52.3; `docs/upstream/videoencoder-crash.md`).

## Simulating freezes and crashes (for watchdog/recovery testing)

External process-level simulation of the documented freeze mechanisms, useful once
`docs/design/freeze-watchdog.md` lands (and for ad-hoc triage today):
- `kill -STOP <WebKitWebProcess pid>` — closest cheap analog of the mechanism-A
  main-thread freeze (heartbeat/rAF/JS all stop; process alive). `kill -CONT` releases.
- `kill -KILL <pid>` — web process crash path.
- Find the pid: `pgrep -f WebKitWebProcess` and match the one whose ancestor is the
  cuemark binary under test (there may be a `bwrap` sandbox layer in between).
- Rust-side audio can be verified alive during a frozen webview by watching the log
  (`audio_get_position` keeps being served) — the webview is not required for audio.

**A real navigation triggered from OUTSIDE a WebDriver command breaks the WebDriver
session** — found implementing `docs/design/freeze-watchdog.md` phase 3
(`scripts/watchdog-test.sh`). If Rust code calls `WebviewWindow::eval("location.reload()")`,
`.reload()`, or forces one via `kill -KILL` + `.reload()` on a window that has an active
tauri-driver session attached, that session stops answering `/execute/sync` reliably (or
returns `invalid session id`) afterward — **even though the page itself reloaded and
rehydrated correctly** (verify via the Rust log, not another `js_sync` call). This is
different from `rehydration-test.sh`'s own `location.reload()`, which works fine because
it's called *from inside* an `/execute/async` script — i.e. the reload itself is a
WebDriver-issued command in that case, not an external navigation the session has to
notice and recover from.

Practical fallout for any test that forces a recovery/reload and then wants to check
post-reload state:
- **Verify recovery via the Rust log**, not by polling the debug hook through the same
  session afterward (`grep` for your own log lines, e.g. a `recovery sequence ...
  succeeded` or an `adopted deck-X at Ys` line the frontend already logs via
  `frontend_log`/`debugLog`) — the log is unaffected by the session's fate and is
  already the authoritative source (a `[recovery] adopted ...` line only fires from the
  exact code path that also updates the live DOM/session state).
- If you need multiple freeze scenarios in one script, give each its own fresh
  `start_app`/session rather than chaining them through one — trying to reuse a session
  across a scenario that already forced a reload just compounds into "invalid session
  id" for everything after the first.
- Don't use webdriver-only fixed sleeps to time "how long did recovery take" — the Rust
  log's own line timestamps (`[YYYY-MM-DD HH:MM:SS.mmm]` prefix, `date -u -d "<ts>"
  +%s.%N` to convert) give the true moment an event happened, vs. whatever moment your
  polling loop happened to notice it.

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
- **A test script's `cleanup()` must kill the launched app binary itself, not just
  Xvfb/tauri-driver** — none of the existing gate scripts (`rehydration-test.sh`,
  `perf-idle-test.sh`) do this, and it doesn't bite them because they never signal
  processes by pid. But a script that does (e.g. `kill -STOP`/`kill -KILL` on the
  WebKitWebProcess, as `watchdog-test.sh` does) needs it: a stray `cuemark` instance
  left running from an aborted run makes `pgrep -f "^$BINARY\$" | head -1` in the *next*
  run pick an arbitrary (often the wrong, stale) process, silently invalidating every pid
  derived from it. Capture the app's pid once right after creating the session (only
  safe if you first confirmed nothing else matched `$BINARY`), and `kill -KILL` it
  (plus `pkill -KILL -P` its children) in cleanup.
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
- **A shell helper's `bash -c "$(declare -f fn); fn ..."` subshell does NOT inherit the
  outer script's variables** — `declare -f` exports the function *body* only, not the
  `$SESSION`/`$DRIVER_PORT` etc. it closes over. A monitoring loop built this way (to get
  a hard per-call `timeout`) silently called the WebDriver endpoint with an empty session
  ID on every iteration, producing a fast, wrong "empty result" that looked exactly like a
  timeout — nearly reported as a live freeze repro before noticing the elapsed time (0.05s)
  was far too fast for the `timeout 12`/`--max-time 10` that supposedly fired (2026-07-25).
  Either inline the variable values directly into the script string (via `jq -n --arg`, not
  string interpolation — see the gotcha above) or use `curl --max-time` for the timeout
  instead of wrapping in `timeout bash -c`.
- **A polled value that stops changing is not proof of a freeze** — confirmed the hard way
  chasing a suspected second freeze mechanism (2026-07-25, see `audio-debugging` skill's
  "UI frozen solid" entry): a track reaching its natural end also makes a polled
  `getVideoTime()` go flat (WebKitGTK resets `currentTime` to 0 after `ended` fires, with
  `paused=true`), which looks identical to a genuine stall from the polled number alone. A
  monitor that treats "N consecutive identical readings" as a stall signal will false-alarm
  on every clean end-of-track. Before concluding a repro, check the video element's
  `paused`/`ended`/`readyState`/`networkState`/`buffered` (`readyState < 3` mid-playback,
  not `paused`, not `ended` = genuine stall; `paused=true` with `readyState=4` and the full
  range buffered = the track just ended normally) and cross-check against the real Rust-side
  position (`window.__TAURI__.core.invoke('audio_get_position', {deckId})` directly, not the
  frontend's cached `getAudioTime()`, which can itself be stuck from an unrelated cause).
  Concrete example of that "unrelated cause" found 2026-07-25 via exactly this technique:
  `seekBus.ts`'s `pendingSeekTarget` staleness filter could freeze `getAudioTime()` forever
  after a seek-while-playing while `v.currentTime` and the raw Rust position both kept
  advancing fine — see `audio-debugging` skill's `pendingSeekTarget` section. Fixed; the
  side-by-side raw-vs-cached comparison is what proved it was a frontend bug, not a
  WebKitGTK/GStreamer stall.
- **Don't load a very long video (tens of minutes) in a headless test.** Loading a ~49-minute
  file caused the WebDriver session itself to die (`"session deleted because of page crash or
  hang"`) even though the underlying app process and its `WebKitWebProcess` were both still
  alive per `pgrep` — the WebDriver health-check gave up waiting, not a real crash. Stick to
  short/modest clips (tens of seconds to a few minutes) for headless repros; use `ffprobe -v
  error -show_entries format=duration -of csv=p=0 <file>` to check before loading.
- **Reuse a locally-cached copy for a reliable, network-independent repro file** rather than
  pointing at a path on the SMB media library (`project_media_library_smb_mount` memory) or one
  associated with a live Digger queue item. `media_cache.rs` caches every loaded file locally at
  `~/.local/share/com.cuemark.app/media_cache/<hash>-<size>.<ext>` — `ffprobe`'s `duration`/
  `TAG:title` on files there will identify a specific previously-used track (e.g. a known
  mechanism-B repro file) without depending on the original SMB path being reachable or
  triggering any Digger-side side effects. Loading that cache path directly as the deck's
  `filePath` works identically to the original (Rust's `ensure_cached()` just no-ops on an
  already-local path).
- **A "fresh" headless launch is not airtight isolation from other cuemark activity** — observed
  2026-07-25: a deck loaded via the debug hook on a just-launched headless instance was later
  found to have a *different* track loaded (one the user says they loaded elsewhere, on a
  separate real desktop session, around the same time). The mechanism was not fully diagnosed —
  ruled out: session-recovery boot logic (requires a *live* pipeline in this process's own,
  freshly-empty `AudioManager`, which a truly fresh launch can't have yet) and a Tauri
  single-instance plugin (not present in `Cargo.toml`). Whatever the cause, treat any headless
  session as potentially not perfectly isolated from concurrent real-desktop cuemark/Digger
  activity: call `getSession()` right after launch and again right before an action that
  depends on a specific deck being in a specific state, rather than assuming a fresh launch
  guarantees a clean slate.
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
