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
  → capsfilter(rate=48000) → pitch(tempo) → output_queue(200ms) → volume → pipewiresink
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

**`output_queue`** (after pitch) — 200ms time-based buffer between soundtouch and pipewiresink.
soundtouch produces variable-sized output chunks at non-1.0 tempos. Without buffering, PipeWire's pull
callback can fire before soundtouch has accumulated a full 1024-sample quantum → xrun. Time-based limit
(no buffer-count or byte limit) so it fills only when soundtouch is momentarily slow.

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

**pw-top diagnostics** — run `pw-top` in another terminal while audio is playing:
- `S` column: `R` = running (producing audio), `I` = idle/paused
- `QUANT / RATE`: both cuemark pipewiresink streams should show `1024 / 48000` (~21ms); if one shows a
  non-standard quantum (e.g. 3969 / 44100), the capsfilter didn't apply (deck was loaded before a Rust rebuild — re-load the track)
- `ERR`: PipeWire xrun count for this stream; brief bursts are normal; sustained growth means pipeline starvation
- Two `+ cuemark` streams expected: our two pipewiresink decks; WebKit video element pipeline appears as a separate stream

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

1. **`v.playbackRate` written too frequently** (most common) — see WebKitGTK section above.
   Symptom: ERR climbs during active tempo fader movement.

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

The waveform reads position from `getDeckTime(deckId)` in `seekBus.ts`, which returns an audio-clock
cache (`audioTimes` map) rather than `video.currentTime`. This avoids the jump artifact that occurred
when the video drifted (at non-1× tempo) and was then snapped by the RAF loop.

**Cache update path**: RAF loop → `audioGetPosition(deckId)` IPC → `setDeckAudioTime(id, pos)` →
`audioTimes.set()` → `getDeckTime()` returns it.

**One in-flight IPC per deck**: `pendingPos` map in `App.svelte` prevents stale out-of-order IPC
responses from overwriting a newer position with an older one (was observed when GStreamer was busy
mid-rate-change and an earlier call resolved late).

**Seek writes the cache immediately**: `seekDeck()` calls `audioTimes.set(id, time)` before the async
`audioSeek` IPC resolves, so the waveform shows the new position instantly on click.

---

## Known failure modes

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

---

## Files

| File | Concern |
|---|---|
| `src-tauri/src/audio/pipeline.rs` | Per-deck GStreamer pipeline, bus monitor, tempo/pitch element |
| `src-tauri/src/audio/mod.rs` | AudioManager, Tauri command handlers |
| `src-tauri/src/midi.rs` | MIDI event loop, log throttle, 14-bit rate decoding |
| `src/App.svelte` | Video element creation (muted), rAF-throttled syncVideoElements |
| `journal.md` | Session notes — decisions and symptoms from past debugging |
