# Scratch audio reaches GStreamer and never reaches the speakers — 2026-08-08

Reference point for the A/B that comes next. The short version: **the PCM scratch feeder is
producing loud, continuous, correct audio for the entire duration of a gesture the user
hears as silent.** Everything upstream of `input_selector` is measured and healthy. The
fault is in the shared output stage, and the most likely cause is a device-routing
configuration that this repo already has an open bug against.

This doc exists because the same fault was chased three times in one session by inference
and fixed three times in the wrong place. Do not add code against a guess here. The
instruments below exist so the next step can be a measurement.

## Provenance

One session, 2026-08-08, live on the real machine with the Hercules Starlight attached.
Three live runs against `docs/design/waveform-scrub.md`'s vinyl-jog gate. Runs 1 and 2
found real defects in the scratch feeder (all fixed, all confirmed fixed by the telemetry
below). Run 3 is the one this doc is about: with those defects gone, the audio still dies.

Log: `~/.local/share/com.cuemark.app/logs/cuemark.log`, gestures at 16:01:12–16:01:39 and
16:02:24–16:02:25.

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

**F6 — the silence does not recover mid-gesture.** User-confirmed: once it goes, it stays
gone until the gesture ends and a new one starts.

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

## Hypotheses

Deliberately not re-derived here — **H1–H4 in `audio-dropout-mid-playback.md` are the same
hypothesis set** and that doc already argues them properly. H1 (the cue branch on the same
physical USB device) is the leading one and F4 confirms the configuration is present.

What this session adds to that doc is the thing it says it is blocked on:

> "If it still will not reproduce, accept that this may need to be caught in the wild
> instead… Leaving it instrumented and waiting is a legitimate plan for a one-occurrence
> fault."

🟢 **There is now an on-demand reproducer.** A jog gesture on a paused deck kills the audio
within a second or two, every time, in the configuration H1 describes. If the two faults
share a root cause, D1 is no longer blocked on catching it in the wild. **Establishing
whether they do share a cause is the point of the A/B below**, and it is worth more than
either fix on its own.

Two additions specific to the scratch path:

**H5 — zero sink margin.** The feeder produces exactly real time (15ms per 15ms) with
`do-timestamp=true`, so buffers are stamped at push time and arrive with no head start. A
sink wanting data slightly *ahead* of now can never be satisfied. Note this is structural
to position-mode scratch: you cannot pre-buffer content whose position the user has not
chosen yet. If H5 is the cause, the fix is a latency/timestamp offset, not a bigger queue.

**H6 — the Paused→Playing cycle across three sinks.** `CLAUDE.md` documents that
`pipewiresink` deadlocks when two or more go Paused→Playing with any delay, which is why
this app uses `pulsesink`. Three `pulsesink`s, two on one device, doing that transition on
every gesture is the same shape even if not the same bug.

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

| # | Arm | Mains | Cue | P | S | T | U |
|---|---|---|---|---|---|---|---|
| A0 | Baseline — as reported | default + Starlight | Starlight | clip | dies | healthy | 67/s |
| A1 | Cue off entirely | default + Starlight | off | | | | |
| A2 | One main only, cue off | Starlight only | off | | | | |
| A3 | One main only, cue elsewhere | Starlight only | PCM2902C | | | | |
| A4 | One main, no controller involved | PCM2902C only | off | | | | |

**How to read it:**

- **A1 clean ⇒ H1 confirmed** (the cue branch is the trigger) and it lands squarely on
  `audio-dropout-mid-playback.md`'s D1, with a reproducer attached.
- **A2 clean but A1 dirty ⇒ it is multi-sink, not cue specifically** — the second main sink
  is enough. Points at the `tee`/multi-sink topology (`mixer.rs`'s shelved `MasterMix` may
  be the real answer).
- **A4 dirty ⇒ none of the above.** One sink, one device, no controller: the fault is in
  `output_queue`/`tee`/`volume` or in H5, and the next step is
  `GST_DEBUG=queue:5,pulsesink:5` on that arm plus a pad probe at `volume`'s src pad —
  the one stage F2's probes do not yet cover.
- **P and S disagreeing across any arm ⇒ two faults**, and the clipping half is a normal-playback
  bug that has nothing to do with scratch.

A4 is the most informative single arm if only one can be run. Run it first if time is short.

## Where to pick up

Nothing here needs a code change to proceed. Run the A/B, fill in the table, then decide.

If A4 comes back dirty and the investigation moves into the output stage, the missing
instrument is a pad probe at `volume`'s src pad (and at each `pulsesink`'s sink pad),
following the exact pattern already in `scratch_second_gesture_reverse_repro` — that is the
one gap between F2's coverage and the speakers.

**Do not** re-fix anything in the feeder, the servo, the scrub bus or the MIDI handler
against this symptom. F1 covers all of it, and it was already fixed three times there by
mistake.

### Related

- `docs/design/audio-dropout-mid-playback.md` — H1–H4, the false-positive analysis, and
  D1, which this reproducer unblocks. **Read before forming a hypothesis.**
- `docs/design/waveform-scrub.md` — the feature, its three fixed faults, and the live-run
  history that produced this doc.
- `docs/design/pcm-buffer-playback.md` — the feeder, and mechanisms 5/6/7, the previous
  family of downstream stalls (fixed by widening `output_queue` for the gesture duration).
- `docs/design/pipewiresink-play-hang.md` — why the sink is `pulsesink`; relevant to H6.
