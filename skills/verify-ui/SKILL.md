---
name: verify-ui
description: Drive the actual cuemark app window headlessly via tauri-driver (WebDriver) + Xvfb — click elements, read the DOM, and screenshot the canvas-rendered video/waveform — without touching the user's real desktop session. Use when asked to visually verify a UI change (deck preview, waveform, compositor output) and no interactive display is available, or to avoid disturbing the user's live `:0`/`wayland-0` session.
---

# Headless UI verification (tauri-driver + Xvfb)

This drives the **real** webview (not a mock, not a unit test) inside an isolated
virtual display, so screenshots reflect actual WebGL/canvas rendering. It does not
replace `run-app` for normal dev-loop testing — use this specifically when you need
a screenshot or DOM-level assertion and don't want to touch the user's live session.

## "No GUI automation" and "driving the UI" are answers to two different questions

Don't say "no GUI automation is available" without saying *which* of these you mean —
conflating them is the single biggest source of sessions contradicting each other on
this exact question:

1. **Driving the user's live, already-open window** (`:0`/`wayland-0`, whatever
   `cargo tauri dev` currently has up). This really is impossible in this environment:
   `xdotool`/`wmctrl`/`ydotool`/`wtype` and every screenshot tool (`grim`, `scrot`,
   `gnome-screenshot`, `spectacle`, `import`) are all absent, and cuemark is a native
   Wayland client with no XWayland presence, so even installing X11 tools would give
   them nothing to attach to. See `project_no_gui_automation_this_session` memory.
   The only way into a window that's already running is WebDriver or the WebKit
   inspector attached *at process start* — neither attaches to an existing process.
2. **Launching a fresh, separate, isolated instance and driving it** — this skill
   (`tauri-driver` + `Xvfb`) or the lightweight `python3-gi` + GDK-event-injection
   probes below. This fully works on `mele` (verified 2026-08-12: `Xvfb`, `tauri-driver`,
   `WebKitWebDriver`, and the `python3-gi`/`gir1.2-webkit2-4.1` stack are all installed —
   see `docs/environment.md` for the full per-machine tooling matrix, since cuemark is
   developed/tested on more than one physical machine and package presence isn't
   guaranteed to transfer) and is exactly what several scripts and probes already do
   successfully. It is not a live-session workaround — it's a real, separate cuemark
   process the driving session fully controls.

If a task needs #1 and can't get it, say so and ask the user to do the manual step —
don't silently fall back to #2 and call it the same thing, and don't let a failure at
#1 read as "GUI automation doesn't work here" when #2 is what most verification tasks
actually need.

## One-time setup

**Check what's actually present before assuming anything is missing or telling the
user to install something** — package names for the WebKit driver vary by distro
release (below), and a check gated on the wrong name reports "missing" even when
everything needed is installed and working:
```sh
which Xvfb 2>/dev/null
which tauri-driver 2>/dev/null || ls ~/.cargo/bin/tauri-driver 2>/dev/null
find /usr/bin /usr/lib -iname 'WebKitWebDriver' 2>/dev/null
```
If all three resolve to a real path, automation is fully available — proceed, don't
report it as unavailable.

If something is genuinely missing, install it. Requires `sudo` for the apt packages —
the user runs that line themselves (see `README.md`); `sudo` in this environment needs
a real interactive terminal (fails with "A terminal is required to authenticate" over a
non-interactive shell, `!`-prefixed or otherwise) — ask the user to run the `apt-get`
line in their own terminal. `cargo install tauri-driver` itself needs no sudo and can be
run directly:
```sh
sudo apt-get install xvfb webkit2gtk-driver || sudo apt-get install xvfb webkitgtk-webdriver
cargo install tauri-driver
```
**The WebKitWebDriver package name varies by distro release, and this is not cosmetic
— checking the wrong one produces a false negative, not an error.** Confirmed on `mele`
(Ubuntu 24.04.4 LTS, 2026-08-12): the package is `webkit2gtk-driver` (`apt-cache policy
webkitgtk-webdriver` shows no candidate at all — it isn't just uninstalled, apt doesn't
know the name here). Confirmed separately on the 2012 MacBook Pro while it was on Ubuntu
26.04 (2026-08-04): `webkitgtk-webdriver` is the real name there, `webkit2gtk-driver`
doesn't exist. **These are two different physical machines, not one machine's package
name drifting over time** — see `docs/environment.md` for the full machine matrix. Don't
assume either name is "current" without checking which machine and which distro release
you're actually on.

⚠️ **A `dpkg -L webkitgtk-webdriver` check silently reports "missing" on a 24.04 machine
(e.g. `mele`), even though the driver is fully installed and working under a different
package name** — `dpkg -L` on a package name that was never installed just returns
nothing (exit 1), with no error to flag that it's the wrong name rather than an absent
tool. This was previously the skill's own literal verify step, and following it on a
24.04 machine produces exactly a false "stop, tell the user it's not installed" — a
likely cause of prior sessions disagreeing about whether automation was available, since
different sessions were sometimes on different machines/distro releases without saying
so. **Always verify by finding the `WebKitWebDriver` binary itself** (the `find`/`which`
block above), never by checking one hardcoded package name.

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

**Shortcut when a `cargo tauri dev` instance is already running and serving Vite**
(confirmed working on `mele`, 2026-08-12): `import.meta.env.DEV` is `true` under Vite
regardless of `VITE_ENABLE_DEBUG_HOOK`, so `window.__cuemarkDebug` is already exposed —
no separate `VITE_ENABLE_DEBUG_HOOK=1 cargo tauri build --debug --no-bundle` needed. Just
point `tauri-driver` at the existing `target/debug/cuemark` binary (built by `cargo tauri
dev`'s own auto-rebuild) with `BINARY` above; it loads `http://localhost:1420/` and
connects to the live Vite server rather than `tauri://localhost` — expected here, not a
bug, since nothing cleared `devUrl` for this binary. This spins up a **second**,
independent cuemark instance/window alongside the one already running — cheap for a
scripted check (state IPC, `execute/sync`), but see the pixel-verification caveat below
before trusting a screenshot or canvas-pixel read from it.

⚠️ **A pixel/frame-render check from this second-instance setup was inconclusive on
`mele` (2026-08-12) and should not be trusted without further isolation.** Loading a
video into a deck and reading `getCodecFramePts()`/canvas pixels came back
null/all-black for two different codecs, even though the Rust-side demux
(`video_demux_load`) returned correct metadata and an isolated single-purpose decode
probe succeeded for the same files — i.e. the failure was specific to *this* driven
instance's rendering, not the codec or the decoder. The likely cause was never isolated:
the driven window ran with `document.hasFocus() === false` (check it — some rAF/paint
paths can be quietly throttled for an unfocused window even while
`visibilityState === 'visible'`), *and* a second, unrelated `cargo tauri dev` instance
was live on the same machine at the same time, competing for the same GPU. **Before
trusting a black canvas as a real bug, retry with exactly one cuemark instance running
and confirm `document.hasFocus()` on the driven window** — neither was ruled out here.

## 2. Start the isolated display

Use a display number that is **not** `:0` / `wayland-0` (the user's real session):
```sh
Xvfb :99 -screen 0 1280x900x24 > /tmp/xvfb.log 2>&1 &
echo $! > /tmp/xvfb.pid
```

## 3. Start tauri-driver on that display

```sh
WEBKIT_DRIVER=$(find /usr/bin /usr/lib -iname 'WebKitWebDriver' 2>/dev/null | head -1)
DISPLAY=:99 tauri-driver --port 4444 --native-driver "$WEBKIT_DRIVER" > /tmp/tauri-driver.log 2>&1 &
echo $! > /tmp/tauri-driver.pid
sleep 1
```
`tauri-driver` proxies the W3C WebDriver protocol to `WebKitWebDriver`, which it
launches itself — it inherits `DISPLAY` from its own environment, so the app appears
on `:99`, not the real screen.

## 4. Create a session (this launches the app)

🔴 **On `mele`, export `CUEMARK_DISABLE_DMABUF=1` before starting `tauri-driver`** —
otherwise `requestAnimationFrame` fires **zero** times under Xvfb and the app silently
does nothing useful: no deck ever gets a video backend, `audio_load` is never called,
every position reads 0, and the log has no `[raf]` lines at all. It looks exactly like a
broken frontend. `latency-test.sh`/`perf-idle-test.sh` now abort with this hint (they arm
a rAF counter first); if you're driving a session by hand, check it yourself:
```sh
# after the session exists — expect ~60, not 0
curl -s -X POST http://localhost:4444/session/$SESSION/execute/sync \
  -H 'Content-Type: application/json' \
  -d '{"script":"window.__n=0;const t=()=>{window.__n++;requestAnimationFrame(t)};requestAnimationFrame(t);return 1","args":[]}' >/dev/null
sleep 1
curl -s -X POST http://localhost:4444/session/$SESSION/execute/sync \
  -H 'Content-Type: application/json' -d '{"script":"return window.__n","args":[]}'
```
The variable forces software page compositing, so CPU/fps numbers measured under it are
not comparable to a live desktop run — set it on *both* arms of any A/B. Confirmed
2026-08-13; see `docs/environment.md`.

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

### 🔴 This "isolated" instance shares localStorage with the user's real app

The isolation is of the *display and process*, not of storage. Every cuemark instance —
this Xvfb one and whatever is running on the user's desktop — loads the same origin
`tauri://localhost` and therefore shares one WebKit localStorage DB under
`~/.local/share/com.cuemark.app/`. **Every `cuemark:`-prefixed `persistentWritable`
written through the debug hook escapes the test and changes the user's actual app**,
permanently, across restarts: `cuemark:videoPathOverride` (per-deck legacy/webcodecs),
`cuemark:videoPathDefault`, and the audio-settings stores.

This is not hypothetical. On 2026-08-13 a **green 10/10** `latency-test.sh` run left
`{"deck-0":"legacy"}` behind — the script forces deck-0 onto the legacy backend in its
step 1b and, until that day, never put it back. The user's deck-0 then rendered colourful
noise instead of video in both the preview and the output window (the VA-API DMA-BUF
`drawImage(video)` corruption documented at the top of `src-tauri/src/main.rs`, which the
legacy path has never been checked against since GPU compositing became the default on
2026-08-02). It read as "the recent refactor broke video playback"; the refactor was
innocent — the passing test suite was the cause.

**So: capture any `cuemark:` value before you overwrite it and restore it on exit,
including the abort path.** `latency-test.sh`'s `restore_override()` + its Step 10
assertion is the pattern; `perf-idle-test.sh` does the same around its webcodecs
scenario. A trap alone is not enough to trust — assert the restore where a check can
still fail, and log it on the paths where none can.

⚠️ **A backgrounded script does not run its `EXIT` trap on `kill -INT`** — bash background
jobs ignore SIGINT, so a run started with `&` and interrupted that way leaks the override
anyway (this is what re-broke the key midway through verifying the fix, and it briefly
looked like storage contention from the user's live app — it wasn't). Use `kill -TERM`, or
^C an interactive foreground run. Either way, verify a restore by its **`[restore]` log
line**, not by reading the key back afterwards: the readback cannot tell "never restored"
from "restored, then re-broken by the next thing you ran".

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

## Real-hardware audio E2E (WebDriver on the real display + pw-record)

For testing that needs **real audio on real hardware** — device routing, multi-deck
mixing, scratch gestures — not just DOM/screenshot assertions. Proven end-to-end
2026-08-11 testing `docs/design/shared-output-pipeline.md` stage 4: it found and
verified the fix for a real bug (a deck silently, permanently stuck `Paused` after a
device rebuild) that log telemetry alone did not catch. Reuse this pattern rather than
re-deriving it.

**Difference from the standard flow above**: launch `tauri-driver` with
`DISPLAY=:0` (the user's real session), not Xvfb `:99`. PipeWire is system-wide, so
audio reaches real hardware either way — the real display just lets the user watch
and listen alongside you, and is required if you want them to confirm anything by
ear. Tell the user before doing this: it replaces whatever `cargo tauri dev` window
they had open with a driven instance, and every device-list change is audible.

1. Build with **both** `VITE_ENABLE_DEBUG_HOOK=1` (for `window.__cuemarkDebug`, see
   above) **and** any runtime env the test needs (e.g. `CUEMARK_SHARED_OUTPUT=1`) —
   the latter must also be exported when launching `tauri-driver`, since it spawns
   the binary inheriting its own environment, not the build environment's.
2. **Drive real UI controls, never bypass the Svelte store with a direct
   `window.__TAURI__.core.invoke(...)` call for anything the store also owns** (device
   selection, most settings). Confirmed the hard way: calling `audio_set_main_devices`
   directly left the frontend's persisted `mainOutputDeviceIds` store unchanged: ~18s
   later something re-ran the UI's own device-sync effect with the stale value and
   silently reverted the device — a real, audible, unplanned click the user heard and
   reported mid-session. Click the actual checkbox/button instead:
   ```js
   const labels=[...document.querySelectorAll(".device-check")];
   const l=labels.find(x=>x.textContent.trim()==="DJControl Starlight — Front");
   l.querySelector("input").click();
   ```
   This keeps frontend and backend state in sync by construction and is what a real
   user's click does, so nothing fights it later.
3. **Simulate a scratch gesture from inside the page**, not via repeated WebDriver
   round-trips (too slow/jittery to look like a real gesture) — `execute/async` with a
   `setTimeout` chain calling `invoke('audio_scratch_to', {deckId, targetSecs, holdMs})`
   at a steady interval, computing `targetSecs` from a slow rate (0.10–0.3x) to match
   real slow-jog gestures (`docs/design/waveform-scrub.md`). Extend the session's
   script timeout first (`POST /session/$SESSION/timeouts {"script": 20000}`) or a
   multi-second async script gets killed mid-gesture.
4. **Capture real audio, don't trust delivery telemetry alone.** `deliver-tel`'s
   `lag=0 drop=0` only proves buffers *left* the deck's appsink — it says nothing
   about whether the shared sink is actually Playing. Use `scripts/scratch-capture.sh`
   (built-in pre-flight confirms the recorder attached to the right monitor ports —
   `pw-record --target` resolves against source names and silently falls back to the
   default source, i.e. a live mic, on any mismatch) or a one-off:
   ```sh
   timeout 5 pw-record -P '{ stream.capture.sink=true }' \
     --target '<node-name>' --rate 48000 --channels <N> /tmp/check.wav
   ```
   then check RMS per channel (near `-240 dBFS` is real digital silence, not "quiet").
   Analyze a scratch capture with `scripts/scratch-envelope.py` — reads `zero%`, not
   just dBFS, which is what actually distinguishes gating from attenuation.
5. **A deck reaching natural EOS mid-test is expected, not a bug** — `playing` flips
   to `false`, the pipeline pauses, and that deck goes correctly silent. Check
   `__cuemarkDebug.getSession().decks` for `playing`/`getAudioTime` before treating any
   silence as a fault; a frozen `getAudioTime` on a deck whose `playing` still reads
   `true`, though, is the real tell — that's a stuck pipeline, not an ended track (this
   is exactly the signature the stage-4 bug above left, and how it was caught: a
   `getAudioTime` value that stopped advancing while `deck.playing` still said `true`,
   confirmed by a silent real capture, confirmed further by a manual `audio_play()`
   call unsticking it).
6. **Tear down and relaunch the user's normal `cargo tauri dev` session afterward** —
   don't leave them on a debug-hook-enabled driven instance. Same commands as
   "Tear down" above, then relaunch per the `run-app` skill.

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
- Run under `xvfb-run -a`, with the app's env (the `GST_PLUGIN_FEATURE_RANK` demotions
  from `main.rs`) so behavior matches. **`WEBKIT_DISABLE_DMABUF_RENDERER=1` is no longer
  part of that env** — it was retired as the default on 2026-08-02 (`CUEMARK_DISABLE_DMABUF=1`
  restores it). Probes that still set it are testing a configuration the app no longer ships;
  for anything graphics-related, run **both** arms, because that variable changes WebGL
  canvas behaviour, not just performance.
- **Always set `APPORT_DISABLE=1`** — a WebKitWebProcess crash inside the probe
  otherwise pops Ubuntu's "application stopped unexpectedly" dialog on the user's
  real desktop session (learned live 2026-07-25, twice).
- Feature-flag enumeration: `WebKit2.Settings.get_all_features()` lists every
  WebKit feature with default/status (`webcodecs_probe.py` does this) — the fast
  way to check whether an API needs a settings toggle before blaming its absence.
- **Never touch `VideoEncoder` in probe pages** (`isConfigSupported` or `configure`
  — instant web process SIGABRT on 2.52.3; `docs/upstream/videoencoder-crash.md`).
- **Pixels cannot be read back out of a WebGL canvas on this build.** `createImageBitmap`,
  `drawImage(glCanvas)` and `readPixels` all fail (transparent / `INVALID_OPERATION`), while
  the canvas *displays* correctly; `OffscreenCanvas` has no `webgl2` context at all. A plain
  2D canvas captures fine. So **a screenshot/pixel assertion against WebGL content proves
  nothing here** — a blank result is the platform, not your change. Verify WebGL rendering by
  *looking at the window*, not by capturing it.

  **Root-caused 2026-08-03: this is a Mesa `crocus` (Intel HD 4000, gen7) driver bug, not a
  WebKit one** — every `readPixels` variant fails on hardware and every one passes under
  `LIBGL_ALWAYS_SOFTWARE=1`. So it is specific to *this machine's GPU*: the same assertions
  may work fine on other hardware, and a failure here is not evidence about WebKitGTK in
  general. Before blaming WebKit for any rendering/readback fault, run the software arm —
  WebKit masks `RENDERER`, so a driver bug is otherwise indistinguishable from a browser bug.
  Probes: `scripts/probes/webgl_readback_variants_probe.py` (route matrix + software control),
  `scripts/probes/webgl_readpixels_diag_probe.py` (why), and the original
  `scripts/probes/offscreencanvas_webgl_capture_probe.py`;
  upstream: `docs/upstream/webgl-canvas-readback-broken.md`.

  **To verify compositor output anyway, run it under software GL.** `readPixels` and canvas
  capture both work under `LIBGL_ALWAYS_SOFTWARE=1`, so a pixel assertion is possible — it just
  cannot run on the hardware path. `scripts/probes/output_window_compositor_probe.py` does
  exactly this for the output window: it loads the real `/output.html`, posts a synthetic frame
  from a same-origin sender, and reads the composited result back, orientation included. Use it
  as the pattern for any new compositor pixel check. Note the inversion of this project's usual
  rule: llvmpipe results are normally the suspect ones, but for *compositing semantics and
  orientation* — which are WebKit-level, not driver-level — the software arm is authoritative.

### Input APIs: presence is not behaviour — inject real platform events (2026-08-08)

`typeof PointerEvent === 'function'` answers a different question than "will a drag
gesture work". This build's whole catalogue of hazards is APIs that are *present* and
silently do nothing (`UNPACK_FLIP_Y_WEBGL` for `ImageBitmap`, `imageOrientation` for
`VideoFrame`, `isConfigSupported` returning true for AV1 before decoding zero frames), and
`dispatchEvent(new PointerEvent(...))` does not close the gap either — it proves your
listeners are wired, nothing about whether the platform ever produces the event.

Push **GDK events into the WebView** instead, which is the same platform→DOM path an X11
mouse takes (`scripts/probes/pointer_events_probe.py`, which cleared Pointer Events for the
waveform drag-scrub gesture):

```python
ev = Gdk.Event.new(Gdk.EventType.BUTTON_PRESS)
ev.button.window = view.get_window()
ev.button.x, ev.button.y = float(x), float(y)
ev.button.button = 1
ev.button.set_device(Gdk.Display.get_default().get_default_seat().get_pointer())
ev.set_screen(Gdk.Screen.get_default())
Gtk.main_do_event(ev)          # → WebKit → DOM
```

Notes that transfer to any input probe here:

- **`xdotool` is not installed on this machine.** GDK injection is the available route; do
  not plan around synthesizing X input externally.
- **Carry a control arm at a different API level.** That probe counts `mouse*` alongside
  `pointer*`, so "the platform delivered nothing" and "the platform delivered mouse but not
  pointer" are distinguishable — and the second is the answer that would force a rewrite.
  A probe that only counts the API you hope works cannot tell those apart.
- **WebKit coalesces motion events** — three injected moves arrived as two. Design gestures
  so a dropped intermediate position is harmless (absolute targets supersede; accumulated
  deltas silently under-travel). This is the same property that makes rAF coalescing safe
  for the scrub bus, see `docs/design/waveform-scrub.md`.
- Give WebKit's event queue time to drain (a few hundred ms) before asking the page what it
  saw; results are not available synchronously after `Gtk.main_do_event`.
- **Set a realistic `GdkEvent.time`, not `Gdk.CURRENT_TIME`.** `CURRENT_TIME` is 0, which is
  fine for testing delivery and useless for testing anything *derived* from the event's time:
  a DOM stamp computed from 0 is indistinguishable from one taken off a different clock. Real
  X11 events carry a monotonic millisecond stamp, so inject
  `(GLib.get_monotonic_time() // 1000) & 0xFFFFFFFF`.
- **To ask whether a derived value is real, perturb its input and check it moves.** The
  question "does `event.timeStamp` carry the platform event's time, or the dispatch time?"
  has opposite consequences — only the first can express a queueing delay — and no amount of
  reading plausible-looking values settles it. The probe's `stale` arm backdates one event's
  `GdkEvent.time` by 250ms; the DOM stamp moved with it by exactly +250ms, so it is
  platform-derived (2026-08-08).
- ⚠️ **`event.timeStamp` sits on an origin offset from `performance.now()` by a constant that
  differs per page load** (−44ms and −466ms in two runs of the same probe). Absolute values are
  meaningless; only variation above a running minimum is a delay. Whatever consumes it must
  calibrate — see `src/lib/audio/scrubStats.ts`.

### Two rules these probes were shipped without, and paid for (2026-08-03)

- **Drive the real module, don't reimplement it in the probe page.** A `load_html` page given
  the dev server's origin can `import` straight from it
  (`import { postFrame } from '/src/lib/renderer/outputBus.ts'`) — Vite transforms it on
  demand. The compositor probe originally hand-rolled its own
  `createImageBitmap(canvas, {imageOrientation:'flipY'})` "the same way the sender does", passed
  its orientation assertion, and the shipping app was upside down anyway: the real sender was
  passing a `VideoFrame`, for which that option is silently ignored. A probe that reimplements
  the code under test can only confirm its own assumptions.
- **Verify a probe by breaking the code.** Reintroduce the defect, watch the probe go red, then
  restore. A green assertion that has never been shown to fail is untested. Two minutes; it is
  the only reason to trust a probe you just wrote.
  ⚠️ Do this by editing the file and restoring from a copy — **not `git stash`**. Most of this
  project's work sits uncommitted for long stretches, so a stash of one file reverts it to a
  commit that may predate the entire feature (hit live 2026-08-03: it rewound `outputBus.ts`
  past the whole output-window architecture).

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

- **`simulateMidiRateBurst`'s fire-and-forget `setInterval` can outlive the WebDriver
  `/execute/async` call that started it** — found live 2026-07-25 verifying
  `docs/design/webcodecs-video-path.md` phase 3: under enough CPU load (two decks
  playing simultaneously, one on each video backend), a burst nominally 20-60s long
  (`count * intervalMs`) took long enough that the wrapping `/execute/async` request
  hit the default 90s WebDriver script timeout and returned `{"error":"script
  timeout",...}` — but the in-page `setInterval` kept firing regardless (it's not
  cancelled by the WebDriver call returning/erroring), confirmed by polling
  `getAudioTime()`/rate-history state afterward and seeing it keep changing. A timed-
  out response from this specific hook is therefore not itself proof the burst failed
  or stopped — re-run with a smaller `count` for a clean, promptly-returning
  measurement if you need the actual `{fired, durationMs}` numbers, and don't confuse
  "the WebDriver call timed out" with "the burst didn't happen" when checking for
  sustained-load side effects.
- **WebDriver's full-window `GET /session/$SESSION/screenshot` can hang indefinitely in
  this environment** — confirmed 2026-07-25 while verifying `docs/design/
  webcodecs-video-path.md` phase 2: repeated 20-45s timeouts with zero response, even
  against an empty session with no decks loaded (so it isn't specific to WebCodecs/WebGL
  load). Matches the precedent already in `journal.md`'s 2026-07-06 entry, which switched
  to canvas pixel extraction for exactly this reason. **Use `canvas.toDataURL('image/png')`
  via `/execute/sync` instead** — returns promptly and reads back the actual rendered
  content of a **2D** canvas (a `DeckCard` preview, a waveform).

  ⚠️ **NOT for the compositor output, or any other WebGL canvas.** Verified 2026-08-02
  (`scripts/probes/offscreencanvas_webgl_capture_probe.py`): `toDataURL` on a `webgl2`
  canvas returns **fully transparent** pixels on this WebKitGTK build, as do
  `createImageBitmap`, `drawImage(glCanvas)` and `readPixels` — while the canvas displays
  correctly on screen. It does not throw. Any assertion built on it therefore "succeeds"
  against a blank image, which is worse than no check: this is precisely how three sessions
  concluded "the data path is provably healthy" while the screen showed garbage. Verify
  WebGL rendering by looking at the window. Upstream:
  `docs/upstream/webgl-canvas-readback-broken.md`.
  ```sh
  RESULT=$(js_sync "return document.querySelectorAll('canvas')[0].toDataURL('image/png');")
  echo "$RESULT" | python3 -c "
  import sys, json, base64
  d = json.load(sys.stdin)
  open('/tmp/shot.png','wb').write(base64.b64decode(d['value'].split(',',1)[1]))
  "
  ```
  Then read `/tmp/shot.png` back with the Read tool as usual — same "blank/black is a
  failure, not a pass" rule applies.
- **A leftover `WebKitWebDriver` process from an earlier session on the same Xvfb display
  can silently steal tauri-driver's native-driver port** (`4445` = webdriver-port+1) —
  the *new* tauri-driver still accepts a session and answers `/execute/sync` fine (looks
  completely healthy), but its own log (`/tmp/tauri-driver.log`) shows `FATAL: Unable to
  listen for HTTP server at host 127.0.0.1 and port 4445`, and other operations (notably
  screenshot) hang. Before trusting a "clean" session, check
  `ps -o pid,lstart,cmd -p $(pgrep -f WebKitWebDriver)` for more than one process and
  compare start times against your own `Xvfb`/`tauri-driver` pids — kill anything stale
  that predates your own launch **and confirm its `DISPLAY` env var matches your own
  `:99`-style virtual display first** (`tr '\0' '\n' < /proc/<pid>/environ | grep DISPLAY`)
  — never kill a process whose `DISPLAY=:0` (or `wayland-0`), that's the user's real
  desktop session, potentially their own legitimate `cargo tauri dev` instance.

- **Historical, now moot**: `dpkg -L <package> | grep WebKitWebDriver` used to match two
  lines — the binary and its man page — leaving `$WEBKIT_DRIVER` holding both paths
  newline-joined and `tauri-driver --native-driver "$WEBKIT_DRIVER"` failing immediately.
  The current setup steps use `find /usr/bin /usr/lib -iname WebKitWebDriver | head -1`
  instead, which sidesteps this (and the man-page path lives under `/usr/share/man`
  anyway, outside the searched dirs) as well as the package-name-varies-by-distro problem
  below — don't reintroduce a `dpkg -L <specific-package-name>` check.
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
- **`WebKitWebDriver` version mismatch**: whichever package provides it
  (`webkit2gtk-driver` or `webkitgtk-webdriver` — see "One-time setup" for which one
  this distro uses) must match the installed `libwebkit2gtk-4.1-0` version or the
  driver handshake fails immediately. `sudo apt-get upgrade` that package if cuemark's
  WebKit dependency is bumped.
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
- **`audio_get_position` returns a `PositionSample` struct (`{pos, entryMs, lockMs,
  queryMs, exitMs}`), not a plain number** — a `js_sync` call that does
  `return window.__TAURI__.core.invoke('audio_get_position', {deckId})` hands shell
  arithmetic (`awk`/`bc`) the whole JSON blob, which fails as `awk: syntax error at or
  near {`. `rehydration-test.sh` had this bug for weeks (introduced when the position
  command grew mutex-contention/query-time telemetry fields, `[[project_ipc_latency_baseline]]`)
  because nothing exercised that code path — found and fixed 2026-08-13. Extract the
  field explicitly: `return window.__TAURI__.core.invoke('audio_get_position',
  {deckId}).then(p=>p.pos ?? 0)`. Any new script reading position via raw `invoke` (not
  `__cuemarkDebug.getAudioTime`/`getVideoTime`, which already return plain numbers) needs
  this `.then(p=>p.pos)` unwrap.
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
- **`org.gnome.Shell.Screenshot` over D-Bus returns `AccessDenied` in this environment** — not worth
  retrying or hunting for a workaround (`grim`/`gnome-screenshot`/`scrot`/`import` are also not
  installed). For a bug on the user's live desktop session, just ask them to paste a screenshot
  directly into chat — confirmed 2026-08-01 chasing the deck-flip bug below: the user's pasted
  screenshot of both windows side-by-side was what actually cracked it, after a much slower headless
  attempt via this skill's normal flow stalled on cold SMB-backed media loading (see next entry).
  Reach for headless repro when the user *can't* easily screenshot themselves or when the bug needs
  DOM/state inspection a screenshot can't show — not as the default first move for a purely visual
  live-desktop bug.
- **A visual bug that's WebGL-specific vs. source-data-specific: compare the `DeckCard` preview
  against the Output window in the same screenshot before touching any code.** `DeckCard`'s own
  preview canvas (`DeckCard.svelte`) is a plain 2D-context `drawImage()` from the same `<video>`
  element or `VideoFrame` the compositor uploads — it has no `UNPACK_FLIP_Y_WEBGL`/texture-coordinate
  logic at all, so it's a flip-agnostic ground truth for "is the decoded frame itself oriented
  correctly." The Output window is downstream of the full WebGL path (`fbo.ts` upload →
  `compositor.ts` composite → `BroadcastChannel` → `output.ts`'s 2D blit, which is itself also
  flip-agnostic). If the preview is correct and Output is flipped/garbled, the bug is confined to
  `fbo.ts`/`compositor.ts`'s WebGL texture handling — skip investigating container rotation
  matrices, codec pixel formats, or demux logic entirely. This is what pinned the 2026-08-01
  deck-flip bug to `uploadVideoFrameFromCodec`'s direct `texImage2D(VideoFrame)` branch (missing
  the flip on real GPU hardware — see `docs/design/webcodecs-video-path.md`'s 2026-08-01
  correction) in one screenshot, after headless reproduction had stalled for several minutes on
  cold-cache SMB loading and a `getDeckTime()`-gated frame-upload path that never fires while
  `playing:false`. For this whole class of bug (orientation/color/distortion), try the live
  screenshot comparison before setting up a headless `tauri-driver` repro.
