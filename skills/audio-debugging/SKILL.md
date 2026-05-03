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
- `set_rate()` — the current seek strategy and the two guards (no-change, throttle)
- `play()` — EOS and error flag handling

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

**Fix already in place:** `set_rate()` now always uses `FLUSH | KEY_UNIT` seeks at the current position. Brief audio dropout per seek (~one keyframe) but fully reliable. The 100 ms throttle limits this to ≤10 seeks/second so the dropout is inaudible during normal fader use.

**Do not reintroduce `INSTANT_RATE_CHANGE`** without first verifying the gst-plugins-good version and testing with the specific MP4 files in use. The async failure mode makes it very hard to catch in testing.

---

### Recovery seek inside the bus error handler → error cascade

**Symptom:** One error becomes six, then the app deadlocks.

**Root cause:** When the bus thread receives an `ERROR` message and immediately calls `seek_simple(FLUSH | KEY_UNIT, pos)` on the same errored pipeline, `qtdemux` is in a broken state and each seek triggers a new error message, which triggers another seek, etc. The bus thread spins in an error loop; the main thread blocks waiting for the `Mutex<AudioManager>`; everything stalls.

**Rule:** Never seek inside the bus error handler. The handler should only set a flag (`at_error`). Recovery happens at the call site (`set_rate` / `play`) on the next user-initiated action.

---

### `applied_rate` desync after an error

**Symptom:** After an error and recovery, moving the tempo fader has no effect — rate doesn't change even though the pipeline is running again.

**Root cause:** `applied_rate` was updated optimistically when the seek was sent. After the error, `applied_rate` still shows the last requested value, so the no-change guard in `set_rate()` skips every subsequent call.

**Fix:** `at_error: Arc<AtomicBool>` in `PipelineInner`. The bus thread sets it on error. `set_rate()` checks it at the top and resets `applied_rate = 0.0` + clears `last_rate_seek` so the next rate event forces a fresh seek regardless of the guard.

---

### Layered / detuned sound during rate changes

**Symptom:** Multiple echoes of the same audio at slightly different pitches. Sounds like a badly tuned chorus effect.

**Likely causes (in rough order of probability):**

1. **Old audio buffers in the hardware ring buffer** — The audio sink (autoaudiosink / pipewiresink) has a hardware-side buffer that FLUSH events don't fully drain before new data arrives. Most noticeable on systems with high-latency PulseAudio/PipeWire buffer config.
2. **Multiple seeks fired before the first AsyncDone** — If the 100 ms throttle is bypassed (e.g. the `at_error` reset clears `last_rate_seek`), multiple seeks can be in flight simultaneously. Each creates a new segment; the sink tries to play all of them.
3. **Multiple pipeline instances** — If `load()` is called and the old pipeline isn't fully torn down before the new one starts playing. Check that `bus.set_flushing(true)` and `set_state(Null)` both complete on the old inner before `self.inner = None`.

**Diagnostics to enable:** Uncomment / add `StateChanged` (pipeline level), `AsyncDone` (with position), and `QOS` (jitter/proportion) to the bus monitor. See "Bus message guide" below.

---

## Bus message guide

| Message | What it tells you |
|---|---|
| `EOS` | Track ended. `at_eos` flag triggers seek-to-zero on next `play()`. |
| `ERROR` | Fatal pipeline error. Log the debug string — it names the element and GStreamer flow return. Set `at_error`; do not seek here. |
| `WARNING` | Non-fatal. Usually codec quirks; rarely actionable. |
| `INFO` | Informational codec/muxer notes. Low signal. |
| `StateChanged` (pipeline-level only) | Shows pipeline moving through NULL→READY→PAUSED→PLAYING. Unexpected drops back to PAUSED mid-playback often precede "layered sound." Filter: `msg.src().name().starts_with("pipeline")`. |
| `AsyncDone` | Seek or state-change async op completed. Log position here. If two `AsyncDone` messages arrive within milliseconds of each other, seeks are piling up. |
| `QOS` | `proportion > 1.0` = buffers arriving late (duplication risk). Negative `jitter` = early (overlap risk). `quality` < 1000000 = GStreamer is dropping samples. |
| `Latency` | A downstream element requested latency recalculation. Can spike after seeks. |
| `StreamStatus` | Stream thread lifecycle (enter/leave/create/destroy). Useful if threads are leaking. |
| `Buffering` | Network/slow-disk stall. Shouldn't appear for local files; if it does, something is treating the file as a streaming source. |

### Enabling verbose bus logging

In `pipeline.rs`, the bus thread `match` block currently has `StateChanged`, `AsyncDone`, and `QOS` arms. They were stripped in commit `9285a8c` for being noisy. To re-enable for a session:

```rust
gst::MessageView::StateChanged(s) => {
    let src = msg.src().map(|e| e.name().to_string()).unwrap_or_default();
    if src.starts_with("pipeline") {
        eprintln!("[bus/{}] pipeline: {:?} → {:?} (pending {:?})",
            deck_id_log, s.old(), s.current(), s.pending());
    }
}
gst::MessageView::AsyncDone(_) => {
    let pos = msg.src()
        .and_then(|e| e.downcast_ref::<gst::Pipeline>())
        .and_then(|p| p.query_position::<gst::ClockTime>())
        .map(|t| t.mseconds())
        .unwrap_or(0);
    eprintln!("[bus/{}] async-done  pos={}ms", deck_id_log, pos);
}
gst::MessageView::Qos(q) => {
    let (jitter, proportion, quality) = q.values();
    eprintln!("[bus/{}] QOS  jitter={jitter}ns  proportion={proportion:.3}  quality={quality}",
        deck_id_log);
}
```

---

## Rate-change seek mechanics

Current approach in `set_rate()`:

1. Clamp rate to `[0.0625, 4.0]`
2. If `at_error` is set: reset `applied_rate = 0.0`, clear `last_rate_seek`
3. No-change guard: skip if `|applied_rate - rate| < 1e-9`
4. Throttle: skip if last seek was < 100 ms ago (rAF loop calls this ~60/s)
5. Issue `seek(rate, FLUSH | KEY_UNIT, Set, current_pos, None, None)`

The key invariant: `applied_rate` tracks what the pipeline actually has, not what was last requested. `load()` always resets it to `1.0`.

---

## MIDI log throttle

High-frequency MIDI controls (faders, jog wheel, crossfader) are throttled to one log line per 500 ms per `(status, d1)` key. Discrete controls (buttons, pads) always log. Implemented via `log_throttle: HashMap<(u8, u8), Instant>` in the MIDI callback closure (`midi.rs`).

To see every event from a continuous control (e.g. to diagnose a stuck value), temporarily remove the key from `log_throttle` or change the threshold to 0.

---

## Files

| File | Concern |
|---|---|
| `src-tauri/src/audio/pipeline.rs` | Per-deck GStreamer pipeline, bus monitor, rate/seek logic |
| `src-tauri/src/audio/mod.rs` | AudioManager, Tauri command handlers |
| `src-tauri/src/midi.rs` | MIDI event loop, log throttle, 14-bit rate decoding |
| `journal.md` | Session notes — decisions and symptoms from past debugging |
