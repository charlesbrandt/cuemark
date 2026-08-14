# Waveform drag-scrub and position-mode scratch — 2026-08-08

Two requests that turned out to be one mechanism: dragging the waveform to dial in a cue
point with audible feedback, and stopping the MIDI vinyl jog from jumping around
erratically. Both are *direct manipulation* — the user physically moves something and the
track should follow — and both were previously impossible to serve because the scratch
feeder only accepted a **rate**.

## Why velocity was the wrong control variable

The PCM scratch feeder (`docs/design/pcm-buffer-playback.md`) walks a pre-decoded buffer at
a signed rate, which is exactly right for shuttle mode: spin the wheel, the deck free-runs
at that speed until told otherwise. Vinyl mode reused it, and `handler.ts` had to
manufacture a rate out of tick timing — an EMA of instantaneous ticks/sec.

That reconstruction cannot work for burst-delivered input, and both of this app's
direct-manipulation inputs are burst-delivered:

1. **Coalescing discarded motion.** `queueScratchRate` collapses everything arriving inside
   one rAF into a single call by overwriting. Coalescing a *rate* is lossy in a way
   coalescing a *position* is not — the ticks that were overwritten still happened on the
   wheel, and nothing downstream ever learns about them.
2. **The divisor was an artefact.** USB MIDI delivers several ticks in one JS macrotask and
   then a gap, so `now - prev.lastT` collapses onto the `SCRATCH_MIN_DT_MS = 4` floor and
   the computed rate saturates at the mode cap. The EMA (`SCRATCH_EMA_ALPHA = 0.4`) blends
   this down but cannot remove it — that trade-off is already documented at length in
   `handler.ts`, where a hard rolling window was tried first and abandoned for the same
   family of reasons.
3. **No absolute reference.** Distance travelled was the integral of an estimated rate over
   free-running time. Every over- and undershoot accumulated for the whole gesture with
   nothing to correct against.

There was a fourth, at gesture *boundaries*: `stop_scratch_feeder()` ends a gesture with a
130ms drain sleep and two flush seeks, and the next `scratch()` read `query_position()` for
its start frame. Precise cueing naturally means short nudges separated by pauses longer
than `SCRATCH_IDLE_MS` (500ms), so the teardown ran constantly — and any gesture starting
before that ACCURATE resync landed began from the *pre-gesture* position. The track jumped
backward between nudges.

## The fix: position mode

`ScratchFeeder` gained `target_frames_bits`, an absolute target in PCM-buffer frames, with
`f64::NAN` meaning "velocity mode" so shuttle is bit-for-bit unchanged. When a target is
set, the feeder derives each 15ms chunk's rate from the distance left to cover:

```
rate = clamp((target - cursor) / chunk_frames, ±SCRATCH_TARGET_MAX_RATE)
```

Pitch still bends with speed, because speed is still nothing but how fast the cursor walks
the buffer — position mode changes what sets the speed, not how sound is produced.

Three behaviours fall out of the target rather than out of a timer:

- **Arrival is silence.** `|err| < SCRATCH_TARGET_EPSILON_FRAMES` stops the cursor and fades
  `hold_gain` to zero, so a stationary finger or hand sounds like a stationary hand on a
  record. `hold_ms` remains only as a backstop against a caller that stops updating without
  calling stop.
- **Big moves snap.** `|err| > SCRATCH_TARGET_SNAP_SECS` sets `cursor = target` and re-ramps
  through `SCRATCH_FADE_FRAMES`. Without it a coarse whole-track overview drag (easily 100s
  in one gesture) would spend many seconds racing through content nobody asked to hear.
- **Direction is free.** The servo changes sign on its own; the existing `last_sign`
  reversal ramp needed no change.

`DeckAudioPipeline::last_scratch_frame` fixes the boundary jump: `stop_scratch_feeder()`
records where the cursor landed *before* the resync sleep, and a new gesture prefers it over
`query_position()`. `seek_output_domain()`, `load()` and `play()` clear it, so it can never
go stale in the other direction. `scratch_to_smoke` guards this by starting a second gesture
100ms after a stop — deliberately inside the resync window.

## Frontend

The scrub bus lives in `src/lib/renderer/seekBus.ts` rather than its own module: it is the
same kind of per-deck position registry as `audioTimes`/`pendingSeekTarget`, it needs
`setScratching`/`seekDeck`/`quantizeToGrid` from there, and a separate module would have
formed an import cycle with `getDeckTime`.

`beginScrub(deckId, anchorSecs, audible)` / `updateScrub` / `endScrub`. Notes:

- **`getDeckTime()` returns a live scrub target above everything else.** The position poll
  is a 140–190ms IPC round trip, so deferring to it during a drag would make the waveform
  visibly trail the pointer. The target is where the user *is*; the audio servo trails it
  slightly, which is what a record does.
- **`audible: false` is the playing-deck path.** Audible scrub needs the paused scratch
  topology (input-selector switch + frozen `uridecodebin`), so a playing deck routes
  updates to `seekDeck()` and keeps playing. Same for a file whose PCM decode failed —
  `audioScratchTo` rejects and the gesture degrades to a silent seek scrub rather than
  dropping input on the floor.
- **`endScrub` honours SNAP** via `quantizeToGrid`, the same treatment hot cues get. The
  extra seek is sequenced *after* `audioStopScratch` resolves, not raced against it — the
  stop performs its own flush seeks.

### The drag gesture (`WaveformCanvas.svelte`)

Press-anchored and relative. Pressing records the grab point and **moves nothing**, which is
what let the old `onclick` needle-drop be removed outright: a stray click can no longer jump
the track.

The direction rule is *whatever moves follows your finger*, which lands on opposite signs in
the two views because they animate opposite halves of the same picture:

| View | What moves | Mapping |
|---|---|---|
| Zoom | the waveform (playhead pinned at `ZOOM_LEAD_RATIO`) | `t = t0 - dx · secPerPx` — you are holding the record |
| Overview | the playhead (waveform is fixed) | `t = t0 + dx · secPerPx` |

`secondsPerPixel()` must keep matching `drawZoom`'s `contentSpan`
(`zoomSeconds × playbackRate`), or the waveform slides at a different rate than the pointer
and the grabbed peak drifts out from under it.

`pointermove`/`pointerup` are bound on `window`, not the canvas — the pointer routinely
leaves a 72px-tall canvas mid-gesture. `setPointerCapture` was avoided because nothing else
in this app exercises it on this WebKitGTK. The canvas needs `touch-action: none` or a
touch/pen drag is claimed as a pan and the move stream stops partway through.

✅ **Pointer Events are real for mouse input on this WebKitGTK — verified, not assumed**
(`scripts/probes/pointer_events_probe.py`, 2026-08-08). This project has been burned
repeatedly by APIs that are *present* here and silently do nothing (`UNPACK_FLIP_Y_WEBGL`
for `ImageBitmap`, `imageOrientation` for `VideoFrame`, `isConfigSupported` for AV1), so
the probe pushes GDK button/motion events into a real `WebKit2 4.1` webview — the same
platform → DOM path an X11 mouse takes — rather than settling for
`typeof PointerEvent === 'function'`. Result: `pointerdown`/`pointermove`/`pointerup` all
fire with `pointerType="mouse"`, coordinates tracking the injected positions,
`setPointerCapture` present.

⚠️ **WebKit coalesces motion events** — three injected moves arrived as two. Harmless here,
and for the same structural reason the rest of this design works: the target is absolute, so
a dropped intermediate position is simply superseded rather than lost. A velocity-based
drag would have silently under-travelled.

Scroll-wheel zoom was left in place: a wheel gesture and a pointer drag do not collide.

### Vinyl jog (`handler.ts`)

The vinyl branch of `jog_nudge` accumulates `target += a.value × VINYL_SEC_PER_TICK` and
routes it through the same scrub bus. `scratchVelocity`, `SCRATCH_EMA_ALPHA` and
`SCRATCH_MIN_DT_MS` no longer apply to it. Shuttle mode keeps all of them.

## 🔴 First live run, 2026-08-08 — two faults, both root-caused from the log

The first live session reported "reverse scrubbing does not play back any audio" and "the
video seems to jump ahead dramatically when using the jog wheel". Both were diagnosed from
`cuemark.log` alone; neither was a reverse-direction bug, and neither needed the controller
to reproduce.

The gesture in evidence: deck-0 paused at 11.86s, one vinyl jog gesture 15:08:36.8 →
15:08:43.9, feeder `mode=position` start frame 569368 → stop frame 506357. That is **1.31s
of content travelled in 6.6s of wall clock — a hand speed of 0.2×** — with zero
`push_buffer took …ms` warnings, so nothing was stalling. The servo tracked the wheel
correctly. It simply did it inaudibly.

### Fault 1 — the servo closed the whole error inside one chunk, so the scrub was a train of blips

`rate = err / chunk_frames` converges in exactly one 15ms chunk. The next chunk finds
`|err| < epsilon`, reports `arrived`, and fades `hold_gain` to zero. Position updates
arrive every ~25–40ms (rAF-coalesced pointer moves; jog bursts), so **half of all chunks
produced silence**, and the half that didn't ran at a third of normal pitch and was
gain-ramped up and down through `SCRATCH_FADE_FRAMES` on the way in and out. At 0.2× that
is not a scrub, it is a 30Hz gate over a very quiet signal — "plays no audio" is a fair
description of it. Nothing about this was direction-specific; reverse is simply the
direction that got reported.

**Fix**: `SCRATCH_SERVO_LAG_CHUNKS = 4.0` — spread the error over ~60ms instead of one
chunk, making the servo a first-order lag. The property that matters is that **a
first-order lag settles to its input's slope for a ramp input**, and a hand moving at a
steady speed is a ramp: the cursor ends up walking the buffer at exactly the hand's speed,
continuously, trailing by a constant `hand_speed × lag` (12ms of content at 0.2× —
inaudible). Continuous motion at the true speed is both the audible fix and the
pitch-correct one. `SCRATCH_TARGET_EPSILON_FRAMES` went 0.5 → 12 frames (¼ms) at the same
time: the approach is now asymptotic, and a half-frame epsilon left an audible exponential
tail running ~465ms after the hand stopped. 12 frames reaches silence in ~300ms, which
sounds like a record coming to rest.

⚠️ **`scratch_to_smoke` passed throughout, and would pass again on the broken code.** It
asserts the cursor *arrives* — and it did arrive, in one chunk, and then sat silent. The
defect was never in where the cursor ended up; it was in the shape of how it got there,
which is a property of the whole gesture rather than of any endpoint. The new
`servo_test` module tests exactly that: it replays a gesture at a given hand speed and
update cadence and asserts on **the fraction of chunks that produced no sound** and **the
mean speed the cursor actually walked at**. It is pure arithmetic — no GStreamer, no PCM
file, no hardware, no `#[ignore]` — because `servo_step()` was split out of the feeder
loop for it. Under the old constants `slow_scrub_is_not_mostly_silent` reports "servo went
silent for 50% of a steady 0.2x scrub"; the distance-based assertions still pass, which is
the whole lesson.

Also fixed here: `last_sign` was seeded from `initial_rate.signum()`, and `scratch_to()`
passes rate `0.0` — but **Rust's `0.0_f64.signum()` is `1.0`, not `0.0`**, so every reverse
gesture opened by "reversing" from a forward direction it never had. Harmless (one extra
5ms ramp) but it made reverse and forward structurally different for no reason. Position
mode now seeds `last_sign = 0.0`.

### Fault 2 — the video ran away because a paused deck decoded with no clock bound

`codecWorker.ts`'s decode-ahead gate read `if (playing && nextFeedIndex > 0 && …)`. On a
**paused** deck the clock bound therefore did not apply at all, and the only remaining
limit was `decodeQueueSize >= QUEUE_HIGH_WATER` (8) — while `pump()` is re-entered on every
`clock` message. A paused scratch polls position at rAF rate (the `deck.playing ||
scratching` branch in `App.svelte`'s `frame()`), so 30–60 pumps/second walked
`nextFeedIndex` forward through the file completely decoupled from `clockPos`.
`CodecPlayer` holds only `HELD_FRAMES = 2` newest frames by pts, so `getFrameForTime(t)`
found nothing at or before the scrub position, fell through to its `?? this.frames[0]`
guard, and presented a frame from wherever the decoder had got to — seconds ahead, and
always *ahead*, since `nextFeedIndex` only increases. Hence "jumps ahead dramatically".

**Fix**: drop `playing &&` from the gate. Catch-up after a seek is unaffected — those AUs
have `pts < clockPos`, so the gate passes them — and the `nextFeedIndex > 0` guard still
lets the first AU through so a frame is ready the instant playback starts. A paused deck
now stops decoding once it is `aheadSeconds()` ahead, which is what it should always have
done.

This was latent, not introduced by this work: a paused deck has always had
`playing === false`, but nothing drove its clock at rAF rate until scrubbing did.

⚠️ **Known limitation (as first shipped): reverse scrub video was coarse — and then found to
be worse than that, see "Reverse scrub video: fixed" below.** With the gate corrected, a
forward scrub tracks smoothly (the clock leads, decode follows within `aheadSeconds()`).
Backward, the held frames are all ahead of the clock and the only way to show the right
frame is a seek — which `setClock()` only issued once the clock had fallen
`BACKWARD_JUMP_SECONDS = 0.5` behind.

The "gdb backtrace deadlock" precedent cited here originally (`pcm-buffer-playback.md`,
"Ninth mechanism") does **not** apply to this path and should not be used to justify
avoiding frequent seeks on `CodecPlayer` — that deadlock is inside WebKitGTK's
`MediaPlayerPrivateGStreamer`, reached via `gst_element_send_event()` from a legacy
`<video>` element's `v.currentTime` write. `CodecPlayer.seek()` never touches a `<video>`
element or WebKit's internal GStreamer media pipeline at all — it's `VideoDecoder.reset()`
+ decode from the nearest keyframe, entirely inside WebCodecs
(`docs/design/webcodecs-video-path.md` already makes this "mechanism A cannot occur on the
codec path by construction" point for the same reason). The real constraint on seek
frequency here is decode cost (redecoding from a keyframe on every call), not a WebKitGTK
deadlock risk, and it's naturally bounded anyway: `setClock()` is driven by App.svelte's
position poll, which allows only one in-flight `audio_get_position` IPC per deck (~150-190ms
round trip, see the IPC latency baseline) — so seeks here can't exceed that cadence no
matter how low the threshold is set.

### Reverse scrub video (2026-08-09): the mechanism is understood; the obvious fix is a regression — REVERTED

**Why it shows nothing at all, which is worse than the "coarse" this doc claimed.**
`setClock()` unconditionally snaps its `lastClockPos` anchor to every incoming position,
*including backward ones under the threshold*. So the `contentPos < lastClockPos -
BACKWARD_JUMP_SECONDS` test only ever sees **one poll's worth of movement**, never a
gesture's accumulated travel. `setClock` is called once per resolved position poll
(~150-190ms, one in-flight IPC per deck), and the vinyl calibration above tops out at 0.92×
content speed — so a single poll step is at most ~0.16s, a third of the 0.5s threshold.
A sustained reverse jog is made *entirely* of sub-threshold steps, so it **never seeks at
all** and the picture freezes on whatever frame was showing when the reversal began. The
doc's "updates every 0.5s of content travel" described intended behaviour that the code
does not implement.

🔴 **The obvious fix — accumulate against a forward-only anchor, lower the threshold to
0.15s — was built, unit-tested, and is a live audio regression. Reverted 2026-08-09.**
User report: *"this seems to break some of the other work we had done to make the jog wheel
play more smoothly. Audio stops after short jogs."* **Do not re-apply it**, and do not
reach for a lower `BACKWARD_JUMP_SECONDS` as a standalone change.

**Why it breaks audio — the cost of a seek, not the seek policy.** `handleSeek()`
(`codecWorker.ts`) is `decoder.reset()` → reconfigure → `nextFeedIndex =
keyframeAuIndexAtOrBefore(target)` → `pump()`. That re-decodes **the whole GOP from the
nearest keyframe** every time, discarding all decoder state; frames before the target are
decoded and immediately closed by `dropBeforeUs`, so the work is spent and thrown away.
**There is no VA-API on this machine — every frame of that is software decode** (see
CLAUDE.md's re-verification). Making that fire every ~0.15s of travel puts a sustained
software-decode burst on the CPU for the whole gesture, which starves both the main thread
(→ pointer events and scrub-bus flushes stall → no new targets) and the GStreamer audio
threads. The servo then does exactly what it is designed to do with no new target:
`HandTracker` coasts for its 300ms / 50ms-of-content window, and then `arrived ⇒ silence`.
Short jogs are hit hardest because they cross the threshold once, mid-gesture, and the
resulting burst lands squarely inside the gesture. This is the same starvation shape as the
legacy `drawImage` finding in CLAUDE.md, reached by a different route.

⚠️ **This is the cost concern the "needs its own design, not a quick threshold change" note
above was really protecting** — the note attached that warning to the wrong reason (the
WebKitGTK deadlock, which genuinely does not apply here, see above). The deadlock rationale
was wrong *and* the conclusion was right, so correcting the rationale is not a licence to
make seeks cheap-and-frequent. Two independent things were being conflated.

📏 **Measured 2026-08-09, and it rules out every seek-per-scrub-step design: the GOP is
~250 frames.** `ffprobe` over the media cache's real library files — keyframe interval
**8.34s** (1920×1080 H.264, 29.97fps) and **10.0s** (1080×1080 H.264, 25fps). So an
arbitrary-position `handleSeek()` decodes **~125 frames on average, 250 worst case**, at
1080p, in software, and `dropBeforeUs` throws away everything before the target — the
average seek spends ~125 frames of decode to deliver one usable frame. Any policy that
issues one of those per scrub step is unaffordable no matter how the threshold is tuned.
Re-measure with `ffprobe -select_streams v:0 -show_entries frame=key_frame,pts_time` before
assuming a different library behaves better.

### ✅ Step 1 built 2026-08-09: the retained frame ring (`codecPlayer.ts`)

**Make short reverse moves need no seek at all**, rather than tuning when seeks fire.
`HELD_FRAMES = 2` was why *any* backward motion needed a seek: the main thread closed every
frame but the newest two the instant they arrived, so the frame a reverse jog wants was
decoded moments ago and then thrown away. The ring retains a recent window instead, serving
short reverse jogs — the exact reported gesture — straight from memory, with **zero** added
decode work, no `decoder.reset()`, and no competition with the audio threads. It is purely
"stop closing frames so eagerly".

This composes with the decode-ahead gate rather than fighting it: backward motion during a
scrub stops the decoder feeding on its own (`pts - clockPos > aheadSeconds()` breaks as
`clockPos` retreats), so nothing overwrites the window while the gesture reverses into it.

Sized by **byte budget, not frame count** (`heldFrameCapacity()`), so a 4K deck cannot
quietly multiply the memory: `FRAME_RING_BYTES = 48MB`, bounded to 2–32 frames. At 1080p
that is 16 frames ≈ 0.64s at 25fps; small frames earn a longer window. Caching a *whole*
GOP as raw frames is not an option at these GOP lengths — 250 × 3.1MB ≈ 775MB per deck.
`localStorage['cuemark:codecFrameRing']` overrides the count for live A/B without a
rebuild, since an HMR edit to this module remounts `App.svelte` and tears the deck down.
The chosen size is logged per deck at construction (`[codecPlayer:deck-N] frame ring: …`).

⚠️ **The risk to watch in live testing is decoder-pool stall, not memory.** A `VideoFrame`
holds a decoder buffer until `close()`, and `VideoDecoder` implementations recycle from a
bounded pool — retaining too many can stall decode outright (symptom: video stops updating
*forward*, and `[codecPlayer] first decoded frame` is followed by nothing). If that appears,
drop the ring via the localStorage override before assuming anything else is wrong; the
eviction path closes frames, so a leak would be a bug rather than the design. 32 is a
deliberately conservative cap for this reason.

Coverage (`codecPlayer.test.ts`, 8 tests): a 0.4s backward move returns the *exact* earlier
frame and issues no seek; the same move under a forced 2-frame ring returns a frame ahead of
the request (pinning the old behaviour); oldest-first eviction with every evicted frame
closed; byte-budget sizing incl. the 4K case; the 2-frame floor and 32 cap; `destroy()`
closes the ring; forward playback unchanged; a real past-threshold jump still seeks.

⏳ **Not yet live-verified.** Unit tests said nothing about the last regression either — the
gesture-shape cautions above apply, and the thing to listen for is that audio is *unchanged*
from the current known-good behaviour.

**Remaining two-tier policy** (steps 2-3, not built), which never pays a GOP walk mid-gesture:

| Reverse travel | Source | Decode cost |
|---|---|---|
| within the ring (~0.5-1s) | held frames, exact | **zero** |
| beyond the ring | seek to the nearest keyframe and show *only* that keyframe — `dropBeforeUs = null`, decode the single key AU, no walk to the exact target | **1 frame** per GOP boundary crossed |
| gesture end | one exact seek to settle the picture | ~125 frames, but once, and outside the gesture |

The middle tier is the key trick: it gives visible, regular motion during a long reverse
sweep (quantized to GOP boundaries, so every ~8-10s of content) for essentially nothing,
instead of exact-but-unaffordable. It needs a new worker message distinct from `seek` —
`handleSeek()`'s `dropBeforeUs` + `pump()` walk is precisely what must *not* run. The
gesture-end seek mirrors what the legacy path has always done (App.svelte: don't touch the
video clock until scratch ends, then one normal snap).

**Whatever is tried next must be measured against audio, not just looked at.** The unit
tests for the reverted version all passed and said nothing about the regression — the same
lesson `scratch_to_smoke` already taught this doc (Fault 1: it asserted the cursor arrived,
while the feature was inaudible). The gesture-shape cautions above apply: slow, smooth,
zoomed, and check `[scratch-tel]` for `arrived%`/`snaps` before blaming or crediting
anything.

## Live run 3 (2026-08-08) — the feeder is exonerated; the fault is downstream

Added `[scratch-tel/…]`, one line per second per gesture, because three rounds of fixes had
been shipped on inference and no existing signal could adjudicate "a few pops and then
nothing": the feeder logs only start/stop, `push_buffer` warns only above 50ms, and the
`output_queue underrun` counter fires **once per chunk by construction** here — 66.8/s
measured against a 66.7/s chunk rate, because a just-in-time feeder empties the queue on
every buffer. That counter cannot distinguish healthy from starved during a scratch and
should not be read as evidence either way.

`rms` is the field that settles it. It is measured on the bytes actually handed to appsrc,
after every gain stage, so it separates "the feeder is not making sound" from "the sound is
not reaching the speakers" — which are different investigations.

The verdict, over a 28-second gesture the user reported as silent after the first moment:

```
chunks=67 (67/s, late 0%) | rms=0.18379 (-14.7 dBFS) | arrived 0% snaps=0 ramps=0
                          | rate mean=0.754 max=1.469 | cursor 92.220s -> 92.978s (0.75x)
```

**Every line for 28 seconds looked like that**, in both directions, RMS between −9.6 and
−18.9 dBFS. The feeder is producing loud, continuous, correctly-tracking audio the whole
time the user hears nothing. It also confirms the three fixes above landed: `snaps=0`
(the anchor fix — every gesture used to open on a silent snap), `arrived 0%` (the servo
lag), `ramps=0` (the `signum` fix), `late 0%` (cadence is exact).

`scratch_second_gesture_reverse_repro`'s pad probes then clear the next stage: `appsrc_src`
and `sel_scratch_pad` track each other exactly, all buffers nonzero, no stall.

**So the fault is downstream of `input_selector`** — `output_queue → tee → volume → sinks`
— and nothing in this feature's own code is in that path. What is in it, from the same
log:

```
[audio/deck-0/0]   sink: pulsesink device=""                          → system default (PCM2902C)
[audio/deck-0/1]   sink: pulsesink device="…DJControl_Starlight…"     → the controller
[audio/deck-0-cue] sink: pulsesink device="…DJControl_Starlight…"     → the SAME device
```

Three `pulsesink`s on one deck, **two of them on the same physical device**, all cycling
Paused→Playing on every gesture. That is the exact configuration
`docs/design/audio-dropout-mid-playback.md` already has open ("~21s after headphone cue was
enabled on a USB controller carrying both the main and cue sinks"), and it is also a
sufficient explanation for the separately-reported clipping during **normal** playback —
with cue open, that device receives the deck twice, summed. Nothing in the scratch path can
cause a normal-playback artifact; nothing changed in this feature touches it.

**Next step is a configuration A/B, not more code**: one main output device, cue on a
different device from the mains, and re-test both symptoms. That is what separates a
cuemark bug from a device-routing one before any more code is written against a guess.

➡️ **The investigation continues in `docs/design/scratch-audio-downstream-delivery.md`** —
the evidence, the ruled-out table, how to read `[scratch-tel]`, and the 5-arm A/B protocol.
This feature's own code is exonerated by F1/F2 there; **do not fix anything in the feeder,
the servo, the scrub bus or the MIDI handler against the silence symptom.** It was already
fixed three times in those places by mistake in one session.

## ✅ Settled: `VINYL_SEC_PER_TICK` calibrated, and the encoder reports plain deltas

Measured live against the Starlight on 2026-08-08. **The load-bearing question is answered:
the encoder reports ±1 deltas, not speed-scaled steps**, so accumulating ticks into an
absolute target is exact and this design is correct as built.

| Arm | msgs | over | rate | `maxAbs` | `values` | `1.8 / absSum` |
|---|---|---|---|---|---|---|
| One revolution, slow | 248 | 6.06s | 41/s | 1 | `[1]` | 0.00726 |
| One revolution, fast | 276 | 2.11s | 131/s | 1 | `[1]` | 0.00652 |

`maxAbs = 1` across all 524 messages is what settles it, and it settles it **independently
of the two totals agreeing** — which is why the instrumentation reports it. That matters,
because the totals *don't* agree: 248 vs 276 is an 11% spread. But speed-scaling would have
shown up as larger values at 3× the speed, and every single message was ±1. An 11% spread
is what judging "exactly one revolution" by hand looks like, nothing more. (The fast arm is
also *higher*, so nothing was dropped at 131 msg/s.)

**Chosen: 256 ticks/revolution → `VINYL_SEC_PER_TICK = 1.8 / 256 = 0.00703`.** It is
bracketed by both measurements (−3.1% / +7.8%), it is a common encoder resolution, and it
is well inside the hand-judgment error that is the only thing the spread measures. The
alternative (the measured mean, 262) differs by 2.3%, which is imperceptible for
cue-hunting either way — this is not a number worth more measurement.

This also **refutes** the suspicion recorded on `SCRATCH_MODE_PARAMS.shuttle` ("the
Hercules encoder appears to report larger step values… as physical speed increases"),
which is corrected in place. If shuttle mode saturates early, the cause is the EMA divisor
collapsing onto `SCRATCH_MIN_DT_MS` under burst delivery — the documented reason velocity
was abandoned for vinyl in the first place — not the encoder.

**Sanity-check against the rest of the design**, using the calibrated constant: the fast arm
is 131 ticks/s × 0.00703 = **0.92× content speed**, the slow arm **0.29×**. Both sit far
below `SCRATCH_TARGET_MAX_RATE` (8.0), and a single rAF flush at the fast rate moves the
target ~0.016s — 30× below `SCRATCH_TARGET_SNAP_SECS` (0.5), so ordinary jogging never
trips the snap path. Steady-state servo error is `speed × lag` = 2650 frames fast / 835
slow, both far above `SCRATCH_TARGET_EPSILON_FRAMES` (12), so neither speed can spuriously
read as "arrived" and go silent.

🔴 **Do not measure this from the Rust MIDI log.** `midi.rs` throttles continuous controls
to **one log line per 500ms per key** (its `log_throttle` map; buttons are exempt). A jog
wheel therefore appears in `cuemark.log` as a tidy `value: -1.0` every ~505ms no matter how
fast it is actually spinning — the 2026-08-08 session's log shows 13 messages for a gesture
that moved 292 ticks. Summing those would have produced a constant ~22× too large and it
would have looked perfectly consistent.

Instrumentation added instead (`vinylTally` in `handler.ts`): one unthrottled line per
gesture, on the frontend side of the IPC, logged when the gesture ends —

```
[jog-cal/deck-0] msgs=… absSum=… net=… maxAbs=… values=[…] over …s (… msg/s) |
                 if this was exactly one revolution, VINYL_SEC_PER_TICK = 0.00…
```

**Procedure** (needs the controller plugged in *before* the app launches):

1. Pause a loaded deck, set scratch mode to vinyl, and `tail -f` the log.
2. Rotate one wheel exactly one revolution **slowly**, then lift off and let the gesture
   end. Record `absSum`.
3. Repeat **quickly**.
4. Equal `absSum` ⇒ reading one, accumulation is exact; take the printed
   `VINYL_SEC_PER_TICK`. Unequal ⇒ reading two; the constant alone cannot be right and
   this doc needs revisiting before the jog fix ships.

`maxAbs` and `values` answer the same question a second way in a single pass: an encoder
reporting plain deltas since the last message never emits anything but ±1, so `maxAbs > 1`
settles it immediately without needing the slow/fast comparison to come out cleanly.

## Verification status

| Check | Status |
|---|---|
| `cargo check`, `cargo test --no-run` | ✅ clean |
| `scratch_to_smoke` (new — convergence, hold, gesture-boundary continuity) | ✅ converged 0.260→0.460s, held, resumed to 0.560s across a boundary — ⚠️ passed while the feature was inaudible; see Fault 1 |
| `servo_test` (new — silent-chunk fraction, tracked speed, reverse symmetry, decay-to-silence) | ✅ 5 tests; `slow_scrub_is_not_mostly_silent` reports "silent for 50%" under the pre-fix constants |
| `vinyl_hold_smoke` (velocity-mode regression guard) | ✅ 0.045s drift in a 200ms gap |
| `npm run check` | ✅ 238 files, 0 errors |
| `npm test` | ✅ 34 tests |
| `scripts/probes/pointer_events_probe.py` (new — Pointer Events for real mouse input) | ✅ GDK mouse → pointerdown/move/up, `pointerType=mouse`; `stale` arm ✅ `timeStamp` is platform-derived (+250ms backdate → +250ms stamp shift), on an origin offset by a per-page-load constant |
| `scrubStats.test.ts` (new — delivery-leg attribution) | ✅ 12 tests; a stall injected into one leg appears in that leg and nowhere else |
| Live: delivery instrument against the chatter/wobble symptom | ✅ run 2026-08-08 (night 2) — delivery, rAF and IPC all exonerated; the dropouts are the designed `arrived ⇒ silence` fade firing during the sparse input a slow hand produces. Gentle drag drops out, hard drag is continuous — the **opposite** dependence from the session-3 sink fault |
| Fix: coast instead of mute while a gesture is live (`HandTracker`) | ✅ built **and live-verified** 2026-08-08 — **19.7% muted → 0.0%** on a bursty 0.28× hand, A/B'd by disabling it; 11 `servo_test` arms + `scratch_to_smoke`/`vinyl_hold_smoke` on the real pipeline. User: *"the audio stays playing the whole time that an action is happening (in both directions)… slightly wobbly, but I'll take that"* |
| Live run 1 (2026-08-08): vinyl jog | 🔴 found Faults 1 and 2 above; both fixed |
| Live run 2 (2026-08-08): vinyl jog, forward, two speeds | ✅ motion tracks the wheel; no video jump (Fault 2 confirmed fixed) — ⚠️ **audio not listened to** |
| Live run 3 (2026-08-08): vinyl jog, both directions, listened | 🔴 audio starts then dies for the whole gesture — but `[scratch-tel]` shows the feeder healthy throughout, so the fault is downstream (see above) |
| Regression: waveform click-to-seek | 🔴 removed by this work, restored 2026-08-08 with `DRAG_THRESHOLD_PX` — a relative drag reaches only one canvas width (±16s in zoom), and the deck position bar is a display-only `<div>`, so the overview click was the only way to jump anywhere in a track |
| Live: `VINYL_SEC_PER_TICK` calibration | ✅ ±1 deltas confirmed; `1.8 / 256` |
| Live: vinyl jog **audio** (Fault 1 fix), incl. reverse | 🔴 audio starts then dies — the downstream fault, not this feature (see below) |
| Live: vinyl jog across pauses > `SCRATCH_IDLE_MS` | ⏳ not yet run |
| Reverse scrub video fix (`codecPlayer.ts` anchor + threshold, 2026-08-09) | 🔴 **reverted** — unit tests passed, live audio regressed ("audio stops after short jogs"). Seek cost, not seek policy; see above |
| Reverse scrub step 1 — retained frame ring (`codecPlayer.ts`, 2026-08-09) | ✅ `codecPlayer.test.ts` (8 tests), `npm test` 54, `npm run check` 0 errors — ⏳ not yet live-verified; watch for decoder-pool stall and confirm audio is *unchanged* |
| Live: waveform drag, paused (audible) | 🔴 run 2026-08-08 evening — **the servo and the drag gesture are correct**; audio dies mid-gesture from the same downstream fault |
| Live: waveform drag, playing (silent seek follow) | ⏳ not yet run |

## Live run 4 (2026-08-08, evening) — the drag gesture itself is verified good

The waveform drag was run as arm A4 of `scratch-audio-downstream-delivery.md`'s A/B,
deliberately in place of the jog wheel so the controller was uninvolved in every respect
including MIDI. **It reproduces the silence identically**, which is itself a result: the
fault is not in `handler.ts`, not in MIDI delivery, and not in the jog path.

Everything this feature owns measured correct through an 18.7-second gesture — `snaps=0`,
`arrived 0%`, `late 0%`, rms −12 to −19 dBFS continuously, cursor tracking the pointer.
The drag mapping, the servo lag, the anchor fix and the `signum` fix are all confirmed
working live. What is broken is downstream of everything in this doc.

⚠️ **Two gesture-shape notes for anyone testing this by hand**, both of which cost time:

- **Use the zoomed view, slowly.** A coarse overview drag runs at 5–10× content speed,
  which legitimately saturates `SCRATCH_TARGET_MAX_RATE` and snaps — and snapping is
  *designed* silence. Such a gesture cannot distinguish the fault from correct behaviour.
- **`arrived%` is designed silence too.** A hand that slows to a stop reports `arrived
  20–46%` and fades out on purpose; that is the feature working. The diagnostic gesture is
  one that holds `arrived 0% snaps=0` — and the fault shows up there too.

The distinguishing observation, which is what took the investigation out of this feature
for good: **the silence never recovers inside a gesture, and a new gesture is immediately
audible again.** A designed fade recovers as soon as the hand moves again. This does not.

Watch `~/.local/share/com.cuemark.app/logs/cuemark.log` during live runs for
`appsrc push_buffer took …ms` warnings and matched `[scratch/…] feeder start … mode=position`
/ `feeder stop` pairs — the servo pushes on the same 15ms cadence as velocity mode, so a new
stall would surface there.

## Live run 5 (2026-08-08, night) — downstream fault closed; a new one found upstream

**The downstream silence this feature was blocked behind is fixed and verified**, so the
"what is broken is downstream of everything in this doc" note above is resolved. It was
`GstAudioBaseSink` resyncing its ringbuffer write pointer ~253ms backwards mid-gesture
after `discont-wait` expired; widening the sink's alignment tolerance for the duration of
a gesture fixes it. A 16s smooth drag now runs continuously with no dropouts, user-
confirmed. Full account: `docs/design/scratch-audio-downstream-delivery.md`.

**What replaced it is a fault this doc does own.** With the sink fixed, two audible
symptoms remain — chatter on hard gestures, speed wobble on smooth ones — and both trace
to **target delivery stalling for 500–874ms in the middle of a gesture the hand is still
moving through**. The servo then has no new information: it converges on the stale target,
parks (silence), and sprints when the next burst finally lands (wobble).

Measured cadence, which is new information for this doc — `[scratch-tel]` now reports
`targets N/s gap p50/p90/max`:

| | this doc's assumption | measured |
|---|---|---|
| update rate | ~60/s (rAF) | **11–45/s** |
| gap p50 | 25–40ms | 17–**105**ms |
| gap p90 | — | **33–163ms** |
| gap max | — | **65–874ms** |

⚠️ **`SCRATCH_SERVO_LAG_CHUNKS`'s justification is stale in one specific way**: its "no
realistic update cadence can outrun it" is true — a steady 0.2× hand at 160ms updates
produces 0% silent chunks in `servo_test::replay` — but the value was justified against a
cadence figure that was never measured and is wrong. The lag is fine; the *stalls* are the
problem, and no lag setting addresses them (an adaptive lag was built and reverted; see the
other doc's "Adaptive lag: implemented, measured, reverted").

**Next step is a frontend-side instrument, not a servo change.** The gap is currently
timed where the call lands in Rust, which cannot separate "no pointer event fired" from
"pointer event fired and the IPC took 800ms". Those have opposite fixes. Candidates:
WebKit pointer coalescing/stall on the canvas (`scripts/probes/pointer_events_probe.py`),
throttling in this doc's own scrub bus, or main-thread IPC backpressure (`[ipc-ping]` is
the standing control arm).

## ✅ The instrument is built (2026-08-08) — `src/lib/audio/scrubStats.ts`

Legs: `evQueue` (device → JS handler) / `rafWait` (input → bus flush) / `dispatchLag`
(newest input → the value actually sent) / `ipc` (invoke → settled), plus input gaps,
coalescing counts and a per-second breakdown on `[scratch-tel]`'s cadence so the two
streams join. Emitted once per gesture, buffered until the end — `debugLog` is an
`invoke()` on the bridge under measurement. How to read each shape, and the reading
procedure, are in `scratch-audio-downstream-delivery.md`'s "The frontend instrument is
built"; the leg-attribution guarantee is pinned by `src/lib/audio/scrubStats.test.ts`.

✅ **Run 2026-08-08 (night 2), and it exonerates every part of the delivery path — including
this doc's own scrub bus.** Two drags, gentle and hard, zoom view. `rafWait` max 129ms and
**13ms in the worst second**; `ipc` max 48–80ms. ⚠️ The suspicion recorded here first — that
`updateScrub`'s rAF coalescing was the ceiling, because 11–45 targets/s matched this
machine's 9–57fps — **was wrong, and the numerical match was a coincidence.** The
coalescing does cost cadence (`sent` 25/s against `in` 31/s) but it is not the stall. Do not
re-derive that hypothesis.

**The stall is that no pointer events were produced**: in both muted seconds the event that
ended the gap carried `evQueue` of 4ms and 10ms — freshly stamped, not delayed. And the
mute itself is this feature's own designed behaviour: `arrived%` tracks hand speed inversely
and exactly (≤0.35× → 15–45% muted, ≥0.96× → 0% for eleven straight seconds), because a slow
hand delivers 5–12 events/s at ~2.3px each, and between events the servo converges inside
`SCRATCH_TARGET_EPSILON_FRAMES` and fades. So the remaining fault **is** in this doc's
territory after all, in the envelope rather than in delivery: `arrived ⇒ silence` is wrong
for precisely the gesture the feature exists for. Fix, evidence table and the reason it is
*not* the reverted adaptive lag: `scratch-audio-downstream-delivery.md`, "RUN 2026-08-08
(night 2)".

### The coast (`HandTracker`, built 2026-08-08)

A platter has mass. When the hand stops feeding it motion it does not stop dead, and that is
both the audible fix and the honest physical model. Implemented as a **tapered extrapolation
of the target** rather than a change to the servo: `servo_step` stays a pure first-order lag
onto whatever it is aimed at, and `HandTracker` decides what that is — the real target while
updates arrive, an extrapolation along the estimated hand speed while they do not, tapering to
a standstill over 300ms and capped at 50ms of content.

**Why estimating a velocity here does not contradict this doc's opening argument.** Velocity is
not the control variable; position still is. Every real target re-anchors the cursor
absolutely, so an estimate error cannot accumulate across a gesture, and its only effect is a
bounded extrapolation that the next target corrects. The old velocity path had neither the
bound nor the correction — that is the whole difference.

✅ **Live-verified 2026-08-08 (night 2).** Continuous audio for the whole gesture in both
directions, gentle and hard. **Residual: mild speed wobble, accepted by the user.** That is
the dead-reckoning overshoot — when a hand slows, the coast has already extrapolated past
where it stopped and the next real target pulls the cursor back. It is bounded by
`SCRATCH_COAST_MAX_FRAMES` (50ms of content) and the levers if it ever becomes annoying are
that cap and `SCRATCH_COAST_CHUNKS`, in that order. Do not reach for
`SCRATCH_SERVO_LAG_CHUNKS` — it was already shown not to be the mechanism, and an adaptive
version of it was built and reverted.

⚠️ The window is deliberately too short to bridge the measured 1180ms gap. Covering that would
make it a flywheel, and a hand that crosses no pixel for 1.2s has genuinely stopped — a held
record is silent. `long_input_gap_still_comes_to_rest` pins that from the other side, so the
pair of tests fails if the window is moved in either direction.

Two changes on the measured path came with it:

- `WaveformCanvas` no longer calls `getBoundingClientRect()` per `pointermove` — that forces
  a synchronous layout flush inside the handler whose latency is being timed, on a main
  thread simultaneously running `frame()`, an rAF-rate position poll and this canvas's own
  redraw. The rect is captured once at `pointerdown` (`dragRect`); a canvas cannot move or
  resize mid-press in any real gesture.
- `noteScrubInput` is the first statement of the pointer handler, ahead of the
  `DRAG_THRESHOLD_PX` guard: the sub-threshold events are still *delivery* evidence even
  though they deliberately send nothing.

---

## Platter mass: the scratch sounded frantic (2026-08-14)

🟢 **Built 2026-08-14.** User report: *"the scrub / scratch effect … sounds almost frantic in
the way the sound responds to midi events. I would like it to sound smoother like vinyl might
sound as you move the record faster and slower."* — against a feature that otherwise worked,
so the requirement was explicitly to smooth it **without** breaking any of the above.

### The mechanism: a jog wheel delivers an impulse train, not a hand

Everything above models the input as a *continuously moving hand, sampled at awkward times* —
which is what a pointer drag is. A jog wheel is not that. It delivers **detents**: one fixed
`VINYL_SEC_PER_TICK` (1.8/256 = 7.0ms of content) at a time, and nothing in between.

At the 0.10–0.26x speeds sustained cueing actually runs at (measured 2026-08-10, see
`jogSecondsPerRev`), that means:

| | at 0.15x |
|---|---|
| one detent | 338 frames = 7.0ms of content |
| cursor travel per 15ms chunk | 108 frames |
| **so the target jumps** | **3.1 chunks' worth of travel, at once, every 47ms** |

`servo_step` is a first-order lag, so it answers each jump with a rate spike that decays over
`SCRATCH_SERVO_LAG_CHUNKS`. The commanded rate was therefore a **~21Hz sawtooth whose peaks
were about twice its own mean** — i.e. the pitch was being modulated by roughly an octave at
the detent rate. That is the "frantic" sound, and it is not a defect in any one component:
every part was doing exactly what it was designed to do.

**It was already visible in the instrumentation and had never been named.** The live
`[scratch-tel]` of 2026-08-08 shows `rate mean=1.026 max=1.424` inside a single second of a
steady 1.03x gesture — a 38% excursion at the *smoothest* end of the range. And
`target_gaps_ms`'s own doc comment records "swings instantaneous rate 3–6× above its
one-second mean" as evidence for a *different* question (the update cadence) without ever
connecting it to what a listener would hear.

### The fix: give the platter mass

A one-pole lag on the servo's commanded rate, applied **per output frame** (not per chunk — a
chunk-rate filter would still step the pitch 66.7 times a second, just by less each time),
before it is used to advance the cursor. `SCRATCH_RATE_INERTIA_MS`, default 40ms, exposed as
**Settings → Audio → Platter** and sent along with every `scratch_to` call so it can be moved
mid-gesture and judged by ear.

**Why this is the platter and not just a filter.** It smooths the *velocity*, never the
position: the servo still chases an absolute target, so nothing here can drift or accumulate,
and the steady-state speed is provably unchanged (a first-order lag tracks a ramp at the
input's slope — the same argument that justifies `SCRATCH_SERVO_LAG_CHUNKS`). All it says is
that the cursor's speed cannot change instantaneously, which is what a mass does and exactly
what the impulse train is missing. Real vinyl is smooth under a jerky hand for this reason.

Measured on the replay harness, at 0.15x, against the total position lag it costs:

| inertia | total lag | jerk | improvement |
|---|---|---|---|
| 0 (old) | 60ms | 0.173 | — |
| 20ms | 80ms | 0.069 | 2.5× |
| **40ms (default)** | **120ms** | **0.029** | **6×** |
| 90ms (max) | 270ms | 0.008 | 22× |

⚠️ **The trade is smoothness against immediacy and there is no free value**, which is why it
is a setting. The return flattens well before the lag does.

### Three things this broke on the way in, all found by measurement

Each was invisible to the change itself and caught only because the servo tests replay whole
gestures rather than single steps. All three are pinned by tests now.

1. **Arrival stopped meaning "at rest".** `SCRATCH_TARGET_EPSILON_FRAMES` is 0.25ms wide, and
   a platter with momentum sweeps through a band that narrow in one chunk — so `arrived` fired
   on a *pass-through*, muting a chunk in the middle of motion the user was still hearing.
   **0% muted without inertia, 9% with it** on the 2026-08-08 sparse-drag schedule: the
   "gentle drag drops out" bug, walking back in through the smoothing. Arrival now requires
   the platter to have slowed as well as the cursor to be close — which is what the words
   already meant. False by construction at inertia 0, so the kill switch stays exact.

2. **A fast drag started snapping.** A first-order servo sustains a standing error of
   `hand_speed × lag`, and `SCRATCH_TARGET_SNAP_SECS` was a *fixed* 0.5s. Widening the lag
   walks that standing error into the threshold, and the gesture collapses into
   snap-mute-snap: **78% of chunks silent, cursor travelling at 0.001x.** Latent since the
   beginning — at the fixed 4-chunk lag the standing error at the servo's own 8x ceiling is
   0.48s, clearing 0.5s by 4% — and turning the lag into a user-facing knob is what walked it
   through. `snap_frames()` now scales with the lag, so a threshold that a legitimate steady
   gesture can reach is no longer expressible.

3. **The knob was not monotone at large values.** The rate filter is a second pole *inside*
   the servo's feedback loop, so at a fixed lag a large inertia makes the loop underdamped:
   the platter rings past the target, and every zero crossing is a direction reversal the
   feeder answers with a 5ms gain ramp — i.e. the "2–8 `ramps` per second" artefact of
   2026-08-09, rebuilt from a different direction. `servo_lag_chunks()` holds the lag at ≥2×
   the inertia, which keeps the damping ratio near 0.7 across the whole range, so turning the
   knob up can only make the gesture smoother, never rougher.

`SCRATCH_RATE_INERTIA_MAX_MS = 90` is where spin-down after a stopped hand (measured 900ms)
would otherwise start racing the frontend's own `SCRUB_HOLD_MS` (1000ms) to end the gesture.

### Instrument

`[scratch-tel]` gained `jerk=` — mean chunk-to-chunk change in playback speed as a fraction of
the mean speed, i.e. the frantic-ness as a number — alongside the resolved `inertia` and
`lag`. Read it against `rate mean`: two gestures at the same mean speed and very different
`jerk` are the smooth one and the rough one. ~0.17 is the old behaviour at cueing speed,
~0.03 the shipping default.

### Not verified live yet

Everything above is simulation and unit-level replay of the real chain. The numbers are
predictions; **the setting is a taste control and the default is a guess at someone else's
taste.** Expect to move the slider.
