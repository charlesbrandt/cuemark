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
