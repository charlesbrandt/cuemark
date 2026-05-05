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
uridecodebin → queue(max-buffers=2) → audioconvert → audioresample → pitch → volume → pipewiresink
```

**`pitch` element** (soundtouch, `gst-plugins-bad`) — sets playback tempo without pitch change via the
`tempo` property. Set at any time; no seek, no flush, no pipeline state transition. Range: 0.1–10.0.
Requires `gstreamer1.0-plugins-bad` (`sudo apt install gstreamer1.0-plugins-bad`).

**`queue`** between uridecodebin and audioconvert — decouples the decoder thread from audioconvert.
Without it, FLUSH seeks (used for waveform-click seeks and EOS restart) can hand audioconvert a buffer
still held by the decoder (ref_count > 1), causing a `gst_buffer_is_writable` assertion crash.

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
- `S` column: `R` = running (producing audio), `I` = idle
- `QUANT / RATE`: e.g. `1024 / 48000` = 21ms quantum
- `ERR`: PipeWire xrun count for this stream
- Two `+ cuemark` streams expected: one is our pipewiresink, one is WebKit's video element pipeline

---

## WebKitGTK video element audio stream

WebKitGTK opens its own GStreamer/PipeWire audio stream for every `<video>` element, even when
`v.muted = true`. The `muted` attribute zeroes the sink volume but does NOT tear down the audio
decode pipeline. Visible in pw-top as a second `+ cuemark` entry, typically QUANT=3969 @ 44100 (~90ms).

**This stream can become audible** — WebKitGTK internally rebuilds its GStreamer pipeline when
`v.playbackRate` changes, and the rebuild can lose the `muted` property. Fix: re-apply `v.muted = true`
immediately before every `v.playbackRate = ...` assignment in `syncVideoElements`. Order matters —
apply muted first so the state is correct when the rebuilt pipeline initialises.

**`createMediaElementSource(v)` does NOT fix this** — in WebKitGTK it creates a third decoder rather
than redirecting the existing one. Tried and reverted.

**Distinguishing WebKit audio bleed from other issues:**
- WebKit bleed: continuous doubled audio independent of any seek/rate timing
- pw-top: the `3969/44100` cuemark stream shows `S=R` (running, not idle)
- Fix: confirm `v.muted = true` is before `v.playbackRate = ...` in `syncVideoElements`

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
