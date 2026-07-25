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

**Bug found and fixed 2026-07-25: this filter had no time bound, so "seek while playing" could
freeze the waveform position permanently.** The distance check above assumes a stale reading is
always *behind* the target — true for "seek then stay paused," false for "seek while playing"
(the normal case): real playback carries the position *past* the target the instant the seek
actually lands. If the first post-seek reading happens to arrive late enough (slow seek, or
several seeks/rate-changes fired back-to-back) that the position is already `>0.5s` past the
target, it's wrongly discarded as stale — and since the filter never clears, *every* reading
after that is discarded too, freezing `getDeckTime()`/the waveform position clock forever while
GStreamer and the `<video>` element both keep advancing normally underneath. User-reported
symptom: "video keeps playing but the waveform position stopped moving," especially at
non-1.0 rate. Confirmed live both headlessly (via this skill's technique below) and
independently on the real desktop at the same time. **Fix**: `pendingSeekTarget` now stores
`{time, setAtMs}`; `getPendingSeekTarget()` auto-expires and clears the entry after
`SEEK_STALE_TIMEOUT_MS` (1500ms) regardless of distance, so a reading that old is trusted
outright — a wrong one-frame reading self-corrects on the very next poll, unlike the permanent
freeze it replaces. See `project_seek_staleness_freeze_fix` memory for the full writeup and
regression-test repro recipe.

**Diagnostic technique for "cached/derived value frozen but is the underlying thing actually
stuck?"**: call the real Tauri command directly from a WebDriver script, bypassing whatever
frontend caching/derivation is under suspicion, and compare side-by-side:
```js
window.__TAURI__.core.invoke("audio_get_position", {deckId}).then(raw => /* compare raw vs cached */)
```
This is what distinguished "the Rust pipeline is genuinely stuck" (raw position frozen too) from
"only the frontend's cached/derived clock is stuck" (raw keeps climbing, `v.currentTime` keeps
climbing, only `getDeckTime()`'s cached value is frozen) — the latter is what this bug turned out
to be. Reusable any time a value read through app-level state is suspected of lying about the
underlying system's real state.

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

### UI frozen solid, audio keeps playing, rAF heartbeat log stops forever — check which of two distinct causes

**Shared symptom**: `[heartbeat] rAF alive` (`App.svelte`'s `frame()`, logged once/sec via
`debugLog`) ticks cleanly then stops permanently — no further log output of any kind —
while GStreamer's independent Rust audio pipeline keeps playing. Found live, root-caused
via `gdb`, 2026-07-24/25 — full writeup in `docs/design/pcm-buffer-playback.md`, "Ninth
mechanism". Two different mechanisms produce this identical externally-observable
symptom; don't assume it's the first one just because the shape matches:

1. **A real deadlock inside WebKitGTK's own `MediaPlayerPrivateGStreamer`** — the GTK/JS
   main thread stuck inside a synchronous `gst_element_send_event()` (a `<video>` seek),
   holding a GStreamer element mutex, while one of WebKit's own internal GStreamer
   streaming threads is parked on a `WTF::ParkingLot` condition variable waiting for that
   same main thread's run loop to service a "new sample ready" signal. Classic AB-BA
   deadlock, confirmed via a live `gdb -p <pid> thread apply all bt` on the actual
   still-hung `WebKitWebProcess`. Not a cuemark/Rust bug — a real WebKitGTK bug. Trigger:
   `App.svelte`'s drift-correction resync (`v.currentTime = contentPos` when audio/video
   drift exceeds a threshold) fires this exact seek call on essentially every
   position-poll for as long as any deck plays at a non-1.0 rate, not just during scratch.
   Mitigation (not a fix — can't fix a bug in WebKitGTK itself): widen the drift threshold
   (`App.svelte`, currently 250ms) so the seek — and thus this deadlock's trigger window —
   fires far less often. **Diagnostic tell**: if you can still get a `gdb`/WebDriver JS
   execution response from the frozen process, it's NOT this one — see #2.
2. **A near-end-of-track decode stall at non-1.0 rate, unrelated to seeks or
   networking** — WebKit's `<video>` element itself genuinely stops advancing
   (`readyState` stuck at 2 `HAVE_CURRENT_DATA`, `networkState` stuck at 2
   `LOADING`, every internal GStreamer streaming thread parked in
   `futex_do_wait`) while the **JS main thread stays fully responsive**
   (WebDriver JS execution and the rAF loop itself keep working). **First
   hypothesis (media_server.rs cache-lookup race) turned out to be wrong** —
   disproven live when the exact same stall recurred with `buffered` already
   reporting the *entire file* downloaded (`[0, duration]`), which rules out
   any network race by definition (nothing left to fetch). `media_cache.rs`'s
   `lookup_wait()` is still a real, worthwhile fix for the race it *does* fix
   (kept), just not the cause of this stall. **Actual root cause, confirmed via
   a control test**: WebKitGTK's internal video-only GStreamer pipeline runs at
   `segment.rate = deck.playbackRate` once `v.playbackRate` ≠ 1.0, and its own
   EOS/segment-boundary bookkeeping doesn't land cleanly at a non-1.0 rate — a
   downstream element waits forever for one more buffer that a rate-scaled
   calculation thinks should exist but doesn't. Confirmed by seeking near the
   end and playing to true EOS at `playbackRate=1.0`: clean every time, vs. 2
   stalls in 3 attempts at 0.87×. A bug inside WebKitGTK itself, same family as
   #1 above (both triggered by non-1.0 `v.playbackRate`) but a different
   manifestation — a decode-thread stall with the main thread free, not a
   main-thread deadlock. **A mitigation (reset `<video>` to `playbackRate=1.0`
   near track end) was built, live-tested, and fully reverted the same day
   (2026-07-25)** after three compounding regressions — see "Eleventh
   mechanism" in the design doc for the full sequence (a store-effect-gated
   guard that never fired; a switch to `v.currentTime` for reliability; a real
   audio-truncation regression from letting `onended` stop the still-playing
   real audio early; a worse attempt to fix that by waiting on `deck-eos`,
   which doesn't reliably arrive and left audio playing forever). **Currently
   unmitigated by deliberate choice** — every attempted fix cost more than the
   rare freeze it avoided. Root-cause research (same session): `libwebkit2gtk
   -4.1` is already at the latest Ubuntu 24.04 apt version (2.52.3, no upgrade
   path); WebKit's own `setRate()` issues a standard `FLUSH|ACCURATE` seek with
   `stop=GST_CLOCK_TIME_NONE`, not obviously wrong in isolation — the actual
   bug likely lives in `multiqueue`'s rate-scaled buffering-level accounting
   never resolving to real EOS once `segment.rate != 1.0`. No matching public
   WebKit bug report found. A real structural fix would mean either never
   setting `v.playbackRate` away from 1.0 at all (raises mechanism-#1
   exposure instead) or a custom Rust/GStreamer video-decode pipeline
   bypassing WebKit's `<video>` element entirely (mirrors the PCM-buffer
   approach already built for audio scratch) — neither attempted; both are
   substantial projects, not quick patches.
   **Diagnostic tell**: check the video element's
   `paused`/`ended`/`readyState`/`networkState`/`buffered` via the debug hook
   or devtools. `readyState < 3` mid-playback (not `paused`, not `ended`) means
   a genuine stall; `buffered` already covering the full duration at the time
   of the stall rules out a network cause and points at internal
   decode/segment bookkeeping instead. Don't assume a stuck position value is a
   freeze at all until you've checked these — reaching a legitimate
   end-of-track also freezes the polled position (WebKitGTK resets
   `currentTime` to 0 after `ended` fires, with `paused=true`), which looks
   identical to a stall from a single polled number alone. A control run at
   `playbackRate=1.0` (the setting a rate-related hypothesis predicts should
   *not* fail) is a cheap, decisive way to confirm or rule out this whole
   class before trusting any fix.

**Catching either one live, cheaper than a fresh repro**: if a process from a *real*
incident is still alive and hung (check `ps -o etimes,stat -p <pid>` — an old, sleeping
`cuemark`/`WebKitWebProcess` pair is worth investigating before anything else), attaching
`gdb` to it directly (`gdb -p <pid> -batch -iex "set debuginfod enabled off" -ex "thread
apply all bt"`) hands you the actual incident's state instead of needing to reproduce
from scratch. This still needs root — `ptrace_scope=1` blocks attaching to a
non-descendant process even with the harness's sandbox override disabled (confirmed: that
override only lifts the harness's own restrictions, not the kernel's). If you don't have
passwordless `sudo`, ask the user to run the `gdb -p` command themselves via `!` so the
password prompt reaches them directly, and paste the backtrace back.

**Systemic plan (2026-07-25 architecture review) — read before adding any new
`<video>`-element mitigation**: both mechanisms above are bugs inside WebKitGTK's
`MediaPlayerPrivateGStreamer`, and the mitigation-stacking approach was explicitly
retired after the Eleventh mechanism. The agreed direction is in `docs/design/`:
`freeze-watchdog.md` (Rust-side heartbeat watchdog + session-of-record + webview
reload recovery — makes ANY webview freeze a few-second blink instead of a
show-ender), `webcodecs-video-path.md` (replace the `<video>` element with
`VideoDecoder` slaved to the Rust audio clock — removes both mechanisms'
trigger operations entirely; feasibility spike passed same day, see its results
table), and `native-output-pipeline.md` (shelved escalation path). Upstream bug
drafts with evidence: `docs/upstream/`. Key empirical facts to not re-discover:
WebCodecs decode is mature/default-on and works correctly here (1080p software
decode 153–165 fps), but **any use of `VideoEncoder` (`isConfigSupported` or
`configure`) SIGABRTs the web process** — recording must stay in Rust. Probe
harnesses: `scripts/probes/` (see `verify-ui` skill's "Lightweight webview
probes" section for the technique).

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
| `EOS` | Track ended. `at_eos` flag triggers seek-to-zero on next `play()`. **The bus thread also calls `pipeline.set_state(Paused)` directly right here** (added 2026-07-25) — GStreamer does not stop a pipeline's clock on EOS by itself; `PLAYING` state keeps ticking with nothing left to render, so `query_position` climbs forever (real-time, unbounded, well past the track's actual duration) until something explicitly pauses it. This used to rely entirely on the frontend's `deck-eos` Tauri-event handler calling `audio_pause()` in response — live-tested and found that round-trip doesn't reliably land in every scenario, leaving audio playing forever with an ever-growing, silently-wrong position. Self-pausing here makes the pipeline correct regardless of frontend timing/behavior. Safe to call `set_state` from this thread: it's a dedicated bus-consumer thread via `bus.iter_timed()`, not a GStreamer streaming thread or the GLib main loop (the documented-unsafe case for synchronous state changes). |
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

## CPU profiling a live "chokes up" freeze — `pidstat` + `perf`

For a freeze that JS-side timing (`frontend_log`/rAF heartbeat, see the pcm-buffer
design doc) has already localized to "the WebKit main thread stopped responding,"
the next question is *why* — busy doing something, or genuinely blocked. That
distinction is invisible from `top`/a single CPU% snapshot and from reading code; it's
immediate from a continuous per-thread trace spanning the repro. Two conflated
freezes in the PCM-scratch feature (2026-07-23) turned out to be different mechanisms
entirely — one CPU-bound (a runaway canvas redraw loop), one blocked-on-I/O (an SMB
network stall) — and `pidstat` is what told them apart. See
`docs/design/pcm-buffer-playback.md`'s "second"/"third freeze mechanism" sections for
the full writeups.

**Step 1 — `pidstat -t -p <cuemark PID>,<WebKitWebProcess PID> 1 -h`**, backgrounded
for the whole test session (`nohup ... > pidstat.log 2>&1 &`). Find PIDs via
`pgrep -af "target/debug/cuemark|WebKitWebProcess"`. Sustained ~100%+ CPU on one
thread during the freeze window = compute-bound (profile it, step 2). Sustained
near-0% CPU on both = blocked on a syscall (a GStreamer seek, a network mount, a lock)
— check what Rust is waiting on instead of profiling JS.

**Step 2 — if CPU-bound, `perf record -g -F 999 -p <WebKitWebProcess PID> -o out.data
-- sleep <N>`.**

- Needs `kernel.perf_event_paranoid` ≤ 1 for non-root profiling. Check with
  `cat /proc/sys/kernel/perf_event_paranoid`; if it's higher, ask the user to run
  `sudo sysctl -w kernel.perf_event_paranoid=1` (temporary, resets on reboot, no
  config file touched — don't ask for anything more permanent than the session needs).
- **A live-hardware repro needs a generous, explicit capture window** — the user is
  looking at the controller, not the terminal. A 25s or 60s window reliably closes
  before they get there (confirmed twice). Use 120s, say clearly that recording has
  started and give a wide "any time in the next two minutes" instruction, then once
  `pidstat` confirms the freeze already happened, stop early with `kill -INT <perf
  pid>` (flushes the file cleanly) rather than waiting out the rest.

**Step 3 — symbolizing the capture: `DEBUGINFOD_URLS="" perf report -i out.data
--stdio -g none -n`.**

- **The `DEBUGINFOD_URLS=""` prefix is not optional on this machine.**
  `DEBUGINFOD_URLS=https://debuginfod.ubuntu.com` is set in the environment; any
  `perf` command that resolves symbols (`perf report`, or `perf script` with a
  `sym`/`dso` field) will try to fetch missing debug info from that URL and can hang
  for many minutes with zero CPU usage and zero output — indistinguishable from perf
  itself being stuck. Always disable it for these commands.
- `-g none` (skip call-graph aggregation) resolves in seconds; `-g flat`/`-g graph`
  (the default) can hang or take minutes on `libwebkit2gtk`'s huge symbol table even
  with debuginfod disabled — start with `-g none` and only reach for a full call graph
  if the flat profile doesn't already answer the question.
- `perf script -F time,comm,tid` (no symbol fields at all) is unaffected by either
  slowdown and resolves instantly — useful as a fast sanity check that the capture
  actually spans the repro window before running the slower symbolized report.
- Expect JS application code to show up as `[JIT] tid <pid>` with no further symbol —
  perf can't resolve JIT-compiled JS without a `jitdump` integration this setup
  doesn't have. High `[JIT]` percentage plus hot *named* leaf symbols in `libm`/`libc`
  (e.g. `__round`, `__memmove`) is itself a useful signal: it means the app's own JS is
  the hot path, not GStreamer/WebGL/video-decode C++ — go look at per-frame `$effect`s
  and RAF loops in the frontend rather than the Rust pipeline.

---

## Catching an intermittent GStreamer-side stall live with `gdb` (not `perf`)

`pidstat`/`perf` (above) answer "CPU-bound or blocked?" and, if CPU-bound, "which JS
line?". For a **blocked** stall inside Rust/GStreamer/GLib — the audio pipeline just
went quiet, `pidstat` shows near-0% CPU — the right tool is `gdb` attached live, to get
an actual C-level thread backtrace at the moment of the block, rather than guessing
from syscall timing. Found and used successfully in `docs/design/pcm-buffer-playback.md`'s
"Seventh mechanism" section (root-caused the "reverse scratch is silent" bug this way).

**`ptrace`/`gdb`/`strace` are not actually blocked in this environment** — a prior
session's note to that effect was a self-inflicted testing mistake, not a real
restriction. This system's default `yama.ptrace_scope=1` only allows a tracer to
attach to its own **descendants**. Attaching `strace`/`gdb` to an independently
backgrounded process makes them **siblings** (both children of the same shell), which
`ptrace_scope=1` correctly rejects with `Operation not permitted` — easy to misread as
"ptrace is disabled here." The fix: launch the target **under** the tracer from the
start (`gdb --args <bin> ...` / `strace -f <bin> ...`), which makes the tracer the true
parent — works with no `sudo`/`sysctl` changes. Attaching to an *already-running*
arbitrary process (e.g. the live app via `gdb -p <pid>`) still needs `sudo sysctl
kernel.yama.ptrace_scope=0` first.

**The `DEBUGINFOD_URLS` gotcha applies to `gdb` too, not just `perf`.** On `run`, `gdb`
prompts interactively "Enable debuginfod for this session? (y or [n])" the first time
it needs symbols — this silently hangs any scripted/non-interactive `gdb` session
(indistinguishable from the program itself hanging). Fix: launch with `-iex "set
debuginfod enabled off"`.

**Unfiltered `strace -f` measurably perturbs GStreamer/PipeWire scheduling races away
(or into worse ones)** — confirmed again this session: one run under `strace -f` with a
*filtered* syscall set hit a 60+ second stall on the very first `Paused→Playing`
transition, far outside anything ever seen untraced. `gdb` launched normally (it only
traps on breakpoints/signals, not every syscall) does **not** perturb timing-sensitive
GStreamer races the way `strace` does — every `gdb`-launched repro run reproduced the
target stall at the same rate/magnitude as untraced runs.

**Pattern for catching an intermittent stall live** (see `scripts/gdb-stall-catcher.py`
for a working implementation using Python's `pexpect`):
1. Launch the target under `gdb --args` with debuginfod disabled, `run` it.
2. Watch the **interleaved stdout** (gdb doesn't separate its own output from the
   inferior's — the same pty carries both) for whatever signal indicates the stall is
   *currently* happening — here, two consecutive identical counter values printed by
   the test itself.
3. The instant that fires, send `Ctrl-C` (`sendintr()` in `pexpect`) to stop the
   inferior while the stall is still in progress, run `thread apply all bt` to see
   every thread's C stack, then `continue`.
4. To resolve a specific thread's `??` frames (common for stripped system `.so`s with
   no debug info but still-present dynamic symbols) regardless of ASLR: switch to it
   by name (`gdb`'s Python API: `for t in gdb.selected_inferior().threads(): if
   t.name == "...": t.switch()`), then `frame N; info symbol $pc` per frame — resolves
   to `<function> + <offset> in section .text of <library>` using the live process's
   actual load addresses, no manual base-address arithmetic needed.

This combination found the actual blocking call in one session: a thread stuck several
frames inside `gst_pad_push()`, blocked on a condition variable inside
`libgstcoreelements.so` — i.e. ordinary `GstQueue` backpressure, not a mysterious
PipeWire scheduling bug. A vague "idle, waiting for work"-looking backtrace on an
**earlier** catch of the *same* stall turned out to be a red herring from too small a
sample (n=1) — re-run a few times (intermittent races need several catches) before
trusting what the first one shows.

## Verifying a fix for an intermittent GStreamer stall: always A/B the same binary

Once a stall is root-caused (as above) and a fix is written, **measure it with a
same-binary, same-environment before/after comparison — never just "run it a few
times and eyeball it."** Pattern used successfully fixing the "reverse scratch is
silent" bug (`docs/design/pcm-buffer-playback.md`, "Eighth mechanism"):
1. Build the fixed test binary, run the repro test (e.g.
   `scratch_second_gesture_reverse_repro`) untraced 10–25 times, tally stalls.
2. Temporarily disable *only* the fix (e.g. set a widened constant back to its
   original value) — not `git stash`, which on a branch with other uncommitted
   work-in-progress can revert far more than intended (stashed an entire
   feature's implementation once this session before the mistake was caught).
   Rebuild, run the *same* test the *same* number of times as the "baseline."
3. Compare hit rates and stall magnitudes side by side. A fix that isn't clearly
   better on this comparison (not just "didn't stall on the 3 runs I tried") isn't
   verified — intermittent races need double-digit sample sizes in both arms to
   trust a delta.

This caught a real mistake in the same session: an initial fix (widen
`output_queue`'s cap at scratch-gesture start, narrow it back after a fixed
grace-period timer) looked plausible and compiled clean, but the A/B comparison
showed it made things *worse* — 8/8 runs stalled with the "fix" vs. ~75% (6/8)
on the disabled-fix baseline. Without the baseline run, "it still stalls
sometimes" could easily have been misread as "the underlying race is just still
there, fix is a partial improvement" — the side-by-side made it obvious the fix
had gone from making things *better* to *reliably worse*, which prompted
looking for what the fix itself was causing (see next section) rather than
concluding the earlier root-cause diagnosis was wrong.

## GStreamer gotcha: narrowing a live `queue`'s `max-size-*` cap while it's over
## the new limit re-applies backpressure immediately, not once it "catches up"

Setting `max-size-time` (or `-buffers`/`-bytes`) on a `GstQueue` element while
the pipeline is running takes effect immediately — the queue re-evaluates its
current fill against the *new* limit on the next internal check, not just for
future buffers. If the queue is currently holding more than the new (lower)
limit, it blocks the pushing thread right then, exactly as if it had just now
filled up to that point live. There is no grace period or graceful drain-down
to the new cap.

This matters for any "widen a queue's cap temporarily, then narrow it back"
mitigation: **narrow it only in response to a real signal that the backlog is
actually gone** (e.g. the event that ends the condition the wider cap was
compensating for), never on a fixed timer independent of the pipeline's actual
state. A timer that fires before the backlog has drained will self-inflict a
new, *more* deterministic stall right at the timer's deadline — which is
exactly what happened in the first attempt at the `output_queue` fix above (see
docs/design/pcm-buffer-playback.md, "Eighth mechanism," and the A/B-testing
section just above for how this was caught).

---

## Svelte reactive-storm freezes: when a "no-op guard" doesn't actually no-op

Found 2026-07-23 (PCM-scratch feature): a redraw loop in `WaveformCanvas.svelte` had
a correct pixel-movement gate on its `requestAnimationFrame` loop, yet the WebKit main
thread still pegged at ~100% CPU for the whole scratch gesture. The gate wasn't
broken — something else was tearing down and recreating the *entire effect* (which
cancels and restarts the gated rAF loop) tens of times per second, and every
recreation paid for one full ungated redraw before the gate was ever reached.

**Root cause**: a `writable<Set<...>>` store (`scratchingDecks` in `seekBus.ts`) had a
guard *inside* its `.update()` callback meant to skip notifying subscribers when
membership didn't change:
```js
scratchingDecks.update((s) => {
  if (active === s.has(deckId)) return s; // looks like a no-op guard — isn't one
  ...
});
```
This does not work. Svelte's `writable` store equality check (`safe_not_equal` from
`svelte/store`) treats **any object or function value as always "changed,"**
regardless of reference equality — `(a && typeof a === 'object')` short-circuits the
whole comparison to `true` whenever the *old* value is a truthy object. A `Set`, `Map`,
array, or plain object always satisfies this, so returning the *same* reference from
inside `update()` still notifies every subscriber. The guard only skips constructing a
*new* Set; it never skips the notification it was written to prevent.

**Fix — move the check outside the `update()`/`set()` call entirely**, using `get()`:
```js
export function setScratching(deckId: string, active: boolean): void {
  if (active === get(scratchingDecks).has(deckId)) return; // never touches the store
  scratchingDecks.update((s) => { const next = new Set(s); ...; return next; });
}
```

**Rule**: any `writable<Set<...>>` / `writable<Map<...>>` / `writable<Array<...>>` /
`writable<object>` in this codebase needs its dedup/no-op guard placed *before* the
`update()`/`set()` call, never inside the updater callback — a guard inside the
callback that "returns the same reference to skip" is a silent no-op for any
object-valued store. Grep for `writable<` and check every `.update()` callback for
this pattern if a similar high-frequency freeze shows up elsewhere.

**Diagnostic technique — isolated single-dependency probe effects.** When a manual
snapshot comparison ("did any field I can think of change?") says nothing changed but
an effect keeps re-running anyway, don't keep expanding the snapshot — the framework's
own dependency tracking is more reliable than a hand-written comparison, which can
have blind spots you haven't thought of. Add one throwaway probe effect per candidate
reactive value, each depending on exactly one thing:
```js
$effect(() => { deck; deckOnlyRuns++; });
$effect(() => { $someStore; someStoreOnlyRuns++; });
```
Flush the counters periodically via `debugLog`/`frontend_log` (see the pcm-buffer
design doc's JS-timing pattern) and compare rates. This isolates the true trigger in
one step instead of iterating on what a manual comparison might be missing — it's what
found this bug after a manual `deck`-field snapshot had already (correctly) ruled out
`deck` itself, leaving `$scratchingDecks` as the only remaining candidate.

**Diagnostic technique — `/proc/<pid>/task/<tid>/wchan` sampling when `perf`/`sudo`
isn't available.** `perf_event_paranoid` may be locked down with no way to lower it
(e.g. a sandboxed session where `sudo` itself is blocked). Sampling every thread's
`wchan` (the kernel function it's blocked in) and `comm` on a fixed interval needs no
elevated permissions and gives the same CPU-bound-vs-blocked-on-I/O distinction
`pidstat` gives at the process level, but additionally names *what* a blocked thread is
waiting on:
```bash
CUEMARK_PID=$(pgrep -f "target/debug/cuemark" | head -1)
nohup bash -c '
while true; do
  ts=$(date "+%H:%M:%S.%3N")
  for t in /proc/'"$CUEMARK_PID"'/task/*/; do
    echo "$ts $(basename "$t") $(cat "$t/comm" 2>/dev/null) $(cat "$t/wchan" 2>/dev/null)"
  done
  sleep 0.5
done' > /tmp/cuemark-wchan.log 2>&1 &
disown
```
Unfiltered on purpose (idle threads produce a lot of routine `futex_do_wait`/
`poll_schedule_timeout` noise) — grep the log for the exact stall window after the
fact rather than trying to pre-filter what's "interesting" live.

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

## WebCodecs H.264 hardware decode requires `description` (avc), not annexb (2026-07-25)

**Symptom**: `VideoDecoder.configure({codec: 'avc1.PPCCLL'})` (no `description`) + `decode()` on
real Annex-B chunks (start-code-delimited NALs, in-band SPS/PPS) — the WebCodecs-documented
"annexb" mode — decodes **zero frames** and `flush()` rejects with `EncodingError: Decode error`.
Confirmed both for real demuxed file data (`video_demux.rs`) and for
`scripts/probes/webcodecs_decode_only_probe.py`'s own **host-encoded synthetic** AUs — re-running
that exact spike script today reproduces the failure it originally reported as a 60/60-frame pass.

**Root cause**: with `GST_DEBUG=h264*:6,webkitvideodecoder:6`, WebKitGTK 2.52.3's internal
`webkitvideodecoder` harness selects `vah264dec` (hardware, VA-API) for `avc1.*` codecs — H.264
hardware decode is enabled in this app's env (see "VA-API hardware decode status" above, only AV1
is demoted) — and **unconditionally signals `stream-format=avc` downstream**, regardless of
whether `configure()` was called with or without `description`. Its internal `h264parse0` then logs
`H.264 AVC caps, but no codec_data` → `refused caps`, and no frames ever reach the decoder. Forcing
software decode instead (`GST_PLUGIN_FEATURE_RANK=vah264dec:0,vaapih264dec:0`) makes the exact same
annexb-without-description call succeed (60/60 frames, pixel-exact) — `avdec_h264` (software) tolerates
annexb-without-description; `vah264dec` (hardware) does not. The spike's originally-recorded pass
was unknowingly exercising the software path only; it does not hold for this app's actual env, which
leaves H.264 hardware decode on.

**Fix**: always build an **avc**-format `description` (AVCDecoderConfigurationRecord: version,
profile_idc/compat/level_idc from the SPS, `lengthSizeMinusOne`, then length-prefixed SPS/PPS) from
the stream's first keyframe, and re-mux each chunk from Annex-B (start-code-delimited, includes
AUD/SPS/PPS/SEI) to avc format (4-byte-length-prefixed slice NALs only, parameter sets stripped —
they live in `description` instead) before calling `decode()`. `App.svelte`'s `probeWebCodecs` debug
hook tries annexb first, falls back to avc+description on failure, and reports which `mode` actually
decoded — use that fallback (or just go straight to avc+description, skipping the doomed-on-hardware
annexb attempt) in `codecPlayer.ts` (phase 2), not annexb-only as the design doc's spike table implied.
**Don't trust a probe result recorded before this app's real env was re-verified against it live** —
same lesson as "GStreamer/audio still runs for real inside Xvfb" in `verify-ui`'s gotcha list, one
level up: even a *result*, not just a mechanism, needs re-confirming once the surrounding env
(feature ranks, driver versions) can plausibly have shifted since it was recorded.

## WebCodecs frame upload: `texImage2D(gl, VideoFrame)` works direct, no Y-flip (2026-07-25)

Phase 2 of `docs/design/webcodecs-video-path.md` re-verified two open questions from the
phase 1 spike, on this app's real GPU (not the spike's Xvfb/llvmpipe software GL):

- **`gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoFrame)` works
  directly** — no SIGTRAP, no scratch-canvas detour needed (unlike `<video>`→`texImage2D`,
  which does crash and is why `fbo.ts`'s `uploadVideoFrame` has the scratch-canvas
  workaround at all). `DeckFBO.uploadVideoFrameFromCodec()` still keeps a scratch-canvas
  `drawImage(VideoFrame)` fallback behind a one-time try/catch (cached in a module-level
  static, not per-instance — this is a GPU/driver capability, not a per-deck one), but on
  this GPU the direct path is what actually fires, confirmed by the compositor output
  screenshot rendering correctly with no fallback exception logged.
- **Do NOT apply `UNPACK_FLIP_Y_WEBGL`** for `VideoFrame` uploads — `uploadVideoFrame`'s
  flip (needed because canvas Y=0 is top but WebGL texture Y=0 is bottom) does **not**
  apply here. A `VideoFrame`'s pixel data from `VideoDecoder` output is already in the
  orientation WebGL expects. Confirmed by screenshot: applying the flip renders upside
  down; omitting it (what `uploadVideoFrameFromCodec` does) renders correctly.

Both findings verified via `canvas.toDataURL()` screenshot comparison against the legacy
`<video>` path rendering the same source file, not just by absence-of-error — a black or
garbled frame is a failure even if no exception was thrown (see `verify-ui`'s new gotcha
on why `toDataURL()` was used instead of WebDriver's `/screenshot` endpoint).

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
