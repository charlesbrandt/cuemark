# Slow-jog scratch audio is inaudible — 🔴 OPEN: the cue branch is GATED

> ⚠️ **§1–§9 below describe a RETRACTED verdict and are kept only as a record of how it went
> wrong. Read §10 onward for the current state.** The short version: §1–§9 analysed the
> **main** output (channels 0,1) while the user was listening on **headphones**, which on this
> device is a different physical channel pair (`RL,RR` = channels 2,3). The pitch arithmetic
> in §1–§2 is real and `Jog scale` is a genuine taste lever, but it was never what the user was
> hearing — and the same capture had digitally-silent headphone channels nobody had looked at.

**Status (2026-08-10, late)**: 🔴 **OPEN.** The cue/headphone branch is chopped into ~75–80%
digital silence during a scratch gesture while main plays normally. Confirmed **GATED, not
pitched**, by a device capture read on channels 2,3 — when cue audio is present its spectral
balance is identical to main's. Not localised to an element. Three further hypotheses were
refuted on 2026-08-10 (§10.1, §10.3, §10.4).

**Start here**: §10.6 for current state and the next reading. §10.5 for the measurement
lesson, which is the durable part.

**Ask which output the listener is on before analysing any capture, and read both pairs**:
`scripts/scratch-envelope.py <cap>.wav --channels 2,3`.

Renamed from `slow-jog-audio-gating.md` when the gate verdict was retracted. The gate is
back — on a different channel pair than the one that was originally checked.

**Read first**: `scratch-audio-downstream-delivery.md` (the two real faults, closed
2026-08-08; both confirmed still working throughout this investigation).

---

## 1. What it is

User report (2026-08-09/10, MIDI jog wheel, deck **paused**, vinyl mode):

> Starts playing at the beginning [of each jog motion], and then quickly goes to silence
> until the next motion. … It was mostly silence. Just the very beginning when there is a
> sudden burst of sound at the beginning of the motion.

**The signal never stops.** Captured at the PipeWire monitor — downstream of everything,
including the two-`pulsesink`s-on-one-device topology:

```
silent windows : 83/599 (14%)
longest silence: 0.050s (interior only; lead-in 1.95s, tail 0.00s excluded)
rms   dBFS     : p10=-35.2 p50=-24.9 p90=-17.4
hp200 dBFS     : p10=-45.3 p50=-39.8 p90=-33.0
zcr   Hz       : p10=0    p50=120   p90=880
hp200 - rms    : -14.9 dB at p50
  → PITCHED
```

Across 13 seconds of gesture there are **four** isolated silent windows, three of them a
single 25ms frame. Median level is −24.9 dBFS — a healthy signal.

The energy is simply in the wrong place. `hp200` sits **14.9 dB below** full-band `rms` and
the zero-crossing rate reads **120 Hz at p50**. At a 0.15x cursor speed an 800 Hz sound
arrives at 120 Hz; content that started at 200 Hz arrives at 30 Hz. It is all still there, at
level, below where small speakers and ears do useful work.

**The "burst at the beginning of the motion" is the one moment fast enough to be audible** —
a hand is quickest as it starts, and pitch follows cursor speed.

## 2. The evidence, joined

`[scratch-tel]` for the same 14 seconds as the capture (21:11:48 → 21:12:01):

| | reading |
|---|---|
| `arrived` | **0%** in 13 of 14 seconds (6% once) |
| `ramps` / `snaps` | 0 in 13 of 14 / 0 always |
| `chunks` | 67/s, `late 0%` |
| feeder `rms` | −8.3 to −18.2 dBFS, continuous |
| delivery margin | −6 to −22ms (healthy) |
| **`rate mean`** | **0.104 – 0.262x**, mean ≈ 0.16x |

Pitch tracks speed, which is the causal link and not just a coincidence of levels:

```
corr(rate, zcr)       = +0.64
corr(rate, hp200-rms) = +0.15      (n=13 one-second bins)
```

The single fastest second (0.236x) reads `zcr 1952 Hz` with `hp200−rms` at only **−7.0 dB**;
the slow seconds (0.10–0.17x) read `zcr 37–348 Hz` at **−12 to −22 dB**. Same gesture, same
chain — the bright second is the audible one.

For scale: **33⅓ rpm is 1.0x** by construction (`VINYL_SEC_PER_TICK = 1.8/256`, one
revolution = 1.8s of content). Sustained gestures here run 0.10–0.26x, i.e. roughly **3–8
rpm**. A record turned that slowly is inaudible too.

## 3. Why every instrument said "healthy" for two sessions

**`rms` is blind to frequency.** The feeder's own `rms` field, the delivery counters,
`arrived%`, `chunks late%` — every one of them is a *level* or *count* measurement, and this
fault changes neither. There was never a reading that could have distinguished it, so no
amount of care in reading them would have found it.

That is the whole lesson, and it generalises past this bug: **an instrument that cannot vary
with the fault carries no information about it, and a clean reading from one is not weak
evidence — it is no evidence.** Five mechanisms were proposed and refuted against exactly
such instruments (§4). The capture settled it in one pass because it was the first
measurement whose value *could* differ between the two worlds.

The trigger worth remembering: **producing stage reports healthy AND delivery counters
advance AND the user reports the fault ⇒ go capture the signal.** Not hypothesis six.

## 4. Ruled out along the way — do not re-run

All five were refuted by measurement before the capture. Kept because each is a plausible
idea that will occur to the next person.

1. **The widened frame ring** (`bc07d01`) — `[raf] busy 1%`, 60fps, `frame-dur max=4ms`. A
   1080p frame costs ~0–1ms; the 54–77ms figure is 4K-only.
2. **Coast taper / distance cap too short** — `arrived 0%` with continuous `rms`. The coast is
   engaged 48–100% and working.
3. **`VINYL_SEC_PER_TICK` miscalibrated** — five independent one- and two-revolution gestures
   give 243–276 ticks/rev against the assumed 256. The constant is right. 🔴 `[jog-cal]`'s
   suggestion is meaningless unless the gesture was *exactly* one revolution, and nothing logs
   how far the wheel turned; an uncontrolled reading of `0.01837` cost an hour.
4. **Sink delivery margin / `base_time` re-roll (H5)** — **real and reproducible**: a
   play/pause cycle immediately before a gesture steps the margin from ~−20ms to ~−200ms, two
   independent pairs, no accumulation. Refuted as *this* cause by ear — the healthy-margin
   gesture sounded worse. Worth fixing on its own terms; unrelated.
5. **Spurious direction-reversal fades** — **a real defect, found and fixed**. `ramps` fired
   2–8/s on a strictly one-direction gesture because `HandTracker::step()` zeroed
   `coast_offset` on every real target, jumping the aim point backwards whenever the hand
   decelerated. The fix absorbs the offset against delivered motion instead, so the aim can
   hold still but never reverse. `ramps` 2–8/s → 0–1/s **as predicted, with the symptom
   unchanged** — which is what killed the hypothesis cleanly and immediately.

Stating the falsification condition before running the test is the one practice here that
worked. Keep doing it.

## 5. The capture tool gave the wrong verdict first

`scripts/scratch-envelope.py` reported **`GATED`** on the take that proves the opposite, and
that verdict was reported and acted on before anyone looked at the timeline.

Cause: `longest silence` was computed over the whole file, so the **1.95s of digital silence
before the user began turning** — the deck sitting correctly paused while the recorder ran —
scored as one long gate. And because `GATED` is an `elif` ahead of `PITCHED`, it *masked* the
right answer, which the same numbers already contained (`hp200 − rms = −14.9 dB`).

Fixed 2026-08-10: the run is measured over the **interior only**, between the first and last
window carrying signal, and the lead-in/tail are reported separately so trimming is visible
rather than silent. A gate is a hole punched in program material; silence before the hand
moves is the deck being paused.

⚠️ Worth its own note in `silent-failure-inventory.md`: the instrument built specifically to
end a chain of confident wrong answers produced one of its own, in its very first use, and it
was caught only by reading the raw timeline underneath it. **Verdict lines are a convenience;
the data is the evidence.**

## 6. The open question — the jog mapping

Not a defect, a design call, and it needs a human answer.

`VINYL_SEC_PER_TICK` faithfully models a 12" platter at 33⅓ rpm. The Starlight's jog wheel is
a few inches across, and the speed a hand naturally uses to *find a cue point* on it —
3–8 rpm — maps to 0.1–0.26x, which is inherently sub-audible. The faithful model and the
usable one diverge, and no constant satisfies both:

| Option | Effect | Cost |
|---|---|---|
| Leave it | Physically faithful; turn the wheel faster to hear it | A slow cueing nudge stays inaudible — the reported complaint |
| Shorten seconds-per-revolution | Same hand speed lands higher up the pitch range | Fine positioning gets coarser in proportion; the wheel becomes twitchy |
| Hold pitch up at low cursor speed | A slow nudge stays intelligible for beat-finding | No longer physically faithful — a deliberate break with the turntable model this feature is built on |

The third is what most DJ software does in practice and is the only one that addresses the
actual use case (hearing *where you are* while nudging slowly), but it contradicts this
feature's stated design premise, so it is not a change to make quietly.

## 7. Two real findings from this investigation, unrelated to it

### 7.1 The unzoomed waveform drag scales its scratch rate by track duration

`secondsPerPixel()` in `WaveformCanvas.svelte` returns `deck.source.duration / rect.width`
when not zoomed. **Identical hand motion scratches 3.3× faster on a 10-minute track than a
3-minute one.** The zoomed path is length-independent (`zoomSeconds × playbackRate`); the jog
is absolute. Same shape as the frame-ring mistake — behaviour tuned against whichever content
happened to be loaded.

### 7.2 The audibility floor sits downstream of three unrelated input mappings

At a gentle 20 px/s on a 1224px canvas:

| Input path | s per unit | rate |
|---|---|---|
| Unzoomed drag, 254s track | 0.208 s/px | 4.2x |
| Unzoomed drag, 60s track | 0.049 s/px | 0.98x |
| Zoomed drag (16s window) | 0.013 s/px | 0.26x |
| Jog wheel @ 41 ticks/s | 0.00703 s/tick | 0.29x |

A 16× spread from the same hand — and **the two paths that land lowest are precisely the two
the docs instruct you to test with** ("slow, smooth, zoomed"). That is a large part of why
low-speed silence kept being re-found and re-attributed across four sessions.

## 8. How to re-measure

```bash
scripts/scratch-capture.sh                      # pre-flights the pw-link; refuses on the wrong node
scripts/scratch-envelope.py /tmp/cuemark-scratch-<ts>.wav \
    --start-epoch "$(cat /tmp/cuemark-scratch-<ts>.epoch)" --log /tmp/cuemark-dev.log
```

Deck **paused**, vinyl mode, one slow steady one-direction turn of ≥5s.

- Read `hp200 − rms` and `zcr` **together with `rate mean`** from `[scratch-tel]`. Level alone
  cannot distinguish this fault from health.
- ⚠️ Log timestamps are UTC; `date`, the capture filename and the `.epoch` file are local.
- ⚠️ A capture that reads ~−53 dBFS and flat is the *wrong node* (the H1n mic), not a quiet
  take. The script checks for this first and refuses to interpret anything below it.
- ⚠️ Ask for **exactly one revolution** if `[jog-cal]` is going to be used for anything (§4.3).

---

## 10. 🔴 REOPENED 2026-08-10 (late) — the user was never listening to the main output

**The "pitched, not gated" verdict above is measured correctly and answers the wrong
question.** It was derived from channels 0,1 of the device monitor — the **main** output.
The user monitors on **headphones plugged into the Starlight**, which is the **cue** output
(`[audio/cue] remap: target=RL,RR full=FL,FR,RL,RR idx=[2,3]`), i.e. channels 2,3. Nobody
asked which one they were listening to until after the investigation closed.

Re-analysing the *same* fast-jog capture (`/tmp/cuemark-scratch-173949.wav`, 15s, 4ch) by
channel pair:

| second | MAIN (ch 0,1) | CUE / headphones (ch 2,3) |
|---|---|---|
| 1 | −23.0 dBFS | −34.0 dBFS |
| 2–14 | **−19.3 to −24.3 dBFS, continuous** | **−999 dBFS — exact digital zero, all 13s** |

Two things make this decisive rather than suggestive:

- **−999 dBFS is literal zero samples**, not a noise floor. The idle monitor on this device
  reads −54 dBFS (§6), so silence here is *quieter than silence* — something is writing
  zeros, not failing to write.
- **−34.0 dBFS in second 1 is exactly right.** `cue_volume = gain × cue_gain × master =
  1.0 × 0.27 × 0.425 = 0.115` against `main = gain × vol × master = 0.425`, i.e. 11.4 dB
  down; −23.0 − 11.4 = −34.4. The cue branch was working correctly, at the correct level,
  and then stopped.

So the cue branch delivers ~1 second of correct audio at the start of a scratch gesture and
then hard-zeros for the rest of it. **That is the user's original symptom verbatim** —
"starts playing at the beginning of each jog motion, and then quickly goes to silence until
the next motion" (§1) — and it has been the symptom the whole time.

### What is ruled out already

- **Not the cue toggle being off.** `[audio/deck-0] cue ON` at 21:31:12, 3.3s after the only
  `load()` of the session, and no reload after. The valve was open for the capture at 21:39.
- **Not `scratch()` touching the cue branch.** It sets `input_selector`'s active pad and
  `valve_normal.drop = true`; it does not reference `cue_valve`, `cue_volume` or `cue_queue`.
- **Not starvation.** `[scratch-tel]`'s delivery probes read `cuevol=68/s cuesink=68/s`
  *during* the zeros. Buffers arrive at the cue sink at full rate and contain silence.
- **Not a sample-rate renegotiation at the tee.** `SCRATCH_SAMPLE_RATE` is 48000 and
  `capsfilter2` forces the same `caps_48k` as the normal branch.

### Why every instrument missed it

The feeder's `rms` is measured on the bytes handed to `appsrc` — **upstream of the tee**, so
it is structurally incapable of seeing a loss that happens on one branch below the split. The
delivery probes count *buffers*, not content, so a branch delivering silence at 68/s reads
identically to one delivering music at 68/s. Between them they cover the whole path except
the one place the fault is. This is C-class in `silent-failure-inventory.md`, and it is the
third distinct instance in this investigation.

⚠️ **The capture tooling has the same blind spot by default.** `scratch-envelope.py` analyses
channels 0,1 unless told otherwise, so it reported **CLEAN** on a capture whose headphone
channels were digitally silent. Always run both pairs:

```bash
python3 scripts/scratch-envelope.py <cap>.wav                 # mains
python3 scripts/scratch-envelope.py <cap>.wav --channels 2,3  # cue / headphones
```

### Next step

One capture that spans **normal playback and then a jog**, with cue on, read on channels 2,3.
That distinguishes "the cue branch is broken generally" from "scratch breaks the cue branch",
which is the last fork before reading GStreamer state directly. Do not form a mechanism
hypothesis before it — five have already been refuted on this bug, and the two that were
adopted (pitch, and the coast-reversal fade) were both measured against the wrong channel.

### §10.1 — the caps-renegotiation hypothesis is REFUTED (2026-08-10, same evening)

The first mechanism proposed for §10 was a caps renegotiation at the cue branch's
`mix-matrix`: `caps_48k` constrained **rate alone**, so the scratch branch inherited
`appsrc`'s unpositioned channel-mask while the normal branch negotiated its own, and
switching `input_selector` would then renegotiate an element whose hand-built N×2 matrix is
only meaningful against a known channel layout.

**Refuted by `instrument_caps()`, which was built in the same commit precisely so the
hypothesis could fail cheaply.** Across a full load + playback + jog cycle the probe emitted
exactly **two** CAPS events, both at load, none when scratch engaged:

```
ch_conv.sink (mix-matrix in): audio/x-raw, rate=48000, F32LE, channels=2, channel-mask=0x3
ch_caps.src  (to cue sink):   audio/x-raw, rate=48000, F32LE, channels=4, channel-mask=0x33
```

Both layouts are **correct** — 0x33 is FL,FR,RL,RR — and neither changes during a gesture.
User-confirmed by ear in the same run: "It sounds the same as before."

**Do not re-run this.** The negotiated layout on the cue branch is right, stays right, and is
not what silences it.

Status of the accompanying change: `caps_48k` and `scratch_caps` are now fully specified
(format, layout, channels, channel-mask). That is **inert** with respect to this bug and is
kept only as hygiene — two selector inputs presenting identical caps is a property worth
having, and it costs nothing. It is not a fix and must not be recorded as one. Revert freely
if it ever gets in the way.

### §10.2 — the instrument that was missing, and the next reading

`instrument_level()` (added 2026-08-10) logs **per-channel RMS of the actual samples** once a
second at four points: `cue after valve`, `cue after volume`, `cue post-matrix (to sink)`, and
`main vol0 (reference)`.

This is the first probe anywhere on the cue branch that reads buffer *content*. Everything
that existed before counts buffers, reports negotiation, or measures level at the `appsrc` —
upstream of the tee, and therefore structurally blind to a loss on one branch below the split.
That is exactly why "68 buffers/s at the cue sink" and "digital silence at the device" were
both true for four sessions without ever contradicting each other.

**How to read it** — whichever probe first shows `-inf` while `main vol0` still shows real
audio is the link that zeroes the signal, and the bug is then located to one element:

| first `-inf` | conclusion |
|---|---|
| `cue after valve` | the tee/valve stops feeding the branch when scratch engages |
| `cue after volume` | the gain stage is being zeroed |
| `cue post-matrix` | the channel routing drops it |
| none of them | the loss is below GStreamer — go to PipeWire's mixing of two sinks on one node, `audio-dropout-mid-playback.md` H1 |

### §10.3 — the level probe answered, and the sink-alignment hypothesis is REFUTED (2026-08-10, late evening)

**The level probe's verdict: "none of them."** Across four gestures on three builds, every
one of the four probes carried real audio for the entire gesture while the user heard
silence in the headphones:

```
cue after valve:            [-11.7 -11.9]
cue after volume:           [-25.5 -25.6]
cue post-matrix (to sink):  [-inf -inf -25.5 -25.6]     ← ch 2,3 = RL,RR = the cue pair
main vol0 (reference):      [-19.3 -19.4]
```

The `-inf` on channels 0,1 is **correct and is not the fault** — `compute_cue_remap()`
routes the stereo cue into `RL,RR` only, exactly as `remap: target=RL,RR idx=[2,3]` reports.
Read this table with the channel mapping in hand or it looks like a smoking gun.

By §10.2's table that verdict means "below GStreamer". ⚠️ **That table's fourth row was too
coarse and cost a cycle.** `GstAudioBaseSink`'s ringbuffer sits *after* the last pad, so
there is one more GStreamer-internal stage between the deepest probe and PipeWire. Reading
"none of them" as "therefore PipeWire" skips it.

**The hypothesis that stage suggested, and its refutation.** `stop_scratch_feeder()`'s F10
fix (`scratch_sink_alignment()`, widening `alignment-threshold`/`discont-wait` for the
gesture) was applied to `inner.main_sink_els` **only** — the cue sink was never in the list,
so it kept stock 40ms/1s and should have reproduced F10 verbatim on the headphone branch.
The timing fit was compelling: audio survived ~1s into a gesture and `discont-wait` defaults
to exactly 1000ms. It is now fixed anyway (`scratch_fed_sinks()`, main + cue) because
excluding the cue sink was wrong on its own terms, but **it is not this bug**:

| gesture | rate profile | alignment read-back | audible? |
|---|---|---|---|
| 22:21:46 (12.0s) | 0.20 → 1.22 → 0.44 | both sinks 2000ms/3600000ms | **yes** |
| 22:25:28 (8.4s) | slow throughout | both sinks 2000ms/3600000ms | no |
| 22:26:04 (3.3s) | normal speed | both sinks 2000ms/3600000ms | no |

Three failures against one success with the widening confirmed in effect on both sinks. A
normal-speed rotation fails too, so **it is not a speed threshold** — an intermediate reading
that briefly looked right when the one audible gesture happened to be the faster one.

**⚠️ Two instruments in this file were themselves blind, and both were written during this
investigation.** The first version of the widened-alignment log printed the *length of the
slice passed in* — a count of intended writes, not an effect — and reported
`on 2 sink(s) incl. cue` for a build whose cue-sink behaviour was never established. It now
reads the properties back per sink and prints `name=2000ms/3600000ms` or
`name=SKIPPED(no property)`. Separately, `scratch_widens_sink_alignment_then_restores` read
`main_sinks_of()` alone, so it passed green for the entire life of the bug it existed to
guard; it now chains `cue_sink_of()` and asserts on ≥2 sinks. **A guard that watches a subset
of the sinks the feeder feeds is not a guard**, and a log line that reports a call is not
evidence of an effect — see `silent-failure-inventory.md`.

### §10.4 — PipeWire node suspend/resume — REFUTED (2026-08-10, same evening)

> ⚠️ **This section is kept as a refuted hypothesis. Do not re-run it.** The reasoning below
> was written before the controlled arms ran; the refutation is at the end of the section.

What appeared to separate the single audible gesture from every silent one was **not** speed,
code, or topology. It looked like elapsed time since the node last carried audio:

```
22:21:43.224  Playing → Paused
22:21:46.019  gesture starts  ← 2.8s after active playback — AUDIBLE
   … 3.5 min idle …
22:25:28.851  gesture starts  ← SILENT
   … 27s idle …
22:26:04.651  gesture starts  ← SILENT
```

`pw-dump` shows the Starlight node at **`state=suspended`** whenever nothing is playing.
PipeWire suspends an idle node and re-negotiates its port links on resume, and the cue
stream is the 4-channel one whose content lives entirely in `RL,RR`. At rest both streams
dump correctly — stream 120 `["FL","FR"]`, stream 161 `["FL","FR","RL","RR"]`, both unmuted
at volume 1.0 — so **the misconfiguration is not static and cannot be found by dumping an
idle graph.**

This accounts for every observation that previously did not fit, including the original
user description ("starts playing at the beginning of each jog motion, then quickly goes to
silence" — the node resuming as the gesture opens), the four sessions of healthy in-pipeline
telemetry, and the one inexplicable success.

⚠️ **It also means the planned H1 topology test would have produced a false positive.**
Moving main off the Starlight leaves cue alone on the node — but a second stream is also
what keeps a node *awake*, so "cue works when main moves" would have been read as "two
`pulsesink`s on one node is the bug" when the operative change was suspend behaviour. H1 and
this may be one mechanism seen from two angles. **Run the suspend arms first.**

**REFUTED by the controlled arms.** Both were run with a 4Hz `pw-dump` sampler recording the
node's state transitions, so the node state at each gesture is measured, not inferred:

| arm | pause → jog | node state at gesture start | audible? |
|---|---|---|---|
| A — node awake | 22:30:12.651 → 22:30:13.005 (0.35s) | `idle` → `running`, **never suspended** | **no** |
| B — node suspended | 22:30:32.224 → 22:30:53.965 (21.7s) | `suspended` → `running` | **no** |

Arm A never let the node suspend and was silent anyway. Suspend/resume is not the mechanism,
and the apparent correlation in the timeline above was three points fitted after the fact.

⚠️ **The generalisable error, which is the same one §10.3 made:** a timeline of a handful of
gestures will always suggest *some* ordering variable, and this bug's base rate was roughly
1 audible gesture in 7. With n that small, "what was different about the one that worked" has
many equally good answers and no power to choose between them. Both §10.3 and §10.4 were
built that way and both died on the first controlled arm. **Do not form another hypothesis
from a gesture timeline — get an instrument that reads differently in the two states.**

### §10.5 — the device capture: GATED, not pitched; and the RMS blindness that hid it

**The capture settled two questions the pipeline's instruments could not.** One 30s take of
the device monitor during a continuous jog, read on **both** channel pairs:

| pair | silent windows | rms p50 | `hp200 - rms` p50 |
|---|---|---|---|
| 0,1 — main | 230/1198 (19%) | −20.9 dBFS | −7.9 dB |
| 2,3 — **cue/headphones** | **966/1198 (81%)** | −27.9 dBFS | −7.8 dB |

1. **It is GATED, not PITCHED.** When cue audio is present its spectral balance is
   *identical* to main's (−7.8 vs −7.9 dB). The pitch theory is now dead on its own merits,
   measured on the correct pair — not merely retracted for having been measured on the wrong
   one (§10, the original error). Do not revive it.
2. **The cue branch is chopped into ~75–80% digital silence for the whole gesture, at every
   rate.** Not "1s of audio then silence" as §10 recorded — continuous chopping. Per-second
   cue silence by third of the take: 85% (slow) → 74% (fast) → 78% (slow). ⚠️ The user
   confirmed afterwards they **could not** reach the audible state during this take, so that
   85/74/78 spread is variation *within* the fault, **not** a working-vs-broken contrast, and
   jog rate is not established as a control variable.

**⚠️ The measurement lesson — an RMS over a window averages a duty cycle into a level.**
A 25% duty cycle is −6.0 dB of mean-square *exactly*. Throughout this investigation the cue
pads read ~−25 dBFS against main's ~−19, and that 6 dB was explained away as `cue_gain`. It
was (at least partly) the gating, in plain sight, disguised as attenuation. **Gating and
attenuation are indistinguishable in a windowed RMS** — the same structural blindness as
"`rms` is blind to frequency" from §10, now the second time it has cost this investigation a
cycle. The tell that separates them: during *normal playback* main and cue read equal
(−19 vs −19), and the gap opens only during a scratch; a real gain difference is present in
both.

**`instrument_level()` now reports `dBFS/zero%` per channel**, counting bit-exact zero
samples. Decoded content is essentially never bit-exact zero across a whole window, so a low
`zero%` at one probe and a high one at the next localises the gating to a single element.
This is the instrument that should have existed four sessions ago.

**Baseline from a clean (non-reproducing) gesture, 22:43** — worth having, because two things
in it are easy to mistake for the fault:

```
cue after valve:            [-11.5/0%z -11.5/0%z]
cue after volume:           [-19.0/0%z -18.9/0%z]
cue post-matrix (to sink):  [-inf/100%z -inf/100%z -19.0/0%z -18.9/0%z]
main vol0 (reference):      [-19.4/0%z -19.2/0%z]
```

- `-inf/100%z` on channels 0,1 of the post-matrix probe is **correct by design** — the
  mix-matrix routes the cue into `RL,RR` only. It is not a smoking gun.
- `zero%` spikes of 30–35% appear at `stop_scratch`/feeder-restart boundaries and are
  **identical on main and cue**. That is the feeder's designed ramp, not the fault. The fault
  signature is `zero%` rising on cue while main stays low.
- In this clean state `cue after volume` sits 7.5 dB below `cue after valve`, which is
  `master_volume` = 0.425 = −7.4 dB exactly. In the broken sessions that drop was **13.8 dB**.

**The 6.4 dB discrepancy is NOT yet localised — two explanations remain open.** It could be
the duty cycle (75% silence = −6.0 dB) or a `cue_gain` difference. `gain`, `vol` and
`master_volume` were logged identical across broken and working sessions, but **`cue_gain`
was not logged at all**, so the two cannot be separated retroactively. Both gaps are now
closed: `zero%` distinguishes gating from attenuation directly, and `load()` logs `cue_gain`
and the resulting `cue_volume`. ⚠️ An earlier draft of this section claimed the 6.4 dB
localised the fault to `cue_volume`; it does not — that inference compared two different
sessions with an unlogged variable between them.

**Found on the way — a real bug, unrelated to the gating.** `set_cue_gain()` wrote
`gain * cue_gain`, dropping `master_volume`, while the build path and `apply_volume()` both
include it. Adjusting cue gain jumped the headphone branch by `1/master_volume` (2.35x,
+7.4 dB) and left it wrong until an unrelated call recomputed it. Fixed by routing through
`apply_volume()`. Note `pipeline.rs`'s own comment documents **the same bug, same missing
factor, already fixed once for the main sinks** — this product is computed in three places
and two of them have been wrong at different times. Collapsing them is a worthwhile follow-up.

### §10.6 — state, and the next reading

**Status: OPEN.** The gating is confirmed real and confirmed *not* pitch. It is not localised
to an element. It did not reproduce in the final session of 2026-08-10 ("audible longer"),
so the reproduction conditions are still not understood — base rate has been roughly 1
audible gesture in 7, with no controlled variable yet found.

**Refuted this session — do not re-run** (in addition to §3's six):

| # | hypothesis | how it died |
|---|---|---|
| §10.1 | caps renegotiation on the cue branch | 2 CAPS events, both at load, correct layouts |
| §10.3 | cue sink excluded from the scratch alignment widening | fixed and read back on both sinks; 3 silent gestures after |
| §10.4 | PipeWire node suspend/resume | arm A never suspended and was silent anyway |

**Next reading is mechanical and needs no new hypothesis.** Reproduce the chopping, then:

```bash
grep "\[level/" /tmp/cuemark-dev.log | tail -20
```

| `zero%` behaviour | conclusion |
|---|---|
| high at `cue after valve` | the tee/valve is feeding silence — the split itself |
| jumps at `cue after volume` | `cue_volume` is being modulated toward zero during the gesture |
| jumps at `cue post-matrix` | the mix-matrix is dropping content |
| ~0% everywhere on ch 2,3 | GStreamer delivers continuously; the loss is below it → the two-`pulsesink`s-on-one-node topology (`audio-dropout-mid-playback.md` H1) |

That last row is a live possibility, not a fallback. **The H1 topology test is now
unconfounded** — the earlier objection (moving main off the node also removes what keeps the
node awake) died with §10.4. Single variable: leave cue on the Starlight `RL,RR`, move
**main** to `Built-in Audio Analog Stereo` or the `PCM2902C`, re-run.

⚠️ **Method note for whoever picks this up.** Three hypotheses died this session and all three
were formed the same way: reasoning from telemetry that reads identically in the working and
broken states. Before spending a build on an idea, ask *which instrument would read
differently if this were true* — and if the answer is "none of the current ones", build the
instrument first. The `zero%` probe took ten minutes and is worth more than all three
hypotheses combined.
