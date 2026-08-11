# Slow-jog scratch audio is inaudible — 🟢 ROOT-CAUSED: two `pulsesink`s on one PipeWire node

> ⚠️ **§1–§9 below describe a RETRACTED verdict and are kept only as a record of how it went
> wrong. Read §10 onward for the current state.** The short version: §1–§9 analysed the
> **main** output (channels 0,1) while the user was listening on **headphones**, which on this
> device is a different physical channel pair (`RL,RR` = channels 2,3). The pitch arithmetic
> in §1–§2 is real and `Jog scale` is a genuine taste lever, but it was never what the user was
> hearing — and the same capture had digitally-silent headphone channels nobody had looked at.

**Status (2026-08-11)**: 🟢 **ROOT-CAUSED — the fault condition is two `pulsesink`s on one
PipeWire node.** §10.9 ran the complementary arm §10.8 asked for and closed the last confound:
with **main** moved off the Starlight and **cue left exactly where it was** — same device, same
`RL,RR` pair, same `analog-surround-40` profile, same 4-channel `mix-matrix` code path — the
gating is gone. Both arms of the pair now agree, and only co-tenancy on the node distinguishes
the failing configuration from either working one.

The symptom, for the record: the cue/headphone branch is chopped into ~80% digital silence
during a scratch gesture — **GATED, not pitched**, confirmed by a device capture read on
channels 2,3, with **main audible 94% of a gesture against cue's 21%** (§10.7, 49/50 gestures
vs 1/50 above 80%). Essentially every gesture gates; what varies is how long the audio survives
first — onset p50 0.11s, death p50 ~0.4–0.5s, then digital zero for the rest.

**The fix is structural, not a tuning knob** (§10.10): the Starlight is physically *one*
4-channel PCM with one subdevice, so "Front" and "Rear" were never two devices — cuemark opens
two `pulsesink`s that pipewire-pulse must merge back into one stream. Send one stream instead.

🔴 **§10.11 sharpened it and killed the easy version**: co-tenancy is **not** generic — two
`pulsesink`s on the *USB CODEC* scratch cleanly. **Two sinks and the Starlight are each
necessary, neither sufficient.** The channel-layout mismatch is refuted too (arm 5: identical
4-channel layouts on both branches, still gates). The mechanism is unnamed; the fix does not
depend on it, since one sink on the node is proven sufficient by two arms.

**Fix status**: A shipped 2026-08-11 (main branches now carry the mix-matrix — fixes a real
silent-ignore, does **not** fix the gating, as expected). B reaches one sink for a single deck;
**only C reaches one sink with two decks loaded**, which is the live topology.

**Start here**: §10.11 for the current condition and what it rules out, §10.10 for the fix
ladder, §10.9 for how the device was localised. §10.5 for the measurement lesson, which is the
durable part and outlives this bug.

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

> ⚠️ **§10.6 is superseded by §10.7 on two points.** (1) The "1 in 7 / not localised" framing
> above is retired: with a main-vs-cue control the gate is localised to the cue branch or
> below, and essentially every gesture gates. (2) The §10.3 row in the table below reads
> "refuted"; the accurate status is **correctly applied and insufficient** — the widening is
> verified present on the cue sink at `discont-wait = 1 hour` and the gating persists anyway.
> The `zero%` reading table below is still the right next reading and is now *more* decisive,
> because §10.7's device test tells you which half of it you are in.

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

---

### §10.7 — the gate is LOCALISED to the cue branch (2026-08-10, night)

**This is the first measurement in the investigation with a control.** Every previous capture
either faded main out (so there was nothing to compare against) or was read on one pair only.
A 120s take (`/tmp/longrun.wav`, 51 gestures) with **both** outputs live, read per-gesture on
both channel pairs:

| | main (`0,1`) | cue (`2,3`) |
|---|---|---|
| audible fraction of a gesture, mean | **94%** | **21%** |
| gestures ≥80% audible | **49/50** | **1/50** |
| longest gesture (6.18s) | 95% | 4% |

Same feeder, same content, same hand, same 25ms windows, same device. **Everything upstream of
the tee is exonerated by construction** — main and cue are fed from the same buffers, and main
does not gate. Whatever this is, it is in the cue branch or below it.

This also corrects the base rate the investigation has been carrying. It is **not** "roughly 1
audible gesture in 7" with an unknown trigger: essentially *every* gesture gates, and what
varies is how long the audio survives first. Measured from `feeder start`, across two takes
(n=13 and n=51): onset at p50 0.11s, audio dies at p50 ~0.4–0.5s, then digital zero for the
remainder — up to 5.8s of it in one 6.18s gesture. The "1 in 7" was the perceptual read of a
gesture whose audible head happened to be long enough to notice.

#### Event density correlates, and cannot be the mechanism

Ranking all 51 gestures by survival and contrasting the longest third against the shortest
third, the whole event-delivery cluster moves together and coherently:

| field | sustained | gated |
|---|---|---|
| `targets/s` | 29.2 | 17.2 |
| `gap_p50` | 28.8ms | 52.6ms |
| `gap_p90` | 62.0ms | 125.4ms |
| `gap_max` | 111.8ms | 238.5ms |
| `rate mean` | 0.25 | 0.17 |
| `arrived%` | 4.9 | 10.3 |

This matches the user's own report that it is "specific to the way the events arrive", and it
is a real effect. **It is still not the cause**: main sees *identical* event delivery — the
same gestures, the same targets, the same gaps — and stays 94% audible. Event density
modulates the severity of a fault that lives downstream of it. This is very likely why jog
rate has repeatedly "looked like a control variable" (§10.6) without ever being established:
it is correlated with the outcome and causally upstream of nothing.

#### §10.3's status changes: the fix is applied AND insufficient

§10.6's table records the sink-alignment hypothesis as refuted, "fixed anyway, correct on its
own terms". The first half is now verified against the running binary and the second half is
now known to be beside the point. During the capture above:

```
scratch: sink alignment widened (defaults 40ms/1000ms) — read back:
  pulsesink0=2000ms/3600000ms  pulsesink1=2000ms/3600000ms
```

Build `f0ef269 (clean)`, so not a stale-binary artifact. There are exactly two `pulsesink`s in
the process — `deck-0/0` (main) and `deck-0-cue` — so both entries in that read-back account
for both sinks, and the cue sink genuinely holds `discont-wait = 1 hour`. A sink that cannot
resync for an hour gated 79% of every gesture anyway.

**The correct status is therefore not "refuted" but "correctly applied, and does not explain
the fault".** Keep the widening — it fixed a real, separate fault
(`scratch-audio-downstream-delivery.md`) and `pipeline.rs`'s `scratch_fed_sinks()` doc comment
describes the mechanism accurately. Just stop treating the cue sink's ringbuffer as the
explanation for *this*.

#### Next reading: the H1 topology test, now the leading candidate

§10.6's last table row — "the loss is below GStreamer → the two-`pulsesink`s-on-one-node
topology" — is where the evidence now points, by elimination rather than by a new idea. Both
sinks target the **same node**:

```
[audio/deck-0/0]   sink: pulsesink device="alsa_output.usb-…Starlight-00.analog-surround-40"
[audio/deck-0-cue] sink: pulsesink device="alsa_output.usb-…Starlight-00.analog-surround-40"
```

**Move the cue output to a different device and re-capture.** No build required — it is a
Settings change. It splits the remaining space cleanly:

| result | conclusion |
|---|---|
| gating disappears | the two-sinks-on-one-node topology (`audio-dropout-mid-playback.md` H1) |
| gating follows cue to the new device | the cue branch itself (`cue_valve` / `cue_volume` / mix-matrix) |

Run the `[level/` `zero%` table from §10.6 in the same session — with the branch/topology
question answered, those probes become decisive rather than suggestive.

#### Tooling: `scratch-envelope.py` reworked (uncommitted at time of writing)

The script's own defaults were part of why this took so long, and three of its failure modes
were the *same* failure mode — presenting an assumption as a measurement:

- **`--channels` now defaults to `auto`**, picking the pair that carries signal and printing
  both p90s. The old fixed `0,1` default reported `CLEAN` for a take whose headphone channels
  were at digital zero (§10.5), and later reported `100% silent / longest silence 0.000s` with
  **no verdict at all** for a take whose mains were deliberately faded out. It warns when the
  two pairs are within 3 dB and the pick is therefore near-arbitrary.
- **A pair that is all-silent now says so explicitly.** It previously fell out of the `if
  loud:` block and printed nothing after the silence count, which reads exactly like a clean
  run.
- **The cross-pair note compares levels instead of asserting.** It used to print "this pair is
  SILENT while the analysed pair is not" from the dead-fraction alone — backwards whenever the
  analysed pair was the dead one. It now separates a *dead* pair from a **live but gated** one
  (`LIVE (-16.9 dBFS at p90) but 32% digitally zero`), which is the fault signature and was
  previously reported as "expected".
- **`--extract OUT.wav`** writes the analysed pair as plain stereo so the capture can be
  *listened to*, not just tabulated — reporting headroom and refusing to silently clip. Every
  other output of that script is a number about the signal, and numbers are what sent this
  investigation to the wrong channel pair for a session.
- **`--by-gesture`** ranks each `feeder start`/`stop` gesture by survival time and contrasts
  the extremes, with the tel fields joined. It refuses to draw the contrast when no gesture in
  the take stayed audible for ≥70% of its length: ranking an all-failing take sorts failures by
  degree, and "least-bad failure vs worst failure" looks identical to "success vs failure"
  while flagging fields that have nothing to do with the fault.

⚠️ **Capture the working state, not more of the broken one.** The instinct to capture "one long
continuous gesture" is wrong here — the failing state is already over-sampled at n=64 across
two takes. What is uncharacterised is the state where audio *keeps going*, so a useful take is
a long one containing many varied turns including whichever ones sound continuous to the
listener. `--by-gesture` then sorts them out; nothing has to be marked by hand.

---

### §10.8 — the device test: gating GONE on a separate cue device (2026-08-10, night)

**User-observed, not captured** — and the observation is sufficient. Cue output moved from the
Starlight (shared with main) to **USB AUDIO CODEC**; the jog "plays without any issue". Against
a baseline of 21% mean audible and 1/50 gestures ≥80% (§10.7), and against a prediction made
before the test, that is not a margin a capture would adjudicate.

**H1 — two `pulsesink`s on one PipeWire node (`audio-dropout-mid-playback.md`) — is now the
leading explanation** for the cue gating, promoted from a background possibility.

⚠️ **But the test moved two variables, and the confound is not yet closed.** Cue went from
*sharing the Starlight node* to *a different physical device*, so it does not separate:

| candidate | still alive? |
|---|---|
| two `pulsesink`s on one node (H1) | yes — leading |
| something specific to the Starlight's `RL,RR` on the `analog-surround-40` profile (mix-matrix, rear pair) | **yes — not excluded** |

**The disambiguating test is the one §10.6 originally specified, and it takes two minutes**:
leave cue on the Starlight `RL,RR` and move **main** to another device. That removes the
shared-node condition while leaving the cue path exactly where it was.

| result | conclusion |
|---|---|
| cue plays fine | H1 confirmed; Starlight rear pair exonerated |
| cue still gates | the Starlight rear pair / surround-40 profile, not the topology — different fix entirely |

**Do not write H1 into `audio-dropout-mid-playback.md` as settled until that arm runs.** The
two takes differ in what they'd have you fix: H1 points at the sink topology (one sink per
device, or a shared sink with a mix-matrix), the other at this device's rear-channel path.

Worth capturing once either way when convenient — `--by-gesture` on a working take is the first
positive class this investigation would have, and "what does a healthy gesture's envelope
actually look like" is currently unmeasured.

---

### §10.9 — the complementary arm ran: H1 CONFIRMED, the rear pair exonerated (2026-08-11)

**User-observed, and it is the arm §10.8 specified in advance.** Main was moved to
`USB AUDIO CODEC`; cue was left on `DJControl Starlight — Rear`. The jog "works flawlessly".

| arm | main | cue | cue during a jog gesture |
|---|---|---|---|
| baseline (§10.7) | Starlight Front | Starlight Rear | **21% audible**, 1/50 gestures ≥80% |
| §10.8 | Starlight Front | USB CODEC | fine |
| **§10.9** | **USB CODEC** | **Starlight Rear** | **fine** |

This is what closes it. In §10.9's arm the cue branch is on the *same device*, the *same*
`RL,RR` pair, the *same* `analog-surround-40` profile, and runs the *same* `compute_cue_remap`
4-channel mix-matrix code path as the failing baseline. Every candidate §10.8 left alive on the
cue side is held fixed. Only main moved, and only co-tenancy on the node changed.

**Both arms of the pair now work and the paired configuration does not** — which is the shape
that licenses the causal claim. Against §10.7's 21%-audible / 1-in-50 baseline, neither
observation needs a capture to adjudicate.

#### What this rules out, and one thing it does not

Ruled out by §10.9 specifically, in addition to the four already refuted in §10.1–§10.4:

- the Starlight's rear pair, the `analog-surround-40` profile, and anything about `RL,RR`;
- the cue branch's `mix-matrix` / `ch_conv` / `ch_caps` chain (it ran unchanged, and worked);
- anything in the cue branch's own topology — valve, `cue_volume`, `cue_queue`, its `async=false`
  sink — for the same reason.

⚠️ **Not settled: whether co-tenancy is fatal on *any* node, or only on this one.** The
Starlight node differs from the USB CODEC in ways that could plausibly make two streams harder
to merge, and none of them have been varied:

| Starlight (`analog-surround-40`) | USB AUDIO CODEC |
|---|---|
| **44100 only** (`/proc/asound/card1/stream0`), while PipeWire's `clock.allowed-rates` is `[ 48000 ]` and cuemark's capsfilter pins 48kHz (`pipeline.rs`) — so every stream to it is resampled | 32000/44100/**48000**, native match, no resample |
| full-speed USB, **ASYNC** endpoint with a separate feedback endpoint (`0x81`) | **ADAPTIVE** endpoint |
| 4ch S24_3LE, one PCM, `subdevices_count: 1` | 2ch S16_LE |
| main arrives as a **stereo** stream, cue as a **4-channel** one — two different layouts on one node | both branches plain stereo |

**The disambiguating test, ~2 minutes and no code**: set main *and* cue both to
`USB AUDIO CODEC`, pull main volume to 0 so cue is audible alone, and jog.

| result | conclusion | fix |
|---|---|---|
| cue gates | co-tenancy is generic | §10.10 C is mandatory |
| cue is clean | something about this node makes co-tenancy fatal | §10.10 B suffices |

The last row of that table — mismatched channel layouts on one node — is the cheapest mechanism
to test and is being addressed by §10.10 A regardless, because it is a real bug on its own.

### §10.10 — the fix ladder

**The hardware settles the shape of the fix.** `/proc/asound/card1/` exposes exactly one
playback PCM (`pcm0p`), `subdevices_count: 1`, `Channels: 4`, `Channel map: FL FR RL RR`. The
Starlight is physically **one 4-channel stream**. "Front" and "Rear" are channels 0–1 and 2–3 of
it; `devices.rs` splits one node into two picker entries and cuemark then opens two independent
`pulsesink`s that pipewire-pulse has to merge back into the one PCM it started as. The device
wants one stream — give it one.

Not the device's fault, and worth stating because it was asked directly:

- **No Dolby, no DSP, no internal feedback loop.** `stream0` is a bare USB Audio Class endpoint.
  "Analog Surround 4.0" is *PulseAudio's profile name* for a 4-channel analog output, not a
  surround format; the card's only profiles are `off`, `output:analog-surround-40`, `pro-audio`.
- **The device cannot be the cause at all**, independent of the above: the gating was measured in
  the PipeWire sink **monitor**, which is upstream of the DAC. Digital zeros there mean nothing
  was ever written into the mix. Those samples never reached USB.

| | change | fixes | cost |
|---|---|---|---|
| **A** | give the **main** branch the same N-channel `mix-matrix` the cue branch already has | the silent-ignore bug below; makes both streams caps-identical, testing the layout-mismatch mechanism | ~30 lines |
| **B** | **one sink per node per deck** — `tee` → main → matrix(`FL,FR`) and cue → matrix(`RL,RR`), summed by `audiomixer` into a single 4-channel `pulsesink` | co-tenancy for a single deck; both Starlight outputs usable together | moderate |
| **C** | **one output pipeline per node, shared by all decks** (`audio/mixer.rs`'s `MasterMix`, still signatures only) | co-tenancy generally | real work — each deck is its own `gst::Pipeline`, so this needs appsink→appsrc or one combined pipeline |

**C is not optional in the long run.** Each deck builds its own sinks, so **two decks playing to
one device is already two `pulsesink`s on one node**, before cue is involved — the same hazard,
and plausibly a component of `audio-dropout-mid-playback.md` as well. A is on the path to B, and
B is on the path to C; none of them is thrown away.

#### The silent-ignore bug A fixes

**Selecting "DJControl Starlight — Rear" as a *main* device does nothing.** The cue branch
parses the `@RL,RR!FL,FR,RL,RR` suffix and builds a mix-matrix; the main branch calls
`make_sink(dev)`, which strips everything after `@` and emits plain stereo. Main audio goes
wherever pipewire-pulse's channelmix puts it, regardless of which pair was picked. The picker
offers the choice and the pipeline discards it, with no log line saying so — belongs in
`silent-failure-inventory.md`.

#### A, as built (2026-08-11)

`compute_cue_remap`/`CueRemap` are now `compute_channel_remap`/`ChannelRemap` — they serve both
branches. Device-id parsing moved into `parse_device_remap()` and element construction into
`make_remap_chain()`, so main and cue build the identical chain from the identical parse.

Error handling is deliberately **asymmetric**, and the asymmetry is the point: an unparseable
device id routes the *cue* branch to `fakesink` (never an unmapped real sink — that is the
same-channel collision that deadlocked PipeWire system-wide on 2026-08-02), while a *main*
branch logs at error level and falls back to a plain stereo sink. Silently muting the master
output mid-set is worse than a routing error, and plain stereo is what main did unconditionally
before this change, so the fallback is not a new risk.

⚠️ **Log labels changed, which matters for reading the excerpts in §10.3 and §10.5 above.**
The caps probes are now branch-prefixed (`cue ch_conv.sink (mix-matrix in)`, `main0 ch_caps.src
(to sink)`), and there is a new level probe, **`main0 post-matrix (to sink)`**. That last one is
the point of the exercise: the main reference used to sit at `volume`'s src and cue's at
`ch_caps`, one stage apart — a difference in the instruments rather than in the signal, which
is precisely what §10.5 is about. Both branches can now be read at the same graph position.
`main vol0 (reference)` is kept as the 2-channel pre-matrix reading.

Reading the new probe: main shows `-inf/100%z` on channels 2,3 and cue on channels 0,1. That is
the mix-matrix working as designed, exactly as §10.6 already warns for cue. The fault signature
is a **target** channel going to `100%z` while the other branch's target stays live.

Verified: the exact chain the code now builds negotiates on the real node —
`stereo(0x3) → mix-matrix → 4ch(0x33) → pulsesink(Starlight)` reaches PLAYING with no
renegotiation and no error, checked with `gst-launch-1.0` and `wave=silence` outside the app.
Six unit tests cover the matrices, the complementarity of front/rear, and the malformed-id
cases (`channel_remap_tests`). **Not yet live-tested** — audio always needs a live pass.

A also removes `compute_cue_remap`'s `target == "FL,FR"` early return, which had the same shape:
"the front pair needs no remap" was true only because an unmapped stereo stream *happens* to
land on the first pair. Making it explicit costs nothing and means a 4-channel node always gets
a 4-channel stream from every branch, which is the property B needs anyway.

### §10.11 — two more arms: layout mismatch REFUTED, co-tenancy is NOT generic (2026-08-11)

Both user-observed, immediately after A shipped.

| arm | main | cue | layouts | cue during jog |
|---|---|---|---|---|
| 5 | Starlight Front (**4ch**, post-A) | Starlight Rear (4ch) | **identical** | **still gates** |
| 6 | USB CODEC, volume 0 | USB CODEC | identical (stereo) | **fine — continuous scratch audio** |

**Arm 5 refutes the layout-mismatch mechanism.** Before A, main was a stereo stream and cue a
4-channel one on the same node, which was the cheapest remaining candidate. With A they are
caps-identical and complementary (verified: `stereo(0x3) → mix-matrix → 4ch(0x33)`), and the
gating is unchanged. **Keep A anyway** — it fixes the A12 silent-ignore, and B needs the matrix
machinery regardless — but it is not the fix and was not expected to be.

🔴 **Arm 6 is the surprising one, and it overturns §10.9's "generic co-tenancy" branch.** Two
`pulsesink`s on one node, one deck, a scratch gesture — the exact fault condition — and it is
**clean** on the USB CODEC. (The topology is intact: a `volume` element at 0 still pushes
buffers, so the main sink's PipeWire stream is open and streaming throughout; the test only
makes cue audible in isolation.)

#### The condition, restated

| | Starlight | elsewhere |
|---|---|---|
| **two** sinks on the node | 🔴 gates (arms 1, 5) | 🟢 fine (arm 6) |
| **one** sink on the node | 🟢 fine (arms 2, 3) | 🟢 fine |

**Two sinks and the Starlight are each necessary and neither is sufficient.** Every simple
one-variable story is now dead: it is not the device alone, not co-tenancy alone, not the rear
pair, not the profile, not the channel layout, and not the cue branch's own topology.

⚠️ **Do not reach for the obvious next hypothesis without an instrument.** The Starlight differs
from the CODEC in at least four ways that could each plausibly make a second stream fatal —
44100-only against a graph pinned to 48000 (so every stream is resampled), a full-speed **ASYNC**
endpoint with a separate feedback endpoint against **ADAPTIVE**, 4ch S24_3LE against 2ch S16_LE,
and `priority.driver = 1009`. Four candidates and one bit of evidence is exactly the ratio that
produced the two hypotheses that died on their first controlled arm (§10.1, §10.4). What has
genuinely improved is that there is now a **positive control**: arm 6 and arm 5 are the same
topology, the same code path and the same gesture, differing only in the device. Any proposed
mechanism must predict the difference between *those two*, and can be checked against a working
state rather than only a broken one.

**The reading that would name it**, if anyone wants the mechanism: `pw-dump` both client streams
mid-gesture in arm 5 and arm 6 and diff them — negotiated rate, format, quantum, and each
stream's state. That is the first measurement in this investigation with a matched working pair.

#### What it means for the fix

**The mechanism is not needed to fix it.** Arms 2 and 3 prove that one sink on the node is
sufficient, whatever the mechanism is, so the ladder still ends in the same place. But the
weighting changes:

- **B (one sink per node per deck) is no longer "enough".** It fixes the *single-deck* case —
  which is the original request, front and rear usable together — but a second loaded deck puts
  a second sink back on the Starlight node and the condition returns. B halves the count; it
  does not reach one.
- **C (one output pipeline per node, shared by all decks) is the only configuration that
  reaches one sink on this hardware**, and today's live topology is up to *four*.
- Arm 6 does soften C's other justification: two decks on a well-behaved stereo device look
  fine, so C is about *this device* rather than about co-tenancy in general.

### §10.12 — the matched-pair reading: nothing distinguishes the branches (2026-08-11)

`scripts/probes/shared_node_stream_diff.py`, 15s per arm, both branches live, jogging
throughout. Arms as specified in §10.11 — the same topology and code path, differing only in
device. (A third take exists from a mislabelled first attempt that was still on the CODEC;
`starlight-shared-095642` is the real failing arm, confirmed by its `target` fields.)

| | Starlight (failing) | USB CODEC (working) |
|---|---|---|
| `deck-0/0` (main) | 3840 quant, 48000, F32LE 2ch, running, **0 xruns** | identical |
| `deck-0-cue` | 3840 quant, 48000, F32LE 2ch, running, **0 xruns** | identical |
| device node | **quant 2048**, 48000, **busy 125–315µs** | **quant 512**, 48000, **busy 13–45µs** |
| device xruns | 0 accrued | 0 accrued (a flat 588 from earlier in the session) |

🔴 **The two branches are indistinguishable from each other, in both arms.** Same quantum, same
rate, same negotiated format, same `running` state for every sample, no xruns, comparable
wait/busy. **Whatever gates the cue branch does so without PipeWire noticing anything at all.**

This is the "no difference in these fields" outcome the probe warns about in advance, and it is
a real result, not a failed measurement. It rules out a class rather than a hypothesis: the cue
stream is **not** being suspended, **not** renegotiating mid-gesture, **not** xrunning, and
**not** getting a different quantum, rate or format from the main stream sitting beside it on
the same node. Every mechanism of that shape is dead.

⚠️ **The `588` on the CODEC device is not a finding** — it is flat across all 15 samples, i.e.
accrued earlier in the session, zero during the take. This is exactly the trap the probe's
`xrun_delta` exists for; a max−min reading would have reported "588 xruns in the working arm"
and inverted the conclusion.

#### The one measured difference, and the cheap test it earns

The device nodes differ in two linked ways: the Starlight runs at **quantum 2048 against the
CODEC's 512**, and costs **~10× more CPU per cycle** (busy ~250µs mean against ~25µs).

2048 is exactly `clock.max-quantum` in this machine's PipeWire settings — **the Starlight node
is pinned at the graph's ceiling**, not sitting at a comfortable value it chose. The elevated
busy time is consistent with what that node has to do that the CODEC does not: resample every
stream 48000 → 44100 (the hardware is 44100-only, §10.9) across 4 channels, then mix.

⚠️ **This is one measured difference, not a mechanism.** It is device-level and applies to both
streams equally, while only cue gates — the same shape of objection that retired jog rate as a
control variable in §10.7. It is worth testing only because it is a **config knob rather than a
code change**, so it costs minutes:

```bash
pw-metadata -n settings 0 clock.force-quantum 512   # then jog on the shared Starlight config
pw-metadata -n settings 0 clock.force-quantum 0     # revert
```

| result | meaning |
|---|---|
| gating changes with quantum | a mechanism at last, and possibly a zero-code workaround |
| gating unchanged | quantum is a correlate of the device, not the cause — stop here and build the fix |

`CUEMARK_SINK_BUFFER_MS` / `CUEMARK_SINK_LATENCY_MS` vary the *stream* side of the same question
without a rebuild (`sink_buffer_times()`), if the device side moves nothing.

**Either way the fix does not change.** One sink on the node is proven sufficient by arms 2 and
3, and §10.11's ladder stands. If the quantum arm comes back negative, the remaining tap is
below PipeWire — ALSA/USB — and that is a much larger investigation than simply not putting two
streams on this node.

#### Probe defects found by running it before trusting it

Four, all of which would have produced a confident wrong reading, and all fixed:

- `ERR` is cumulative, so max−min charged a suspended node's whole history to the take —
  **read 588 xruns on a device that had none in the window.**
- An inactive node reports `quant=0`, so every take showed two quantum values and looked like a
  mid-gesture renegotiation.
- `pw-dump <id> <id>` returns an **incomplete** set on this PipeWire (two ids in, one object
  out), silently dropping one branch's state for a whole take and printing it as `state=?` — a
  missing measurement that reads like a finding. It now dumps fully and filters locally.
- pw-top's first column is the node's **state letter**, and `S` there means *suspended* — so
  detecting the header with `startswith("S ")` also matched every suspended node's row and
  discarded it. Harmless for a node that is inactive anyway, but a watched node going suspended
  mid-gesture is precisely the event being hunted. (Verified not to have cost data in these two
  takes: all three watched nodes have a complete 15 rows in both.)

### §10.13 — quantum is the control variable, and cuemark sets it (2026-08-11)

🟢 **`pw-metadata -n settings 0 clock.force-quantum 512` makes the jog work on the shared
Starlight configuration** — main on Front, cue on Rear, the arm that has failed every time since
§10.7. User-observed, against a 21%-audible baseline.

That is the first thing in this investigation that *changes* the fault rather than relocating
it, and it identifies a control variable at last: **the device node's quantum**.

#### Where the 2048 came from — cuemark, not the device

`clock.force-quantum` is a poor fix: it is global to every app on the machine and does not
survive a PipeWire restart. So the question is whether cuemark can reach the same quantum by
itself. Measured directly, outside the app, one silent 4-channel `pulsesink` on the Starlight:

| `pulsesink` property | device QUANT | stream QUANT |
|---|---|---|
| `buffer-time=200ms` (**cuemark's compiled default**) | **2048** — exactly `clock.max-quantum` | 3840 |
| `buffer-time=50ms` | **512** | 960 |
| `buffer-time=20ms` | **512** | 960 |
| `latency-time` 20ms / 10ms / 5ms (buffer-time held at 200ms) | **2048 throughout** | — |

**`buffer-time` is the lever and `latency-time` is not** — tested before being assumed, and the
obvious guess (`latency-time`, the period-size knob) was the wrong one. cuemark's own
`sink_buffer_times()` default of 200ms is what pins this node at the graph ceiling. So the fix
is available in-app as a constant, with `CUEMARK_SINK_BUFFER_MS` as the no-rebuild lever.

#### ⚠️ The tension this walks into, and why the old reasoning may not hold

`sink_buffer_times()` was raised **50ms/10ms → 200ms/20ms on 2026-08-02** precisely because
50ms caused "live-confirmed choppiness on USB audio", justified in its doc comment as *"the old
value was ~1.17 graph quanta"*. That arithmetic checks out only against a **2048** quantum:
50ms ÷ 42.7ms = 1.17.

**But quantum and buffer-time are not independent — they move together**, which is exactly what
the table above measures. At `buffer-time=50ms` the node runs at 512 (10.7ms), so the ringbuffer
is **4.7 graph quanta**, not 1.17 — the identical ratio to today's 200ms ÷ 42.7ms. The 2026-08-02
premise assumed the quantum would stay at 2048 while the buffer shrank. If that is what
happened, the choppiness was a consequence of holding one variable fixed that does not hold
fixed, and lowering `buffer-time` now may not reproduce it.

⚠️ **"May not" is not "will not" — this is the known risk of the change and the thing to watch
for.** Choppiness during ordinary playback is the regression signature, and this pipeline
**cannot see clipping** (`audio-dropout-mid-playback.md`): the gap warning needs >1s of silence
and `underrun` needs starvation, so a clean log and a clean-sounding set are very nearly
independent statements. Judge this one by ear over a real session, not by grepping.

#### What it does to the fix ladder

If a lower `buffer-time` holds up, **this bug is a one-constant fix and neither B nor C is needed
for it.** That would be a much better outcome than the architecture change, and it is why the
quantum arm was worth running before building anything.

It does not retire B/C on its own terms — one sink per node is still the right shape for a
device that is physically one 4-channel PCM (§10.10), and `audio-dropout-mid-playback.md`'s
four-`pulsesink` topology is unaffected by any of this. But they stop being *this* bug's fix.

⚠️ **Quantum being a control variable does not make it the mechanism.** §10.12 still stands:
the two branches are indistinguishable at the PipeWire layer, and nothing yet explains why a
large quantum starves *cue* while *main* — same node, same quantum, same buffers — plays
normally. A control variable that changes the symptom is worth shipping; it is not an
explanation, and the file should not be closed as though it were.

⚠️ **C is not a mechanical extension of B.** Each deck is its own `gst::Pipeline`, and its
`pulsesink` is what provides the pipeline clock, the position query and the scratch feeder's
timing reference — all of which CLAUDE.md flags as delicate and previously-broken. Moving the
sinks into a shared output pipeline (deck appsinks → per-node appsrc → `audiomixer` → matrix →
one sink) makes the deck pipelines sink-less and changes the clock architecture. **That wants a
design doc before code**, not an incremental patch.

### §10.14 — FIXED, live-confirmed (2026-08-11). One sink per node.

🟢 **The cue branch survives a scratch on the shared Starlight configuration** — main on
Front, cue on Rear, the arm that has failed every time since §10.7. User-confirmed live,
against a 21%-audible / 1-in-50-gestures baseline. **Position tracking is honest too**, which
was the other gate (see below — it was not free).

The fix is rung **C** of §10.10's ladder, built the same day:
`docs/design/shared-output-pipeline.md` is the design of record and `audio/mixer.rs` is the
implementation. Every *device node* now gets exactly one `pulsesink`, fed by an `audiomixer`
summing one live `appsrc` per deck branch; deck pipelines terminate in `appsink`s and hand
buffers across. Enabled by `CUEMARK_SHARED_OUTPUT=1`.

**Why this closes it without naming the mechanism.** §10.11 established that two sinks *and*
the Starlight are each necessary and neither sufficient, and §10.12 established that the two
streams are indistinguishable at the PipeWire layer in both the failing and the working arm.
The mechanism is still unnamed. What arms 2, 3, 5 and 6 did establish is that **one sink on
the node is sufficient**, whatever the mechanism is — so the fix is to reach that
configuration, and this reaches it structurally rather than by tuning. ⚠️ **Do not record
this file as explaining the fault.** It explains the fix. If someone later needs the
mechanism (e.g. it resurfaces on other hardware), §10.12's last paragraph is the live end:
the remaining tap is below PipeWire, in ALSA/USB.

#### The §10.13 quantum lever is a dead rung

`clock.force-quantum 512` worked once, and §10.13 speculated that cuemark could reach the
same quantum by itself via `sink_buffer_times()`'s `buffer-time`. **Re-tested and it does not
hold** — the gating returns after a short playback duration (user-observed, 2026-08-11). So
the quantum is a control variable that can *move* the symptom without fixing it, which is
consistent with §10.12's finding that it applies to both streams equally while only cue
gates. It stays a correlate. `sink_buffer_times()` keeps its 200ms default and the 2026-08-02
choppiness reasoning stands untouched.

#### What the fix cost, and the two bugs the build found

Both were caught by a hardware test written alongside the code, and both would have been
**silent** in production — the recurring shape in this whole investigation.

1. **An `audiomixer` with no request pads cannot reach PLAYING.** The node's clock and
   latency are read at creation, and are needed *by* the first branch attaching — so the
   ordering was circular. It sat in PAUSED for the full 5s timeout.
2. **`set_state(Playing)` returns before a clock is selected**, so `pipeline.clock()` read
   `None`. Nothing errors on that; every deck just quietly runs on the system clock.

Fixed with a **permanent silent keepalive source** on every node's mixer
(`audiotestsrc wave=silence is-live=true`) plus waiting for the state change to settle. The
keepalive also makes retained nodes coherent: a node whose last branch detaches would
otherwise run dry, EOS, and never resume.

#### ⚠️ Position had to be corrected, and nothing would have reported it

`GstAudioBaseSink` reported position as what the *device* was playing, netting out its own
200ms ringbuffer. An `appsink` reports the last buffer it handed off, which the output graph
then buffers again. **Measured: 171.3ms on the Starlight.** Uncorrected, every deck reads
that far ahead of what is audible — and since audio is the master clock, video leads audio by
a sixth of a second everywhere, constantly. It is a fixed offset, not a drift, so it presents
as "the video decoder is early" and would be chased in entirely the wrong file.
`position()` now subtracts `OutputGraph::latency_ns`.

#### Two instruments changed meaning, and both were caught mid-session

Recorded because reading either one the old way would send the next session backwards:

- **`output_queue underrun` now fires continuously during ordinary playback** on the shared
  path — 67/s, through a clean 4-minute take. The `appsink` renders just-in-time, so the
  queue is empty between every buffer by construction. This is the same structural artifact
  already documented for the scratch feeder, now the steady state. It has been **downgraded
  to info with honest wording** on this path only; the legacy path keeps the warning, where
  it still means what it always meant. A warning that always fires is worse than no warning.
- **The scratch sink-alignment widening reports `SKIPPED(no property)`** for every branch,
  where §10.3 taught people to expect `discont-wait = 1 hour` read back live.
  `alignment-threshold`/`discont-wait` are `GstAudioBaseSink` properties and an `appsink` is
  not one. It is correct and expected: re-stamping at the handoff means the shared
  `pulsesink` never sees a discontinuity to resync on, so the widening has nothing left to
  do. Do not read `SKIPPED` as the fix having fallen off.

#### One design claim that reality corrected

The design says deck pipelines adopt the *device's* clock so production and consumption rates
agree. In practice the graph runs on **`GstSystemClock`** and `pulsesink` slaves its device to
it (`slave-method=skew`, its default) — `GstAudioBaseSink` cannot provide a clock until its
ringbuffer is acquired, which on a live pipeline is after `GstBin` has already picked one.
**Rate agreement still holds**, which is the property that matters: both sides of the handoff
run at system-clock rate and the device difference is absorbed inside `pulsesink`, which is
that element's job. Verified live: 4 minutes with `lag=0 drop=0` on both handoffs. The log
line now says which clock was chosen and why, so this cannot silently drift out of date.

#### Still open in the neighbourhood

- ✅ **Multi-deck and multi-node — DONE 2026-08-11** (stage 4 of the design doc, same day).
  Two decks on one node — the case that motivated C in the first place — plus a second node
  concurrently, both live-confirmed.
- ✅ **`CUEMARK_SHARED_OUTPUT` now defaults on — DONE 2026-08-11** (stage 5), closed by a
  600s real-hardware soak (`shared_output_soak`, `pipeline.rs`): 13 device rebuilds, 0
  stuck-after-rebuild, 0 handoff drops. `=0` still reverts to the legacy path.
- `audio-dropout-mid-playback.md`'s H1 is the same hazard and should be re-read against this
  fix — but it is a *different* fault (silence mid-playback, no scratch involved) and the
  shared graph has not been soaked for it specifically.
