---
name: audio-debugging
description: Debug GStreamer audio issues in cuemark — bus errors, rate changes, layered sound, pipeline recovery. Load this when the audio pipeline misbehaves.
---

# Cuemark Audio Debugging

Orient to the current state of the GStreamer pipeline and the known failure modes we've already worked through.

## Step 1 — read the current pipeline code

```
src-tauri/src/audio/pipeline.rs   ← the whole file
```

Focus on:
- The bus monitor thread (what's currently logged, what flags are set on each message)
- `set_rate()` — the current seek strategy and all guards (no-change, seek_in_flight, 200ms dwell, at_error)
- `play()` — EOS and error flag handling
- `file_to_uri()` — per-byte percent encoding

## Step 2 — check recent journal/git for context

```bash
git log --oneline -10
```

Then read `journal.md` for the most recent session notes.

---

## Known failure modes (earned the hard way)

### INSTANT_RATE_CHANGE → qtdemux cascade crash

**Symptom:** `[bus/deck-N] ERROR: Internal data stream error … qtdemux … streaming stopped, reason error (-5)` appearing multiple times in rapid succession after a tempo-fader move. App eventually deadlocks and shows "not responding."

**Root cause:** `GST_SEEK_FLAG_INSTANT_RATE_CHANGE` (GStreamer ≥ 1.18) is supposed to adjust playback speed without flushing. The Rust seek call returns `Ok(())` — no synchronous error — but `qtdemux` subsequently fails internally and posts `GST_FLOW_ERROR (-5)` on the bus asynchronously. Because the call looks like it succeeded, `applied_rate` is updated optimistically and the flush-seek fallback never fires.

**Fix already in place:** `set_rate()` now always uses `FLUSH | ACCURATE` seeks at the current position.

**Do not reintroduce `INSTANT_RATE_CHANGE`** without first verifying the gst-plugins-good version and testing with the specific MP4 files in use. The async failure mode makes it very hard to catch in testing.

---

### KEY_UNIT seeks snap to video keyframe → pipeline replays same audio (doubling)

**Symptom:** Audible doubling or looping effect when moving the tempo fader — sounds like two copies of audio slightly out of sync, or the track looping from a fixed point. The `async-done pos=` log value repeats the same timestamp across many consecutive seeks (e.g. `30000ms` every time even though the track should be advancing).

**Root cause:** `KEY_UNIT` seeks snap to the nearest *video* keyframe. Music videos typically have keyframe intervals of 2–5 seconds. Every rate-change seek target within a 2s window (e.g. 30116ms, 30211ms, 30315ms) snaps back to the same keyframe boundary (30000ms). The pipeline replays from 30000ms each time, while the hardware ring buffer drains audio from further along → two simultaneous audio streams at different positions.

**Fix already in place:** `set_rate()` uses `FLUSH | ACCURATE` (not `KEY_UNIT`). ACCURATE decodes forward from the keyframe to the exact requested time, so successive seeks land at distinct positions. The `async-done pos=` values should now advance steadily (30116ms → 30234ms → 30352ms…).

**Diagnostic confirmation:** If `async-done pos=` shows the same value repeating across multiple seeks despite position estimation being correct, suspect KEY_UNIT keyframe snapping has been re-introduced.

---

### Recovery seek inside the bus error handler → error cascade

**Symptom:** One error becomes six, then the app deadlocks.

**Root cause:** When the bus thread receives an `ERROR` message and immediately calls `seek_simple(FLUSH | KEY_UNIT, pos)` on the same errored pipeline, `qtdemux` is in a broken state and each seek triggers a new error message, which triggers another seek, etc.

**Rule:** Never seek inside the bus error handler. The handler should only set a flag (`at_error`). Recovery happens at the call site (`set_rate` / `play`) on the next user-initiated action.

---

### `applied_rate` desync after an error

**Symptom:** After an error and recovery, moving the tempo fader has no effect — rate doesn't change even though the pipeline is running again.

**Root cause:** `applied_rate` was updated optimistically when the seek was sent. After the error, `applied_rate` still shows the last requested value, so the no-change guard in `set_rate()` skips every subsequent call.

**Fix:** `at_error: Arc<AtomicBool>` in `PipelineInner`. The bus thread sets it on error. `set_rate()` checks it at the top and resets `applied_rate = 0.0` + clears `last_rate_seek` and `seek_in_flight` so the next rate event forces a fresh seek regardless of the guards.

---

### Layered / detuned sound during rate changes

**Symptom:** Multiple echoes of the same audio at slightly different pitches / slightly different times. Sounds like a badly tuned chorus effect or a doubled track.

**Root cause: Hardware buffer overlap during rapid rate-change FLUSH seeks.**

Audio sinks (pipewiresink, pulsesink, etc. extending GstAudioBaseSink) buffer ~200ms of audio in the hardware ring by default. When rate-change seeks fire every 200ms (dwell gate), the following sequence occurs:
1. FLUSH seek at t=0ms targets a new position + rate
2. Pipeline sends FLUSH_START event; HW buffer supposedly clears
3. New audio segment arrives at t=90ms (seek complete, AsyncDone fires)
4. BUT old audio from before the FLUSH is still draining from the HW speaker buffer (lives ~200ms)
5. At t=100–200ms, both old audio (at old rate/position) and new audio (at new rate/position) are in the HW buffer simultaneously
6. Speaker output is the mix: two slightly-detuned versions playing together

**Fix (APPLIED):** In `make_sink()`, set `buffer-time=50000` (50ms) on all audio sinks (via `child-added` hook for autoaudiosink, direct set for pipewiresink). 50ms buffer drains completely within one dwell window, so old and new audio segments do not overlap.

**Likely causes of residual issues (if doubling persists):**

1. **KEY_UNIT keyframe snapping** — Each seek resets to the same keyframe while the hardware buffer drains different audio. Already fixed (using ACCURATE flag), but if you see async-done position repeat the same value across multiple seeks, suspect KEY_UNIT was re-introduced.
2. **Multiple seeks fired before the first AsyncDone** — If `seek_in_flight` gate is bypassed or resets unexpectedly, multiple seeks can be in flight simultaneously, each creating a new segment. Check that AsyncDone always clears `seek_in_flight` before the next set_rate arrives.
3. **Multiple pipeline instances** — If `load()` is called and the old pipeline isn't fully torn down before the new one starts playing. Check that `bus.set_flushing(true)` and `set_state(Null)` both complete on the old inner before `self.inner = None`.

**Diagnostics to verify the fix:** Look for these log lines on startup and during fader use:
- `[audio/deck-1] sink: pipewiresink buffer-time=50000us latency-time=10000us` — confirms buffer was applied
- `[audio/deck-1] set_rate → 1.0881  target=26500ms  elapsed-since-async-done=215ms  prev_rate=1.0000` — confirms position math is correct and elapsed-since-async-done ≥200ms (dwell gate working)

---

### Pipeline replaying from fixed position (frozen `async-done pos=`)

**Symptom:** `async-done pos=` reports the same timestamp across many consecutive seeks (e.g. always `7875ms` or always `30000ms`). Rate changes audibly but audio loops from that position.

**Root cause (variant A — stale query_position):** `query_position()` returns the seek *target* for a brief window after `AsyncDone` because the pipeline clock hasn't advanced yet. MIDI events arrive faster than that window closes, so successive seeks all target the same timestamp.

**Root cause (variant B — KEY_UNIT keyframe snap):** The estimated position advances correctly, but KEY_UNIT snaps it back to the same keyframe boundary. Distinguished from variant A because the pos stays exactly at a round number that's a keyframe boundary (2s/4s/etc. interval).

**Fix already in place (variant A):** `PipelineInner.last_async_done: Arc<Mutex<Option<(u64, Instant)>>>`. The bus thread records position + wall-clock instant on each AsyncDone. `set_rate()` computes `estimated_pos = async_done_pos + elapsed_since_async_done × prev_rate` instead of calling `query_position()`. The key correctness detail: `prev_rate` must be captured *before* `self.applied_rate` is updated to the new rate.

**Fix already in place (variant B):** ACCURATE flag on rate-change seeks (see above).

---

### Seeks too frequent → choppy / stuttery audio

**Symptom:** Audio sounds stuttery or choppy during fader moves — not exactly doubled, but rough-edged. The `set_rate →` log lines appear in rapid succession.

**Root cause:** Each FLUSH seek temporarily pauses the pipeline and flushes GStreamer's internal buffers. With seeks every ~90ms (AsyncDone gate alone), the pipeline barely reaches Playing state before the next seek interrupts it. The hardware ring buffer constantly flushes and refills, producing audible artifacts.

**Fix already in place:** Two-layer gate in `set_rate()`:
1. **AsyncDone gate** (`seek_in_flight: Arc<AtomicBool>`): don't issue a new seek until the previous one completes (cleared by bus thread on AsyncDone). Safety fallback: forces a seek after 500ms if AsyncDone never fires (stuck pipeline).
2. **Dwell gate** (200ms minimum from `last_rate_seek`): ensures the pipeline spends at least ~110ms in Playing state between seeks (seek takes ~90ms, so 200ms total spacing = ~110ms play time per cycle).

If still choppy, raise the dwell gate from 200ms to 300ms. If rate changes feel too sluggish/delayed, lower it to 150ms.

---

### Elements disposed in READY/PAUSED state → GStreamer CRITICAL warnings

**Symptom:** Terminal output like `Trying to dispose element autoaudiosink0, but it is in READY instead of the NULL state.` after a file fails to load.

**Root cause:** When `load()` returns early (e.g. preroll failure because the file doesn't exist), the local `pipeline` variable goes out of scope and is dropped while elements are still in READY or PAUSED state. The bus monitor thread is also still running.

**Fix already in place:** Before the early `Err` return in the preroll failure path:
```rust
bus.set_flushing(true);           // stops the bus monitor thread
let _ = pipeline.set_state(gst::State::Null); // transitions all elements to NULL
```

---

### Non-ASCII filenames fail to load (UTF-8 mangled in file URI)

**Symptom:** `ERROR: Resource not found` for files with accented characters (é, ç, ñ, etc.). The debug string shows the filename with mangled characters like `GarÃ§on FranÃ§ais` instead of `Garçon Français`.

**Root cause:** `file_to_uri()` was using `byte as char` for non-ASCII bytes. In Rust, casting a `u8 > 127` to `char` gives a Latin-1 supplement character (e.g. `0xC3` → 'Ã', `0xA7` → '§'). Multi-byte UTF-8 sequences get exploded into wrong Unicode code points. GStreamer passes these through to the OS, which can't find the file.

**Fix already in place:** `file_to_uri()` now percent-encodes every byte that isn't an ASCII unreserved/path character:
```rust
match byte {
    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
    | b'-' | b'.' | b'_' | b'~' | b'/' | b':' | b'@'
    | b'!' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b'+' | b',' | b';' | b'=' => {
        out.push(byte as char);
    }
    b => { /* %XX encode */ }
}
```
So `ç` (UTF-8: `0xC3 0xA7`) becomes `%C3%A7` in the URI.

---

## Bus message guide

| Message | What it tells you |
|---|---|
| `EOS` | Track ended. `at_eos` flag triggers seek-to-zero on next `play()`. |
| `ERROR` | Fatal pipeline error. Log the debug string — it names the element and GStreamer flow return. Set `at_error`; do not seek here. |
| `WARNING` | Non-fatal. Usually codec quirks; rarely actionable. |
| `INFO` | Informational codec/muxer notes. Low signal. |
| `StateChanged` (pipeline-level only) | Shows pipeline moving through NULL→READY→PAUSED→PLAYING. Unexpected drops back to PAUSED mid-playback often precede "layered sound." Filter: `msg.src().name().starts_with("pipeline")`. |
| `AsyncDone` | Seek or state-change async op completed. Log position here. If `async-done pos=` repeats the same value across multiple seeks, either KEY_UNIT is snapping (use ACCURATE) or the position estimation has a bug. |
| `QOS` | `proportion > 1.0` = buffers arriving late (duplication risk). Negative `jitter` = early (overlap risk). `quality` < 1000000 = GStreamer is dropping samples. |
| `Latency` | A downstream element requested latency recalculation. Normal after each FLUSH seek. |
| `StreamStatus` | Stream thread lifecycle (enter/leave/create/destroy). Useful if threads are leaking. |
| `Buffering` | Network/slow-disk stall. Shouldn't appear for local files; if it does, something is treating the file as a streaming source. |

### Enabling verbose bus logging

In `pipeline.rs`, the bus thread `match` block currently has `StateChanged`, `AsyncDone`, `QOS`, `Latency`, and `StreamStatus` arms enabled. To strip noisy ones for a session (as was done in commit `9285a8c`), comment out the `StateChanged`, `QOS`, `Latency`, and `StreamStatus` arms.

---

## Rate-change seek mechanics (current)

Full gate sequence in `set_rate()`:

1. Clamp rate to `[0.0625, 4.0]`
2. If `at_error` is set: reset `applied_rate = 0.0`, clear `last_rate_seek`, clear `seek_in_flight`
3. **No-change guard**: skip if `|applied_rate - rate| < 1e-9`
4. **AsyncDone gate** (`seek_in_flight`): skip if previous seek not yet complete; safety override after 500ms
5. **Dwell gate**: skip if last seek was < 200ms ago (allows ~110ms Playing time per cycle)
6. Capture `prev_rate = applied_rate` (before updating — pipeline was at this rate since last AsyncDone)
7. Update `applied_rate = rate`, `last_rate_seek = now`, `seek_in_flight = true`
8. Estimate position: `async_done_pos + elapsed_since_async_done × prev_rate`
9. Issue `seek(rate, FLUSH | ACCURATE, Set, estimated_pos, None, None)`

Key invariants:
- `applied_rate` tracks what the pipeline actually has, not what was last requested. `load()` always resets it to `1.0`.
- `prev_rate` must be captured before `applied_rate` is updated — it's the rate the pipeline has been playing at since the last AsyncDone, not the new rate.
- `last_async_done` stores `(pos_ns, Instant)` so `set_rate()` can estimate position without calling `query_position()` (which returns stale data immediately after a seek).

---

## MIDI log throttle

High-frequency MIDI controls (faders, jog wheel, crossfader) are throttled to one log line per 500 ms per `(status, d1)` key. Discrete controls (buttons, pads) always log. Implemented via `log_throttle: HashMap<(u8, u8), Instant>` in the MIDI callback closure (`midi.rs`).

To see every event from a continuous control (e.g. to diagnose a stuck value), temporarily remove the key from `log_throttle` or change the threshold to 0.

---

## Files

| File | Concern |
|---|---|
| `src-tauri/src/audio/pipeline.rs` | Per-deck GStreamer pipeline, bus monitor, rate/seek logic, URI encoding |
| `src-tauri/src/audio/mod.rs` | AudioManager, Tauri command handlers |
| `src-tauri/src/midi.rs` | MIDI event loop, log throttle, 14-bit rate decoding |
| `journal.md` | Session notes — decisions and symptoms from past debugging |
