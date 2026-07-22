# Jog-wheel scratch audio while paused (design, not implemented)

## Goal

Turning the jog wheel on a paused deck currently moves the position (see
`src/lib/midi/handler.ts` `jog_nudge` paused branch, and the two jog-wheel bugs fixed
in this same session — rate-runaway-while-playing and UI-freeze-while-playing, both in
`handler.ts`) but produces no sound. The user wants **true bidirectional scratch audio**:
turning the wheel forward/backward should play audio forward/backward at a speed
matching the wheel, like a real turntable — specifically to make it easier to identify
a beat/transient by ear while dialing in a grid anchor.

Decided against the simpler alternative (forward-only preview blip, auto-pausing after
an idle timeout, always playing forward regardless of wheel direction) — lower risk but
doesn't sound like scratching when spinning backward. User explicitly chose full
bidirectional scratch and accepted the risk below.

## Why this is nontrivial

The existing rate-change mechanism (`pipeline.rs` `set_rate()`, used by the tempo fader
and the "while playing" jog nudge) sets the `tempo` property on the `pitch` element
(soundtouch, from `gst-plugins-bad`). That's **pitch-preserving** speed change — correct
for the tempo fader, wrong for scratch. Real vinyl scratching changes pitch *with* speed
(slow down → lower pitch), and soundtouch's `rate`/`tempo`/`pitch` properties are all
**positive-only scale factors** — libSoundTouch has no concept of time-reversal, so it
cannot produce reverse playback at all.

True reverse playback in GStreamer instead requires a **segment-rate seek**: call the
full `Element::seek()` (not the `seek_simple()` already used in `pipeline.rs::seek()`)
with a negative `rate` argument. This changes the segment GStreamer negotiates for the
whole pipeline — samples flow through in reverse temporal order.

**The risk**: the `pitch` element sits in the main signal path between the source and
the tee (`capsfilter(48kHz) → pitch → output_queue → tee`, see the pipeline topology
comment at the top of `pipeline.rs`). SoundTouch's algorithm assumes a continuous forward
audio stream; it is not designed to receive buffers in reverse order, even at
`tempo=1.0`/`rate=1.0` passthrough. Behavior when fed a reversed segment is **unverified
and may produce silence, glitches, or GStreamer errors** — this needs to be tested
empirically against real files before deciding whether `pitch` needs to be dynamically
bypassed during scratch (nontrivial: requires unlinking/relinking pads live, since the
tee and volume/cue branches are downstream of `pitch`).

**Second risk**: reverse-playback support in GStreamer is codec/demuxer-dependent.
Raw/simple formats (WAV) generally support it well. Compressed formats (MP3, AAC/MP4)
often have flaky or entirely unsupported reverse decode depending on the demuxer/decoder
plugin — this also needs empirical testing against the user's actual library (mix of
`.wav`, `.mp3`, `.mp4` observed in this session's logs).

## Proposed shape (not yet implemented)

### Rust (`src-tauri/src/audio/pipeline.rs`)

New method on `DeckAudioPipeline`, alongside the existing `seek()`/`set_rate()`:

```rust
/// Variable-rate scratch playback: seeks to the current position with a signed rate
/// (negative = reverse) and transitions to Playing. Unlike set_rate() (soundtouch
/// `tempo`, pitch-preserving), this is a segment-rate seek — pitch bends with speed,
/// matching real vinyl. Reverse-playback support depends on the file's demuxer/decoder;
/// untested against `pitch` element passthrough — may need to bypass it during scratch.
pub fn scratch(&mut self, rate: f64) -> Result<(), String> {
    let inner = self.inner.as_ref().ok_or_else(|| "no pipeline loaded".to_string())?;
    inner.at_eos.store(false, Ordering::Relaxed);
    let pos = inner.pipeline.query_position::<gst::ClockTime>()
        .unwrap_or(gst::ClockTime::ZERO);
    let flags = gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE;
    let result = if rate >= 0.0 {
        inner.pipeline.seek(rate, flags, gst::SeekType::Set, pos,
                             gst::SeekType::None, gst::ClockTime::NONE)
    } else {
        inner.pipeline.seek(rate, flags, gst::SeekType::None, gst::ClockTime::NONE,
                             gst::SeekType::Set, pos)
    };
    result.map_err(|e| e.to_string())?;
    inner.pipeline.set_state(gst::State::Playing)
        .map_err(|e| format!("scratch play failed: {e}"))?;
    Ok(())
}

/// Stops scratch playback, returning to Paused.
pub fn stop_scratch(&mut self) -> Result<(), String> {
    self.pause()
}
```

Exact `seek()` signature/types need verifying against the `gstreamer-rs` version pinned
in `Cargo.toml` (`ACCURATE` vs `KEY_UNIT` trade-off: ACCURATE seeks to the exact sample
but is slower — likely necessary here since KEY_UNIT's snap-to-keyframe would make short
scratch gestures on compressed audio imprecise; needs live testing either way) — this is
exactly the kind of thing to validate with `cargo check` and small live tests, not decide
from documentation alone.

New Tauri commands in `src-tauri/src/audio/mod.rs`, mirroring the existing
`audio_seek`/`audio_set_rate` pattern:

```rust
#[tauri::command]
pub fn audio_scratch(state: State<'_, AudioState>, deck_id: String, rate: f64) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.scratch(rate)
}

#[tauri::command]
pub fn audio_stop_scratch(state: State<'_, AudioState>, deck_id: String) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.stop_scratch()
}
```

Register both in `lib.rs`'s command handler list alongside the other `audio_*` commands.

### Frontend (`src/lib/midi/handler.ts`, `src/lib/audio/pipeline.ts`)

Add `audioScratch`/`audioStopScratch` wrappers in `pipeline.ts` (same shape as
`audioSeek`).

In the `jog_nudge` paused branch (`handler.ts` ~line 202-211), replace the current
position-seek scrub with a rate-derived scratch call:

- Convert encoder step + inter-event timing into a signed rate (magnitude from ticks per
  unit time, sign from tick direction) — needs a velocity estimate, not just the raw
  `a.value` (±1 per tick), since scratch feel depends on *how fast* the wheel is turning,
  not just direction. Likely needs a small rolling window of tick timestamps.
- Call `audioScratch(deckId, rate)` — **not** through `queueScrub`'s rAF-coalesced
  position-seek path, since this is now continuous rate-based playback, not discrete
  seeks. This should sidestep the seek-congestion risk explored earlier in this session
  (each scratch call only needs to update rate, not re-seek+preroll every tick).
- Reuse the existing 150ms idle-timeout pattern (`jogTimers`, already used for the
  "while playing" rate-nudge revert) to call `audioStopScratch(deckId)` shortly after
  ticks stop arriving.
- **Must not** touch `deck.playing` / `updateDeck()` — scratch is a pipeline-level
  Playing state independent of the session's logical play/pause intent, exactly as
  established for the (rejected) simpler design. Play/pause UI, `syncVideoElements`,
  and the RAF position-polling loop (`App.svelte` `frame()`, gated on `deck.playing`)
  should all stay unaware this is happening.
- Video element (`<video>`) position display during scratch: needs its own decision —
  either leave it static at the pre-scratch position (simplest, but disconnects visual
  from audio during scratch) or drive it from `audioGetPosition` polling similar to the
  normal playing path, temporarily, while scratch is active.

## Open questions for the next session

1. Does the `pitch` element pass reversed segments through cleanly, or does it need to
   be dynamically bypassed? Test first — this determines whether the rest of the plan
   is even viable as-is, or needs a pad-bypass mechanism added.
2. Does reverse playback work on the user's actual compressed files (MP3/MP4), or only
   WAV? If compressed formats don't support it, may need a WAV-only feature flag, a
   fallback to the (rejected) forward-only preview for those files, or a pre-decode
   caching layer (out of scope for a first pass).
3. How to derive rate-from-velocity cleanly — window size, min/max clamps, and whether
   this should share any code with the existing `jogBaseRate`/`jogTimers` "while playing"
   nudge logic in `handler.ts`, or be fully separate given the different underlying
   mechanism (rate-seek vs. tempo-property).
4. Whether `ACCURATE` seeks are fast enough for responsive scratch feel on this hardware,
   or whether `KEY_UNIT` (with its precision loss) is required for acceptable latency —
   only answerable by testing with the real jog wheel controller (`DJControl Starlight`).

## Implementation attempt and findings (2026-07-22)

Implemented as designed:
- `DeckAudioPipeline::scratch(rate)` / `stop_scratch()` in `pipeline.rs` (segment-rate
  seek + `Playing`, and a reset-to-forward-1.0 seek + `pause()` respectively — the
  reset was added beyond the original sketch: without it, a normal `play()` after
  scratching would resume at whatever rate/direction the last scratch tick left the
  segment in, since only a seek changes it).
- `audio_scratch`/`audio_stop_scratch` Tauri commands, registered in `lib.rs`.
- `audioScratch`/`audioStopScratch` wrappers in `pipeline.ts`.
- `handler.ts`'s `jog_nudge` paused branch: tick-velocity → signed rate (rolling
  120ms window, magnitude clamped to `[0.15, 3.0]`), rAF-coalesced via
  `queueScratchRate` (mirrors `queueDeckPatch`), 150ms idle timeout calls
  `stopScratch()`. `deck_play_toggle` defensively stops any in-flight scratch before
  flipping `playing` true, closing the race where a stale reverse/sped-up segment
  could leak into normal playback.

**Verified working**: forward scratch (`rate > 0`) — confirmed via direct
`audio_scratch` IPC call against a loaded WAV through the real app (tauri-driver +
Xvfb), no errors, GStreamer accepts and plays the seek.

**Reverse scratch (`rate < 0`) does not work with this pipeline, and this is a hard
blocker, not a tuning problem.** Isolated with a minimal standalone GStreamer
reproduction (same element chain, no Tauri/WebKit involved) against both file types
in the user's library:

- **WAV (`wavparse`)**: the seek is rejected outright.
  `GST_DEBUG` shows the event propagating cleanly down to `wavparse0:src`, then:
  `gstwavparse.c:628:gst_wavparse_perform_seek: negative playback rates are not
  supported yet.` `Pipeline::seek()` returns `Err(BoolError("Failed to seek"))`,
  exactly as our Rust code's `.map_err` would surface it — this part of the design
  degrades safely (an error, not silent misbehavior).
- **MP4/AAC (`qtdemux`)**: worse — `seek()` returns `Ok(())`, no bus error or
  warning, i.e. *looks* like it worked. A buffer probe on the sink pad (bypassing the
  audio sink entirely) shows what actually happens: `qtdemux` decodes **forward**
  through the `[start, stop]` window given to the seek (here `[0, 10s]`, all PTS
  increasing 0.00 → 10.01s), then hits `gst_qtdemux_advance_sample: reached max
  allowed sample, mark EOS` and posts EOS. It is not reversing playback at all — it's
  treating the negative-rate seek as a bounded forward clip and stopping at the
  boundary. This is the dangerous case: no error to catch, just wrong audio (forward
  audio into a paused-deck jog wheel spinning backward), and it would EOS almost
  immediately, right when the user expects continuous scratch audio.

Repro used: `uridecodebin → queue → audioconvert → audioresample →
capsfilter(48kHz) → [pitch, omitted in one variant to rule it out] → sink`, i.e. the
same shape as the real pipeline minus the tee/cue branches (irrelevant to seek
behavior). `pitch` was *not* the blocker in either case — removing it from the chain
made no difference; the rejection/mis-decode happens at the demuxer, upstream of
where `pitch` sits.

This resolves the design's open questions #1 and #2 conclusively, and worse than
either anticipated: it's not "does `pitch` need a bypass" (question #1) or "does it
work on WAV but not compressed" (question #2) — **neither format actually reverses**,
for two different reasons (explicit rejection vs. silent wrong-direction decode), and
the tested GStreamer plugin set (`gst-plugins-good`/`gst-plugins-bad`, whatever
version ships with this system) is the actual constraint, not anything specific to
this pipeline's topology.

**What this means for the feature as designed**: true bidirectional segment-rate
scratch is not achievable via `uridecodebin`'s stock demuxers on this system.
Forward-direction scratch (already verified working) could ship on its own, but that
was explicitly the "simpler alternative" the user rejected at the start of this
design specifically because it doesn't sound like scratching in reverse. Real reverse
audio would require a fundamentally different mechanism — e.g. decoding the file to
an in-memory PCM buffer up front (similar to what `analysis.rs` already does for
waveform peaks) and manually feeding reversed chunks through an `appsrc`, sidestepping
the demuxer's seek handling entirely. That is a materially larger feature than this
doc originally scoped, deserving its own design pass rather than a bolt-on.

## Session context for whoever picks this up

This design followed a debugging session (same day, `journal.md`/commit history around
`2026-07-21`/`2026-07-22`) that fixed two real jog-wheel bugs while investigating this
feature request:
- Rate-runaway while playing (nudge compounded off the live rate instead of a saved
  base) — fixed in `handler.ts`.
- UI freeze while playing (jog nudge called `updateDeck()` synchronously per MIDI tick
  instead of the rAF-throttled `queueDeckPatch()` used by every other continuous MIDI
  control) — fixed in `handler.ts`.

Also worth knowing: `midi.rs` throttles **log printing** for continuous controls to once
per 500ms per key (`log_throttle`, `midi.rs` ~line 288-317) but does **not** throttle the
actual `MidiAction` dispatch to the frontend — don't mistake sparse jog-wheel log lines
for a low real event rate when debugging.
