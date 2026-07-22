# PCM-buffer playback: real reverse scratch, and a look at broader use (design)

## Why this exists

`docs/design/jog-scratch-audio.md` proposed true bidirectional scratch via a
GStreamer segment-rate seek (negative `rate` on `Pipeline::seek()`). Implemented and
tested against the user's real files (see that doc's "Implementation attempt and
findings" section, 2026-07-22): **it doesn't work**. `wavparse` rejects negative-rate
seeks outright (`negative playback rates are not supported yet`); `qtdemux` accepts
the seek call (`Ok(())`, no error) but silently decodes **forward** through the
seek's `[start, stop]` window instead of reversing, then EOSes at the boundary —
confirmed with a buffer probe showing monotonically increasing PTS/sample values
where a reversal was expected. Neither demuxer in this pipeline supports real
reverse decode, and that's a property of the plugins, not something tunable via seek
flags (`ACCURATE` vs `KEY_UNIT` made no difference; removing `pitch` from the chain
made no difference — the rejection/misbehavior happens at the demuxer, upstream of
everything else).

This doc covers the alternative: decode the file to a raw PCM buffer once, up front,
and feed it to the pipeline via `appsrc` under our own control. Reverse playback
then isn't a GStreamer feature we depend on at all — it's just "read the array
backward."

## Validated: appsrc has no notion of direction

Prototyped standalone (no Tauri/WebKit, `/tmp/.../scratchpad/gst-repro`, kept as
scratch work — not part of the repo): built a pipeline `appsrc → audioconvert →
fakesink` and pushed two buffers of synthetic PCM where `sample[i] == i as f32` (an
index marker, so any reordering is visible by construction, not by ear/inference).
First buffer: samples `[0..500)` in original order. Second buffer: samples
`[1000..1500)` **reversed** (`1499, 1498, …, 1000`), given a normal
monotonically-increasing PTS immediately following the first buffer's — i.e. nothing
about the *timestamps* signals reverse; only the *sample order inside the buffer* is
reversed.

```
[appsrc-out] pts=0.000000000 n=500 first=0.0   last=499.0
[sink-in]    pts=0.000000000 n=500 first=0.0   last=499.0
[appsrc-out] pts=0.011337868 n=500 first=1499.0 last=1000.0
[sink-in]    pts=0.011337868 n=500 first=1499.0 last=1000.0
```

`sink-in` is byte-identical to `appsrc-out` for both buffers. `audioconvert`
(everything downstream of `appsrc`, by extension) has no concept of "sequence" — it
processes whatever bytes it's handed, in order, full stop. This is the entire
mechanism: **reverse-direction audio is just "hand the sink descending-index
samples instead of ascending-index samples."** No negative rate, no seek event, no
demuxer involvement, and therefore none of `wavparse`/`qtdemux`'s limitations apply.

(An earlier attempt piped this through `audioresample` too, which produced a
confusing non-monotonic trace — not a bug, just FIR interpolation smearing across a
synthetic 1000-unit discontinuity that a real audio waveform would never have at a
scratch direction-change, especially once real playback crossfades the transition.
Removed audioresample from the prototype since it wasn't answering the question
being asked; noted here so the same confusion doesn't recur if this is revisited.)

## Two scopes

### A. Scratch-only: swap in a PCM feeder branch during scratch, leave normal playback untouched

Add a second source branch inside the existing per-deck pipeline, gated by a valve,
merged with the normal branch before the shared downstream chain:

```
uridecodebin → queue → convert → resample → capsfilter(48k) → pitch → valve_normal ⌐
                                                                                     ├→ input-selector → output_queue → tee → …
appsrc(scratch PCM) → convert2 → resample2 → capsfilter2(48k) →──── valve_scratch ⌐
```

`input-selector`'s `active-pad` switches which branch's data actually reaches
`output_queue`/`tee` — GStreamer's own mechanism for exclusive source switching,
handling the flush/segment bookkeeping a raw pad unlink/relink would leave to us.
The scratch branch's `appsrc` is fed by a small thread walking a pre-decoded PCM
buffer at a variable step size (derived from tick velocity, same signal already
computed in `handler.ts`) — forward or backward, sub-sample positions handled with
linear interpolation between adjacent buffer samples so the "spin speed" is
continuous rather than a stair-step. Deliberately bypasses `pitch`: scratch's
pitch-bend-with-speed isn't a separate effect to apply, it's the *direct
consequence* of how fast we walk the buffer — feeding that back through
soundtouch's WSOLA algorithm (built for continuous forward musical audio) would be
redundant at best, and actively wrong given it already choked structurally on
`pitch`-adjacent reversal in the failed design.

**Blast radius**: normal playback's existing branch (`uridecodebin → … → pitch`) is
untouched — scratch only ever engages `valve_scratch`/`input-selector` while a deck
is paused. Low risk to ship.

**New per-deck cost**: one full PCM decode at load time (see "Where the buffer comes
from" below) and the buffer held in memory for the deck's lifetime, even though it's
only *read* during scratch gestures.

### B. Unified: appsrc as the primary source for all playback, not just scratch

If `appsrc` replaces `uridecodebin` as the *only* source (normal playback included,
still through `pitch` for the tempo fader, fed by a thread pushing forward-order
chunks paced by GStreamer's `need-data` signal), every seek in the app — waveform
click, hot-cue jump, loop points, EOS-loop restart — becomes an in-memory cursor
write instead of a real demux/decode operation. This directly targets a pain point
already on record in `CLAUDE.md`: the `pendingSeekTarget` filter in `seekBus.ts`
exists specifically because "on a heavy video, GStreamer can take >1s to process a
seek" — with the file already fully decoded in RAM, that multi-hundred-ms-to->1s
demux/preroll cost disappears; what's left is just a `FLUSH` event traveling through
the already-allocated queues, which is fast regardless of file weight. It would let
`pendingSeekTarget`'s workaround be simplified or possibly removed outright (needs
re-verification once built, not assumed).

**This is the part worth being honest about scope for.** It touches the one piece
of this app that must never regress — playback that's already correct, tested, and
carries a long list of hard-won fixes (EOS handling, multi-sink `tee`/`async=false`
ordering, PipeWire quantum via the 48kHz `capsfilter`, `output_queue` sizing for
soundtouch's variable chunk output, cue-branch valve gating, rate-then-seek
ordering). Replacing the source element means every one of those needs
re-verification against the new source, not just scratch. It is very plausibly worth
doing — the seek-latency fix alone is a real, currently-worked-around problem — but
it's a separate, larger initiative from "make the jog wheel scratch," deserving its
own milestone plan and dedicated test pass (the `perf-idle-test.sh`/
`latency-test.sh` scripts exist for exactly this kind of change and should gate it),
not a rider on this branch.

**Recommendation**: build (A) now — it's the actual ask, it's low-risk, and it
proves the PCM-buffer-and-appsrc pattern in production. Treat (B) as a follow-up
proposal once (A) has run for a while, written up as its own design doc when there's
appetite for a dedicated migration (own branch, own phased rollout, own test gate) —
not folded into this one.

## Where the buffer comes from

`analysis.rs::compute_analysis()` already does almost exactly this decode, once per
load, off the main thread (`spawn_blocking`): `uridecodebin → audioconvert →
audioresample → capsfilter(F32LE mono 44100) → appsink`, with the same
`autoplug-select` video-skip guard `DeckAudioPipeline` uses, pulling samples in a
loop until EOS. It currently only retains two downsampled derived arrays (peaks,
envelope) and discards the raw samples.

Two options, not mutually exclusive:
1. Add a second decode function (or a mode flag on the existing one) that retains
   the full-resolution samples — **stereo**, not the mono-forced analysis path
   (scratch audio should preserve the source's channel image), and at 48kHz to match
   the pipeline's `capsfilter(rate=48000)` rather than analysis's 44100, avoiding a
   resample step in the scratch feed path.
2. Reuse the *same* decode pass for both purposes (capture full samples and derive
   peaks/envelope from them in one traversal) to avoid decoding the file twice at
   load time. Better long-term, more invasive to `analysis.rs`'s existing shape and
   its `PEAKS_PER_SECOND`/`ENVELOPE_RATE` chunking, which assumes 44100 mono. Fine as
   a follow-up once (1) is proven; not required for (A).

## Memory cost

Stereo F32 interleaved at 48kHz: `48000 × 2 × 4 = 384,000 bytes/s ≈ 22.5 MB/min`. A
5-minute track ≈ 112 MB; loaded across several decks concurrently (no hardcoded deck
limit — see `CLAUDE.md`'s N-deck guarantee) this adds up, e.g. 4 decks ≈ 450 MB+.
Halving to S16LE (`192 KB/s ≈ 11.25 MB/min`, ≈ 56 MB per 5-min track) is a cheap
mitigation if this becomes a real constraint, with a convert step back to F32 either
in the feeder thread or via `audioconvert` downstream of `appsrc` — worth deferring
until (A) is running and actual memory pressure (if any) is observed, rather than
optimizing up front. Not a blocker either way for scratch-only scope, where the
alternative (no working reverse scratch at all) is worse.

## Open items before implementing (A)

1. **`input-selector` vs. a valve pair into a `funnel`**: `input-selector` is the
   more "correct" element for exclusive switching (proper flush/segment handling on
   switch); needs a quick standalone prototype (same pattern as the `appsrc`
   validation above) before wiring it into the real per-deck pipeline, given the
   segment-switching semantics are the one part of this not yet empirically checked.
2. **Feeder thread lifecycle**: started/stopped alongside scratch start/stop
   (`scratch()`/`stop_scratch()` equivalents), needs clean teardown so it doesn't
   keep pushing to a dead `appsrc` after `stop_scratch()` — likely an `Arc<AtomicBool>`
   run flag, mirroring the existing bus-monitor-thread pattern in `pipeline.rs`.
3. **Sub-sample interpolation**: linear interpolation between adjacent buffer
   samples for non-integer step sizes, direction-aware (step can be negative).
   Needs a click-free crossfade at the moment scratch starts/stops and at
   direction reversals — a hard discontinuity (as in the synthetic prototype above)
   would be audible in real playback even though the prototype didn't care.
4. **Buffer decode timing**: full decode at track load adds latency before scratch
   is available (though `analysis.rs`'s existing full decode for peaks/envelope
   already pays a similar cost — this may be closer to "free" once combined per
   option 2 above than it looks in isolation).

## Status

Design only — not yet implemented. Prototype code for the appsrc validation lives
outside the repo (`/tmp/.../scratchpad/gst-repro`), kept for reference during this
session only. All work for this feature is on the `jog-scratch-reverse-pcm` branch
so it can be reverted cleanly if it doesn't pan out.
