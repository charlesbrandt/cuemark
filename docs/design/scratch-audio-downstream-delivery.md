# Scratch audio reaches GStreamer and never reaches the speakers — 2026-08-08

**🟢 CLOSED 2026-08-08 (night) — root-caused, fixed, and verified live.**
`GstAudioBaseSink` gave up masking the feeder's accumulated lateness after `discont-wait`
(1s) and resynced its ringbuffer write pointer ~253ms *backwards*, behind the read
pointer, so every subsequent buffer landed in already-played segments (F10). Widening
`alignment-threshold`/`discont-wait` for the duration of a gesture fixes it: a 16s smooth
gesture ran at a **sustained −55ms of lateness** — continuously past the old 40ms
threshold, i.e. the death condition itself — with **zero** discontinuity WARNs, and the
user confirms continuous audio with no dropouts.

**Two separate faults remain, neither of them this one, both in the feeder's servo and
envelope rather than downstream.** See "The remaining fault" below. Do not reopen this doc
for them.

The original short version, still true: **the PCM scratch feeder is producing loud,
continuous, correct audio for the entire duration of a gesture the user hears as silent.**

This doc exists because the same fault was chased three times in one session by inference
and fixed three times in the wrong place. Do not add code against a guess here. The
instruments below exist so each step can be a measurement.

## Provenance

**Session 1, 2026-08-08 (afternoon)** — live on the real machine with the Hercules
Starlight attached. Three live runs against `docs/design/waveform-scrub.md`'s vinyl-jog
gate. Runs 1 and 2 found real defects in the scratch feeder (all fixed, all confirmed
fixed by the telemetry below). Run 3 is the one this doc was opened about: with those
defects gone, the audio still dies.

Log: `~/.local/share/com.cuemark.app/logs/cuemark.log`, gestures at 16:01:12–16:01:39 and
16:02:24–16:02:25.

**Session 2, 2026-08-08 (evening)** — ran the A/B below to completion, found and fixed a
UI bug that had been silently preventing arm A4 from ever being reached, and added the
delivery instrument this doc had specified as the next one to build. Same machine, same
build lineage (`c14035c`), waveform drag rather than the jog wheel so the controller is
uninvolved in every respect including MIDI. Log: same file, `18:52`–`19:17`.

## What is established

**F1 — the feeder is healthy for the whole gesture.** `[scratch-tel/…]`, one line per
second, over 28 seconds the user reported as silent after the first moment:

```
chunks=67 (67/s, late 0%) | rms=0.18379 (-14.7 dBFS) | arrived 0% snaps=0 ramps=0
                          | rate mean=0.754 max=1.469 | cursor 92.220s -> 92.978s (0.75x)
```

Every line looked like that. RMS −9.6 to −18.9 dBFS throughout, both directions,
cadence exact. `rms` is measured on the bytes actually handed to `appsrc`, **after every
gain stage**, so it is not an assertion about intent — it is the signal.

**F2 — `appsrc → input_selector` delivers everything.** `scratch_second_gesture_reverse_repro`'s
three pad probes: `appsrc_src` and `sel_scratch_pad` track each other exactly at every
200ms sample, `nonzero == total` at every probe, no stall.

**F3 — the fault is therefore downstream of `input_selector`**: `output_queue → tee →
volume → pulsesink`. No code in the waveform-scrub/position-mode-scratch feature is in
that path.

**F4 — the deck runs three `pulsesink`s, two of them on the same physical device.**
From the same log:

```
[audio/deck-0/0]   pulsesink device=""                      → system default (PCM2902C)
[audio/deck-0/1]   pulsesink device="…DJControl_Starlight…" → the controller
[audio/deck-0-cue] pulsesink device="…DJControl_Starlight…" → the SAME device
```

All three cycle Paused→Playing on every scratch gesture.

**F5 — there is a clipping artifact during *normal* playback**, reported independently and
confirmed by the user as "any time", with no jog involved. Nothing in the scratch path can
produce that. With cue open, the Starlight receives the deck twice, summed — which is a
sufficient explanation and needs no code.

**F6 — the silence does not recover mid-gesture.** User-confirmed, and re-confirmed in
session 2 under arm A4: once it goes, it stays gone until the gesture ends, and a **new
gesture is audible again immediately**. This is the single most diagnostic observation in
the doc. It rules out the `arrived`-fade explanation outright — a designed fade recovers
the moment the hand moves again *inside* the same gesture, and this does not — and it
points at something that is re-established per gesture. Every gesture drives
`Paused → Playing` (`pipeline.rs`, `begin_or_update_scratch`), which re-rolls `base_time`.

**F7 — device routing is not the cause (session 2).** The A/B ran down to arm A4: a
single `pulsesink`, on the onboard PCM2902C, with the Starlight carrying no audio at all
and the cue branch on a `fakesink`. **The audio still dies mid-gesture.** H1 does not
explain this fault. See the filled table below.

**F8 — the whole graph delivers, all the way to the sink pad (session 2).** The delivery
probes (`DeliveryProbe`, `pipeline.rs`) count buffers at `volume`'s src pad and the
`pulsesink`'s sink pad, reported in `[scratch-tel]` once a second. Over an 18.7-second A4
gesture the user heard die partway through:

```
19:16:44  rms −15.6 dBFS  arrived 1%   | delivery vol0=70/s(-0ms) sink0=70/s(-0ms)
19:16:47  rms −12.9 dBFS  arrived 0%   | delivery vol0=67/s(-0ms) sink0=67/s(-0ms)
19:16:52  rms −18.9 dBFS  arrived 21%  | delivery vol0=67/s(-0ms) sink0=67/s(-0ms)
19:16:57  rms −16.0 dBFS  arrived 0%   | delivery vol0=67/s(-0ms) sink0=67/s(-0ms)
19:17:01  rms −13.3 dBFS  arrived 0%   | delivery vol0=67/s(-1ms) sink0=67/s(-1ms)
```

**67 buffers/s into the sink, unbroken, for the entire gesture**, carrying −12 to −19 dBFS
of real signal. Not one second dips. There is no delivery stall anywhere in the graph:
GStreamer hands the device the audio and it does not come out.

**F9 — the sink margin is pinned at zero, measured (session 2).** The same probe reports
each buffer's running time minus the element's current running time. It reads **−0ms every
second, from the first chunk** — not a decay, a structural constant. That is H5's
precondition confirmed rather than argued: a just-in-time feeder with `do-timestamp=true`
cannot produce slack. ⚠️ It is the *precondition*, not the mechanism — a resyncing ring
buffer and a healthy one are indistinguishable from outside the sink. (F10 got inside the
sink and found the resync. The −93ms this probe read at gesture 2's open is the head start
on the lateness that F10's resync then punished.)

**F10 — the sink resyncs its ringbuffer backwards mid-gesture, and that is the fault
(session 3, 2026-08-08 night).** Arm A4 confirmed from the log (one `pulsesink` on the
BurrBrown/TI USB codec, cue on `fakesink`). Two waveform drags in one run, and **they
disagreed** — the first stayed audible for its full 17s, the second died. That accident
is the best control arm in this investigation: same build, same routing, same session,
one variable (how hard the gesture was driven).

`GST_DEBUG=audiobasesink:6,pulsesink:5` over both gestures contains **exactly two WARNs in
17,006 lines**, and both are inside the gesture that died:

```
0:02:48.295 WARN audiobasesink gst_audio_base_sink_get_alignment:<pulsesink0>
            Unexpected discontinuity in audio timestamps of -0:00:00.253062500, resyncing
```

The render trace on either side of it:

```
rendering at 2154577   (align +12067)     ← sink masking 251ms of lateness, sounds correct
rendering at 2155297   (align +12141)     ← mask still growing
    WARN  -0:00:00.253062500, resyncing   ← discont-wait expires, align := 0
rendering at 2143870                      ← write pointer drops back 11427 samples
rendering at 2144591 / 2145311 / 2146031  ← continues from there, small aligns, never returns
```

The buffer *timestamps* never went backwards — they advance ~15ms per buffer throughout.
What moved is the sink's write pointer.

**The arithmetic closes on GStreamer's two defaults**, both read off this machine's
`gst-inspect-1.0 pulsesink`:

| | default | in the log |
|---|---|---|
| `alignment-threshold` | 40ms | `1920` samples @48kHz — the threshold in `ABS (12067) < 1920` |
| `discont-wait` | 1.000s | WARN fires 1.355s after the gesture's `Paused→Playing` |

So the sequence is: the gesture opens ~93ms late (F9's margin caught exactly this),
misalignment crosses 40ms about 0.35s in, `get_alignment()` records a discont *candidate*
and **keeps correcting it by aligning to the previous sample** — which is why the audio is
fine at first — and one full `discont-wait` later it stops, sets `align = 0`, and places
the buffer at its raw timestamp-derived offset 253ms in the past. That is behind the
ringbuffer's read pointer, so those samples and all after them are written into segments
already played out. Silence, for the rest of the `Playing` span.

⚠️ **The `align with prev sample, ABS (12067) < 1920` DEBUG line is misleading and cost
time to read.** 12067 is not less than 1920. That branch prints whenever the sink
*decides* to align, including while a discont candidate is pending — the printed
comparison is not the test that was performed. Read it as "aligned anyway", not "was
within threshold".

**What F10 explains that nothing else did:**

- **F6, exactly.** The silence cannot recover inside the gesture because the write pointer
  stays retarded for the whole `Playing` span; a new gesture re-rolls `base_time` and
  starts clean, so it is instantly audible.
- **F8's paradox.** 67 buffers/s really do reach the sink pad, and the sink really does
  `wrote 720 of 720` on every one. Delivery was never the question — placement was.
- **Why it is rate-dependent.** The user's own read on the two gestures ("maybe I kept the
  rate low enough") is what the telemetry says: gesture 1 ran `rate mean` 0.17–0.64 and
  never sustained >40ms of misalignment for a full second; gesture 2 ran `rate mean`
  2.2–3.2 with `max` saturating the 8.0 clamp, and did.
- **Why the sink's own behaviour is the lever.** For the entire second it aligned, the
  output was correct. Masking is the *right* behaviour for this feeder. The fault is that
  it is time-limited.

## What is ruled out, and by what

| Ruled out | By |
|---|---|
| Feeder produces silence / wrong samples | F1 — `rms` after all gain stages |
| Servo stalls, snaps, or reports `arrived` | F1 — `arrived 0% snaps=0` |
| Spurious fade ramps chopping the signal | F1 — `ramps=0` |
| Feeder misses its 15ms cadence | F1 — `late 0%`, `chunks=67/s` |
| Gesture-start anchor mismatch (was real, now fixed) | F1 — `snaps=0`, where every gesture used to open on a silent snap |
| `appsrc` internal queueing / the mechanism-6 stall | F2 — probes at three points, all nonzero |
| Anything in the scrub bus, the MIDI handler, or `WaveformCanvas` | F1 — the feeder receives correct targets and acts on them |
| The cue branch / two sinks on one physical device (H1) | F7 — arm A4: one sink, one device, cue on `fakesink`, still dies |
| Multi-sink `tee` topology generally | F7 — A4 has a single main branch |
| MIDI, `midir`, the jog wheel, `handler.ts` | Session 2 reproduced it with a **mouse waveform drag**; the controller carried neither audio nor input |
| A stall in `output_queue` / `tee` / `volume` | F8 — 67 buffers/s at `volume`'s src pad throughout |
| The sink being starved (anything upstream of it) | F8 — 67 buffers/s at the sink's own sink pad throughout |
| The `arrived`-fade being mistaken for a fault | F6 — designed silence recovers when the hand moves again; this does not |
| The servo's `SCRATCH_TARGET_MAX_RATE` clamp | Telemetry: the clamp engaged in 1 second of a 13.5s gesture (the closing flick). The steady portion asked for 0.05–1.6×, nowhere near 8.0 |
| A stall or drop *inside* the sink | F10 — the sink renders every buffer, `wrote 720 of 720` throughout. It writes them to the wrong place |
| PipeWire / ALSA below GStreamer (H4) | F10 — the fault is fully explained one layer above, in `GstAudioBaseSink`'s alignment logic, with both of its thresholds matching the observed timing. `pw-top`/`pw-record` remain unspent and are no longer needed |

## The instruments, and how to read them

**`[scratch-tel/deck-N]` (`pipeline.rs`, `spawn_scratch_feeder`)** — per second, per
gesture. Fields: `chunks` (cadence + `late%`), `rms`/`dBFS`, `arrived%`, `snaps`, `ramps`,
`rate mean/max`, cursor travel and effective speed. **`rms` is the one that adjudicates**:
healthy RMS with nothing audible ⇒ downstream; collapsing RMS ⇒ feeder or gain logic.

⚠️ **`output_queue underrun` is useless during a scratch and must not be cited as
evidence.** It fires **once per chunk by construction** — 66.8/s measured against a 66.7/s
chunk rate — because a just-in-time feeder empties the queue on every buffer. It reads as
alarming and says nothing. (It is also separately known to have a ~6:1 false-positive rate;
see `audio-dropout-mid-playback.md` §"Secondary finding".)

⚠️ **`push_buffer took …ms` only warns above 50ms**, so its silence is weak evidence.
F1/F2 are the strong forms.

**`delivery …` in the same `[scratch-tel]` line (`DeliveryProbe`, `pipeline.rs`)** — added
2026-08-08 (evening), this doc's own prescribed next instrument. `<label>=<buffers/s>(<margin>)`
for `volume`'s src pad (`vol<i>`) and each `pulsesink`'s sink pad (`sink<i>`):

- **buffers/s** — `0/s` while the feeder is producing means a delivery stall, and the label
  says which link. Steady 67/s through silence means delivery is not the fault at all.
- **margin** — the buffer's own running time minus the element's current running time.
  Positive = arrived ahead of the clock and the sink can wait for it. Negative = already
  late on arrival. A margin walking steadily negative across a gesture *is* H5.

It reports into the feeder's telemetry line deliberately: correlating delivery against the
rms that produced it, across two separate log lines, is most of what made this fault hard
to read.

⚠️ **The counters are cumulative for the life of the pipeline** — only the per-second delta
is meaningful, and the feeder baselines them at gesture start.

⚠️ **`instrument_sink_flow()`'s gap warning cannot see this fault, and its silence proves
nothing.** It only reports a gap when flow *resumes*, and a stall that persists to the end
of a gesture is followed by a transition out of `Playing` that invalidates the probe's
timestamp (the D2 invalidation in `audio-dropout-mid-playback.md`, working as designed).
The delivery counters are deliberately ungated for exactly this reason.

## The bug the A/B found on its way through — arm A4 was unreachable from the UI

**`audioSetCueDevice("")` was never sent.** `App.svelte`'s cue-device `$effect` read:

```js
const deviceId = $cueOutputDeviceId;
if (deviceId) audioSetCueDevice(deviceId).catch(console.error);   // '' is falsy
```

Selecting **`— none —`** sets the store to `""`, which is falsy, so the call was skipped
and the backend kept whatever cue device it had last been told about. **The UI read
"— none —", greyed out the headphone slider, and the pipeline went on building a live
`pulsesink` on the Starlight.** Fixed 2026-08-08 (send unconditionally, change-guarded in
the `_lastMasterVolume` idiom already in the file).

Consequences worth carrying forward:

- **This is a real user-facing bug independent of the investigation**: once a cue device
  was set it could not be turned off without restarting the app. It only ever bit on
  *disable* — a fresh boot with no cue persisted also skips the call, but the backend's own
  default is already "no cue", so the two agreed by luck.
- It silently turned arm A4 into arm A3 for two attempts running. **Never confirm a device
  arm from the UI.** The authority is the log:
  ```
  [audio/deck-0/0]   sink: pulsesink device="…BurrBrown…USB_AUDIO_CODEC…"
  [audio/deck-0-cue] no device set — cue output routed to fakesink
  ```
- The backend already had a matching no-op guard (`mod.rs`, `audio_set_cue_device`) whose
  comment says "same bug, same fix, for the headphone cue output's `$effect` in
  App.svelte" — the guard was added on the backend side while the frontend kept the
  truthiness test that caused the problem.

## Hypotheses

**H1 (the cue branch / shared physical device) is refuted for this fault** by F7 — arm A4
has one sink on one device and still dies. It remains a live hypothesis for
`audio-dropout-mid-playback.md`'s separate D1, which was never reproduced here.

**H5 — zero sink margin — is CONFIRMED (F10), with a more specific mechanism than it was
originally stated with.** Zero margin is the precondition; the failure itself is
`GstAudioBaseSink` timing out its alignment correction after `discont-wait` and resyncing
the ringbuffer write pointer backwards past the read pointer. The original statement of
the hypothesis follows, unchanged, because it was right:

The feeder produces exactly real time (15ms per 15ms) with `do-timestamp=true`,
so buffers are stamped at push time and arrive with no head start: F9 reads **−0ms every
second, from the first chunk**. `GstAudioBaseSink` writes samples into its ring buffer at
the position their timestamp implies, so with zero slack a few milliseconds of jitter
decide whether a buffer lands ahead of the write pointer or behind it. That is a mechanism
which can begin failing mid-gesture and stay failed for the rest of the `Playing` span —
and which a new gesture's fresh `base_time` resets. **It is the only hypothesis on the list
that predicts F6's shape.**

Note this is structural to position-mode scratch: you cannot pre-buffer content whose
position the user has not chosen yet. If H5 is confirmed, the fix is a latency/timestamp
offset — push buffers a fixed lead ahead of the clock, or give the sink a `ts-offset` — and
it is emphatically **not** a bigger queue and **not** anything in the feeder or servo.

**H6 (the Paused→Playing cycle across three sinks)** resolves into H5, as anticipated:
`GST_DEBUG` did show the ringbuffer resyncing, so they are one finding seen from two
sides. The `Paused→Playing` transition is not itself harmful — it is what makes each new
gesture audible again, by re-rolling `base_time` and clearing the retarded write pointer.

**H4 (PipeWire/ALSA below GStreamer) is no longer needed** and its instruments stay
unspent — see the ruled-out table.

### On the shared-cause question with `audio-dropout-mid-playback.md`

Session 1 opened this doc hoping the two faults shared a root cause, which would have given
that doc's D1 an on-demand reproducer instead of a multi-hour wait. **The A/B answered it,
and the answer is probably no.** D1's H1 configuration (two sinks on one USB device) is
*absent* in arm A4 and this fault persists regardless — so whatever this is, it is not the
device-contention mechanism D1 is about. The scratch reproducer does not transfer.

What does transfer is the delivery instrument: `DeliveryProbe` is not scratch-specific, and
during normal playback it would answer D1's central question ("did the sink keep receiving
buffers during the 10.8s gap?") directly. Wiring its output into a non-scratch log line is
cheap and would make the next wild occurrence far more readable.

## The A/B protocol

**Change one variable at a time and re-test both symptoms.** Both are needed: if the
clipping and the scratch silence move together, they share a cause and H1 is confirmed;
if they move independently, they are separate faults and this doc splits in two.

Setup for every arm: deck loaded and **paused**, playhead mid-track (not 0:00), scratch
mode `vinyl`, `tail -f` on the log. Controller plugged in **before** launch.

Per arm, record:

- **P** — normal playback: clipping present? (play 30s, no jog)
- **S** — jog gesture ~10s, both directions: audible for the whole gesture, the first
  moment only, or never?
- **T** — the `[scratch-tel]` lines for that gesture: `rms`, `arrived%`, `late%`
- **U** — `output_queue underrun` delta (context only; see the warning above)

### ✅ RUN 2026-08-08 (evening) — results

| # | Arm | Mains | Cue | P | S | T | U |
|---|---|---|---|---|---|---|---|
| A0 | Baseline — as reported | default + Starlight | Starlight | **clip** | **dies** | healthy | 67/s |
| A1 | Cue off entirely | default + Starlight | off | not run | not run | | |
| A2 | One main only, cue off | Starlight only | off | not run | not run | | |
| A3′ | One main, cue elsewhere *(mirrored)* | PCM2902C only | Starlight Rear | **pristine** | **dies** | healthy | 67/s |
| A4 | One main, no controller involved | PCM2902C only | off (`fakesink`) | **pristine** | **dies** | healthy | 67/s |

A1 and A2 were skipped deliberately: A4 subsumes them (it is strictly fewer sinks than
either), and it came back dirty, so nothing they could have shown would change the verdict.
A3 ran mirrored — mains on the PCM2902C and cue on the Starlight rather than the reverse —
which is the same arm shape (one main, cue on a different device) and was what the live
config made cheapest.

**What it says:**

- **P and S moved independently ⇒ two faults**, as the read rule predicted. The clipping
  vanished the instant the mains stopped sharing a device with the cue, which is exactly
  F5's summing explanation. **That half is a routing configuration, not a bug, and it is
  closed.**
- **S is unmoved by every routing variable.** Down to one sink on one device with the
  controller carrying nothing, it still dies. **H1 is dead for this fault** (F7), and with
  it the hope that this and `audio-dropout-mid-playback.md`'s D1 share a cause — see that
  doc's updated "Where to pick up".
- Combined with F8, the fault is **inside the sink's render stage or below it**.

⚠️ **Two traps that cost time in session 2, both worth avoiding on any re-run:**

1. **Drag the *zoomed* waveform, slowly.** A coarse overview drag runs at 5–10× content
   speed, which legitimately produces `snaps` and high `arrived%` — both of which are
   *designed* silence. Those gestures cannot distinguish the fault from correct behaviour.
   The usable gesture looks like `arrived 0% snaps=0` with rms −10 to −16 dBFS.
2. **Confirm the arm from the log, never from the UI.** See the cue-device bug below.

## The fix

**Do not** touch the feeder, the servo, the scrub bus or the MIDI handler. F1, F8 and F10
cover that whole span end to end, and it was already fixed three times there by mistake.
The change belongs on the main `pulsesink`s.

**Implemented and verified live 2026-08-08 (night)** — `scratch_sink_alignment()` in
`pipeline.rs`, applied by `begin_or_update_scratch()` before its `Paused→Playing`
transition and restored by `stop_scratch_feeder()`: `alignment-threshold` 40ms → **2s**,
`discont-wait` 1s → **1h**.

**Scoped to the gesture, not set on the sink permanently.** Outside a scratch these
defaults are load-bearing — a real decoder gap during normal playback *should* resync
rather than be masked into contiguous-but-late audio that drifts away from video. During a
gesture there is nothing to drift from: the normal branch is valved off and
`uridecodebin`'s state is locked, so the feeder is the deck's only audio and it is
self-paced to wall clock. It rides the existing widen-at-start/restore-at-end idiom that
`output_queue`'s cap already uses, and the restore sits ahead of every early return in
`stop_scratch_feeder()` — a leaked widening has no symptom until some unrelated live
session drifts, which is what `scratch_widens_sink_alignment_then_restores` guards.

⚠️ The property write is guarded by `find_property()`. `make_sink()` falls back to
`autoaudiosink` when `pulsesink` is missing, that is a `GstBin` with neither property, and
`set_property` on an absent property **panics** — unguarded, a missing-plugin install would
crash on the first jog gesture.

**Why this rather than something cleverer:** F10's strongest practical detail is that *the
masking worked* — for the entire
second the sink aligned to the previous sample, the output was correct. The defect is that
the correction is time-limited by a default tuned for decoded media streams with
meaningful timestamps, which is not what a scratch feeder is.

⚠️ **`discont-wait=0` is the trap here, not the fix.** It reads like "never wait to
resync" and does the opposite of what is wanted — it removes the grace period, making
*every* over-threshold buffer an instant discont. Both values must go **up**.

Trade-off to state honestly: unbounded alignment means the scratch output drifts steadily
later than the pipeline clock over a long gesture. During a scratch that costs nothing —
see the scoping note above — and every gesture re-rolls `base_time`. It would matter if a
scratch ever had to stay aligned to video; today it does not.

**Rejected: a fixed timestamp lead on the pushed buffers.** This is what the doc predicted
before F10 and it is the wrong trade. Giving buffers a head start means stamping them to
play N ms in the future, and N has to be ≥ the worst-case lateness (~250ms observed) to
work. A quarter-second of latency on a scratch is grossly audible — the gesture would feel
detached from the sound, which is the entire point of the feature. `ts-offset` on the sink
has the same cost and additionally applies to normal playback through the same element.

**Verification — ✅ passed 2026-08-08 (night).** A 16s smooth gesture
(`arrived 0% snaps=0 ramps=0`, rms −10 to −18 dBFS, 67 chunks/s, `late 0%`) logged **zero**
`Unexpected discontinuity` WARNs, and the user confirms continuous audio, no dropouts.

**The strongest evidence is the delivery margin, not the WARN count.** That gesture ran at
`delivery vol0=67/s(-74ms … -48ms)`, a **stable ~−55ms** for its full 16 seconds, against
−0 to −6ms in every earlier run. −55ms is continuously past the old 40ms
`alignment-threshold` — under stock settings that is exactly F10's death condition, one
`discont-wait` from a backward resync. It ran for sixteen seconds and the sink absorbed
all of it. The margin oscillates around −55 without growing, so it is a stable offset, not
a runaway. ⚠️ **Do not "fix" this margin** — it is the fix working. A just-in-time
position-mode feeder cannot produce slack (F9), so the sink absorbing steady lateness is
the intended end state.

The reproduction procedure, for any re-run:

```bash
GST_DEBUG=audiobasesink:6 GST_DEBUG_NO_COLOR=1 GST_DEBUG_FILE=/tmp/gst-fix.log \
cargo tauri dev
# control arm — stock GStreamer values, should still reproduce:
CUEMARK_SCRATCH_ALIGN_MS=40 CUEMARK_SCRATCH_DISCONT_WAIT_MS=1000 …
```

- **Drive the gesture hard** — `rate mean` >2, `max` at the 8.0 clamp. That is the
  condition F10 showed is required. A gentle drag passes either way and proves nothing;
  that is precisely what gesture 1 was.
- **Pass = zero `Unexpected discontinuity` WARNs** and audio for the whole gesture. The
  WARN count is the assertion; do not rely on listening alone. `grep -c` it.
- Confirm the arm from the log, never the UI — `[audio/deck-0] scratch: sink
  alignment-threshold=…ms discont-wait=…ms` is printed at every gesture start, and an
  active env override additionally logs `OVERRIDE ACTIVE`.
- If WARNs persist at 2s/1h, the threshold is not the whole story and the next question is
  what is making a *single* buffer land >2s out — do not simply raise it further.

⚠️ Level 6 on `audiobasesink` is per-buffer and large; `GST_DEBUG_FILE` is not optional.

### ✅ Verified 2026-08-08 (night) — and the remaining symptom is a different fault

Arm confirmed from the log (`alignment-threshold=2000ms discont-wait=3600000ms`, no
`OVERRIDE ACTIVE`). One 12s gesture, driven hard.

**The F10 mechanism is gone.** No backward resync anywhere in the run. The five WARNs
present are +50ms, +0.7ms, +0.3ms, +2.1ms and +1.5ms, and the sink re-aligns within a
single buffer after each (`ABS (22)`, `ABS (57)` immediately following). Nothing lands
behind the read pointer and stays there. **The user's report changed shape accordingly:
"choppy/stuttering, sound coming and going" instead of F6's "dies and stays dead."**

⚠️ **"Zero WARNs" was the wrong pass criterion and is retracted.** Those WARNs fire at
|align| = 2423 samples — far *under* the 96000-sample (2s) threshold — so they are not the
threshold branch at all. `gst_audio_base_sink_get_alignment()` also refuses to align when
aligning would write **behind the ringbuffer's read segment**, and that check is
threshold-independent. Four of the five are a ~2ms catch-up transient at gesture start,
where the write position lands ~411ms behind where playback already was (`452518` →
`432765`) and takes a few buffers to climb back over the read pointer. Zero is therefore
unreachable by construction. **The correct gate is "no *sustained* backward resync"** —
i.e. no WARN whose following buffers continue from the retarded position instead of
re-aligning. That is what passed.

⚠️ **The verification gesture was over-driven, and the instruction is what did it.**
"Drive it hard" produced `snaps=9/11/14` per second and `arrived 41–48%`, which is the
regime the A/B protocol's trap #1 says cannot adjudicate anything. The original repro was
hard but *smooth*: `rate mean` 2.2–3.2 at `snaps=0, arrived 0%`. **Say "fast and smooth,
one direction, no flicks or reversals" — never just "hard."**

### The remaining fault: `arrived ⇒ silence` chatters under burst-delivered input

Not the sink, not delivery, not this doc's original subject. Recorded here because the
gesture that exposed it is the same one, and because it is what a user now hears.

`arrived%` is the share of 15ms chunks the servo commanded to **silence**
(`target_hold_gain = 0.0`, 5ms ramp each way via `SCRATCH_FADE_FRAMES = 240`). At 41–48%,
nearly half the gesture is muted in ~15ms fragments — audibly chatter, not a dropout.
Two paths reach it, both in `servo_step()`:

- `err.abs() > snap_frames` (`SCRATCH_TARGET_SNAP_SECS` = 0.5s) → snap, silence.
- `err.abs() < SCRATCH_TARGET_EPSILON_FRAMES` → target reached, silence.

The second dominates a smooth fast drag, and it is a **design mismatch with burst
delivery**: pointer moves arrive rAF- and WebKit-coalesced, the servo converges within
`SCRATCH_SERVO_LAG_CHUNKS`, then mutes until the next event lands. A record under a moving
hand coasts between updates; this cursor stops dead and mutes. **The target should be a
waypoint, not a place to park** — mute on a genuine hold timeout (no new target for N ms),
and coast at the last commanded rate through the inter-event gap.

**The same root produces a second, milder symptom on gestures that never mute at all.**
The verified-clean 16s gesture was reported as "a bit erratic sounding, but continuous",
and the telemetry shows why: within a single second, `rate mean=1.06` against `max=4.55`;
`rate mean=0.72` against `max=2.42`. Instantaneous speed swings 3–6× above its own
one-second average, every second, at `snaps=0` — so this is not snapping, it is the servo
lurching at each coalesced batch and coasting to near-zero between batches. Audibly, speed
wobble.

**Both symptoms are one fix.** Converge-and-park lurches when it converges and goes silent
when it parks; hard gestures hear the silence, smooth ones hear the lurch. Smoothing the
target across the inter-event gap — rather than treating each burst as a fresh destination
to reach as fast as `SCRATCH_TARGET_MAX_RATE` allows — addresses both. ⚠️ Note this means
**raising `SCRATCH_TARGET_MAX_RATE` (the deferred "Adjacent work" item below) would make
the wobble worse, not better** — it raises the ceiling on exactly the lurch being measured
here. Reassess that item after this fix, not before.

Adjacent and separate: **there is no anti-aliasing when decimating.** The lerp in the
feeder is a reasonable interpolator for `rate < 1` but does nothing against aliasing at
`rate > 1`; at the 8.0 clamp everything above ~3kHz folds back. That is a harshness/timbre
fault, **not** a silence one — do not reach for it to explain a dropout.

### Session 3 method note, worth reusing

The control arm was an accident: the user ran one gentle gesture and one hard one, and
only the hard one failed. **Two gestures of deliberately different intensity in a single
run is now the standard protocol for this fault** — it costs nothing, and a within-run
control removes build, routing, device and session state as variables in one stroke. The
earlier A/B spent five arms establishing less.

### Adjacent work this investigation surfaced but did not do

- **Raise `SCRATCH_TARGET_MAX_RATE` (currently 8.0), and revisit `SCRATCH_TARGET_SNAP_SECS`
  with it.** A fast overview drag saturates the clamp and then snaps, and snapping is
  silent by design — so coarse drags sound broken even when nothing is wrong. Position mode
  **cannot drift** (the target is absolute; error never accumulates the way the old
  velocity path's did), so the cap is about pitch/aliasing at extreme speed, not position
  integrity. Raising it is safe in the way that matters. Deliberately deferred so it does
  not muddy the arms.
- **Wire the delivery counters into a non-scratch log line**, for `audio-dropout-mid-playback.md`'s
  D1 — see "On the shared-cause question" above.

### Related

- `docs/design/audio-dropout-mid-playback.md` — H1–H4, the false-positive analysis, and D1.
  ⚠️ The hoped-for shared cause did **not** survive the A/B; read "On the shared-cause
  question" above before assuming this doc's findings transfer to that one.
- `docs/design/waveform-scrub.md` — the feature, its three fixed faults, and the live-run
  history that produced this doc.
- `docs/design/pcm-buffer-playback.md` — the feeder, and mechanisms 5/6/7, the previous
  family of downstream stalls (fixed by widening `output_queue` for the gesture duration).
- `docs/design/pipewiresink-play-hang.md` — why the sink is `pulsesink`; relevant to H6.
