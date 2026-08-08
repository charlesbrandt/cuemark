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

⚠️ **Known limitation, not fixed: reverse scrub video is coarse.** With the gate corrected,
a forward scrub tracks smoothly (the clock leads, decode follows within `aheadSeconds()`).
Backward, the held frames are all ahead of the clock and the only way to show the right
frame is a seek — which `setClock()` only issues once the clock has fallen
`BACKWARD_JUMP_SECONDS = 0.5` behind. So a reverse scrub updates the picture every 0.5s of
content travel and freezes in between. Audio, the actual cueing signal, is exact throughout.
Making this smooth means a scrub-aware seek policy in `CodecPlayer`, and a per-rAF seek on
a 4K H.264 stream is exactly the call a live `gdb` backtrace once caught WebKitGTK
deadlocked inside (`pcm-buffer-playback.md`, "Ninth mechanism") — so it needs its own
design, not a quick threshold change.

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
| `scripts/probes/pointer_events_probe.py` (new — Pointer Events for real mouse input) | ✅ GDK mouse → pointerdown/move/up, `pointerType=mouse` |
| Live run 1 (2026-08-08): vinyl jog | 🔴 found Faults 1 and 2 above; both fixed |
| Live run 2 (2026-08-08): vinyl jog, forward, two speeds | ✅ motion tracks the wheel; no video jump (Fault 2 confirmed fixed) — ⚠️ **audio not listened to** |
| Live run 3 (2026-08-08): vinyl jog, both directions, listened | 🔴 audio starts then dies for the whole gesture — but `[scratch-tel]` shows the feeder healthy throughout, so the fault is downstream (see above) |
| Regression: waveform click-to-seek | 🔴 removed by this work, restored 2026-08-08 with `DRAG_THRESHOLD_PX` — a relative drag reaches only one canvas width (±16s in zoom), and the deck position bar is a display-only `<div>`, so the overview click was the only way to jump anywhere in a track |
| Live: `VINYL_SEC_PER_TICK` calibration | ✅ ±1 deltas confirmed; `1.8 / 256` |
| Live: vinyl jog **audio** (Fault 1 fix), incl. reverse | ⏳ the open gate — run 2 was watched, not heard |
| Live: vinyl jog across pauses > `SCRATCH_IDLE_MS` | ⏳ not yet run |
| Live: waveform drag, paused (audible) | ⏳ not yet run |
| Live: waveform drag, playing (silent seek follow) | ⏳ not yet run |

Watch `~/.local/share/com.cuemark.app/logs/cuemark.log` during live runs for
`appsrc push_buffer took …ms` warnings and matched `[scratch/…] feeder start … mode=position`
/ `feeder stop` pairs — the servo pushes on the same 15ms cadence as velocity mode, so a new
stall would surface there.
