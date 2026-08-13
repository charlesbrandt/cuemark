# Silent failures — inventory and remediation plan

**Status**: catalogue only. Nothing here is scheduled; this exists so a future session can
pick items off it deliberately instead of rediscovering them one live gesture at a time.

## Why this document exists

Cuemark's dominant failure mode is not the crash. It is the call that returns success while
doing nothing, the guard that gates nothing, and the instrument that reports healthy about a
thing it cannot see. `journal.md` called this the "silent-ignore" note; CLAUDE.md repeats
some version of "verified empirically, it does not throw" a dozen times. The cost is not
mainly debugging time — it is **wrong conclusions held with confidence**, several of which
shipped.

The proximate trigger, 2026-08-10: chasing `slow-jog-audio-inaudible.md`, the plan was to stop
reading telemetry and capture the real signal. Two silent failures fired inside that single
step.

1. `audio_record_start/stop` — the command the design doc named as the next instrument — is
   a **stub**. It logs `[record] start recording to …`, sets `active = true`, returns
   `Ok(())`, and writes no file. The encoder chain is still marked "Step 8".
2. Its replacement, `pw-record --target <sink>`, **captured the wrong device**. `--target`
   resolves against *sources*; a sink's `node.name` matches none, so it fell back to the
   default source — a Zoom H1n microphone — and recorded 15 seconds of the room. The
   analysis was internally consistent, plausible, and reported **CLEAN**. It was caught only
   because the numbers matched an idle control take to within 0.7 dB.

A newly-written diagnostic tool failed silently *while being used to diagnose a silent
failure*. That is the argument for treating this as a class rather than as a series of
one-off bugs.

## The catalogue

Every entry is a confirmed, previously-observed instance with its source. Nothing here is
speculative.

### A. Calls that report success while doing nothing

| # | Thing | What it does instead | Source |
|---|---|---|---|
| A1 | `audio_record_start/stop` | flag + log line, no file | `src-tauri/src/audio/record.rs` |
| A2 | `pw-record --target <sink>` | records the default **source** | `scripts/scratch-capture.sh` |
| A3 | `pulsesink` with unresolvable `device=` | falls back to system default sink | `make_sink()` NOTE, `pipeline.rs` |
| A4 | `VideoDecoder.isConfigSupported({av01…})` | returns `true`, then decodes **zero frames** | `legacy-video-fallback-cost.md` |
| A5 | `UNPACK_FLIP_Y_WEBGL` on an `ImageBitmap` source | ignored; no GL error, no exception | CLAUDE.md, `fbo.ts` |
| A6 | `createImageBitmap(…, {imageOrientation:'flipY'})` on a `VideoFrame` | ignored; ships the projector upside down | CLAUDE.md, `outputBus.ts` |
| A7 | All GPU→CPU readback on Mesa `crocus` | transparent/zeroed buffer; **none of them throw** | `docs/upstream/webgl-canvas-readback-broken.md` |
| A8 | `media.name` in `stream-properties` | appears to work, silently overwritten by track tags | `make_sink()`, `pipeline.rs` |
| A9 | `GST_PLUGIN_FEATURE_RANK` VA-API demotion | a **no-op** — no VA-API driver exists on this machine | CLAUDE.md |
| A10 | CSS `width` on a `<canvas>` in a flex child | silently falls back to the 300px intrinsic default | CLAUDE.md "Canvas sizing rule" |
| A11 | `texImage2D(…, null)` | allocates, leaves contents **undefined** | `compositor.ts` / `fbo.ts` |
| A12 | Picking a channel pair ("— Front"/"— Rear") for a **main** device | discarded — `make_sink()` strips everything after `@` and nothing else read the suffix, so main went out as plain stereo wherever pipewire-pulse's channelmix put it. The picker offered the choice and the pipeline dropped it with no log line. **Fixed 2026-08-11** (`parse_device_remap` now runs on main branches too) | `slow-jog-audio-inaudible.md` §10.10, `pipeline.rs` |

### B. Guards and checks that gate nothing

| # | Thing | Why it never fired | Source |
|---|---|---|---|
| B1 | `currentTime !== lastDrawnTime` preview change-check | `currentTime` advances continuously here, so every deck drew on 100% of rAF ticks | `legacy-video-fallback-cost.md` |
| B2 | Svelte store-equality check on the scratch path | reference equality passed on a mutated object | `project_pcm_scratch_status` |
| B3 | `0.0_f64.signum()` returns **1.0**, not 0.0 | every stationary chunk read as "moving forward"; reverse gestures reversed from a direction they never had | `pipeline.rs` feeder loop |
| B4 | Tests that pass on both the old and the new code | asserted a property the bug did not violate; twice | `sparse_slow_hand_stays_audible`, `forward_gesture_never_reverses_the_aim_point` |
| B5 | `[jog-cal]`'s suggested constant | computed from an unverifiable premise (exactly one revolution) and printed as a number | `slow-jog-audio-inaudible.md` §3.3 |

### C. Instruments healthy about things they cannot see

| # | Thing | The blind spot | Source |
|---|---|---|---|
| C1 | Feeder `rms` | **frequency-blind** — content shifted down four octaves reports the same level | `pipeline.rs`, `slow-jog-audio-inaudible.md` §9 |
| C2 | `output_queue underrun` | fires once per chunk *by construction* during a scratch (66.8/s vs a 66.7/s chunk rate) | `instrument_queue_flow()` |
| C3 | `instrument_sink_flow()` | 6:1 false-positive rate | `audio-dropout-mid-playback.md` |
| C4 | Everything, w.r.t. **clipping** | gap warning needs >1s of silence, `underrun` needs starvation | CLAUDE.md |
| C5 | A sub-2-minute frame-rate sample | cannot measure steady state; reads as a monotonic trend either way | CLAUDE.md "VP9 decay" |

### D. Artifacts that are not the code you think

| # | Thing | Source |
|---|---|---|
| D1 | The desktop-launcher binary never auto-rebuilds — caught stale **by a month** | CLAUDE.md; `scripts/check-launcher-staleness.sh` |
| D2 | Vite serving a stale transform of a file that is correct on disk (`npm run check` passed, projector black) | CLAUDE.md |
| D3 | `built=` is when `build.rs` last ran, not when the binary was linked | CLAUDE.md |

### E. Defaults that quietly destroy evidence

| # | Thing | Source |
|---|---|---|
| E1 | `tauri-plugin-log` defaults (40KB/`KeepOne`) erased the exact window being diagnosed, twice in one day | CLAUDE.md "Logging" |
| E2 | `compute_cue_remap` treating an unparseable target as "no remap needed" would collide two sinks and **deadlock PipeWire machine-wide** | `pipeline.rs` |

## The three moves that actually work

Drawn from the instances above that were successfully fixed, not invented here.

1. **Verify the effect, never the call.** `isConfigSupported` says yes and decodes nothing;
   `pw-record` exits 0 having recorded the wrong device. The probe scripts under
   `scripts/probes/` exist because of exactly this and are the established pattern —
   `webcodecs_vp9_av1_probe.py` decodes a real file rather than asking. Extend it: every
   instrument gets a probe that proves it observes what it claims.
2. **Pre-flight the attachment and refuse to proceed.** `scratch-capture.sh` now checks
   `pw-link` and aborts before the countdown rather than after the gesture. The general
   form: before any measurement that costs a live take, assert what the tool is connected
   to. Cheap, and it converts a wasted session into a two-second error.
3. **Make the failing case loud, even when the API won't.** A3's guard is
   `AudioSettings.svelte`'s on-mount auto-heal plus a log line naming what was *asked for*;
   A11's is an explicit clear. Neither makes the underlying API throw — they make the
   discrepancy visible.

## Proposed work for a future session

Ordered by (live-cost avoided) ÷ (effort). Not scheduled.

1. **A1 — decide `record.rs`'s fate.** Either implement step 8 or make `audio_record_start`
   return `Err("not implemented")`. Returning `Ok` from a stub is the worst of both. Smallest
   item on this list and it already cost one investigation its planned next step.
2. **A3 — assert the sink actually opened.** `pulsesink` cannot tell us, but PipeWire can:
   after PLAYING, confirm via the graph that the stream is linked to the node that was asked
   for, and `log::warn!` naming both when it is not. Directly serves
   `audio-dropout-mid-playback.md`'s H1, where "two sinks on one device" is the standing
   suspect and nothing currently confirms the routing at runtime.
3. **C1 — give the feeder a spectral field.** One high-passed RMS beside the existing `rms`
   in `[scratch-tel]` would have answered the pitch-vs-gate question in the log, with no
   capture and no live gesture. The arithmetic is a one-pole filter; the pattern is already
   written in `scripts/scratch-envelope.py`.
4. **B-class — a lint pass over change-checks.** B1 and B2 are the same bug in two
   languages: a guard compared the wrong thing and silently disabled itself. Worth grepping
   every `!==`/`!=` change-check in the rAF and feeder paths and asking what proves it ever
   returns false. B4 says the test must be **run against the unfixed code** before it counts.
5. **C-class — label the blind spots in the log lines themselves.** `output_queue underrun`
   already carries a doc comment saying it adjudicates nothing during a scratch; the line it
   prints does not. Instruments that cannot see a thing should say so where they are read,
   not where they are defined.

## Added 2026-08-10 (late) — three more, two of them written during the investigation

| # | instrument | how it failed silently |
|---|---|---|
| **D1** | the widened-alignment log line | printed the **length of the slice passed in** — a count of intended writes — not what the property read back as. It reported `on 2 sink(s) incl. cue` for a build whose cue-sink behaviour was never established either way, and that reading was used to advance the investigation. Now reads each property back and prints `name=2000ms/3600000ms` or `name=SKIPPED(no property)`. |
| **D2** | `scratch_widens_sink_alignment_then_restores` | read `main_sinks_of()` alone, so it **passed green for the entire life of the bug it was written to guard** — the widening covered only main sinks and the cue sink kept stock 40ms/1s. A guard that watches a subset of the sinks the feeder feeds is not a guard. Now chains `cue_sink_of()` and asserts ≥2 sinks. |
| **D3** | `instrument_level()`'s per-channel RMS | a windowed RMS **averages a duty cycle into a level**: 25% duty cycle is −6.0 dB exactly. The cue pads read ~−25 dBFS against main's ~−19 and the gap was attributed to `cue_gain` for a full session; the device capture later measured the same branch at 81% digitally-zero windows. Now reports `dBFS/zero%` per channel. |

⚠️ **D1 and D2 were both authored during the very investigation they then misled.** That is
the same shape as §5 of `slow-jog-audio-inaudible.md`, where the capture tool built to end a
chain of wrong answers produced one of its own on first use. **A new instrument is at its
least trustworthy the moment you most want to believe it.** Check a fresh instrument against
a state whose answer you already know before you let it adjudicate anything.

⚠️ **D3 generalises past this bug.** Any windowed mean — RMS, an average rate, a p50 —
destroys the distinction between "smaller" and "intermittent". `rms` was already documented
as blind to *frequency*; it is equally blind to *duty cycle*, and both blindnesses cost this
investigation a cycle each. When a level reads low, ask whether it is quieter or chopped,
and prefer a counter that cannot conflate them.

Also fixed 2026-08-10, found while reading for D3 and unrelated to the gating:
`set_cue_gain()` computed `gain * cue_gain`, dropping `master_volume`, while the build path
and `apply_volume()` both include it — adjusting cue gain jumped the headphone branch
`1/master_volume` (2.35x) and left it wrong until an unrelated call recomputed it. ⚠️ **This
product is computed in three places and two have now been wrong at different times** — see
`pipeline.rs`'s own comment recording the identical bug already fixed once for the main
sinks. Collapsing the three to one is a real follow-up.

## E — three silent failures found building the shared output pipeline (2026-08-11)

All three are in `audio/mixer.rs`, all three were caught by a hardware test written alongside
the code, and none of them errors, warns, or shows up in any counter. They are recorded
together because they share one shape: **a GStreamer state change that returns successfully
while leaving the thing you asked for absent.**

- **E1 — `set_state(Playing)` returns before a clock is selected.** `pipeline.clock()` reads
  `None` immediately after. Nothing errors; every deck just quietly runs on `GstSystemClock`
  and drifts against the device forever, presenting as a click every few minutes with no
  instrument implicating the clock. Fix: wait for the state change to settle.
- **E2 — an `audiomixer` with no request pads cannot reach PLAYING**, and says so only by
  sitting in PAUSED until whatever timeout you happened to write. The node's clock and latency
  are read at creation and are needed *by* the first branch attaching, so the ordering was
  circular. Fix: a permanent silent `audiotestsrc` keepalive on every node.
- **E3 — an aggregator with non-live pads waits forever for data on each pad.** With
  `is-live=false` on the output `appsrc`s, the sink receives **zero** buffers for as long as
  any one branch is idle — while other branches are actively feeding. One paused deck silences
  the whole node, with no error anywhere. Measured, deliberately, as the control arm of
  `scripts/probes/shared_output_mixer_probe.py`.

⚠️ **E3's real lesson is about the probe, not the pipeline.** The main arm of that probe passed
on the first run. That PASS was worth nothing until `--not-live` demonstrated the check could
*fail* — an instrument that cannot register the failure it is claiming to rule out is not
evidence, which is the same rule §D and the standing rule below arrive at from other
directions. Build the negative arm before believing the positive one.

Two instruments also **changed meaning** under this refactor without breaking, which is its own
silent-failure class — the reading stays plausible while its interpretation rots:
`output_queue underrun` now fires continuously during ordinary playback (downgraded to info on
that path), and the scratch alignment report reads `SKIPPED(no property)` because `appsink` is
not a `GstAudioBaseSink`. Both are documented at their call sites and in §10.14.

## Standing rule

**An instrument is not evidence until you have seen what it was attached to.** Six
hypotheses in `slow-jog-audio-inaudible.md` were refuted against instruments that were all
working correctly; the seventh step failed because the new instrument was pointed at a
microphone. Both halves of that sentence are this project's normal.
