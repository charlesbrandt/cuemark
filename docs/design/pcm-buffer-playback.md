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

## Implementation notes (A), 2026-07-22

Built as designed: `pcm_buffer.rs` (`decode_stereo_48k`, mirrors `analysis.rs`'s decode
skeleton but stereo/48kHz, cached on `DeckAudioPipeline` per loaded file, skipped on
device-switch reloads of the same file). `pipeline.rs` gained the appsrc branch
(`appsrc → audioconvert → audioresample → capsfilter(48k)`) merged into the shared
chain via `input-selector`, downstream of `pitch`/`valve_normal`, exactly per the
topology diagram above. `scratch()`/`stop_scratch()` keep their existing signatures —
no frontend changes were needed beyond updating stale doc comments that described the
old segment-rate-seek mechanism.

Resolved item 1 (input-selector vs. valve+funnel) empirically: input-selector works,
but not for free — see the two hangs below, both found only by actually running it
against a real file, not by code review. Resolved items 2–3 as designed
(`Arc<AtomicBool>` stop flag + thread join; linear interpolation with a 240-frame
(~5ms) fade-in/out ramp). Item 4 (decode latency) wasn't a problem in practice: a
5.6s file decodes in well under the test's own setup time.

**Two real hangs found via a live smoke test** (`pipeline.rs`'s
`scratch_smoke_test::scratch_smoke`, `#[ignore]`d — hardcoded local file path, run
explicitly with `cargo test scratch_smoke -- --ignored --nocapture`), not by
inspection. Both were silent: no error, no panic, just a `seek_simple()`/`set_state()`
call that never returns. Worth preserving here because neither is discoverable by
reading the GStreamer docs for `input-selector`, `valve`, or `appsrc` in isolation —
both are interaction effects between them:

1. **Runaway decode**: gating the normal branch with `valve_normal` (`drop=true`)
   during scratch doesn't backpressure `uridecodebin` — a closed valve *discards*
   instantly rather than blocking, so nothing upstream of it stalls. `uridecodebin`
   raced ahead and decoded (and discarded) the rest of a 5.6s file in a fraction of a
   second regardless of how short the scratch gesture was, reaching EOS almost
   immediately every time. Fix: explicitly freeze `uridecodebin`'s own element state
   via `set_locked_state(true)` while scratch is active (`scratch()`), unlocked again
   in `stop_scratch_feeder()`/`load()`'s teardown/`Drop`. The valve alone was never
   going to be enough; locking the source is what actually stops it from working.

2. **Stuck preroll on switch-back**: even with (1) fixed, switching
   `input-selector`'s `active-pad` back to the normal branch and then issuing a single
   flush seek to resync it left the main `pipewiresink` stuck forever —
   `pipeline.state()` reported it pinned at `cur=Playing target=Paused` indefinitely,
   confirmed by waiting a real 3 seconds inside the test with no change (not a slow
   transition; a genuine deadlock). Root cause (as far as empirically isolated,
   without kernel-level ptrace access to confirm the exact internal lock — this
   environment's `yama/ptrace_scope=1` blocks attaching gdb to a non-child process):
   switching the active pad while the sink's preroll bookkeeping still reflects the
   scratch branch, then immediately asking the *new* branch to both preroll *and*
   resolve a seek in one step, doesn't work. Fix, found by bisection rather than
   documentation: issue a first flush seek **while still on the scratch pad**
   (before switching), *then* switch `active-pad`/valve/unlock, *then* issue the
   real resync seek. The first seek's target time is irrelevant — appsrc has no real
   seekable position — only the `FLUSH_START`/`FLUSH_STOP` cycle it drives through the
   shared downstream chain matters; it's what lets the *second* seek (on the
   newly-active branch) actually complete instead of hanging. A 130ms sleep before
   that first flush (draining the feeder's already-pushed fade-out tail through
   `output_queue`'s up-to-100ms buffer) was tested as *not* the cause of either hang —
   it's there purely so the fade-out is audible before its buffer gets flushed away,
   not for correctness.

**Verified working** end-to-end via the smoke test: load (including PCM decode),
forward scratch, a live rate change mid-gesture (no reseek — just an atomic store the
feeder thread picks up), reverse scratch, stop, and resumed normal playback — with
position tracked correctly through all of it (paused at 0.300s → scratch cursor lands
at 0.443s → 200ms of resumed forward playback advances to 0.643s). Not yet verified
inside the real app/WebKit UI (MIDI jog wheel → `handler.ts` → IPC) — the smoke test
exercises `DeckAudioPipeline` directly, standalone, which was sufficient to find and
fix both hangs above without needing the full Tauri/WebKit stack in the loop.

## Live hardware iteration (Hercules jog wheel), 2026-07-22

Wiring (A) into the real MIDI path (`handler.ts`'s `jog_nudge` case, paused-deck
branch) surfaced four more problems, **none of which the standalone smoke test or
code review caught** — every one needed a real controller and a real ear in the loop.
Recorded here because each is a distinct pitfall, not just "tune the constants":

1. **Tick-velocity math saturated to max speed on essentially every gesture.**
   First version computed rate from a hard rolling window: sum of signed tick values
   over the last `SCRATCH_TICK_WINDOW_MS`, divided by the elapsed time since the
   *oldest* tick still in that window. Bug: on the very first tick of any gesture,
   that oldest tick *is* the one just pushed, so the divisor is ~0ms — floored to
   1ms, producing a computed "ticks/sec" in the thousands, clamped to
   `SCRATCH_MAX_RATE`. The comment in the original code literally said "clamped to
   SCRATCH_MAX_RATE regardless" without registering that this meant *every* gesture's
   opening tick played at full speed, independent of actual wheel speed — reported
   as "accelerated rate, didn't match the jog wheel feel."

   First fix attempt (floor the divisor at a fraction of the window instead of 1ms)
   traded one bug for another: real USB MIDI delivery is bursty (several CC messages
   land in one JS macrotask, then a gap — an event-loop/OS-scheduling artifact, not
   real wheel motion), so the rolling window frequently contained just one recent
   tick *mid-gesture*, not just at the start — any inter-tick gap over the floor
   collapsed the rate to `SCRATCH_MIN_RATE`, reported as "stuttery and
   unresponsive," with a stray tick's raw sign occasionally flipping the perceived
   direction.

   **Final fix**: replaced the hard window entirely with an EMA
   (`SCRATCH_EMA_ALPHA`) of *instantaneous* ticks/sec computed from the gap since the
   *immediately previous* tick (not "oldest tick in an arbitrary window"). This has
   no degenerate zero-divisor case beyond a tiny `SCRATCH_MIN_DT_MS` floor (guards
   against two ticks landing in the same millisecond), and bursts/gaps get smoothed
   by the EMA blend instead of being fully trusted or fully discarded. Lesson: for
   noisy per-event hardware input, prefer EMA-over-previous-sample to windowed-sum —
   the window's "divide by elapsed time within the window" formulation has a hidden
   assumption (the window is usually well-populated) that bursty delivery violates
   constantly, not just at edge cases.

2. **Position silently snapped to the nearest keyframe on every gesture boundary.**
   The resync seek in `stop_scratch_feeder()` used `SeekFlags::FLUSH | KEY_UNIT` —
   correct for the *warm-up* seek earlier in the same function (its target is
   irrelevant; only the FLUSH cycle matters there), wrong for the real resync, whose
   exact position *is* the point. `KEY_UNIT` tells the demuxer "nearest keyframe is
   fine," which on an MP4 source rounded a scratch cursor that stopped at
   `2326862/48000 = 48.476s` down to `2304000/48000 = 48.000s` — a suspiciously round
   number that gave the bug away in the logs. Every following gesture then started
   from that snapped position instead of where the previous one actually ended,
   reported as "can only play forward/backward a fixed length from the starting
   position." Fix: `ACCURATE` instead of `KEY_UNIT` for that specific seek — costs a
   bit more (decode from the prior keyframe up to the target) but it's a discrete
   once-per-gesture operation, not a hot path. **Lesson**: `KEY_UNIT` vs `ACCURATE`
   is not a minor perf knob — grep for every seek in the codebase before assuming an
   existing pattern (most of this app's seeks intentionally use `KEY_UNIT` for
   scrubbing responsiveness, tolerated by `pendingSeekTarget`'s slop filter) applies
   uniformly; a scratch resync's precision requirements are different in kind, not
   degree, from a waveform-click seek.

3. **Displayed timestamp and waveform playhead were completely frozen during
   scratch — the audio was correct the whole time.** Two independent UI paths both
   gate on `deck.playing`, which is always `false` throughout a scratch gesture (see
   `jog_nudge`'s `if (!d.playing)` branch): `App.svelte`'s RAF position-poll loop, and
   `WaveformCanvas`'s redraw loop. Neither has any notion of "scratching." Separately,
   even once polled, `DeckAudioPipeline::position()` was returning the *scratch
   appsrc branch's* running time — meaningless as a content position, since the
   appsrc buffers are timestamped by `do-timestamp=true` (wall-clock time of when
   they were *pushed*), not by what part of the file they contain. Fix required three
   coordinated pieces: a shared `scratchingDecks` store (`seekBus.ts`) that
   `handler.ts` populates and both `App.svelte`'s poll condition and
   `WaveformCanvas`'s redraw-loop gate now check alongside `deck.playing`; and
   `position()` (Rust) now returns the scratch feeder's live PCM-buffer cursor
   (already tracked, reused from the `stop_scratch_feeder` resync) whenever a feeder
   is active, instead of querying the pipeline. **Lesson**: any feature that
   introduces a *new* "the deck is doing something" state (scratching, in this case)
   needs to be audited against every place in the UI that gates continuous work on
   the *existing* states (`deck.playing`) — those gates were all correct on the day
   they were written and silently wrong the day a new state was added alongside them.

4. **Reverse scratch didn't sound reversed, even after (1)-(3) were fixed** — traced
   to what the audio was actually doing being correct (confirmed via logs: cursor
   frame count decreasing on a negative-rate gesture) but perceptually ambiguous:
   what this implementation produces is closer to a tape/CDJ "shuttle" (jog velocity
   → playback *speed*, decoupled from real time, free-running between MIDI ticks) than
   real vinyl manipulation (jog position → playback *position*, 1:1 with physical
   motion, silent the instant your hand stops). Reversed audio at shuttle speeds
   (1.5–3×) reads to the ear as generic fast noise in both directions — you can't
   easily tell forward-fast from backward-fast by feel alone, which is a property of
   the *mode*, not a bug in the direction handling. Not fixed as of this writing —
   see "Open question" below.

**Every one of these four was found by a human turning the actual wheel and
listening/watching**, not by `cargo test`, `cargo clippy`, or reading the diff. The
standalone smoke test (`scratch_smoke`) remains useful as a regression guard for the
mechanism (does scratch hang, does position resync, does reverse move the cursor
backward) but cannot catch tuning/feel problems or UI-wiring gaps by construction —
it drives `DeckAudioPipeline` directly, with no `handler.ts`, no `App.svelte`, no ears.

## Open question: shuttle mode vs. vinyl mode

Raised after the round of fixes above: what's built is a *shuttle*-style scratch
(velocity-controlled, decoupled from real time — the feeder free-runs at the
last-set rate, paced by its own wall clock, between MIDI ticks) — useful for fast
cueing/searching, but not what "vinyl mode" traditionally means on a DJ controller:
direct 1:1 position control, where the platter (and thus the audio) moves *only*
when and exactly as much as your hand does, and stops dead the instant you stop.

These aren't just two tunings of the same mechanism — they're different control
models:
- **Shuttle (current)**: jog input → target *velocity* → feeder integrates that
  velocity against wall-clock time, continuing between ticks. Needs a "how fast" and
  naturally free-runs. This is what `scratch(rate)` already implements.
- **Vinyl**: jog input → direct *position delta* per tick, with no free-running
  between ticks — silence (or true hold, zero movement) the instant ticks stop
  arriving, since a stationary hand on a real record produces no motion at all. This
  needs the feeder to *not* keep pushing samples paced by its own clock once ticks
  stop; position should track tick arrival directly, not decay from a floor rate.

**Implemented, 2026-07-22** — global toggle (`scratchMode` in `audioSettings.ts`,
persisted, default `"vinyl"`), a dropdown in the settings panel. Reused
`scratch()`'s existing appsrc/input-selector plumbing rather than a separate feeder
shape, per the "likely" guess above — it only needed a decay strategy, not new
topology: `scratch(rate, hold_ms)` (both Rust and the `audio_scratch` Tauri command
gained a `hold_ms` parameter) — if no `scratch()` call refreshes the feeder's
`last_update` within `hold_ms`, it ramps rate *and* gain to zero and freezes the
cursor, instead of continuing to free-run at the last rate. Shuttle passes an
effectively-infinite `hold_ms` (preserving the exact original free-running
behavior); vinyl passes 40ms. Mode-specific rate scale/floor/cap live in
`SCRATCH_MODE_PARAMS` in `handler.ts` — vinyl's are considerably gentler
(0.02–0.8 vs. shuttle's 0.15–3.0), appropriate for slow, precise motion rather than
fast searching. Regression-guarded by `vinyl_hold_smoke` in `pipeline.rs` (asserts a
short-hold gesture drifts only ~0.07s across a 200ms gap with no further ticks, vs.
~0.3s if it had kept free-running).

**Found immediately on real use: vinyl mode's natural usage pattern (short, precise
nudges with pauses) starved the whole app.** `SCRATCH_IDLE_MS` (the *only* thing
gating `stop_scratch_feeder()` — full branch teardown and resync to normal playback)
was 150ms, shared with the pre-vinyl-mode design. `stop_scratch_feeder()` runs a
130ms drain sleep plus two synchronous flush seeks (one `ACCURATE` — see finding 2
in "Live hardware iteration" above — real decode work) *while holding the single
global `Mutex<AudioManager>`* that every audio Tauri command for every deck
serializes behind (position polls from the RAF loop, rate/gain/volume syncs, other
decks' commands, everything — `AudioState = Mutex<AudioManager>` in `mod.rs`). That
teardown used to fire once per whole shuttle gesture; vinyl mode's natural
short-nudge-then-pause rhythm fires it on almost *every* pause between nudges, and
once those ~200–500ms mutex-held windows started overlapping faster than they could
drain, the entire app's audio IPC — and by extension anything in the JS event loop
awaiting those promises — stalled. Reported as "the application became
unresponsive" (the user's own guess, "overfilled buffers," is directionally right
about *something piling up* — it's IPC calls queued behind the mutex, not a literal
audio buffer). **Fix**: `SCRATCH_IDLE_MS` raised from 150ms to 500ms. This is safe
because it now governs a *different* thing than it used to: audio responsiveness on
pause is entirely `hold_ms`'s job (already near-instant, 40ms for vinyl), so the
branch-teardown timer no longer needs to be that aggressive — it only has to detect
"the user has genuinely let go," not "there was a brief gap between nudges." Pressing
play mid-pause still tears down synchronously first (the `isScratching()` check in
`deck_play_toggle`), so this doesn't add any release-to-play lag. **Lesson**: once a
timer serves two purposes (here: "make audio quiet" and "release the shared
pipeline/mutex"), a design change that makes one purpose's job much finer-grained
(hold_ms) can leave the *other* purpose still running at the old, now-mismatched
cadence — worth deliberately re-examining every existing consumer of a shared
threshold constant when its usage pattern changes, not just adding a new consumer
alongside it. If a very long, uninterrupted rapid-nudging vinyl session still
reproduces stalling at 500ms, the deeper (riskier, untried) fix is moving
`stop_scratch_feeder()`'s blocking work off the mutex-held critical section
entirely — not attempted yet, since it changes the locking model this feature has
otherwise left untouched and this codebase has already hit two real hangs
(see "Live hardware iteration" above) from confident-looking GStreamer state changes.

Needs a decision (not yet made) on whether the mode should stay a global setting or
become per-deck / a runtime MIDI-button toggle, matching how real controllers key
vinyl-mode on/off from a dedicated button since DJs switch between "search fast" and
"nudge precisely" within a single track.

**Recurred at 500ms, same mechanism — fixed structurally, 2026-07-22.** Raising
`SCRATCH_IDLE_MS` bought headroom but didn't remove the actual cause: any vinyl
session with pauses longer than the threshold still hits the same mutex-held
teardown, every time. The "deeper fix" flagged as risky/untried above — moving
`stop_scratch_feeder()`'s blocking work off the mutex-held critical section — turned
out to already have a proven precedent in this exact file: `audio_load` (`mod.rs`)
already pulls a deck's pipeline out of the `HashMap` before its own slow blocking call
(GStreamer preroll, up to 5s) and reinserts it after, specifically so other decks'
IPC doesn't queue behind it. Generalized that into `with_pipeline_detached()` and
routed `audio_pause`/`audio_stop_scratch` through it. This changes *when* the global
`Mutex<AudioManager>` is held, not the locking model itself — no new lock, no new
thread, no change to `pipeline.rs`'s teardown sequence at all. The only new failure
mode: a concurrent command for the *same* deck while its pipeline is detached gets a
clean `Err("no audio pipeline for deck …")` instead of blocking-then-succeeding —
already a handled, `.catch()`'d error path everywhere on the frontend, and a strictly
safer outcome than racing two calls against the same live GStreamer state.

Verified with a concurrency stress test (`audio::concurrency_stress_test` in
`mod.rs`, `#[ignore]`d like the other pipeline smoke tests — needs a real local file):
one thread cycles deck-a through scratch→pause (a full teardown every time) while
another hammers deck-b's `position()`, recording worst-case latency. Confirmed the
test actually catches the regression before trusting it: temporarily reverted
`with_pipeline_detached` to hold the lock across the call (the old behavior) and
reran — deck-b's worst-case latency spiked to **1519.6ms** (worse than the ~130-400ms
estimated for a single teardown, since deck-a's cycles compound back-to-back). With
the fix, worst case dropped to **0.4ms**. This is the right way to validate a
locking-behavior fix in this codebase before trusting it live: don't just assert the
fix works, temporarily reintroduce the bug and confirm the *same* test catches it —
otherwise a test that "passes" might be passing for the wrong reason (e.g. not
exercising real contention at all).

**Why this approach over per-deck locks**: per-deck locking (one `Mutex` per
`DeckAudioPipeline` instead of one global `Mutex<AudioManager>`) was considered and
explicitly set aside for now — not because it's unsafe here (every Tauri command is
single-deck-scoped, so there's no code path that would ever need two different decks'
locks at once, which is the usual source of lock-ordering deadlocks), but because
`with_pipeline_detached` fixes the actual reported problem with zero new
synchronization primitives and reuses an idiom already live-tested in this codebase
(`audio_load`). Revisit per-deck locking only if another blocking call turns up
elsewhere that this pattern doesn't cover.

**Recurred a third time — and this time the telemetry proved the Rust-side fix wasn't
the cause at all.** Added millisecond-precision log timestamps (`lib.rs`'s custom
`tauri_plugin_log` formatter — the default only has 1-second resolution, nowhere near
enough for this class of bug) plus per-phase timing in `stop_scratch_feeder`/
`take_and_join_feeder` and an "IPC received" log at the top of `with_pipeline_detached`.
Next live repro: the Rust log showed the feeder-thread join complete in 5.5ms and the
*entire* teardown (drain sleep + both seeks) complete in 154.3ms — fast, exactly as
designed. But there was a real **4.4-second gap with zero Rust-side log activity at
all** between the last MIDI tick's release and the moment `with_pipeline_detached`'s
"IPC received" log fired for the stop-scratch call. Rust was sitting completely idle
that whole time — the delay was entirely upstream, on the JS/WebKit side, before the
IPC call was even issued. This also explains the user's new report that "normal
playback controls no longer work after the choke" — a stuck GStreamer call wouldn't
touch play/pause button click handlers (different code path entirely), but a busy
WebKit main thread/webview would block *everything*, including button clicks, matching
the symptom exactly.

**Root cause: `v.currentTime` write storm during scratch.** The scratch branch of
App.svelte's position-poll block (`frame()`) snaps `v.currentTime = contentPos`
whenever drift from the last-set value exceeds 80ms. During active scratch this drift
threshold is crossed roughly every ~100ms (at typical vinyl-mode rates), so a
multi-second gesture fires dozens of `v.currentTime` writes to the *same* `<video>`
element in quick succession. WebKitGTK does not handle this well — CLAUDE.md already
documents the same class of fragility for `v.playbackRate` (an internal GStreamer
pipeline rebuild on every write, requiring a change-only guard); `currentTime` writes
appear to have a comparable cost, and issuing them faster than WebKit can drain them
queues up a backlog that can take several seconds to clear *after* the gesture ends —
during which the whole webview, not just video playback, stays busy. **Fix**: throttle
`v.currentTime` writes during scratch to at most once per 150ms via a
`lastVideoSnapTime` map, independent of the existing drift check (both conditions must
now hold). The waveform-playhead update (`setDeckAudioTime`) is untouched — it's a
cheap JS/store write with no WebKit cost, and was the actually load-bearing part of the
original "poll during scratch" fix; only the expensive `v.currentTime` line needed
throttling. Video no longer tracks a fast jog frame-accurately, but audio (the real
cueing signal, via the independent PCM feeder) is unaffected.

**Lesson, worth remembering beyond this feature**: when a live report says "it froze,"
don't assume the freeze is in the subsystem you were just working on. The previous
round's Rust-side fix (`with_pipeline_detached`) was correct, stress-tested, and
verified to fix a real problem — but it wasn't *this* problem. Instrumenting both sides
(millisecond Rust timestamps *and* checking what was and wasn't logged during the gap)
is what made it obvious the stall was upstream of Rust entirely, rather than tuning the
same fixed subsystem a third time. See [[feedback_audio_midi_live_testing]].

## The `v.currentTime` throttle did not fix it — retest, 2026-07-22

A fourth live report ("same behavior as before... normal playback controls no longer
work after the choke up") came in *after* the 150ms throttle above was deployed and
hot-reloaded (confirmed present in the running frontend, no stale bundle). Comparing
the retest's log against the pre-throttle log it was meant to fix:

| | pre-throttle (23:15) | post-throttle retest (23:28) |
|---|---|---|
| gesture length | ~8.5s (13:04.942 → 13:13.286 last tick) | ~7.1s (28:13.554 → 28:20.559 last tick) |
| gap: last MIDI tick → `audio_stop_scratch` IPC arrives at Rust | **4.4s** | **12.3s** |
| Rust-side teardown once the IPC arrives | 154.3ms | 145.2ms |

The gap got **worse**, not better, after throttling `v.currentTime` from ~10/s to
~6.7/s. That rules the throttle out as the fix (it may still be worth keeping — fewer
WebKit seeks is not harmful — but it isn't what's blocking the idle-timer callback).
`stop_scratch_feeder()`'s own teardown continues to be fast and is not a suspect.

Also notable: reading the full MIDI log (not just the scratch-tagged lines) for the
first time showed jog ticks arriving from the Hercules only ~2/s (roughly every
500ms), not the assumed high rate — `audioScratch()` IPC calls, coalesced to one per
rAF via `queueScratchRate`, therefore fire at most ~2/s too, far too sparse to be
backing up on their own. `audioGetPosition()` is the one call that genuinely runs up
to 60/s during a gesture, but it's already gated to one-in-flight via `pendingPos`, so
it can't queue either. Neither obvious IPC-volume theory survives contact with the
actual tick rate — another reason not to guess again without more direct evidence.

**Added JS-side timing that lands in the same log file**, since guessing twice already
produced one confirmed-wrong fix: a `frontend_log` Tauri command (`lib.rs`) that any
frontend code can call via `src/lib/debugLog.ts` to forward a message to
`log::info!`, so JS-side events interleave with Rust/MIDI timestamps on one timeline
instead of requiring two clocks to be reconciled after the fact. Three call sites:

- **rAF heartbeat** (`App.svelte` `frame()`, throttled to ~1/s) — if this stops during
  a stall, the whole JS main thread is blocked, not just the scratch teardown path.
- **Idle-timer arm/fire** (`handler.ts` `stopScratch`) — logs how many ms late the
  `setTimeout(SCRATCH_IDLE_MS)` callback actually fired relative to its deadline. Large
  lateness = main thread was busy with something else when the timer should have
  fired. Fires-on-schedule = the timer itself is fine and the delay is elsewhere.
- **`audioStopScratch()` round-trip** (`handler.ts` `stopScratch`) — logs how long the
  invoke() promise took to settle, independent of when the timer fired. Rust's own
  teardown log (154ms/145ms above) already shows Rust is fast once the call *arrives*,
  so a slow round-trip here would point at the WebKit-side IPC bridge itself, not Rust.
- **`v.currentTime` write cost** (`App.svelte`, only logs if >5ms) — measures the
  synchronous cost of the property assignment itself, separate from whatever
  asynchronous seek WebKit does afterward.

Deliberately not gated/batched like the audio-rate IPC helpers — call volume is a
handful of lines per gesture, not per-frame, so it can't contaminate the very
measurement it exists to take. Debug-only; not intended to stay long-term once the
real cause is found.

## Localized: WebKit's own main thread freezes, not an IPC slowdown — 2026-07-23

The instrumentation above paid off on the very next repro. Full timeline (all
timestamps same session, `cuemark.log`):

- `00:47:10.599` — last MIDI activity: jog-wheel touch-sensor release.
- `00:47:11.190` — one more rAF heartbeat, then **silence for 7.36s**.
- `00:47:18.548` — heartbeat resumes.
- `00:47:19.030` — idle timer fires, self-reporting **"11ms late"** relative to when
  it was armed.

That last line is the decisive one. The idle timer is (re-)armed synchronously inside
the frontend's MIDI `listen()` callback, on every `JogNudge` event. Rust emitted the
*last* `JogNudge` at `10.218`, but "11ms late" against a 500ms deadline means the arm
call itself didn't execute until ≈`18.519` — **8.3 seconds after Rust had already sent
it**. Combined with the rAF heartbeat gap over almost the same window, this means the
entire WebKit JS main thread — render loop *and* event dispatch — was frozen solid for
~7-8s, not just the audio-stop IPC path. Rust's log is completely silent for the whole
window (no GStreamer bus messages, nothing), so the backend was never involved.
`v.currentTime write took Xms` (the >5ms threshold) never fired once — no single
synchronous property assignment was ever slow. So the freeze is not the throttled JS
call itself; it's WebKit's own internal (non-Rust) video decode pipeline for this
`<video>` element doing something that blocks its GTK main loop asynchronously,
independent of how often (throttled to 150ms or not) the write happens — consistent
with the same class of VA-API/GStreamer fragility CLAUDE.md documents for canvas
rendering, and with this feature's own earlier discovery that *reverse* seeks are more
expensive than forward ones (this gesture reversed direction mid-scratch).

**Fix, this time a removal rather than a tune**: stop writing `v.currentTime` at all
while `scratching` is true (App.svelte, position-poll block). Video simply holds its
last frame for the duration of a scratch gesture; `setDeckAudioTime` (the waveform
playhead, no WebKit cost) keeps updating live throughout, and audio — the actual
cueing signal, via the independent PCM feeder — is unaffected. The instant scratch
ends, the existing non-scratch branch does one ordinary snap back to the audio clock.
Removed the now-unused `lastVideoSnapTime` throttle map along with it. Frequency
tuning (150ms throttle) had already been tried and made the freeze worse, not better —
this is a stronger test of the same hypothesis (WebKit video seeking during scratch is
the cause) by removing the writes entirely rather than reducing their rate.
**Live-tested (2026-07-23): did not resolve the freeze** — see below. The removal
itself was not reverted (it's still correct not to write `v.currentTime` needlessly
during scratch), but it wasn't the actual cause of the choke-up symptom.

## Second freeze mechanism found: SMB/CIFS network stall on scratch resync — 2026-07-23

The `v.currentTime`-removal fix above didn't help, so the investigation escalated from
JS-only instrumentation to OS-level CPU profiling — the next tool up once
`frontend_log`/rAF-heartbeat timing had exhausted what it could localize on its own.

**`perf record` needs one-time unblocking on this machine**: non-root perf events are
disabled by default (`kernel.perf_event_paranoid=4`). Unblocked for the session via
`sudo sysctl -w kernel.perf_event_paranoid=1` (not persisted — resets on reboot, no
config file touched, ask the user to re-run it after a restart if profiling is needed
again).

**`pidstat -t -p <cuemark PID>,<WebKitWebProcess PID> 1 -h`**, run continuously in the
background across live test sessions, is what actually separated two previously
conflated freeze symptoms: a WebKit-CPU-pegged freeze (this pattern; `WebKitWebProcess`
at ~90-145%, `cuemark` idle) versus a genuinely-blocked freeze (next paragraph;
*neither* process shows CPU, because the thread is parked waiting on I/O, not spinning).
Sustained near-0% CPU during an app-appears-frozen window is the signature of a
blocking syscall, not a compute problem — that distinction is invisible from
`top`/single-snapshot CPU% and from reading the code, but immediate from a
1-second-resolution per-thread trace spanning the whole repro.

That second pattern showed up directly: `stop_scratch_feeder()`'s `resync_seek` (an
`ACCURATE`-flagged GStreamer seek that un-freezes the normal `uridecodebin` branch,
left completely idle for the whole scratch gesture) blocked for **9923.8ms** on one
repro, with `pidstat` showing neither `cuemark` nor `WebKitWebProcess` consuming CPU
during that window — a real blocking wait, not a busy loop. `mount | grep -i cifs`
explained why: the media library (`/media/memory/t7` and siblings) is mounted over
SMB/CIFS from `10.20.2.222`, `soft,relatime,vers=3.1.1,cache=strict,actimeo=1`. A
scratch gesture never touches that network branch (only the in-RAM PCM buffer is
read), so resuming it after being idle for the length of a gesture plausibly hits an
SMB idle-reconnect/re-negotiation stall.

**Fix**: `src-tauri/src/media_cache.rs` (new) — copies a track to local disk
(`app_data_dir()/media_cache/`, keyed by a hash of the original path + file size, so a
replaced source re-copies instead of serving stale bytes) the first time it's loaded,
and every subsequent read for that track — PCM decode, `uridecodebin` preroll/seeks,
waveform analysis, and video serving via `media_server.rs` — resolves through the
local copy instead. `audio_load` calls the blocking `ensure_cached()`; `media_server.rs`
and `audio_analyze_file` do a non-blocking `lookup()` (never trigger or wait on a copy
themselves — a miss just falls back to the original network path exactly as before, no
regression). The network is now touched once per track load — the same full-file read
PCM decode already required — instead of unpredictably on every seek. Session state,
`grid_store.rs`, and Digger integration are all untouched — the network path remains
the canonical identifier everywhere; only these two Rust I/O boundaries resolve
through the cache.

**Confirmed via log on the next live repro**: `teardown timing: total=170.0ms
warmup_seek=0.5ms resync_seek=25.6ms` — down from 9923.8ms. This mechanism is fixed.

**Gotcha for next time — `perf report`/`perf script` symbol resolution can hang
indefinitely**: this machine has `DEBUGINFOD_URLS=https://debuginfod.ubuntu.com` set
globally. Any `perf` command that resolves symbols (`perf report`, or `perf script`
with a `sym`/`dso` field) tries to fetch missing debug info from that URL and can hang
for many minutes with zero CPU usage and zero output — indistinguishable from perf
itself being stuck. Always prefix with `DEBUGINFOD_URLS=""` (or `env -u
DEBUGINFOD_URLS`) before `perf report`/`perf script` on this machine. `perf script -F
time,comm,tid` (no symbol fields) is unaffected and useful for a fast sanity check —
e.g. confirming a capture actually spans the repro window — before running the slower
symbolized report.

**Capturing a live-hardware repro under `perf` needs a generous, explicit window**:
the user isn't watching the terminal while working the physical controller, so a short
`sleep N` capture reliably misses the gesture (confirmed twice — a 25s and a 60s window
both closed before the user reached the hardware). What worked: a 120s capture, telling
the user recording had started and giving a wide "any time in the next two minutes"
window, then killing `perf record` with `SIGINT` (flushes the file cleanly) as soon as
`pidstat` confirms the freeze already happened, rather than waiting out the rest of the
window.

## Third freeze mechanism found: unthrottled full-waveform redraw during scratch — 2026-07-23

Even with the network-cache fix live (confirmed fast teardown via log), a repro
immediately after still showed the same "system locked up, no sound" symptom. Same
`pidstat` monitor caught it again: `WebKitWebProcess` pegged at 100-103% CPU for a
continuous **33 seconds**, `cuemark` idle throughout (explains the missing audio — the
whole JS main thread, not just the audio path, was wedged).

A `perf record -g -F 999 -p <WebKitWebProcess PID>` capture over that exact window (see
the debuginfod/capture-window gotchas above — both bit this capture before a clean one
landed) showed **92% of samples inside `[JIT] tid <pid>`** — i.e. our own JS, not
GStreamer/WebGL/video-decode C++ code. The hottest *named* leaf symbols were
`libm`'s `__round`/`__roundf`/`__lroundf` (hundreds of samples each) plus
`__memmove_avx_unaligned_erms` and repeated `WTF::equal(StringImpl...)` — the profile
signature of a tight per-item loop doing rounding and canvas-style-string churn, not
decode cost.

Root cause: `WaveformCanvas.svelte`'s `$effect` (around line 116) runs a raw
`requestAnimationFrame` loop calling `draw()` on every frame whenever
`deck.playing || scratchingDecks.has(deck.id)` — the `scratchingDecks` half of that
condition was added specifically so the playhead keeps moving during a *paused-deck*
scratch gesture (see the `getDeckTime()`-during-scratch comment on that effect). In
overview mode (the default, non-zoomed view), `drawOverview()` loops over the *entire*
`peaks` array unconditionally — ~7953 bars for this test track (30 peaks/sec × ~265s)
— each iteration doing `Math.floor`/`Math.ceil`, a `fillStyle` string assignment, and a
`fillRect` call. That's ~8000 canvas draw calls × 60fps with no gate on whether the
playhead moved enough to matter — exactly the anti-pattern CLAUDE.md's rendering
section already warns about ("every per-frame RAF loop must gate its expensive work on
an actual-change check"), just not yet applied here. Before the scratch feature
existed, a *paused* deck never ran this loop at all — `scratchingDecks` is what turns
it on for a state that used to be free. The observed feeder rate on this repro was
`0.020` (very slow jog), meaning the playhead moved a small fraction of a pixel per
frame — so nearly every one of those ~8000-bar redraws was fully wasted work.

**Fix**: gate the redraw loop on the playhead having moved at least one device pixel
since the last drawn frame (`WaveformCanvas.svelte`, the same `$effect`) — compute
`pxPerSec` from the canvas width and the active time span (`zoomSeconds` in zoom mode,
`deck.source.duration` in overview), skip `draw()` when `|Δtime| × pxPerSec < 1`.
Frontend-only, hot-reloaded live via Vite HMR immediately after the edit (confirmed in
`tauri_dev7.log`). **Not yet live-tested against the real controller** — the session
was interrupted (user needed to restart) right after the fix landed, before a retest
could happen. This is the next thing to verify on resume: repeat the paused-deck
scratch gesture (ideally at a few jog speeds, since the fix should still redraw every
frame at high speed — only slow/held gestures should see fewer redraws) and confirm
no freeze, no audio dropout, and that the waveform playhead still visually tracks
correctly (not lagging or jumping) despite the coarser redraw cadence.

## Status

(A) implemented, smoke-tested, and live-tested through the real MIDI/app path — see
"Live hardware iteration" above for four real bugs found and fixed in that pass, plus
the shuttle-vs-vinyl mode split (implemented, see above) and the mutex-contention
stall it surfaced twice (first mitigated by decoupling `SCRATCH_IDLE_MS` from
`hold_ms`, then fixed structurally via `with_pipeline_detached` once the mitigation
proved insufficient — see above, including the concurrency stress test added to guard
against a regression). Prototype code for the original appsrc validation lives outside the repo
(`/tmp/.../scratchpad/gst-repro`), kept for reference during that session only. All
work for this feature is on the `jog-scratch-reverse-pcm` branch so it can be
reverted cleanly if it doesn't pan out. Open: global vs. per-deck vs. MIDI-button
mode selection (see above), not decided. (B) remains a follow-up proposal, not
started.

**"Chokes up" investigation — three distinct mechanisms found, two confirmed fixed,
one fix pending retest (as of 2026-07-23):**

1. WebKit main-thread freeze from rapid `v.currentTime` writes during scratch —
   fixed by not writing `v.currentTime` at all while scratching (see above). Correct
   on its own terms, but not sufficient alone — freezes continued after this landed.
2. SMB/CIFS network stall on scratch-teardown's `resync_seek` (media library is a
   network share; scratch leaves that branch idle, and resuming it hit a ~10s
   idle-reconnect stall) — **fixed and confirmed via log**: `media_cache.rs` caches
   each track to local disk on load; `resync_seek` dropped from 9923.8ms to 25.6ms on
   the next repro.
3. Unthrottled full-waveform redraw (`WaveformCanvas.svelte`) during a paused-deck
   scratch gesture — thousands of `fillRect` calls per frame with no change-gating,
   pegging `WebKitWebProcess` at ~100% CPU for 33s straight on one repro (found via
   `perf record -g` stack profile: 92% of samples in JIT-compiled JS, hot
   `Math.round`/`memmove`/string-compare). **Fixed, not yet live-tested** — gate the
   redraw on ≥1 device-pixel playhead movement since the last drawn frame.

**Next step on resume**: repeat the paused-deck jog-wheel scratch gesture (a few
speeds/durations) and confirm no freeze and no audio dropout. If it recurs, re-arm
`pidstat -t -p <cuemark PID>,<WebKitWebProcess PID> 1 -h` first (distinguishes
CPU-bound vs. blocked-on-I/O in one glance) before profiling further — see the
mechanism-2 and mechanism-3 sections above for the full toolchain (including the
`perf_event_paranoid` and `DEBUGINFOD_URLS` gotchas) and `skills/audio-debugging` for
the reusable version of that toolchain.

**The system-wide-freeze lead from the prior session did not reproduce.** After a
reboot, the browser-freeze correlation the user reported was gone — normal browser
video playback was unaffected by cuemark's freezes in this session's testing. Not
chasing thermal/GPU/memory further unless it recurs; treat mechanism 3 (below) as the
sufficient explanation for what was actually observed.

## Fourth freeze mechanism found: Svelte writable-store equality doesn't skip
## same-reference object updates — 2026-07-23 (continued session)

Retesting mechanism 3's fix (the pixel-movement redraw gate) on real hardware after a
reboot showed the exact same symptom: multi-second-to-16-second WebKit main-thread
freezes (rAF heartbeat gaps, idle-timer callbacks firing many seconds late), confirmed
via `pidstat` to be the same CPU-pegged-single-core signature as before — meaning the
mechanism-3 fix, though correct on its own terms, was not sufficient on its own either.

**Diagnostic approach, since `sudo` for `perf_event_paranoid` was unavailable in this
session** (blocked by the harness's auto-mode classifier — asking the user to run it
interactively was the fallback, but a cheaper option existed first): added manual
counters directly in `WaveformCanvas.svelte`'s redraw `$effect`, flushed at most once/sec
via `debugLog` (see "Added JS-side timing" above for the pattern). This immediately
showed something the design so far hadn't considered: `effectRuns` (how often the
*outer* effect body re-executes — which does one **unconditional** `draw()` call before
the pixel-movement gate is ever reached, see the code) climbed into the hundreds within
a ~10-20s gesture, while `loopTicks` (the *inner* `requestAnimationFrame` loop, the thing
mechanism 3's fix actually gates) stayed at 1-2. The gate was working exactly as
designed — it just wasn't the hot path anymore. Something was tearing down and
re-creating the whole effect (cancelling and restarting its internal rAF loop) tens of
times per second, and every one of those re-creations paid for one full, ungated
`drawOverview()` pass (thousands of `fillRect` calls) via the top-of-effect `draw(c)`
call.

**Ruled out via manual snapshot, then confirmed via isolated single-dependency probes**:
first hypothesis was `deck` prop churn (store-wide re-renders creating new object
references even for an unrelated deck's own patch) — tracked both `deck`'s reference
identity and a snapshot of every field `draw()` reads; both stayed at zero changes
across hundreds of effect reruns, ruling this out cleanly. Rather than keep guessing,
added two *isolated* probe effects, each reading exactly one candidate reactive value
(`$effect(() => { deck; deckOnlyRuns++ })` and `$effect(() => { $scratchingDecks;
scratchingOnlyRuns++ })`) — this uses Svelte's own dependency tracking as the source of
truth instead of manual comparison, which can have blind spots. Result: `scratchingOnlyRuns`
climbed to 265 across one gesture that contained only ~10 real MIDI `JogNudge` ticks —
definitively pointing at `$scratchingDecks`, not `deck`.

**Root cause**: `setScratching()` (`seekBus.ts`) is called once per MIDI jog tick, with a
guard meant to no-op when membership hasn't changed:
```js
scratchingDecks.update((s) => {
  if (active === s.has(deckId)) return s; // meant to skip notification
  ...
});
```
This guard does prevent constructing a new `Set` — but it does **not** prevent
notification, because Svelte's plain `writable` store's equality check
(`safe_not_equal`, from `svelte/store`) treats **any object or function value as always
"changed,"** independent of reference equality:
```js
function safe_not_equal(a, b) {
  return a != a ? b == b : a !== b || (a && typeof a === 'object') || typeof a === 'function';
}
```
The `(a && typeof a === 'object')` clause makes the whole check `true` whenever the
*old* value is a truthy object — which a `Set` always is — regardless of whether `a ===
b`. This is intentional Svelte behavior (it exists so that in-place-mutated objects
still trigger reactivity), but it means **a no-op guard that returns the same object
reference from inside `writable.update()` never actually prevents notification** — only
a guard that skips calling `update()`/`set()` in the first place does. Every
`setScratching()` call was therefore unconditionally notifying every subscriber,
re-running `WaveformCanvas`'s redraw effect (and its unconditional `draw()`) at whatever
rate `setScratching()` was called — which on close reading turned out to be higher than
the raw MIDI tick rate alone would suggest (265 notifies for ~10 ticks over one gesture);
the exact amplification path beyond "notified once per `setScratching()` call" wasn't
fully isolated further once the fix eliminated the effect either way, so treat "~2-30+
notifies/sec, gesture-dependent" as the empirically observed range rather than a
derived formula.

**Fix** (`seekBus.ts`): move the equality check to *before* calling `update()`/`set()` at
all, using `get()` to read the current value:
```js
export function setScratching(deckId: string, active: boolean): void {
  if (active === get(scratchingDecks).has(deckId)) return; // never touches the store
  scratchingDecks.update((s) => { const next = new Set(s); ...; return next; });
}
```
**Confirmed fixed live**: re-ran the isolated probes after the fix — `scratchingOnlyRuns`
dropped to exactly 1 per gesture-start and 1 per gesture-stop (the two genuine
transitions), and three consecutive scratch gestures (forward, reverse, forward) all
completed with the idle timer firing 0-1ms late (vs. 8-16 SECONDS late before the fix) —
no freeze, no CPU pegging.

**Lesson — applies beyond this bug**: any Svelte `writable` store holding a `Set`,
`Map`, `Array`, or plain object needs its no-op/dedup guard placed *outside* the
`update()`/`set()` call, not inside the updater callback. A guard inside the callback
that "returns the same reference to skip" is a silent no-op itself when the store's
value type is an object — Svelte will notify anyway. This is easy to miss because the
code reads correctly and the comment even says "avoid notifying subscribers every
tick." Grep any other `writable<Set<...>>`/`writable<Map<...>>`/`writable<object>` in
this codebase for the same pattern if this class of freeze recurs elsewhere.

**Diagnostic technique worth reusing**: when a manual snapshot comparison says "nothing
changed" but a reactive effect is clearly re-running anyway, don't keep expanding the
snapshot — add an *isolated* single-dependency probe effect per candidate (`$effect(()
=> { candidateValue; counter++ })`). This uses the framework's own dependency-tracking
as ground truth and cleanly attributes the rerun to a specific reactive source in one
step, rather than iterating on what fields a manual comparison might be missing.

**Diagnostic technique for when `perf`/`sudo` is unavailable**: sampling
`/proc/<pid>/task/<tid>/wchan` (and `/comm`) for every thread on a fixed interval (e.g.
every 500ms, unfiltered, to a log file) needs no elevated permissions and shows which
kernel function each thread is blocked in — a usable substitute for `perf record` when
distinguishing "genuinely blocked on I/O/a lock" from "CPU-bound in a tight loop" (the
same distinction `pidstat`'s CPU% already gives at the process level, but `wchan`
additionally names *what* a blocked thread is waiting on). Not used to full effect this
session (the mystery stall below recurred but wasn't caught mid-stall with the sampler
armed), but the sampler script is cheap to re-arm:
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

## Fifth mechanism: a genuinely-blocked `resync_seek` stall on the *local cache copy* —
## found 2026-07-23, unresolved

With mechanism 4 fixed, the freeze (JS main thread lockup) is gone, but a *different*,
narrower stall recurred on `stop_scratch_feeder()`'s `resync_seek` — the same call
`media_cache.rs` (mechanism 2, above) was built to fix. Observed magnitudes across
several gestures in the same session: 162ms (fine), 2848ms, 3902ms, 9657ms, 11825ms —
inconsistent, not obviously correlated with gesture length or rate.

**This is not a recurrence of mechanism 2.** Explicitly ruled out:
- The file being seeked is confirmed local: `mount` shows no CIFS/NFS mount anywhere
  under `~/.local/share/com.cuemark.app/media_cache/` — it's on the same `ext4`-on-LVM
  volume as the rest of the home directory.
- Raw local read of the exact same file (`cat file > /dev/null`, `time`d) completed in
  10ms; `iostat -x 1` during a live stall showed the NVMe device essentially idle — not
  a disk-throughput or cold-cache problem.
- `pidstat` during a live 9.5s-stall repro showed the `cuemark` process at ~0% CPU
  throughout the stall — a genuine blocking wait, not a compute-bound loop (rules out a
  qtdemux moov-parse-on-cold-file theory, which would show CPU activity).
- Traced the full path from `mod.rs`'s `audio_load` (calls `cache.ensure_cached()`
  before touching GStreamer at all) through `pipeline.rs`'s `load()` (line ~302) to
  confirm **both** the normal branch's `uridecodebin` URI (line ~493) and the PCM
  scratch-buffer decode (line ~320, `pcm_buffer::decode_stereo_48k`) receive the exact
  same already-cached `file_path` parameter — there is no separate path resolution
  anywhere in the pipeline that could still be pointing at the network share.

Likely candidate (not yet confirmed): the stall is inside GStreamer/PipeWire's own
internal synchronization when the long-idle `uridecodebin`/sink chain resumes after
`set_locked_state(false)` — e.g. `pipewiresink` waiting on `ASYNC_DONE` from the actual
PipeWire server, which could itself be contended by something unrelated, rather than
anything in this app's own Rust code blocking on I/O. Not confirmed because the `wchan`
sampler (see above) wasn't armed early enough on the gesture that produced the largest
stall (11825ms) to catch it live — **this is the concrete next step**: keep the `wchan`
sampler running continuously through several gestures, then grep its log for the exact
stall window once `resync_seek`'s Rust-side log line reports a large value, and read
off exactly which `cuemark` thread was parked and in what kernel function.

## Open bug: reverse scratch produced no audible output — found 2026-07-23, unresolved

In the same live-testing session, after mechanism 4's fix, a forward scratch gesture
(rate +0.8) sounded correct — but the very next gesture on the same deck, reversing
direction (rate -0.726), produced **silence** for its whole ~4s duration; normal
playback resumed correctly afterward. The Rust-side log showed everything superficially
correct for this gesture: MIDI ticks arrived at a normal, steady cadence (7 ticks over
~4s), the feeder's logged start/stop cursor frames moved backward by a plausible amount
for the elapsed time and rate, and no errors/warnings appeared anywhere in the log.

Reviewed (not yet conclusively diagnosed): `DeckAudioPipeline::scratch()`
(`pipeline.rs` ~961) only switches `input-selector`'s `active-pad` and locks
`uridecodebin` when `inner.scratch_feeder` is `None` — i.e. only on the first `scratch()`
call of a *new* gesture, which this was (the prior gesture's `stop_scratch_feeder()` had
already run and cleared it) — so the "stale state skips the branch switch" theory
doesn't hold up on inspection. The feeder thread's cursor-stepping math
(`cursor = (cursor + effective_rate).clamp(...)`, `pipeline.rs` ~1278) is sign-agnostic
and looks correct for negative `effective_rate`. Neither read rules out a bug elsewhere
(gain/fade logic on a fresh-thread sign already matching `initial_rate.signum()` from
the start was not stepped through in detail; the `input-selector` pad switch itself was
read, not empirically verified with a buffer probe the way the original appsrc
direction validation was, see "Validated: appsrc has no notion of direction" above).
**Needs a live repro with the debug/probe pattern from mechanism 4** (or a GStreamer
buffer-probe on the scratch branch, matching this doc's very first validation) rather
than further static reading — deprioritized this session in favor of consolidating
already-confirmed fixes, per user request.

## Sixth mechanism: the "reverse scratch is silent" bug is mechanism 5, not a DSP or
## routing bug — reproduced headlessly, no MIDI hardware needed — found 2026-07-23

Picked back up the "reverse scratch produced no audible output" bug from the previous
section. The original plan was "needs a live repro with the debug/probe pattern from
mechanism 4" — but before scheduling another live-hardware session, tried building a
plain `cargo test` repro using the same buffer-probe technique this doc opened with
("Validated: appsrc has no notion of direction"). It worked: **this bug reproduces in a
standalone unit test, with no MIDI controller, no live app, no ears involved.**

`pipeline.rs`'s `scratch_smoke_test::scratch_second_gesture_reverse_repro` does: load a
real file, forward scratch (gesture 1), full `stop_scratch()` teardown, then a *second*
scratch gesture at a negative rate (gesture 2) — the exact shape of the live report.
Three pad probes (same `PadProbeType::BUFFER` + amplitude check pattern as the original
appsrc-direction validation) are installed at:
1. `appsrc`'s own src pad — buffers actually leaving appsrc's internal queue.
2. `sel_scratch_pad` — input-selector's sink pad, after convert2/resample2/capsfilter2.
3. `input_selector`'s src pad — downstream of the active-pad switch.

**Result, sampled every 200ms across a 3-second gesture 2**: (1) and (2) track each
other exactly at every sample — proving convert2/resample2/capsfilter2 add no delay of
their own here (same input/output rate, pure pass-through) and the delay is *inside*
appsrc itself, between the feeder thread's `push_buffer()` call and appsrc's own task
actually emitting the buffer onto its src pad. A timing check added around
`push_buffer()` in `spawn_scratch_feeder` (warns above 50ms) never fired — each
individual call returns fast — so the feeder thread is not itself blocked; buffers are
being handed to appsrc promptly and queueing invisibly inside it.

**The observed pattern across many runs, directly analogous to mechanism 5's own
160ms–11.8s spread**: sometimes gesture 2 delivers smoothly from the first sample
(indistinguishable from gesture 1). Other times: a short trickle, then a plateau where
the cumulative buffer count doesn't move for several consecutive 200ms samples, then a
burst that dumps everything queued so far, then either smooth delivery resumes or
another plateau follows. **In the worst observed runs, all three probes stayed at zero
for the entire 3-second sampling window** — i.e. a full gesture's worth of scratch
audio, produced by a feeder thread that is running normally and pushing on schedule,
never once reaches even the first element of the shared downstream chain. This is a
byte-for-byte match of the original live report ("produced silence for its whole ~4s
duration") — not a coincidence; it's the same failure, just caught this time by a
probe with millisecond timestamps instead of a person's ears.

**Ruled out** by this data:
- **Not a direction/DSP bug.** Every buffer that does arrive is fully audible (never
  literally silent PCM) — confirmed by the `nonzero` counter, which always equals
  `total` at every probe. The fade/hold gain logic reviewed-but-not-verified in the
  previous section is fine; it was never the suspect once buffers are shown to simply
  not be arriving at all for a while.
- **Not an input-selector routing bug.** (2) and (3) track together throughout; when
  data does reach input-selector's sink pad, it comes straight out the src pad. The
  active-pad switch itself works.
- **Not specific to *reversing* from the prior gesture's direction.** Swapping the test
  to negative-then-negative (both gestures reverse) reproduced the identical stall
  with identical buffer counts. Swapping gesture 2 to positive (forward-then-forward)
  never reproduced it in repeated runs — smooth delivery every time, starting from the
  very first sample. **The trigger is specifically: a freshly spawned scratch feeder
  (a new gesture, not a live rate update on an existing one) whose initial rate is
  negative** — not "reversal," not "second gesture" in general.

**Confirmed to be a genuine timing race, not a deterministic defect** — three
independent signals:
1. The exact same test, unchanged, alternates between fully smooth and fully silent
   across consecutive runs (roughly half-and-half in this environment).
2. Wrapping the test binary in `strace -f` (even filtered to a handful of syscalls) or
   setting `GST_DEBUG` made the stall far less likely to reproduce across several
   tries — both perturb relative thread scheduling enough to dodge the race window,
   the classic heisenbug signature. (Contrast with mechanism 2/3's hangs, which were
   deterministic logic bugs findable by reading the code once known where to look —
   this one isn't; it had to be caught empirically and would resist a static reading
   no matter how careful.)
3. Stretching the gap between gesture 1's teardown finishing and gesture 2's `scratch()`
   call from 100ms to 2000ms measurably *reduced* the reproduction rate (roughly 60%
   down to 15–30% in a small sample) but did not eliminate it — consistent with a
   background GStreamer/PipeWire settling process that usually, but not always,
   finishes within a couple seconds of the previous gesture's teardown.

**Working theory, not yet proven**: this is very likely the *same underlying
instability* already tracked as mechanism 5 (the `resync_seek` stall on the *normal*
branch), just surfacing through a different call site — appsrc's own streaming task
here, instead of a `pipeline.seek_simple()` call there. Both are: (a) genuinely
intermittent with a similar order-of-magnitude delay range (hundreds of ms to multiple
seconds), (b) triggered by resuming/restarting a branch of this same pipeline shortly
after significant state churn (an input-selector switch, a flush, a state transition),
and (c) not attributable to this app's own Rust logic — the feeder thread's own pacing
and `push_buffer()` calls are confirmed fast in every run, stalled or not. Not proven
to share a root cause (that would need tracing inside GStreamer/PipeWire's own
scheduling, which this environment's blocked `ptrace`/limited `perf` symbol resolution
made impractical to pursue further this session — see mechanism 5's own tooling notes
above, which apply equally here), but the resemblance is strong enough that a future
fix attempt for one should be checked against the other's repro before being considered
complete.

**Why this matters going forward**: mechanism 5 previously required live MIDI hardware
and a lucky repro window to chase (the doc's own "next step" for it involved arming a
`wchan` sampler and hoping to catch an 11-second stall live). This test reproduces the
*same class* of stall on demand, headlessly, in about 4 seconds per attempt, at roughly
a 50% hit rate — a dramatically cheaper way to iterate on a fix or gather more evidence
(e.g. re-running under a `wchan` sampler is now a scripted loop instead of a live
session with a human on the jog wheel). Kept in the repo as
`scratch_second_gesture_reverse_repro` (`#[ignore]`d like the other hardware-touching
smoke tests — run explicitly with `cargo test scratch_second_gesture_reverse_repro --
--ignored --nocapture`). Its assertions are deliberately non-flaky where the underlying
behavior is flaky: it always checks that probes are wired correctly and that any
delivered audio is genuinely audible, but the "did gesture 2 deliver within 3 seconds"
assertion is *expected* to fail sometimes — a failure there **is** the bug reproducing,
documented as such in the test's own comments so a future reader doesn't mistake it for
a broken test.

**Not yet done**: an actual fix. Two directions worth trying in a future session, in
order of how much they risk touching already-hard-won logic:
1. **Mitigate**: if delaying the *next* scratch's start after a teardown reduces (per
   the 2s-gap experiment above) but doesn't eliminate the race, is there a cheap signal
   to poll for "the previous teardown's async work has actually settled" rather than a
   fixed sleep? Worth checking what GStreamer state/message would indicate this — an
   `ASYNC_DONE` on the pipeline bus after `stop_scratch_feeder()`'s resync seek would be
   the natural candidate, and this pipeline's bus-monitor thread already logs
   `async-done` events (visible in every test run's log above) — instrumenting exactly
   how long after `stop_scratch_feeder()` returns that async-done fires, and whether a
   *fast* async-done correlates with gesture 2 delivering smoothly, would either
   confirm or rule this out cheaply.
2. **Root-cause**: get real visibility into what appsrc's streaming task is doing
   during a stall. This session's tools (kernel `wchan` sampling, `strace`, `GST_DEBUG`)
   either perturbed the race away or didn't get run during an actual stall window in
   time (the wchan sampler in this session was armed but only showed the *idle* thread
   state, `futex_do_wait`, uninformative on its own — need it correlated tightly enough
   with the probe's own epoch-stamped output to know it's sampling during an active
   stall, not just generically "sometime during the test"). A tighter loop — spawn the
   wchan sampler from inside the same test process (a background Rust thread polling
   its own `/proc/self/task/*/wchan`, writing timestamps compatible with the probe's own
   `epoch=` lines) rather than an external shell script racing to attach — would remove
   the attach-timing uncertainty entirely.

## Seventh mechanism: root-caused via live `gdb` — `output_queue` backpressure,
## not a PipeWire/GStreamer scheduling mystery — found 2026-07-23, later same session

The previous section's blocker ("this environment's blocked `ptrace`/limited `perf`
symbol resolution") turned out to be a **self-inflicted testing mistake, not a real
restriction**. Re-verified from scratch this session: a process ptracing its own true
`fork()` child succeeds immediately (`PTRACE_SEIZE` → errno 0) on this machine. The
earlier "Operation not permitted" results came from attaching `strace`/`gdb` to a
**sibling** process (both spawned by the same interactive shell) — under this system's
default `yama.ptrace_scope=1`, only a direct **ancestor** may attach, and a separately
launched `strace`/`gdb` is never the parent of an independently-backgrounded target.
The fix is simply to launch the target *under* the tracer from the start (`gdb --args
<bin> ...` / `strace -f <bin> ...`), which makes the tracer the true parent and needs
no `sudo`/`sysctl` changes. (Attaching to an *already-running* arbitrary process, e.g.
the live app, still needs `sudo sysctl kernel.yama.ptrace_scope=0` — not required for
what this section did.) No seccomp, AppArmor, or container layer was ever involved.

With that unblocked, built `scripts/gdb-stall-catcher.py` (`pexpect`-driven): launches
`scratch_second_gesture_reverse_repro` under `gdb`, watches the interleaved stdout for
the test's own `sel_scratch_pad cumulative: total=NN` lines, and the instant two
consecutive 200ms samples report the same total (a stall in progress, live), sends
`Ctrl-C`, dumps `thread apply all bt` for every thread, resolves symbols for the
`appsrc0:src` thread's frames via `info symbol $pc` (accounts for ASLR automatically
since it's live), then `continue`s. Two gotchas hit along the way, both worth keeping
in mind for any future scripted `gdb` use against this codebase:
- **`gdb`'s debuginfod prompt hangs a scripted session** — first hit in an earlier
  session (see prior mechanism's mention of "the `DEBUGINFOD_URLS` gotcha"), hit again
  here. `gdb -iex "set debuginfod enabled off"` avoids the interactive y/n prompt.
- **A plain `strace -f`/unfiltered trace still perturbs the race** (confirmed again —
  one run under an unfiltered filtered-syscall `strace` this session hit a 60+ second
  stall on the *first* `Paused→Playing` transition, far outside anything seen
  untraced). `gdb` launched normally (no single-stepping, no syscall tracing — it only
  traps on breakpoints/signals) does **not** perturb the race; every `gdb`-launched run
  this session reproduced the stall at roughly the same ~50% rate and magnitude as
  untraced runs.

**First catch** (`gdb_run_1.log`): interrupted mid-stall (a full 3-second window with
zero buffers delivered — the worst-case "total silence" shape). The `appsrc0:src`
thread's backtrace: `g_cond_wait` ← unresolved frame in `libgstreamer-1.0.so.0` ←
unresolved frame in `libglib-2.0.so.0` ← `start_thread`. Initially read as "idle,
waiting for the next task" (a GLib thread-pool worker with nothing to do) — this
reading turned out to be wrong (see next catch) but is included here because it's
what a first glance at an unresolved `???` stack suggests, and the correction is the
actual lesson.

**Second and third catches** (`gdb_run_2.log`, `gdb_run_4.log`, both independent
stalls): a *materially different*, far more informative backtrace for the same named
thread:
```
#0  syscall ()
#1  g_cond_wait () — libglib-2.0.so.0                    (g_cond_wait + 77)
#2  ?? () — libgstcoreelements.so                         [unresolved, no exported symbol]
#3  ?? () — libgstreamer-1.0.so.0                         [unresolved: pad-chain dispatch]
#4  ?? () — libgstreamer-1.0.so.0                         [unresolved: pad-chain dispatch]
#5  gst_pad_push () — libgstreamer-1.0.so.0               (gst_pad_push + 132, resolved)
```
This is not an idle thread — it is **`appsrc`'s own streaming task thread, mid-call
inside `gst_pad_push()`**, several frames deep into the synchronous chain-function
dispatch that a push triggers, blocked on a condition variable **inside
`libgstcoreelements.so`** — the GStreamer plugin that implements `queue`,
`input-selector`, `tee`, and friends. `pipeline.rs`'s topology (confirmed by re-reading
the code, not guessed) is `input_selector → output_queue → tee`, and `output_queue` is
a stock `queue` element sized `max-size-time = 100_000_000` ns (100ms) with **buffers
and bytes limits both disabled** (`max-size-buffers = 0`, `max-size-bytes = 0`) — i.e.
purely time-bounded. `GstQueue`'s `chain()` function, when the queue is at its
configured limit, blocks the *pushing* thread on exactly this condition variable
(commonly referred to as its `item_add`/`not_full` cond) until its own downstream
consumption drains enough room. That consuming side is the queue's own streaming task
feeding `tee` → per-output `queue`+`volume` → `pipewiresink`, ultimately paced by
PipeWire's real-time pull cycle.

**This resolves the "why do probe (1) [appsrc's own src pad] and probe (2)
[`sel_scratch_pad`, input-selector's sink] always match exactly, both stuck at the same
count" mystery from the "Sixth mechanism" section above.** `GST_PAD_PROBE_TYPE_BUFFER`
probes fire synchronously, inline, as part of the single nested `gst_pad_push()` call —
`convert2`/`resample2`/`capsfilter2`/`input_selector` are pure pass-through with no
queuing of their own, so a push that gets far enough to reach `output_queue` has
*already* fired both probes on its way through, before hitting the block. The appsrc
task thread cannot start the *next* push (and thus cannot fire probe (1) again) until
the *current* one returns — so a block many frames downstream, on a single thread, is
sufficient to explain both probes freezing at an identical count for the whole stall,
with no need for any bug in input-selector's routing or in convert2/resample2's
pass-through behavior (both of which the "Sixth mechanism" section had already,
correctly, ruled out).

**Root cause, now grounded in an actual C-level stack instead of syscall-timing
inference**: this is **ordinary, intentional `GstQueue` backpressure** — the "silent
scratch" and "resync_seek stall" symptoms are the *expected*, by-design behavior of a
bounded queue whenever its consumer falls behind for hundreds of ms to a few seconds.
The open question is no longer "what is GStreamer/PipeWire secretly doing" but
narrower and far more tractable: **why does `output_queue`'s downstream drain
(ultimately `pipewiresink`'s pull cadence) fall behind specifically in the first
stretch after a fresh scratch gesture starts following a teardown+restart** (matches
every trigger condition already established: a *new* feeder, not a rate update on an
existing one; worse right after `input_selector`'s active-pad switch and the
`stop_scratch_feeder()` resync seek; the magnitude — hundreds of ms to low seconds —
matches PipeWire re-establishing its stream's RT cycle after a state-transition churn,
not a fixed per-push cost). Plausible next-session directions, none yet tried:
1. Add a pad probe (or `GST_DEBUG=GST_QUEUE:5` briefly, now that we know exactly which
   element to point it at) directly on `output_queue` to log its live fill level
   (current/max buffered time) across a captured stall — confirms it's actually at its
   100ms cap during the freeze rather than something adjacent.
2. Check whether `pipewiresink`'s pull cadence genuinely stalls or slows for the first
   several cycles after the `Paused→Playing` transition immediately preceding each
   scratch gesture (the async-done timing instrumentation proposed in the "Sixth
   mechanism" section's direction 1 is still the right first move, now aimed at a
   specific, confirmed target instead of a hypothesis).
3. If confirmed as a startup-latency effect of the sink rather than something fixable
   pipeline-side, consider whether `output_queue`'s 100ms cap (chosen for tempo-change
   latency, per this doc's earlier "PipeWire quantum" notes and `CLAUDE.md`) needs a
   larger allowance specifically in the moments right after a state transition, without
   regressing the tempo-change-lag reason it's capped at 100ms in the first place.

**Not yet done**: an actual fix — this session's scope was root-causing, not patching.
`scripts/gdb-stall-catcher.py` is kept in the repo so a future session can re-run this
cheaply (`python3 scripts/gdb-stall-catcher.py [--max-attempts N]`, ~50% hit rate,
~5s/attempt) to gather more evidence (e.g. add an `output_queue` fill-level probe to
the catcher's on-stall inspection block) before attempting a mitigation.

## Eighth mechanism: fix landed — widen `output_queue` for the gesture's
## duration, not on a timer — found/fixed 2026-07-24, same session continued

Picked up direction 3 from the "Seventh mechanism" list (give `output_queue` a
larger transient allowance) and turned it into an actual fix in `pipeline.rs`.

**First attempt (wrong) — narrow back on a fixed timer.** `scratch()` widened
`output_queue.max-size-time` from the steady 100ms to 2s right before the
`Paused→Playing` transition, then a spawned thread narrowed it back to 100ms
after a fixed `SCRATCH_STARTUP_GRACE_MS` (1500ms) grace period, guarded by an
epoch counter so a stale reset couldn't clobber a newer gesture. Rebuilding the
test binary and running `scratch_second_gesture_reverse_repro` untraced (no
`gdb`, matching real-world timing) gave a striking result: **every single run
(8/8) now stalled**, for a suspiciously consistent 1.2–1.4s, starting almost
exactly where the 1500ms grace timer would fire. A baseline comparison (same
test, cap held fixed at the steady 100ms — i.e. the fix disabled — 8 runs)
showed the *original* symptom: ~75% hit rate, stall length varying 800ms–2800ms.
The fixed version was *more* deterministic and *always* stalled — worse, not
better.

**Why**: narrowing a live `GstQueue`'s `max-size-time` while it's still holding
more buffered time than the *new* (lower) cap doesn't wait for the excess to
drain gracefully — the queue immediately re-evaluates against the new limit and
applies backpressure right then. At t≈1.5s into a gesture, `output_queue` was
still working through the real catch-up backlog (per the baseline data, that
backlog can run past 2.5s) — narrowing to 100ms mid-backlog just relocated the
block to the moment of narrowing, self-inflicting a deterministic stall where
an intermittent one used to be.

**Fix**: don't narrow on a timer at all. Widen `output_queue`'s cap to 2s when
a fresh scratch gesture starts (`scratch()`, only on the "no feeder yet" path —
cheap per-tick rate updates on an already-running gesture don't touch it), and
leave it widened for the gesture's entire duration. Narrow it back to the
steady 100ms only in `stop_scratch_feeder()`, once the gesture has actually
ended and the normal (uridecodebin) branch is about to become active again and
needs tight tempo-change latency. This removed the epoch/timer machinery
entirely — no thread spawn, no guard needed, since there's no longer a
delayed action that could race against a newer gesture.

**Verification**: rebuilt the test binary and ran `scratch_second_gesture_reverse_repro`
untraced, 25 times total (10 + 15 in two batches) — **0/25 stalls**, vs. ~75%
(6/8) on the disabled-cap baseline measured immediately before, same binary,
same environment. Also ran the full `cargo test --lib -- --ignored` suite
(`scratch_smoke`, `vinyl_hold_smoke`, `scratch_second_gesture_reverse_repro`)
and the non-ignored suite — all pass, no regressions.

**Why this doesn't reintroduce the tempo-change-lag problem** the 100ms cap
was originally chosen to avoid (see "PipeWire quantum" notes and `CLAUDE.md`):
that concern is specifically about *soundtouch tempo changes on the normal
branch*, which only happens during normal playback. `output_queue` is shared
by both branches (downstream of `input_selector`), but the normal branch is
always paused (`valve_normal` closed, `uridecodebin` state-locked) for the
entire time the cap is widened — there's no tempo change in flight to lag.

**Still not known** (unchanged from the Seventh mechanism section): *why*
`output_queue`'s downstream drain falls behind after a fresh
`Paused→Playing` transition in the first place — this fix absorbs the
consequence rather than eliminating the cause. If it resurfaces at a
magnitude beyond 2s (not observed in 25 runs, but the baseline did show up to
2.8s in only 8 runs), directions 1–2 from the Seventh mechanism section are
still the right next step. Not attempted this session: raising the cap
further or making it adaptive: 2s already fully closed the gap in this
session's testing and a larger fixed cap risks masking backlog growth that
would be better surfaced as a symptom of the still-unexplained root cause.

## Status (updated 2026-07-24, continued session)

Mechanism 4 (Svelte store-equality) is fixed and confirmed live across three
consecutive gestures — the JS main-thread freeze that motivated this whole
investigation is resolved. The "reverse scratch is silent" bug (mechanisms
5/6/7) is **root-caused and fixed** (see "Seventh" and "Eighth mechanism"
above): `output_queue` (the queue between `input_selector` and `tee`) now
widens its cap for the duration of a scratch gesture instead of holding a
steady 100ms cap throughout, avoiding the `GstQueue` backpressure that used to
block `appsrc`'s push thread during the post-restart catch-up window.
Confirmed via 25 untraced runs of `scratch_second_gesture_reverse_repro`
(0 stalls) against a same-session baseline of ~75% stalls with the cap fix
disabled. Not yet done: live-hardware confirmation with real MIDI jog-wheel
input (this session's verification was all headless/automated); understanding
*why* the drain lags in the first place, which remains open per the Seventh
mechanism section's queued directions.
