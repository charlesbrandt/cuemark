---
name: audio-debugging
description: Debug GStreamer audio issues in cuemark — bus errors, pitch element, device routing, WebKit video stream. Load this when the audio pipeline misbehaves.
---

# Cuemark Audio Debugging

## Step 1 — read the current pipeline code

```
src-tauri/src/audio/pipeline.rs   ← the whole file
```

Focus on:
- `make_sink()` — which sink is in use and how latency is configured
- The bus monitor thread — what's currently logged and which flags are set
- `set_rate()` — should be ~3 lines setting `pitch_el.set_property("tempo", rate)`; if it's longer, something regressed
- `load()` — whether `pitch.set_property("tempo", self.rate)` is called before `inner` is stored (restores rate on reload)

## Step 2 — check recent journal/git for context

```bash
git log --oneline -10
```

Then read `journal.md` for the most recent session notes.

---

## Current pipeline topology

```
uridecodebin → queue(max-buffers=2) → audioconvert → audioresample
  → capsfilter(rate=48000) → pitch(tempo) → output_queue(100ms) → volume → pipewiresink
```

**`pitch` element** (soundtouch, `gst-plugins-bad`) — sets playback tempo without pitch change via the
`tempo` property. Set at any time; no seek, no flush, no pipeline state transition. Range: 0.1–10.0.
Requires `gstreamer1.0-plugins-bad` (`sudo apt install gstreamer1.0-plugins-bad`).

**`queue`** (input, before audioconvert) — decouples the decoder thread from audioconvert. Without it,
FLUSH seeks can hand audioconvert a buffer still held by the decoder (ref_count > 1), causing a
`gst_buffer_is_writable` assertion crash. Max 2 buffers, no byte/time limit.

**`capsfilter(rate=48000)`** — forces the downstream chain to run at 48000 Hz regardless of source
file sample rate. Without this, 44100 Hz source files cause pipewiresink to negotiate at 44100 Hz with
PipeWire, which assigns a non-power-of-two quantum (e.g. 3969 samples) → scheduling irregularities →
xruns. `audioresample` handles the actual conversion; capsfilter just locks the contract.

**`output_queue`** (after pitch) — 100ms time-based buffer between soundtouch and pipewiresink.
soundtouch produces variable-sized output chunks at non-1.0 tempos. Without buffering, PipeWire's pull
callback can fire before soundtouch has accumulated a full 1024-sample quantum → xrun. Time-based limit
(no buffer-count or byte limit) so it fills only when soundtouch is momentarily slow. **Keep at 100ms
or below** — 500ms was tried and caused audible lag after tempo changes (old-rate audio must drain before
the new tempo is heard).

---

## Why seek-based rate changes were abandoned

All seek-based approaches (FLUSH | ACCURATE, INSTANT_RATE_CHANGE, scaletempo) share a fundamental flaw:
any seek on a playing pipeline with a live PipeWire sink temporarily moves the pipeline to PAUSED for
re-preroll. With MIDI firing at 200+ events/second this is unrecoverable — a second seek fires mid-
preroll, the pipeline never returns to PLAYING. See journal.md (2026-05-05) for the full history.

**Do not attempt to reintroduce seek-based rate changes.** The property-set approach is the correct one.

---

## Current sink: pipewiresink (direct PipeWire)

`make_sink()` prefers `pipewiresink` over `autoaudiosink`. On a PipeWire+pipewire-pulse system,
`autoaudiosink` picks `pulsesink` (rank 266 > pipewiresink rank 0), routing audio through three layers
with extra buffering. Direct `pipewiresink` removes that hop.

**pipewiresink has no `buffer-time` / `latency-time` properties** — those are `GstAudioBaseSink`-specific.
pipewiresink extends `GstBaseSink`. Latency is controlled via PipeWire stream properties:

```rust
let stream_props = gst::Structure::builder("props")
    .field("node.latency", "1024/48000")  // ~21ms
    .build();
sink.set_property("stream-properties", &stream_props);
```

**pw-top diagnostics** — two modes:

```bash
# Batch mode — point-in-time snapshot, scriptable (use from Claude Code tool calls or scripts)
pw-top -b | grep -E "cuemark|ERR"

# Interactive mode — live-updating table in a terminal (use when watching a live session)
pw-top
```

Column reference:
- `S` column: `R` = running (producing audio), `I` = idle/paused
- `QUANT / RATE`: both cuemark pipewiresink streams should show `1024 / 48000` (~21ms); if one shows a
  non-standard quantum (e.g. 3969 / 44100), the capsfilter didn't apply (deck was loaded before a Rust rebuild — re-load the track)
- `ERR`: PipeWire xrun count for this stream; brief bursts are normal; sustained growth means pipeline starvation
- Two `+ cuemark` streams expected: our two pipewiresink decks; WebKit video element pipeline appears as a separate stream

**Use `pw-top -b` to diagnose a live audio-stop** — run it while the app is showing symptoms (audio silent, UI still active). The ERR count on the 48kHz cuemark stream tells you immediately whether you have an xrun cascade (thousands) vs a pipeline logic bug (ERR near zero). No need to restart first.

---

## WebKitGTK video element audio stream

WebKitGTK opens its own GStreamer/PipeWire audio stream for every `<video>` element, even when
`v.muted = true`. The `muted` attribute zeroes the sink volume but does NOT tear down the audio
decode pipeline. Visible in pw-top as a separate `+ cuemark` entry.

**`v.playbackRate` changes trigger WebKit pipeline rebuilds** — every time `v.playbackRate` is written,
WebKitGTK can rebuild its internal GStreamer pipeline. This is CPU-intensive. With MIDI tempo events
firing at 200+/sec (rAF-throttled to 60/sec), this was causing CPU spikes that starved the audio
streaming thread → PipeWire xrun cascade (observed: 177 xruns → 1301 within seconds → pipeline ERROR).

Fix: `syncVideoElements` tracks `lastPlaybackRate` per deck and only writes `v.playbackRate` when the
value actually changes. This reduces rebuilds from 60/sec constant to once per unique rate value.
During active MIDI tempo sweeps, each unique value still triggers one rebuild.

**The rebuild loses `muted`** — the new WebKit pipeline initializes briefly unmuted before the JS
`v.muted = true` re-apply lands. `v.muted` alone is not reliable because it's linked to the pipeline
state. Fix: also set `v.volume = 0` — this is a JS object property that survives pipeline rebuilds.
Both `v.volume = 0` and `v.muted = true` are applied unconditionally every `syncVideoElements` pass
AND inside the `lastPlaybackRate` guard after `v.playbackRate =`.

**WebKit stream always at source file sample rate** — WebKit negotiates its own audio stream at the
source file's native rate (44100 Hz for most music files), independent of our capsfilter. You will
always see a second `+ cuemark` stream in pw-top at 44100/3969 when a 44100 Hz file is loaded.
This is expected and unavoidable. The ERR count here should be low (< 10); sustained growth would
indicate the WebKit pipeline is stalling.

**`createMediaElementSource(v)` does NOT fix this** — in WebKitGTK it creates a third decoder rather
than redirecting the existing one. Tried and reverted.

**Distinguishing WebKit audio bleed from other issues:**
- WebKit bleed: doubled audio specifically during or just after tempo changes
- Root cause: muted lost on pipeline rebuild; volume survives
- Fix: confirm `v.volume = 0` is set unconditionally in `syncVideoElements` (not just inside the rate-change guard)

---

## PipeWire xrun cascade

xruns in pw-top's ERR column are normally benign (brief gaps during seeks). A cascade — ERR climbing
rapidly to 1000+ — means the pipeline has entered ERROR state and stopped producing audio while the
PipeWire connection stays open. PipeWire keeps scheduling the stream every 21ms; each missed callback
is one more xrun.

**Three causes, ordered by likelihood:**

1. **14-bit fader LSB triggering duplicate writes** (most common) — each fader position fires
   CC N (MSB) then CC N+32 (LSB), each emitting a `DeckPlaybackRate` action with a slightly
   different value (~0.002–0.004 apart). A strict `===` guard lets both fire through:
   - `v.playbackRate` written twice → two WebKit GStreamer pipeline rebuilds per fader position
   - `audio_set_rate` IPC called twice → two soundtouch `tempo` property sets per fader position
   Both double CPU pressure on the streaming thread. Observed: 5,788 xruns and audio silence
   within ~4 minutes of tempo fader use on a loaded machine.
   Fix: `Math.abs(rate - last) < 0.005` in `lastPlaybackRate` check (`syncVideoElements`, App.svelte)
   and in `syncRate` (`audioSync.ts`). Use `pw-top -b` to get a snapshot of ERR counts mid-session
   to confirm the cascade before restarting.
   Symptom: ERR climbs steadily during tempo fader sweeps; audio drops after extended fader use.

2. **Source file at non-native sample rate** — deck loaded before the Rust capsfilter was compiled in,
   or capsfilter negotiation failed. Symptom: `pw-top` shows the deck at 44100 Hz / QUANT=3969.
   Fix: re-load the track to get a fresh pipeline.

3. **soundtouch variable output chunks** — transient; the `output_queue` absorbs this. If xruns still
   appear at specific tempos, check that `output_queue` with time-based limit is present in the pipeline.

**Diagnosing a stuck pipeline**: when ERR stops climbing but audio is silent, check the bus log for
`[bus/deck-N] ERROR:`. The `at_error` flag is set but there is no auto-recovery — the pipeline stays
in ERROR until the user re-loads the track.

---

## Waveform position clock

The waveform reads position from `getDeckTime(deckId)` in `seekBus.ts`. When playing, that returns
the `audioTimes` map (IPC-driven content position). When paused or right after a seek (before any IPC
resolves), it falls back to `els.get(deckId)?.currentTime`.

### `query_position` returns wall-clock, not content time

GStreamer's `query_position` always returns stream time based on the GStreamer segment rate.
The soundtouch `pitch` element sets its `tempo` property in-place — it never issues a rate-seek —
so the GStreamer segment rate always stays 1.0 regardless of `deck.playbackRate`. At 2× tempo,
`audioPos` (from `query_position`) advances at 1× wall-clock while content actually advances 2×.

**`contentPosTracker` in `App.svelte`** converts wall-clock IPC position to content position by
integrating per-frame deltas at `deck.playbackRate`:

```
contentPos += (audioPos - prev.audioPos) × playbackRate
```

A delta > 500 ms between consecutive IPC responses is treated as a seek: in that case `audioPos`
directly IS the correct content position (GStreamer returns the seek target immediately once the seek
completes), so it is used as-is and `contentPosTracker` is re-anchored from there.

**`resolvedRate` is read at IPC resolution time**, not at the moment the IPC is dispatched. If the
rate changed while the call was in flight (e.g. a 2× → 1× change arriving while a 2× delta is
integrating), the start-rate would overshoot `contentPos` by `IPC-latency × rate-diff`. Reading the
rate from the Svelte store at the moment the Promise resolves avoids this.

### `pendingSeekTarget` filter (stale pre-seek IPC responses)

On a heavy video, GStreamer can take > 1 s to flush and re-preroll after a seek, during which
`query_position` keeps returning the pre-seek position. Without filtering, the RAF loop computes
`contentPos ≈ pre-seek-value`, then the snap `v.currentTime = contentPos` reverts the video to
the old position.

`seekDeck()` records the seek target in `pendingSeekTarget`. The RAF callback checks after computing
`contentPos`: if `|contentPos − seekTarget| > 0.5 s`, the frame is skipped entirely (no snap, no
`setDeckAudioTime`). Once GStreamer's position converges on the seek target, the filter clears.

### `audioTimes.delete` on seek (not `.set(time)`)

`seekDeck()` calls `audioTimes.delete(deckId)` rather than `audioTimes.set(deckId, time)`. If the
GStreamer IPC later returns `null` (common during the EOS → seek → play transition), the callback
exits early without calling `setDeckAudioTime` — leaving `audioTimes` populated with the seek target
would block `getDeckTime`'s fallback, making the waveform return the stale seek-target value
indefinitely. With `delete`, `getDeckTime` falls back to `els.get(deckId)?.currentTime`, which was
already set synchronously by `el.currentTime = time` in `seekDeck()`.

### One in-flight IPC per deck

`pendingPos` map in `App.svelte` ensures only one `audioGetPosition` IPC is in flight per deck at
a time. A stale slow-resolving IPC (e.g. from a mid-rate-change GStreamer hiccup) cannot overwrite
a newer position already written by a subsequent IPC that resolved faster.

---

## Video serving and WebKit canvas/render-loop debugging (2026-06-20)

**Production video no longer uses a custom URI scheme.** `media://` never worked reliably for
`<video>` in WebKitGTK (confirmed: instant `FormatError`, zero GStreamer pipeline construction,
codec-independent — see journal.md 2026-06-20). Both dev and prod now serve local video files over
plain HTTP: dev via the Vite middleware in `vite.config.ts`, prod via `src-tauri/src/media_server.rs`
(a `tiny_http` server on an ephemeral `127.0.0.1` port). If video loads but the deck preview is
black again, first suspect the local HTTP server (is `media_server_port` resolving? is the file
path correct?) — not codec/decoder issues.

**Cross-origin canvas tainting can silently kill the entire render loop.** The `<video>` element's
`src` is a different origin (`http://127.0.0.1:<port>`) than the page (`tauri://localhost`). Without
`v.crossOrigin = "anonymous"` (set in `App.svelte` right after creating the element, before `src`),
any canvas read of the video (`drawImage`/`texImage2D` in `fbo.ts`) throws `SecurityError`. Because
this throw happens inside the `requestAnimationFrame` callback in `App.svelte`, it aborts *before*
the trailing `requestAnimationFrame(frame)` reschedule — the entire render loop dies silently after
one bad frame. Symptom: video/audio keep playing (separate codepaths), but the Output Window stops
updating and the waveform playhead/position freezes, with no console error visible unless devtools
happened to be open at the exact moment. **Every HTTP response from `media_server.rs`, success or
error (404/500), must carry `Access-Control-Allow-Origin`** — a browser permanently marks a media
resource's CORS-taint flag the moment *any* request for it lacks the header, even a transient error
under load, and that taint never clears even once later requests succeed. If the canvas pipeline
worked earlier in a session and then silently breaks again with no code change, suspect taint
accumulation from an intermittent server-side gap, not a regression in whatever you just touched.

**`WatchDogQueue` trap = WebKit's own renderer crashed, not an app hang.** A gray, frozen-looking
window that still plays audio (GStreamer/Rust pipeline is independent of the JS render loop) usually
means `WebKitWebProcess` itself died. Check `pgrep -af WebKitWebProcess` — if it's gone while the main
`cuemark` process is alive and idle, `dmesg | grep WatchDogQueue` (needs `sudo`) will show
`traps: WatchDogQueue[pid] trap int3 ... libglib-2.0.so` — WebKit's internal main-thread
responsiveness watchdog deliberately self-trapped because the JS main thread was blocked too long.
Tauri/wry doesn't currently detect or recover from this; the window stays frozen until killed and
relaunched. Root cause was an unbounded backlog in `outputBus.ts`'s `postFrame()` (no backpressure —
fixed with an in-flight guard) compounding with genuinely heavy per-frame work (WebGL composite +
canvas capture + cross-process `postMessage` for two simultaneous decks).

**Debugging WebKit's *internal* GStreamer pipeline requires a global `GST_DEBUG` threshold, not just
named categories.** `GST_DEBUG=uridecodebin:5,decodebin:5` shows plenty for our own Rust process but
nothing for `WebKitWebProcess` — categories not explicitly listed default to `NONE`, and WebKit's own
categories (`webkitmediaplayer`, etc.) aren't in a list built for our pipeline. Use
`GST_DEBUG=2,webkitmediaplayer:7,uridecodebin:5,decodebin:5,...` (leading global number) to see both.
Also: `WEBKIT_DEBUG` (any channel, even definitely-valid ones like `Network`) is fully non-functional
on this machine's webkit2gtk build ("Unknown logging channel" for everything) — don't waste time on
it here. And each `gst_init()` call gets its own debug clock starting at `0:00:00.000`; use the `pid`
field in the log line (the number right after the timestamp), not the timestamp itself, to tell which
process a line came from when merging logs from our pipeline and WebKit's.

**Production builds need `devtools` + `withGlobalTauri` to be debuggable at all.** Both are enabled
permanently in `Cargo.toml`/`tauri.conf.json` now. Without `devtools`, there's no right-click →
Inspect Element on a release build, so `console.error`/`console.log` (where most real signal lives —
CORS errors, taint SecurityErrors) is invisible. Without `withGlobalTauri`, `window.__TAURI__`
doesn't exist, so you can't call `window.__TAURI__.core.invoke('audio_get_position', { deckId:
'deck-0' })` directly from the console to bisect "frontend bug vs. backend bug" without adding
temporary instrumentation.

**`video.duration === Infinity` for non-fast-start MP4s breaks naive "not yet known" guards.**
Common for YouTube-downloaded files where the `moov` atom is at the end of the file. `Infinity` is
truthy in JS, so a guard written as `!s.duration` (meant to mean "we don't have a real duration yet,
apply the GStreamer-derived fallback") never fires once `Infinity` lands there. Downstream,
`WaveformCanvas`'s `playheadX = (currentTime / duration) * W` evaluates to `0` for any `currentTime`
when `duration` is `Infinity` — looks exactly like "playhead frozen at the start," not "duration is
wrong." Fix needs **both** `!s.duration` (catches the real initial placeholder, `0`) and
`!Number.isFinite(s.duration)` (catches `Infinity`/`NaN`) — swapping one check for the other instead
of combining them breaks the other case.

**Every `drawImage(video, ...)` call site needs its own `videoWidth`/`videoHeight === 0` guard —
they don't share one.** `fbo.ts`'s `uploadVideoFrame()` already guarded against drawing a video
element with no video track (audio-only files, e.g. `.mp3`, loaded into a `'video'`-type deck).
`DeckCard.svelte`'s separate preview-canvas draw loop (its own `requestAnimationFrame`, drawing
straight to a 2D canvas for the per-deck thumbnail) did not have this guard, and WebKitGTK throws
`SecurityError` from `drawImage()` when the source video element has `readyState >= 2` but
`videoWidth === 0` (no video track) — Chrome silently no-ops in this case, WebKitGTK doesn't.
Symptom: console shows `readyState=4 ... error=none` (the file loaded fine) immediately followed
by `SecurityError: The operation is insecure` at `texImage2D`/`drawImage`, only when the loaded
file has no video stream. Fixed by adding the same `video.videoWidth > 0 && video.videoHeight > 0`
check (plus a try/catch, since a render loop dying from one bad frame is the same `requestAnimationFrame`
abort-on-throw failure mode as the cross-origin tainting bug above) in `DeckCard.svelte`. **Any new
canvas/texture draw site that reads from a `<video>` element needs this same guard independently —
it is not centralized.**

---

## Known failure modes

### UI freeze on first track load (mutex held during preroll)

**Symptom**: the app feels completely unresponsive for 1–5 seconds immediately after dropping a file onto a deck. After the freeze everything works normally.

**Root cause**: `audio_load` in `mod.rs` was holding `Mutex<AudioManager>` for the entire duration of `pipeline.load()`. GStreamer preroll — the `pipeline.state(Some(gst::ClockTime::from_seconds(5)))` call at the end of `load()` — can block for up to 5 seconds (typically 0.5–2 s). Any other audio command that needed the mutex (`audio_get_position`, `audio_play`, `audio_set_volume`, …) blocked for the full preroll duration.

**Fix**: `audio_load` now removes the pipeline from the map, releases the mutex inside a scoped block, runs `pipeline.load()` without holding any lock, then re-acquires the mutex briefly to re-insert the pipeline. The pattern:

```rust
// In mod.rs audio_load:
let mut pipeline = {
    let mut mgr = state.lock().unwrap();
    mgr.pipelines.remove(&deck_id).unwrap_or_else(|| { /* create new */ })
    // mutex released here ↑
};

let result = pipeline.load(&file_path); // preroll runs WITHOUT holding the mutex

state.lock().unwrap().pipelines.insert(deck_id, pipeline);
result
```

While the pipeline is out of the map, other commands that look up `deck_id` will get a "no pipeline for deck" error — correct behaviour, since there is nothing to query during a load.

**`audio_analyze_file`** was also changed from a sync command (`pub fn`) to `pub async fn` with an explicit `spawn_blocking`. The sync version implicitly consumed a Tokio blocking thread for the full GStreamer audio decode; the async version makes the threading contract explicit.

**If the freeze returns**: open `src-tauri/src/audio/mod.rs`, find `audio_load`. Confirm the `state.lock()` guard closes (`}`) **before** `pipeline.load()` is called. If the lock is still held during `load()`, preroll will re-introduce the freeze.

### `set_rate →` log lines stop but MIDI events keep firing

With the pitch element, `set_rate()` has no guards — if MIDI events are arriving but no `set_rate →`
lines appear, the issue is upstream of pipeline.rs:

1. **`inner` is None** — no pipeline loaded (check for a failed `load()` earlier in the log)
2. **`at_eos` not set but no inner** — `Ok(())` returned silently from the `None` branch
3. **Regression** — someone reintroduced guards or the old seek-based logic

If `set_rate →` lines appear but audio is not changing, check that the `pitch` element compiled in
(look for `[audio/deck-N] sink:` line on load — if missing, load() failed and inner is None).

### Tempo has no effect after reloading a file

`load()` calls `pitch.set_property("tempo", self.rate)` before storing `inner`. If that line is missing
or moved after the `inner = Some(...)` assignment, a fresh load always resets tempo to 1.0.

### Audio stops after waveform-click seek or cue jump

These go through `seek()` → `seek_simple(FLUSH | KEY_UNIT, pos)`. Unlike rate-change seeks (which are
gone), user-initiated seeks are infrequent one-shots and the pipeline recovers normally. If audio stops:
- Check bus log for ERROR after the seek
- Check whether `at_eos` was true at seek time (EOS restart seek in `play()` is a separate path)

### EOS restart plays at wrong tempo

`play()` calls `seek_simple(FLUSH | KEY_UNIT, ZERO)` when `at_eos` is set, then sets state to Playing.
After the seek, the `pitch` element's `tempo` property is unchanged — it was set at load time and isn't
reset by seeks. No special handling needed. If tempo is wrong after EOS restart, check that `load()` is
setting `pitch.set_property("tempo", self.rate)` (not defaulting to 1.0).

### Non-ASCII filenames fail to load

`file_to_uri()` percent-encodes every non-ASCII byte individually — covers multi-byte UTF-8 sequences.
If a file fails to load and the path contains special characters, check `file_to_uri()` is intact.

### Elements disposed in READY/PAUSED state → GStreamer CRITICAL warnings

`load()` preroll failure path calls `bus.set_flushing(true)` + `set_state(Null)` before early return.
`Drop` impl does the same. If you see CRITICAL warnings on teardown, check these paths.

### Fresh machine: tracks load (filename shows) but never play, no waveform, black video preview

Confirmed root cause on a clean Ubuntu install (2026-06-19): `gstreamer1.0-plugins-bad` was never
installed — only `libgstreamer-plugins-bad1.0-0` (the runtime *library*, pulled in transitively) was
present, not the actual plugin package. This is a silent failure: `cargo build`/`cargo tauri dev`
compile and launch fine, because the Rust code only links against `gstreamer`/`gstreamer-audio`
headers, not against specific plugin .so files — the missing element is only discovered at pipeline
construction time, deep in `load()`.

Two independent symptoms, same one cause:
- Rust audio pipeline: `GStreamer element 'pitch' not found: Failed to find element factory with name
  'pitch'` in the WebKit devtools console (right-click deck → Inspect Element → Console — this does
  **not** appear in `cargo tauri dev`'s terminal output or `~/.local/share/com.cuemark.app/logs/cuemark.log`,
  since it's a JS-side `console.error` from a rejected `audioLoad()` promise, not a Rust `log::` call).
  Pipeline construction throws before `inner` is ever set → "no pipeline loaded" / "no audio pipeline
  for deck" on every subsequent call → no waveform (waveform analysis also goes through the Rust
  pipeline, not `decodeAudioData` — see CLAUDE.md).
- `<video>` element: `NotSupportedError`, `error.code === 4` — WebKit's own internal GStreamer instance
  also needs `h264parse` (also shipped in `plugins-bad`) to demux H.264-in-MP4, so it fails too. Looks
  identical to the unrelated VA-API DMA-BUF black-screen bug (see journal.md 2026-06-19 entry) but has
  a different fix — don't reach for the VA-API rank-demotion fix first; check `gst-inspect-1.0 pitch`
  before assuming it's the GPU driver issue.

Fix: `sudo apt-get install gstreamer1.0-plugins-bad`, then **fully restart** the app (`cargo tauri dev`
caches the GStreamer plugin registry per-process — a frontend hot-reload is not enough, kill and
relaunch). Verify with `gst-inspect-1.0 pitch` before relaunching. See `run-app` skill's prerequisites
section, which now lists this as a separate "runtime plugins" install step from the build-time
`-dev` headers, since the two are easy to conflate.

---

## Bus message guide

| Message | What it tells you |
|---|---|
| `EOS` | Track ended. `at_eos` flag triggers seek-to-zero on next `play()`. |
| `ERROR` | Fatal pipeline error. Log names the element and GStreamer flow return. Sets `at_error`. |
| `WARNING` | Non-fatal. Usually codec quirks. |
| `StateChanged` (pipeline-level) | Shows NULL→READY→PAUSED→PLAYING lifecycle. An unexpected drop to PAUSED mid-playback is a sign of a seek interaction problem. |
| `AsyncDone` | Seek completed (user-initiated seek or EOS restart). Logs position. |

---

## MIDI log throttle

High-frequency MIDI controls throttled to one log line per 500ms per `(status, d1)` key in `midi.rs`.
To see every event, remove the key from `log_throttle` or set threshold to 0.

**Debugging trap (confirmed 2026-07-21 jog-wheel session)**: the throttle only suppresses the
*log line* — `MidiAction` dispatch to the frontend fires for every real message, unthrottled.
Counting `=> JogNudge` (or any continuous-control) log lines and comparing against a downstream
counter (e.g. real seeks/IPC calls) will show what looks like 5–13x "amplification" that isn't
there — it's just many real events for each logged one. Don't chase a duplicate-listener or
double-dispatch theory from this mismatch alone. To get a real 1:1 count for debugging, add a
temporary counter/log at the effect site itself (e.g. inside the Tauri command being called),
not by comparing against the throttled MIDI log line count. This cost real time in that session:
a plausible-looking "5 HMR reloads ≈ 5x duplicate seeks" coincidence turned out to be a red
herring once a Rust-side `audio_seek` call counter proved the real ratio (238 IPC calls for 92
logged events) was fully explained by the log throttle, not by stacked event listeners.

---

## Files

| File | Concern |
|---|---|
| `src-tauri/src/audio/pipeline.rs` | Per-deck GStreamer pipeline, bus monitor, tempo/pitch element |
| `src-tauri/src/audio/mod.rs` | AudioManager, Tauri command handlers |
| `src-tauri/src/midi.rs` | MIDI event loop, log throttle, 14-bit rate decoding |
| `src-tauri/src/media_server.rs` | Local HTTP server for prod video serving (replaces `media://`) |
| `src/App.svelte` | Video element creation (muted, crossOrigin), rAF-throttled syncVideoElements, render loop |
| `src/lib/renderer/outputBus.ts` | Output Window frame capture/transport — has backpressure guard |
| `journal.md` | Session notes — decisions and symptoms from past debugging |

## VA-API hardware decode status (as of 2026-06-20)

`src-tauri/src/main.rs` sets `GST_PLUGIN_FEATURE_RANK` to demote specific VA-API decoders to rank 0,
forcing software decode fallback for codecs where this GPU's DMA-BUF export was confirmed broken.
**Current state: only AV1 (`vaav1dec`/`vaapiav1dec`) is demoted.** H.264 hardware decode was
re-enabled 2026-06-20 after a `mesa-va-drivers`/`webkit2gtk` update and confirmed working (real
video, no corruption, lower CPU than dual software decode). If a black-screen or solid-garbage-color
symptom returns for H.264, or shows up freshly for AV1/VP9/HEVC, re-add the codec's `va*dec`/
`vaapi*dec` factory name to the rank string in `main.rs` — see the comment there and the
2026-06-19/2026-06-20 journal entries for the full history before assuming it's fixed for good.

## Clipping / muddy output — gain chain and master volume

**Symptom**: output sounds clipped or distorted even when per-deck volume and gain sliders are
turned down. Master volume slider appears to have no effect.

**Root cause confirmed 2026-06-28**: `MasterMix.set_master_volume()` (`mixer.rs`) is a stub — it
stores the value but never applies it to GStreamer. `MasterMix` is scaffolding for a future
shared-audiomixer topology; its `_main_pipeline` is always `None`. The actual master volume is now
implemented in `AudioManager` directly (see below).

**Gain chain per deck** (as of 2026-06-28):

```
GStreamer volume element = gain × vol × master_volume
```

- `gain` — pre-fader trim (0–4, default 1.0); UI slider in DeckCard
- `vol` — post-fader level (0–1, default 1.0); driven by crossfader or UI slider
- `master_volume` — global factor (0–1, default 1.0); set via `audio_set_master_volume` IPC

`master_volume` is stored in `AudioManager.master_volume` and propagated to all active deck
pipelines via `set_master_volume_factor()`. New pipelines inherit it at `audio_load` time.

**PipeWire summing**: each `DeckAudioPipeline` has its own `pipewiresink`; PipeWire sums all
streams at hardware level. With N decks at gain=1, vol=1, master=1 you can get up to N× summed
amplitude. Reduce master volume if two fully-loaded decks clip: pulling to ~0.6 gives ~4 dB of
headroom for two simultaneous sources.

**What is still a stub** (2026-06-28):
- `MasterMix` in `mixer.rs` — the shared audiomixer topology hasn't been built
- `set_eq()` in `pipeline.rs` — EQ sliders show in the UI but do nothing to GStreamer
