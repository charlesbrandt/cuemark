---
name: run-app
description: Launch the cuemark Tauri dev app and monitor its output. Use when asked to run, start, or test the app, or before verifying a UI/audio change.
---

# Running Cuemark

## Environment notes

- No `tmux` or `screen` available in this environment — use background Bash + log file instead.
- `cargo tauri dev` starts the Vite dev server (port 1420) first, then compiles and launches the Rust binary. First launch after a clean checkout is slow (~5 min, 530 crates); subsequent launches reuse the incremental cache and finish in seconds.
- MIDI: Hercules Starlight absence at launch is normal — `[midi] Hercules Starlight not found` is not an error.
- **Digger proxy errors are normal**: `[vite] http proxy error: /queue … ECONNREFUSED 127.0.0.1:8200` just means the Digger media library service isn't running. The app degrades gracefully — drag-and-drop and manual load still work.
- **GTK theme warnings are harmless**: `Gtk-WARNING **: Theme parsing error: gtk.css:…` at launch is cosmetic, not a functional issue.
- **No screenshot tool available**: grim, scrot, gnome-screenshot, spectacle are all absent. Verify the app is running by checking for `WebKitWebProcess` in `ps aux` and confirming log lines (see "Confirm it's up" below). The app window will appear on the user's desktop.
- **`pactl` is not installed** — for any live PipeWire/audio-routing inspection (sink volumes, mute state, which client streams are actually active) use `wpctl status` or `pw-dump` instead. See "HMR cascade → orphaned PipeWire streams" below for a concrete use case.

## Prerequisites check

Before launching, verify cargo is on PATH:

```bash
. "$HOME/.cargo/env"   # source this if `cargo --version` fails
cargo --version
```

If Rust isn't installed at all: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path`

Required system packages (build will fail without these — see README for the full list):
```bash
sudo apt-get install -y \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev \
  libasound2-dev
```

**Also required, separately — GStreamer *runtime* plugins** (the build links fine
without these; the app compiles and launches, but playback silently fails at
runtime, which makes this easy to miss on a fresh machine):
```bash
sudo apt-get install -y \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
  gstreamer1.0-libav gstreamer1.0-pipewire
```
Verify before declaring a fresh-machine setup done:
```bash
gst-inspect-1.0 pitch    # soundtouch tempo element — from plugins-bad
```
**Symptom if `gstreamer1.0-plugins-bad` is missing**: tracks appear to load (filename
shows in the deck card) but nothing plays. Devtools console (right-click → Inspect
Element → Console) shows `GStreamer element 'pitch' not found` and `no pipeline
loaded` — the Rust `DeckAudioPipeline` fails to construct, so there's no audio *and*
no waveform. The `<video>` element also fails with `NotSupportedError` (code 4)
because `h264parse` (also in plugins-bad) is unavailable to WebKit's own internal
GStreamer pipeline, so the preview stays black too. Both symptoms share this one
root cause — don't chase them as separate bugs.
`libasound2-dev` is needed by the `alsa-sys` crate (pulled in by `midir` for MIDI on Linux); it's the most common missing package on fresh machines.

Also confirm the Tauri CLI is installed (`cargo tauri` is a cargo subcommand, not bundled with `cargo`):
```bash
cargo tauri --version || cargo install tauri-cli --version "^2"
```
Compiles from source — takes ~2 min.

## Launch

```bash
. "$HOME/.cargo/env"
export PATH="$HOME/.cargo/bin:$PATH"
cargo tauri dev > /tmp/cuemark-dev.log 2>&1 &
echo $! > /tmp/cuemark-dev.pid
echo "PID: $(cat /tmp/cuemark-dev.pid)"
```

Run this from `/home/account/repos/cuemark` with `run_in_background: true` so the shell doesn't block. The `run_in_background` task only captures the `echo` line — the real output goes to `/tmp/cuemark-dev.log`.

## Confirm it's up

Wait for both signals in the log before declaring the app ready:

```bash
grep -E "VITE.*ready|Running.*cuemark" /tmp/cuemark-dev.log
```

Expected output:
```
  VITE v6.4.2  ready in 657 ms
     Running `target/debug/cuemark`
```

Also confirm WebKit loaded the frontend:
```bash
ps aux | grep -E "WebKitWebProcess" | grep -v grep
```
A live `WebKitWebProcess` entry means the window is up and the frontend is running.

## Monitor (persistent)

Set up a persistent Monitor on the log so errors and GStreamer events surface automatically:

```bash
tail -f /tmp/cuemark-dev.log | grep -E --line-buffered \
  "Error|error|WARN|warn|panic|thread.*main|audio|midi|MIDI|bus/|pipeline|crash|failed|gst|GST|IPC|tauri|vite|HMR|reload|rebuild"
```

Use `Monitor` tool with `persistent: true` and `timeout_ms: 3600000`.

## Stop the app

```bash
kill $(cat /tmp/cuemark-dev.pid) 2>/dev/null; rm -f /tmp/cuemark-dev.pid
```

🔴 **That kills `cargo tauri dev` but NOT the Vite server it spawned, and the next launch then
silently runs against the stale one.** Caught 2026-08-09: the relaunch logged
`error when starting dev server: Port 1420 is already in use` and
`The "beforeDevCommand" terminated with a non-zero status code`, then **started the app
anyway**, serving the frontend from the previous session's Vite. The codec worker failed to
import (`[codecPlayer:deck-0] worker.onerror: undefined (undefined:undefined)`) and the user
lost video entirely — reported as a regression in the Rust change that had just been made,
which it was not. This is the "Vite serves a stale transform" hazard in CLAUDE.md with a
louder failure mode.

Kill both, and **scope the pattern to this repo** — there are unrelated Vite servers on this
machine (ports 5173/5175, `/app/node_modules/...`) that a bare `pkill -f vite` would take out:

```bash
kill $(cat /tmp/cuemark-dev.pid) 2>/dev/null
pkill -f "node /home/account/repos/cuemark/node_modules/.bin/vite"
sleep 2
pgrep -af "repos/cuemark.*vite|target/debug/cuemark" | grep -v "bash -c" || echo "all stopped"
```

Then after relaunching, confirm the *new* server actually started before trusting anything:

```bash
grep -E "VITE.*ready|already in use" /tmp/cuemark-dev.log   # want the first, never the second
```

**Always stop before making Rust changes** (`src-tauri/`). After editing Rust code: stop, make the edit, restart. `cargo tauri dev` auto-detects frontend changes and hot-reloads them without a restart.

**`pkill -f "target/debug/cuemark"` matches every instance, not just the one you mean** —
confirmed the hard way (2026-07-25): a `verify-ui`-style headless debug-hook build and the
visible `cargo tauri dev` window both run a binary at the same relative path
(`target/debug/cuemark`), so a substring `pkill -f` pattern kills both, including the
window the user is actively looking at. Use the **full absolute path**
(`pkill -f "src-tauri/target/debug/cuemark$"`, note the trailing `$`) or the specific PID
(`kill $(cat /tmp/cuemark-dev.pid)`) when you only want one of them gone.

## Lifecycle rules (from CLAUDE.md)

- Frontend changes (`.svelte`, `.ts`) → Vite hot-reloads instantly, no restart needed.
- Rust changes (`src-tauri/`) → must stop + restart; the old binary keeps running until the rebuild finishes and wins, so edits silently have no effect if you skip the restart.
- **Env-var changes → require a full restart, and the restart must not inherit the old value.**
  Env is read at process start, so editing a default in Rust while an override is exported in the
  launching shell tests neither. See "Making sure a change actually reached the running app" below.

## Making sure a change actually reached the running app (2026-08-02)

A change can compile, be committed, and still not be what the app is running. Three distinct
ways that happened in one day — check all three before concluding a fix "didn't work":

**1. The edit went somewhere that doesn't execute.** A default was "changed" by rewriting only
its *doc comment*, leaving the function body at the old value. `cargo check` passes — a wrong
constant is still a valid constant — and the doc then actively lies to the next reader. Type
checks cannot catch this class at all.
→ *Verify from the runtime log line, never from the source or from "I made the edit."*

**2. An environment override masked the default.** The dev server had been started with
`CUEMARK_SINK_BUFFER_MS=200` exported. Every test passed while that shell lived; the unchanged
default only surfaced on the next "clean" restart, looking like a fresh regression.
→ Overrides now log at **WARN** on startup:
```
[audio] CUEMARK_SINK_BUFFER_MS=200ms OVERRIDE ACTIVE — compiled-in default (200ms) is NOT in effect
```
If that line is present, **you are not testing the default.** Restart without the var before
drawing conclusions about default behavior.

**3. The binary that auto-rebuilds is not the binary being launched.** `cargo tauri dev` watches
`src-tauri/` and rebuilds; the desktop-launcher release binary (`~/.local/bin/cuemark`) does not,
and has been caught a *month* stale (see CLAUDE.md). A bug reproduced there may already be fixed.

**Ground-truth checks — cheap, do them instead of assuming:**

```bash
# Which build is running? First line of every run (build.rs stamps it in).
grep '\[build\]' ~/.local/share/com.cuemark.app/logs/cuemark.log | tail -1
# [build] cuemark e998273 (dirty) profile=debug built=2026-08-02 18:15:04Z
#         exe=/home/account/repos/cuemark/src-tauri/target/debug/cuemark

# Is the running process actually the current binary?
P=$(pgrep -f 'target/debug/cuemark' | head -1)
stat -Lc %i /proc/$P/exe; stat -c %i src-tauri/target/debug/cuemark   # inodes must match

# What config is REALLY in effect? (audio example — appears on every track load)
grep "sink: pulsesink" ~/.local/share/com.cuemark.app/logs/cuemark.log | tail -2
grep "OVERRIDE ACTIVE" ~/.local/share/com.cuemark.app/logs/cuemark.log

# Is the desktop-launcher binary behind the code? (check, not a forced rebuild)
scripts/check-launcher-staleness.sh    # exit 0 fresh · 1 stale · 2 not built
```

**Read the `[build]` line before trusting anything else in the log.** `exe=` says whether
this was `cargo tauri dev` or the launcher; `(dirty)` says the worktree had uncommitted
edits, so the SHA alone does not identify the code; `built=` dates it. Old log files
retain their own stamp, so a report from last week still identifies its build.

**Prefer logging effective config over trusting the build.** Any value worth tuning is worth
printing at the point it is applied, with its source. That single habit converts all three
failure modes above from silent to obvious.

## Reading the log

| Pattern | Meaning |
|---|---|
| `VITE … ready` | Frontend dev server up |
| `[build] cuemark <sha> (clean\|dirty) profile=… exe=…` | First line of every run — **which code produced this log**. Check it before trusting anything below |
| `[audio] … OVERRIDE ACTIVE` | An env var is overriding a compiled-in default — you are **not** testing default behavior |
| `[audio/<deck>] output_queue underrun` | Pipeline can't feed the sink — upstream/CPU problem (audio-debugging skill) |
| `[audio/<deck>] main sink N: first buffer reached the sink` | Audio is actually reaching the device (absence on a silent deck is the diagnosis) |
| `[heartbeat] rAF stalled <N>ms` | Main thread stalled and recovered, with measured duration |
| `Running \`target/debug/cuemark\`` | Rust binary launched |
| `[midi] Hercules Starlight not found` | Normal — controller not plugged in |
| `[bus/<deck>] ERROR:` | GStreamer pipeline error — load audio-debugging skill |
| `[bus/<deck>] WARNING: No decoder available for type 'video/…'` | Normal — autoplug-select is correctly skipping video decoders in the audio pipeline |
| `[audio/<deck>] preroll still pending` | Pipeline deadlock — see CLAUDE.md async=false rule |
| `[analysis] peaks=N for /path/…` | Waveform analysis completed via Rust (expected on track load) |
| `HMR update` / `page reload` | Frontend hot-reload fired |
| `Watching … for changes` | Tauri watching Rust source; will rebuild on next `.rs` save |

## Measuring CPU of a running app

**`ps %cpu` is a lifetime average and is useless here.** On a 2-hour-old process it reported
7.3% while the process was genuinely at 64%. Always take a delta sample and read the *second*
iteration:

```bash
top -b -n 2 -d 3 -p $(pgrep -x cuemark) -p $(pgrep -f 'webkit2gtk-4.1/WebKitWebProcess' | head -1) \
  | awk '/PID|WebKit|cuemark/' | tail -3
```

Reference points measured 2026-08-03 with one deck playing, projector closed:
`WebKitWebProcess` 36–64%, `cuemark` 18–25%. A webview far above its main-thread `busy%`
(see CLAUDE.md's instrumentation notes) means the cost is in paint/composite, not JS.

**Always sample CPU per arm of a performance A/B, not once for the run.** The pairing is what
identifies the regime, and the two numbers can move in opposite directions: 2026-08-03 late,
`WebKitWebProcess` read **51.7% at 20fps** in one arm and **8.6% at 62fps** in another 30
seconds later, while instrumented `busy%` sat at 1% in both. `busy%` alone said "nothing is
happening"; CPU alone said "something is"; only together did they say *where*
(`docs/design/control-window-frame-budget.md` §5). Note `top -b -n 2 -d 3` takes ~3s, so start
it inside the arm's window, and record the wall-clock time of the sample so it can be matched
to a log window afterwards — a sample that straddles an arm boundary is worthless.

## Performance pitfalls / common causes of freezes

### UI freeze on first track load — mutex held during GStreamer preroll

**Symptom**: dropping a file onto a deck causes the UI to freeze for 1–5 seconds, after which everything works normally.

**Root cause**: `audio_load` (`src-tauri/src/audio/mod.rs`) previously held `Mutex<AudioManager>` for the full duration of `pipeline.load()`, which blocks waiting for GStreamer preroll (up to 5 s). Every other audio command — `audio_get_position`, `audio_set_volume`, `audio_play`, etc. — blocked on the same mutex during that window, making the app unresponsive.

**Fix applied (2026-06-28)**: `audio_load` now removes the pipeline from the map, releases the mutex, runs preroll, then re-inserts the pipeline. Other commands can proceed freely during preroll; if they look up the deck while it's being loaded they simply get a "no pipeline" response (which is correct — there's nothing to query yet).

**`audio_analyze_file`** was also changed from a synchronous command (implicitly blocking a Tokio blocking thread) to an explicit `async` command using `spawn_blocking`, keeping the threading model transparent.

**Verification**: after the fix, a `cue ON` command arrived at 21:11:15 (8 s into a load), while waveform analysis was still running and only completed at 21:11:27 — confirming the mutex was released promptly after preroll and other commands could proceed normally.

**If the freeze returns**: check `audio_load` in `mod.rs` — the mutex must be released (the `{}` block must close) before `pipeline.load(&file_path)` is called.

### "Deck stuck on load" that isn't a GStreamer/backend freeze at all — check the console before chasing the pipeline

**Symptom**: a deck shows its filename (so `deck.source` clearly updated) but never gets a video
frame, waveform, or working transport — everything else in the app (other panels, other decks)
stays fully responsive. This *looks* like the classic "freeze" but isn't the mutex-preroll bug
above or a `WatchDogQueue` WebKitWebProcess crash (see "Known WebKitGTK quirks" below) — check
process state before assuming either:

1. `ps -T -p <cuemark-pid>` and `ps -T -p <WebKitWebProcess-pid>` — if every thread is idle
   (`futex_do_wait`/`poll_schedule_timeout`, near-0% CPU across a couple of 1s samples), nothing
   is deadlocked or spinning in native code. A real GStreamer preroll hang or postFrame backpressure
   stall shows up as sustained CPU or a blocked syscall, not silence.
2. `/tmp/cuemark-dev.log` — `audio_load`'s `load()` (`pipeline.rs`) logs unconditionally very early
   (the `spectrum` element check, then `make_sink`) the moment it's reached. **Zero pipeline-related
   log lines despite a deck supposedly loading means the Rust command was never actually invoked**
   — this is backend-silent, not backend-stuck-with-a-5s-timeout (that case *does* log a `preroll
   still pending` warning).
3. Given (1) and (2), the bug is almost always a **frontend exception aborting a Svelte effect
   flush**, not anything GStreamer-related. An uncaught error thrown while rendering one component
   (e.g. a template expression like `deck.bpm.toFixed()` on an unexpectedly-`undefined` value) can
   abort the whole batch of effects scheduled in that tick — including sibling effects with no
   apparent connection to the crashing component, like `App.svelte`'s `syncVideoElements` (which
   calls `audioLoad`) or `WaveformCanvas`'s `analyzeFile` `$effect`. This is why the symptom reads
   as "the backend never got the command" — it didn't, but the actual bug is a frontend crash three
   components away from the one that looks broken.
4. **The fastest diagnostic is always the devtools console** (right-click → Inspect Element →
   Console — enabled permanently in this project, see "Debugging the production/launcher build
   specifically" below). Ask the user to check it before spending time on process/log forensics —
   a live example (2026-07-06) found the actual cause (`TypeError: undefined is not an object
   (evaluating '$$props.deck.bpm.toFixed')`) in seconds once the console was checked, after
   significant time spent ruling out mutex/GStreamer/native-freeze theories first. See
   `digger-integration` skill's gotcha on `bpm`/`downbeat` for that specific bug's root cause.

### Transport readout frozen while audio plays fine (audio-only files)

**Symptom**: a loaded track plays normally — audio, waveform playhead, position poll all
advancing — but the deck's elapsed/remaining readout sits frozen, often showing a *plausible*
time that belongs to the **previous** track.

**Root cause class**: `DeckCard`'s `currentTime`/`videoDuration` are written only from inside
the preview rAF loop, which has exactly two branches — a legacy `<video>` with
`readyState >= 2`, and a codec player. An audio-only file (`.wav`/`.mp3`) satisfies neither:
codec demux fails as designed (`[video-path] deck-N demux failed, falling back to legacy
<video>: timed out waiting for parsebin to expose a video stream`), and the fallback `<video>`
element never reaches `readyState 2` because there is nothing to decode. Neither branch runs,
so both values keep whatever the last video track left in them.

**Fixed 2026-08-03** — a third branch reads the master audio clock (`getDeckTime()`), plus an
explicit reset keyed on `filePath` so nothing survives a track change. If a similar frozen
readout reappears, check that the reset effect still fires before blaming the audio clock.

**Diagnostic shortcut**: if the two numbers on screen imply a *different* duration than the
filename label does, they are from different tracks — that arithmetic identifies the bug
immediately (0:43 elapsed + 4:05 remaining = 4:48, against a 6:26 file).

⚠️ **The `CODEC` badge in DeckCard does not clear on fallback** — a deck that failed demux and
is running the legacy `<video>` path still shows `CODEC`. Cosmetic, still unfixed; do not use
that badge to determine which video path a deck is actually on. Use the `[video-path]` log
lines instead.

### HMR hazard: landing a call site before its import kills the rAF loop

Distinct from the stale-transform trap in CLAUDE.md — here Vite serves each write *correctly*,
but an intermediate state is briefly wrong. Adding `foo()` to a loop body and its `import` in a
separate Edit means HMR fires on the intermediate file and throws
`ReferenceError: Can't find variable: foo`. Inside a rAF loop that throw happens **before** the
tail `requestAnimationFrame(...)` call, so the loop stops permanently for that component
instance — it only recovers because the next HMR re-runs the `$effect`.

**Write the import in the same pass as the first call site**, and after any instrumentation
edit confirm the loop is actually still ticking rather than assuming:
```bash
grep -a '\[aux-loop\]' ~/.local/share/com.cuemark.app/logs/cuemark.log | tail -3
```
A loop that died silently looks exactly like a loop with nothing to report.

### HMR cascade hang — batch all App.svelte edits into one pass
Each HMR reload of App.svelte (the root Svelte component) tears down and rebuilds every
GStreamer audio pipeline and re-runs full waveform analysis for every loaded track. Three
rapid HMR reloads in 11 seconds caused a full app hang confirmed in session 2026-06-27.

**Rule: make all edits to App.svelte in a single editing pass, then let HMR fire once.**
If multiple logical changes are needed, stage them all in memory and apply with one Edit/Write
call rather than incremental edits. This applies only to App.svelte — child component HMR
is lightweight and can be done incrementally.

### HMR remounts pause the deck — so never build an A/B that needs an edit per arm

The same App.svelte teardown described above also means **every code-switched measurement arm
costs a remount, a paused deck, and often a wedged pipeline needing a track re-load** (see
audio-debugging, "Transport retry storm"). Four arms that way is four interruptions of the
thing being measured, by the measurement.

**Build the switch so the arms advance themselves**: a wall-clock sweep driven from
`frame()` — 30s per arm, `baseline → X → Y → baseline`, rearming whenever nothing is playing so
each press of play is a fresh run — plus the arm name stamped on **every** `[raf]` line. One
edit total, the operator only presses play, the return-to-baseline arm proves there was no
drift, and no log window can be misattributed. Worked example:
`docs/design/control-window-frame-budget.md` §5.

Two switch designs that failed there first, both silently:
- **Keyboard.** F7/F8 never reach the webview on this desktop (F6 does).
- **`window.addEventListener` in `onMount`.** HMR does not unwind it, so handlers from
  destroyed instances keep firing and logging arm switches *for dead components* while the live
  arm never moves. **A log line reporting a switch is not evidence the switch took effect** —
  only a line stamped by the loop under measurement is. Prefer `<svelte:window onkeydown={…}>`,
  which Svelte tears down with the instance, or no listener at all.

### HMR cascade → orphaned PipeWire streams (silent audio, no hang, no error)

A quieter variant of the cascade hang above (2026-08-02): several App.svelte edits landed as
separate saves in a live session (each one touching `src/lib/state/types.ts` too, which forces
a full webview reload rather than a hot patch). Each reload re-ran `onMount`'s rehydration
logic against the **same still-running Rust process** — `AudioManager` never restarted, so
every reload tore down and recreated both decks' `DeckAudioPipeline`s again, ~10 times in under
a minute. Unlike the cascade-hang case, the app didn't freeze — it stayed fully responsive, the
log showed normal `Null → Ready → Paused` sequences and steady `position-poll` advancement after
Play — but no audio actually reached the speakers.

**Why it's silent**: the tee/`async=false` sink topology (CLAUDE.md, `av-sync-architecture.md`)
deliberately decouples GStreamer's position clock from whether a given sink branch is actually
delivering — so a pipeline stuck on a dead output still reports healthy state and an advancing
clock. The real fault was one layer down, at PipeWire: each pipeline recreation opened a new
`pulsesink` client connection to the DJControl Starlight's 4 output ports, but the *old*
pipeline's connection wasn't always cleanly dropped first. Result: 4 separate `cuemark`
PipeWire client streams fighting over the 2 decks' worth of ports (should be 1 per deck), 3 of
them orphaned and permanently stuck `[paused]`, only 1 actually `[active]` — so at least one
deck's real audio was silently bound to a dead stream.

**Diagnostic** — `pactl` is not installed in this environment; use `wpctl` (from
`wireplumber`, confirmed present) instead:
```bash
wpctl status | sed -n '/Streams:/,/^$/p'
```
Expect exactly one `cuemark` client per currently-loaded deck, all channels `[active]` while
playing. More `cuemark` clients than loaded decks, or any client stuck `[paused]` while a deck
is supposedly playing, means orphaned streams — sample it 2-3 times a second apart; a real
stuck orphan doesn't flip to `[active]` on its own.

**Fix**: kill the whole dev-server process tree (not just the frontend — the leaked PipeWire
connections live in the Rust process) and relaunch per "Stop the app" above. Killing the process
drops its PipeWire connection outright, clearing every orphaned stream immediately — confirmed
via `wpctl status` showing an empty Streams section right after the kill, before relaunch.
A plain frontend HMR reload does **not** fix this, because `AudioManager` (and its leaked
PipeWire clients) lives in the Rust process HMR never touches.

**Prevention is the same rule as the cascade-hang entry above**: batch edits to any file that
forces a full webview reload (notably shared type files like `src/lib/state/types.ts`, not just
App.svelte) into one pass before letting HMR fire, especially with a live/audible session
running. If a full restart already happened for another reason mid-edit-session, don't assume
that alone flushes leaked streams from *before* the restart — check `wpctl status` once
afterward regardless.

### MIDI audio lag — root cause chain (two layers)

**Layer 1: rAF latency in `syncVideoElements`**
`syncVideoElements` is rAF-gated (~16ms). Putting audio IPC there adds up to 16ms before
GStreamer changes rate. Fix: `v.playbackRate` stays there (WebKitGTK rebuilds pipeline on
each write — must throttle). `audioSetRate/Gain/Volume` must NOT live there.

**Layer 2: Svelte store saturation (the harder problem)**
`session` is a coarse-grained `writable<Session>`. Every `updateDeck()` call (200+/sec from
the tempo fader) creates new Session + Deck objects and fires ALL reactive subscribers:
every `$effect`, `compositor.syncDecks()`, component re-renders. A `$effect` with a
last-value guard reduces IPC call rate, but the JS thread still processes 200 store
mutations/sec — confirmed to cause visible UI display lag even after moving IPC out of rAF.

**Current fix: `src/lib/audio/audioSync.ts`**
Module-level idempotent sync functions (`syncRate`, `syncGain`, `syncVolume`) with shared Maps.
The MIDI handler (`handler.ts`) calls them **directly** before any store update:
```
MIDI → syncRate(id, val)          ← immediate IPC, no Svelte involved
     → queueDeckPatch(id, patch)  ← rAF-throttled store update for display (60fps)
```
App.svelte has a `$effect` that also calls `syncRate/syncGain/syncVolume` — this handles
UI-slider-triggered rate changes. The shared Maps prevent duplicate IPC calls.

**Rule: for continuous high-frequency controls (rate/gain/volume/crossfader) — bypass the
Svelte store for the audio path. Call `audioSync.ts` directly from the MIDI handler.
Use last-value guard Maps (in `$effect`) only for infrequent controls (cue toggle, play/pause).**

Symptom of getting this wrong: visible UI lag for the value display even when audio responds.
Both audio lag and UI display lag together = JS thread saturated by store reactive cascades.

**Confirmed miss (2026-07-21): the `jog_nudge` MIDI case was calling `updateDeck()` directly,
synchronously, on every tick** — every other continuous control (`deck_playback_rate`,
`deck_gain`, `deck_volume`, `crossfader`) already routes through `queueDeckPatch()`/
`queueCrossfader()`, but jog_nudge predated that pattern and was never migrated. A sustained
jog spin froze the whole UI (audio kept playing — GStreamer is a separate Rust thread/process,
unaffected by the JS main thread stalling) while `audio_seek IPC` kept and processed calls
fine. **When adding or reviewing any new `case` in the `handler.ts` MIDI switch that can fire
at controller-tick rates, check it routes store writes through `queueDeckPatch`/
`queueCrossfader`, not a bare `updateDeck()` call** — this is the single most common way to
reintroduce this class of freeze.

**Related but distinct bug in the same code (rate-runaway)**: `jog_nudge`'s "nudge and spring
back after idle" logic computed the new rate as `d.playbackRate + delta` — the *live*,
already-nudged value — instead of `jogBaseRate[deckId] + delta`, the saved base captured at
the start of the gesture. Every tick compounded on the previous tick's result instead of
producing a bounded offset, running the rate to its clamp within about a second of spinning.
**Any "temporary offset that springs back after idle" control must compute the offset from
the saved base value, never from the current live value** — the live value already includes
previous ticks' effects, so adding to it integrates instead of bounding.

### `output_queue` buffer limits tempo-change response
The GStreamer pipeline has an `output_queue` between the `pitch` element and `pipewiresink`.
When `set_property("tempo")` is called, soundtouch immediately processes future audio at
the new rate — but old-rate audio already in the queue must drain first. At 500ms (the
original value), this caused up to 500ms of audible lag on tempo fader moves.
Current value: 100ms (~5× the PipeWire quantum). If audio xruns appear after a rate change,
bump this slightly — but keep it under ~150ms or the lag becomes perceptible again.

### Debug `console.log` in syncVideoElements
A `console.log('[syncVideoElements]', ...)` call in the per-frame function emits at rAF
rate (60/sec). Remove any debug logging from `syncVideoElements`, `frame()`, or other
RAF-loop functions before leaving them in place.

## Known WebKitGTK quirks

- **Video canvas noise**: If deck preview shows random colored static instead of video, `WEBKIT_DISABLE_DMABUF_RENDERER=1` is missing from `main.rs`. This env var must be set before `cuemark_lib::run()` to prevent VA-API DMA-BUF surfaces from being misread by 2D canvas.
- **Port conflict on restart**: If `cargo tauri dev` fails to bind port 1420, a Vite child process is still running. Fix: `fuser -k 1420/tcp`.
- **`window.confirm()` / `window.alert()` / `window.prompt()` do NOT work** — wry (the WebView library under Tauri) never connects WebKit's `run-javascript-dialog` signal. In practice, `window.confirm()` either blocks the JS thread indefinitely with no visible dialog, or auto-accepts silently depending on WebKit version. Confirmed broken in WebKit2GTK 2.52.3. **Never use native JS dialogs for user-facing confirmation.** Use `@tauri-apps/plugin-dialog` instead:
  - `ask(message, { title, kind })` → "Yes"/"No" native dialog, returns `Promise<boolean>` — use for "Are you sure?" prompts
  - `confirm(message, { title, kind })` → "OK"/"Cancel" dialog
  - `message(message, { title, kind })` → informational alert
  - Requires the matching capability in `capabilities/default.json`: `dialog:allow-ask`, `dialog:allow-confirm`, or `dialog:allow-message`. Missing permission → IPC call silently fails.
  - Both `tauri-plugin-dialog = "2"` (Cargo) and `@tauri-apps/plugin-dialog` (npm) are already installed in this project.

## Desktop launcher (GNOME — "Show Applications" / Super key)

This mirrors the Fieldnote pattern (CLAUDE.md "Desktop launcher" section) — no `.deb`
packaging, just a release binary + symlink + hand-written `.desktop` entry. One-time setup,
or repeat after any change meant for the launcher build (not needed for `cargo tauri dev`
iteration — that's separate from this).

```bash
. "$HOME/.cargo/env"; export PATH="$HOME/.cargo/bin:$PATH"
npm run tauri build -- --no-bundle    # release build, no installer packaging — ~1-2 min incremental, longer cold
ln -sf "$(pwd)/src-tauri/target/release/cuemark" ~/.local/bin/cuemark
mkdir -p ~/.local/share/icons/hicolor/{32x32,128x128}/apps
cp src-tauri/icons/32x32.png ~/.local/share/icons/hicolor/32x32/apps/cuemark.png
cp src-tauri/icons/128x128.png ~/.local/share/icons/hicolor/128x128/apps/cuemark.png
```

Then write `~/.local/share/applications/cuemark.desktop` (this file does not exist by
default — it must be created, not just refreshed):
```ini
[Desktop Entry]
Type=Application
Name=Cuemark
Comment=VJ / live A/V mixing software
Exec=cuemark
Icon=cuemark
Terminal=false
Categories=AudioVideo;Video;Audio;
```

Refresh caches so GNOME Shell picks it up:
```bash
update-desktop-database ~/.local/share/applications/
gtk-update-icon-cache -f -t ~/.local/share/icons/hicolor
```

**Verify without relying on the live desktop session** — `gtk-launch <name>` resolves and
runs a `.desktop` file exactly like the Shell would, and is scriptable:
```bash
DISPLAY=:0 timeout 5 gtk-launch cuemark
ps aux | grep "[t]arget/release/cuemark"   # confirm it actually started
```

No restart of `gnome-shell` is needed — new `.desktop` files in `~/.local/share/applications/`
are picked up automatically. Launch via the Windows/Super key → type "Cuemark".

**After any Rust or frontend change meant for the launcher build**: rerun
`npm run tauri build -- --no-bundle` — the symlink means no reinstall step, just relaunch
from the app grid (or `gtk-launch cuemark`) to pick up the new binary.

**This build never auto-rebuilds — it will silently go stale.** Unlike `cargo tauri dev`, nothing
watches `src-tauri/` for the launcher binary; it only changes when this command is rerun by hand.
Confirmed the hard way (2026-07-26): a live-session freeze was diagnosed against a launcher binary
built 2026-06-22 — over a month stale, missing the entire webcodecs-video-path effort (phases 1-5)
and everything after, so the "freeze" was already-fixed pre-webcodecs behavior, not a regression.
Rebuild periodically, and always after a troubleshooting or design-doc session that touched
`src-tauri/`, before trusting a direct launcher-build session to reflect current code:
```bash
npm run tauri build -- --no-bundle
```
Quick staleness check — compare the binary's mtime against the newest commit touching `src-tauri/`:
```bash
stat -c '%y' src-tauri/target/release/cuemark
git log -1 --format='%ci' -- src-tauri/
```

**Always use `npm run tauri build -- --no-bundle` for this, never plain `cargo build --release`.**
A plain `cargo build` bakes in the unmodified `tauri.conf.json`, which still points `devUrl` at the
Vite dev server — the resulting binary shows "Could not connect to localhost: Connection refused"
instead of loading the bundled frontend. Only the Tauri CLI build pipeline clears `devUrl` first.
Hit this twice in one night (2026-06-20) despite it being documented in `verify-ui`'s SKILL.md too —
it's an easy one to reach for by habit when only a Rust file changed.

## Debugging the production/launcher build specifically

The launcher binary exercises a genuinely different code path than `cargo tauri dev` — most notably
video serving (`media_server.rs` vs. Vite's dev middleware) and the production `withGlobalTauri`/
`devtools` setup. Bugs that only reproduce in the launcher build, not in `cargo tauri dev`, are real
and not "just a build artifact" — see journal.md's 2026-06-20 entry for a full session where this
was the case for several stacked bugs at once.

- **`devtools` (Cargo feature on `tauri`) and `withGlobalTauri: true` (`tauri.conf.json`) are both
  enabled permanently.** Right-click → Inspect Element works on the release binary; the devtools
  console can call `window.__TAURI__.core.invoke('command_name', { ...args })` directly to test
  backend behavior without adding temporary frontend instrumentation.
- **A gray, unresponsive window that's still playing audio** means `WebKitWebProcess` crashed (its
  own internal main-thread watchdog self-trapped — see `audio-debugging` skill), not that the whole
  app hung. `pgrep -af WebKitWebProcess` — if it's gone while `cuemark` is still alive and idle,
  that's confirmed; `dmesg | grep WatchDogQueue` (needs `sudo`) shows the trap.
- **Launching the release binary directly from a terminal for debugging** (rather than via the
  desktop launcher) sometimes silently failed to start when combining `nohup ... & disown; sleep;
  pgrep` in one inline command alongside a sandbox override — no process, no error. A tiny wrapper
  script (`export FOO=bar`, `exec /path/to/cuemark`) launched via its own separate
  `nohup ./wrapper.sh > log 2>&1 < /dev/null & disown` call was reliable; cramming it all into one
  command often wasn't.
