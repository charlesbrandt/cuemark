# Slow-jog scratch audio is inaudible — RESOLVED: pitched, not gated

**Status**: mechanism resolved 2026-08-10 by capturing the device monitor. **There is no
pipeline defect.** The audio is produced, delivered, and rendered continuously at a healthy
level; at the cursor speeds a jog gesture actually produces it is shifted ~3 octaves down and
is barely reproducible. What remains is a **design question about the jog mapping** (§6), not
a bug.

Renamed from `slow-jog-audio-gating.md` — the original title asserted a gate, and there
isn't one.

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
