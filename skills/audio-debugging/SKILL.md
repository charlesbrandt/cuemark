---
name: audio-debugging
description: Debug GStreamer audio issues in cuemark — bus errors, pitch element, device routing, gain staging, capturing the real device output, network/Snapcast outputs, WebKit video stream. Load this when the audio pipeline misbehaves, including "it works on one output device but not another".
---

# Cuemark Audio Debugging

## Step 1 — read the current pipeline code

```
src-tauri/src/audio/pipeline.rs   ← the whole file
```

Focus on:
- `make_sink()` — which sink is in use and how latency is configured
- The bus monitor thread — what's currently logged and which flags are set
- `set_rate()` — should be ~3 lines setting `pitch_el.set_property("tempo", rate)`; if it's longer, something regressed
- `load()` — whether `pitch.set_property("tempo", self.rate)` is called before `inner` is stored (restores rate on reload)

## Step 2 — check recent journal/git for context

```bash
git log --oneline -10
```

Then read `journal.md` for the most recent session notes.

---

## Current pipeline topology

**There are two output topologies**, selected by `CUEMARK_SHARED_OUTPUT` at deck-load time —
**defaults to the shared-output path since 2026-08-11**; set `CUEMARK_SHARED_OUTPUT=0` to get
the legacy one. Everything upstream of the `tee` is identical in both; only where the branches
terminate differs. Check which one you are debugging *before* reading any sink-side instrument
— several of them mean different things on each path (see the two warnings at the end of this
section).

Shared per deck, both paths:

```
uridecodebin → queue(max-buffers=2) → audioconvert → audioresample
  → capsfilter(48000/F32LE/2ch) → pitch(tempo) → [spectrum] → input_selector
  → output_queue(100ms) → tee ├─ volume₀ …
                              ├─ volume₁ …
                              └─ cue_valve → cue_volume → cue_queue …
```

**Legacy path (`CUEMARK_SHARED_OUTPUT=0`)** — each branch ends in its own `pulsesink`, so one
deck opens up to four, and main+cue on one device is *two sinks on one node*:

```
  … volume₀ → [mix-matrix → caps] → pulsesink₀
  … cue_queue → [mix-matrix → caps] → pulsesink_cue
```

**Shared-output path (default since 2026-08-11)** — each branch ends in an `appsink` that
hands buffers to a per-node output pipeline, which sums them into **one** `pulsesink`:

```
  … volume₀   → appsink ─┐  push_buffer
  … cue_queue → appsink ─┴─► appsrc(is-live) → queue(30ms) → mix-matrix → caps ─┐
                             appsrc(is-live) → queue(30ms) → mix-matrix → caps ─┼→ audiomixer
                             audiotestsrc(silence, keepalive) ─────────────────┘      ↓
                                                            master volume → pulsesink (N ch)
```

This is the fix for the cue-gating bug (`docs/design/slow-jog-audio-inaudible.md` §10.14);
`docs/design/shared-output-pipeline.md` is the design of record. **Read it before changing
`audio/mixer.rs`**, and run `scripts/probes/shared_output_mixer_probe.py` with its
`--not-live` control arm.

**`pitch` element** (soundtouch, `gst-plugins-bad`) — sets playback tempo without pitch change via the
`tempo` property. Set at any time; no seek, no flush, no pipeline state transition. Range: 0.1–10.0.
Requires `gstreamer1.0-plugins-bad` (`sudo apt install gstreamer1.0-plugins-bad`).

**`queue`** (input, before audioconvert) — decouples the decoder thread from audioconvert. Without it,
FLUSH seeks can hand audioconvert a buffer still held by the decoder (ref_count > 1), causing a
`gst_buffer_is_writable` assertion crash. Max 2 buffers, no byte/time limit.

**`capsfilter(rate=48000)`** — forces the downstream chain to run at 48000 Hz regardless of source
file sample rate. Without this, 44100 Hz source files cause pipewiresink to negotiate at 44100 Hz with
PipeWire, which assigns a non-power-of-two quantum (e.g. 3969 samples) → scheduling irregularities →
xruns. `audioresample` handles the actual conversion; capsfilter just locks the contract.

**`output_queue`** (after pitch) — 100ms time-based buffer between soundtouch and pipewiresink.
soundtouch produces variable-sized output chunks at non-1.0 tempos. Without buffering, PipeWire's pull
callback can fire before soundtouch has accumulated a full 1024-sample quantum → xrun. Time-based limit
(no buffer-count or byte limit) so it fills only when soundtouch is momentarily slow. **Keep at 100ms
or below** — 500ms was tried and caused audible lag after tempo changes (old-rate audio must drain before
the new tempo is heard).

---

## Why seek-based rate changes were abandoned

All seek-based approaches (FLUSH | ACCURATE, INSTANT_RATE_CHANGE, scaletempo) share a fundamental flaw:
any seek on a playing pipeline with a live PipeWire sink temporarily moves the pipeline to PAUSED for
re-preroll. With MIDI firing at 200+ events/second this is unrecoverable — a second seek fires mid-
preroll, the pipeline never returns to PLAYING. See journal.md (2026-05-05) for the full history.

**Do not attempt to reintroduce seek-based rate changes.** The property-set approach is the correct one.

---

## Current sink: pulsesink (PipeWire via the Pulse compat layer)

> ⚠️ **Changed 2026-08-02: `make_sink()` now uses `pulsesink`, NOT `pipewiresink`.**
> The native element has an AB-BA lock inversion in `libgstpipewire.so`
> (gst-plugin-pipewire 1.6.2) that deadlocks whenever **two or more `pipewiresink`
> elements in one process** go PAUSED→PLAYING with any delay between the transitions —
> which cuemark does on every play, since each deck has ≥1 main sink plus the cue branch.
> Measured 4/6 runs with two sinks, 6/6 with three, 0/6 with one; `pulsesink` is 0/6 at
> both. When it fires it hangs *every* PipeWire client on the machine until the process is
> killed. Full analysis: `docs/design/pipewiresink-play-hang.md`. Reproducer:
> `scripts/probes/pipewiresink_multisink_deadlock.py` — re-run it before switching back.

`pulsesink` still reaches PipeWire, via `pipewire-pulse.service`. Its `device` property takes the
same PipeWire `node.name` that `pipewiresink`'s `target-object` did, so cuemark's
`node@target!full_layout` device-id format is unchanged. Empty `device` = system default.

**Gotcha: an unresolvable `device` does not error.** `pulsesink` silently falls back to the default
sink, so a stale/corrupted persisted device id shows up as "wrong device", never as a failure —
unlike a bad `target-object`. `AudioSettings.svelte`'s on-mount auto-heal is the only guard.

`pulsesink` is a `GstAudioBaseSink`, so latency uses the real properties (50 ms / 10 ms):

```rust
sink.set_property("device", node_name);       // PipeWire node.name
sink.set_property("buffer-time", 50_000i64);  // us
sink.set_property("latency-time", 10_000i64); // us
```

For contrast, `pipewiresink` extends plain `GstBaseSink` and has **no** `buffer-time`/`latency-time`;
it needed `stream-properties` `node.latency=1024/48000` (~21 ms) instead. If you ever see that
pattern in old code or notes, it predates this change.

`libgstpulseaudio.so` ships in **`gstreamer1.0-plugins-good`** (not a `gstreamer1.0-pulseaudio`
package — that name does not exist).

**pw-top diagnostics** — two modes:

```bash
# Batch mode — point-in-time snapshot, scriptable (use from Claude Code tool calls or scripts)
pw-top -b | grep -E "cuemark|ERR"

# Interactive mode — live-updating table in a terminal (use when watching a live session)
pw-top
```

Column reference:
- `S` column: `R` = running (producing audio), `I` = idle/paused
- `QUANT / RATE`: both cuemark pipewiresink streams should show `1024 / 48000` (~21ms); if one shows a
  non-standard quantum (e.g. 3969 / 44100), the capsfilter didn't apply (deck was loaded before a Rust rebuild — re-load the track)
- `ERR`: PipeWire xrun count for this stream; brief bursts are normal; sustained growth means pipeline starvation
- Two `+ cuemark` streams expected: our two pipewiresink decks; WebKit video element pipeline appears as a separate stream

**Use `pw-top -b` to diagnose a live audio-stop** — run it while the app is showing symptoms (audio silent, UI still active). The ERR count on the 48kHz cuemark stream tells you immediately whether you have an xrun cascade (thousands) vs a pipeline logic bug (ERR near zero). No need to restart first.

---

## WebKitGTK video element audio stream

WebKitGTK opens its own GStreamer/PipeWire audio stream for every `<video>` element, even when
`v.muted = true`. The `muted` attribute zeroes the sink volume but does NOT tear down the audio
decode pipeline. Visible in pw-top as a separate `+ cuemark` entry.

**`v.playbackRate` changes trigger WebKit pipeline rebuilds** — every time `v.playbackRate` is written,
WebKitGTK can rebuild its internal GStreamer pipeline. This is CPU-intensive. With MIDI tempo events
firing at 200+/sec (rAF-throttled to 60/sec), this was causing CPU spikes that starved the audio
streaming thread → PipeWire xrun cascade (observed: 177 xruns → 1301 within seconds → pipeline ERROR).

Fix: `syncVideoElements` tracks `lastPlaybackRate` per deck and only writes `v.playbackRate` when the
value actually changes. This reduces rebuilds from 60/sec constant to once per unique rate value.
During active MIDI tempo sweeps, each unique value still triggers one rebuild.

**The rebuild loses `muted`** — the new WebKit pipeline initializes briefly unmuted before the JS
`v.muted = true` re-apply lands. `v.muted` alone is not reliable because it's linked to the pipeline
state. Fix: also set `v.volume = 0` — this is a JS object property that survives pipeline rebuilds.
Both `v.volume = 0` and `v.muted = true` are applied unconditionally every `syncVideoElements` pass
AND inside the `lastPlaybackRate` guard after `v.playbackRate =`.

**WebKit stream always at source file sample rate** — WebKit negotiates its own audio stream at the
source file's native rate (44100 Hz for most music files), independent of our capsfilter. You will
always see a second `+ cuemark` stream in pw-top at 44100/3969 when a 44100 Hz file is loaded.
This is expected and unavoidable. The ERR count here should be low (< 10); sustained growth would
indicate the WebKit pipeline is stalling.

**`createMediaElementSource(v)` does NOT fix this** — in WebKitGTK it creates a third decoder rather
than redirecting the existing one. Tried and reverted.

**Distinguishing WebKit audio bleed from other issues:**
- WebKit bleed: doubled audio specifically during or just after tempo changes
- Root cause: muted lost on pipeline rebuild; volume survives
- Fix: confirm `v.volume = 0` is set unconditionally in `syncVideoElements` (not just inside the rate-change guard)

---

## PipeWire xrun cascade

xruns in pw-top's ERR column are normally benign (brief gaps during seeks). A cascade — ERR climbing
rapidly to 1000+ — means the pipeline has entered ERROR state and stopped producing audio while the
PipeWire connection stays open. PipeWire keeps scheduling the stream every 21ms; each missed callback
is one more xrun.

**Three causes, ordered by likelihood:**

1. **14-bit fader LSB triggering duplicate writes** (most common) — each fader position fires
   CC N (MSB) then CC N+32 (LSB), each emitting a `DeckPlaybackRate` action with a slightly
   different value (~0.002–0.004 apart). A strict `===` guard lets both fire through:
   - `v.playbackRate` written twice → two WebKit GStreamer pipeline rebuilds per fader position
   - `audio_set_rate` IPC called twice → two soundtouch `tempo` property sets per fader position
   Both double CPU pressure on the streaming thread. Observed: 5,788 xruns and audio silence
   within ~4 minutes of tempo fader use on a loaded machine.
   Fix: `Math.abs(rate - last) < 0.005` in `lastPlaybackRate` check (`syncVideoElements`, App.svelte)
   and in `syncRate` (`audioSync.ts`). Use `pw-top -b` to get a snapshot of ERR counts mid-session
   to confirm the cascade before restarting.
   Symptom: ERR climbs steadily during tempo fader sweeps; audio drops after extended fader use.

2. **Source file at non-native sample rate** — deck loaded before the Rust capsfilter was compiled in,
   or capsfilter negotiation failed. Symptom: `pw-top` shows the deck at 44100 Hz / QUANT=3969.
   Fix: re-load the track to get a fresh pipeline.

3. **soundtouch variable output chunks** — transient; the `output_queue` absorbs this. If xruns still
   appear at specific tempos, check that `output_queue` with time-based limit is present in the pipeline.

**Diagnosing a stuck pipeline**: when ERR stops climbing but audio is silent, check the bus log for
`[bus/deck-N] ERROR:`. The `at_error` flag is set but there is no auto-recovery — the pipeline stays
in ERROR until the user re-loads the track.

---

## Capture the actual output and look at it (2026-08-10) — the instrument of last resort, and it should be reached for sooner

**Reach for this the moment the pipeline's own instruments read healthy and the user still
reports a fault.** Not after the fifth hypothesis. Every probe in this file is a *level*, a
*count*, or a *state* — none of them is the signal, and a fault that changes none of those is
invisible to all of them at once.

```bash
scripts/scratch-capture.sh                      # pre-flights the pw-link, refuses on the wrong node
scripts/scratch-envelope.py /tmp/cuemark-scratch-<ts>.wav \
    --start-epoch "$(cat /tmp/cuemark-scratch-<ts>.epoch)" --log /tmp/cuemark-dev.log
```

It taps the **PipeWire device monitor**, downstream of everything including the
two-`pulsesink`s-on-one-device topology, so a fault anywhere in the chain lands in it. The
analyser prints a per-window envelope (`rms`, `hp200`, zero-crossing rate), joins
`[scratch-tel]` lines inline against wall clock, and separates the three outcomes the log
cannot:

| verdict | means | where to look next |
|---|---|---|
| `GATED` | interior silence ≥150ms reached the device | join the gap start against `[scratch-tel]`; `arrived`/`ramps`/`snaps` say whether the feeder muted |
| `PITCHED` | level holds, energy collapses below 200 Hz | nothing is muted — the content is shifted down by a low cursor speed. No gate constant will fix it |
| `CLEAN` | both hold | the loss is downstream of the tap: analog, routing, the controller's mixer |

**Why this earns its own section**: it broke a stalled investigation open
(`slow-jog-audio-inaudible.md`) after five mechanisms had been proposed and refuted against
instruments that were structurally incapable of varying with the fault.
**`rms` is blind to frequency *and* blind to duty cycle**, so the feeder's own `rms` field
read healthy throughout and *could never have shown either* candidate.

> An instrument that cannot vary with the fault carries no information about it. A clean
> reading from one is not weak evidence — it is no evidence.

⚠️ **The verdict this section used to report — `PITCHED` — was measured correctly and
answered the wrong question, and that is the more useful lesson.** The analysis ran on
channels 0,1 (**main**) while the user was monitoring on **headphones**, a different physical
channel pair on that device. The pitch arithmetic is real (a slow jog runs the cursor at
0.10–0.26x, ~2.7 octaves down, full level, inaudible on most monitoring) and `Jog scale` is a
genuine taste lever — but it was never what the user was hearing, and the same capture had
digitally-silent headphone channels nobody had looked at. **Ask which output the listener is
actually on before analysing any capture, and read both pairs**
(`--channels 2,3`). The real answer was `GATED`, and the cause was two `pulsesink`s on one
PipeWire node — fixed 2026-08-11 by the shared output graph (§10.14).

### Four traps, all of which fired on first use

- 🔴 **`audio_record_start/stop` is a stub.** `src-tauri/src/audio/record.rs` logs, returns
  `Ok`, and writes nothing (the encoder chain is "step 8"). The design doc that prescribed it
  did not know that. Use the capture script.
- 🔴 **A capture reading ~−53 dBFS and flat is the wrong node, not a quiet take.**
  `pw-record` silently falls back to the default source — here the H1n mic — producing a
  perfectly plausible "clean" envelope of the room. It was caught only because it matched an
  idle control take to within 0.7 dB. The analyser now checks this *first* and refuses to
  interpret anything below it; `scratch-capture.sh` pre-flights the link.
- 🔴 **Trim lead-in silence before judging a gap.** The deck sits paused before the gesture
  starts, so a capture opens with true digital silence. Scored over the whole file that reads
  as one long gate — and because `GATED` is checked before `PITCHED`, it *masked* the correct
  verdict on the very take that settled the bug. Now measured over the interior only.
- 🔴 **`pw-record` cannot capture more than two channels — and it fails by fabricating
  silence** (2026-08-13). `pw-record --target <4ch sink> --channels 4`, with or without
  `--channel-map FL,FR,RL,RR`, creates a capture node carrying only `input_FL`/`input_FR`.
  PipeWire upmixes stereo→4ch, so **ch2/ch3 arrive as exact digital zero** with no warning and
  a correct-looking 4-channel WAV header. On the Starlight that is the entire headphone pair,
  and it produced a confident "the cue branch is delivering silence to the rear" verdict that
  was simply false — the rear pair was carrying music at full level the whole time. Use
  `pipewiresrc` instead, and **check the port count before believing any per-channel number**:

  ```bash
  SER=$(pw-dump <node-id> | python3 -c "import json,sys; print([o['info']['props']['object.serial'] for o in json.load(sys.stdin) if o.get('type')=='PipeWire:Interface:Node'][0])")
  gst-launch-1.0 pipewiresrc target-object=$SER \
    ! "audio/x-raw,format=F32LE,channels=4,rate=48000" ! wavenc ! filesink location=out.wav
  # verify the capture node really has 4 input ports, mid-capture:
  pw-dump | python3 -c "import json,sys; d=json.load(sys.stdin); ids={o['id'] for o in d if o.get('type')=='PipeWire:Interface:Node' and o.get('info',{}).get('props',{}).get('node.name')=='pipewiresrc0'}; print([o['info']['props'].get('port.name') for o in d if o.get('type')=='PipeWire:Interface:Port' and o['info']['props'].get('node.id') in ids])"
  ```

  Note `object.serial`, **not** the node id — `target-object` takes the serial and silently
  fails to link with anything else. This is the same lesson as the wrong-node trap above,
  one layer in: the capture succeeded, the file was well-formed, and the numbers were fiction.

### Timezone

⚠️ **Log stamps are UTC; `date`, the capture filename and the `.epoch` file are local.** The
`--log` join parsed them as local until 2026-08-10 and therefore matched nothing, **silently**
— no warning, just an envelope with no telemetry beside it. Check `date -u` against the log's
last line before concluding a join found nothing.

## "Audio is choppy" / "audio is silent" — read `output_queue` first (2026-08-02)

**Start here for any audio symptom**, before touching buffer sizes or tempo code. Reaching
`Playing` with no bus `ERROR` and the right volume on the right device proves the graph was
*built and started* — it says nothing about whether samples are *moving*. `pulsesink` reports
underflows only at `GST_DEBUG` level, so a badly broken audio path can produce a completely
healthy-looking log.

Two probes in `audio/pipeline.rs` close that gap:

```
[audio/deck-0] output_queue underrun (total=N) — ...          # instrument_queue_flow()
[audio/deck-0] main sink 0: first buffer reached the sink     # instrument_sink_flow()
[audio/deck-0] main sink 0: buffer flow resumed after a 3.2s gap
[audio/deck-0] cue sink: first buffer reached the sink        # cue branch, since 2026-08-08
[deliver-tel/deck-0] vol0=…/s(min …) margin …(min …) | sink0=… | cuevol=… | cuesink=…
```

⚠️ **Check what these can and cannot see before concluding anything from a clean log.** The
gap warning needs **>1s** of no buffers; `underrun` needs upstream starvation. **Brief
clipping, glitching or distortion is below the resolution of every instrument in this
pipeline** — so for those symptoms "the log is clean" is close to no information at all, and
must never be reported as "the fault is gone". `[deliver-tel]`'s `margin(min …)` is the nearest
thing available, and it measures *slack*, not audible artifacts.

| Log | Meaning | Where to look |
|---|---|---|
| `output_queue underrun` | Upstream can't produce audio in real time | CPU contention — `uridecodebin`/soundtouch vs. the WebKitWebProcess. See "CPU profiling a live chokes-up freeze" below. Widening the sink buffer only delays it. |
| no `underrun`, still choppy | Samples flow through the queue fine; the gap is past it | The sink's own ringbuffer — see `sink_buffer_times()` below. |
| deck silent, **no** `first buffer` line | Nothing ever reached the sink | Upstream, in the rebuilt graph — the sink never got data to lose. |
| deck silent, `first buffer` line present | Audio *was* delivered to the sink | The sink/device — suspect PipeWire/ALSA not releasing the node before a rebuilt `pulsesink` reopened it (the track-reload-silence bug). |

**Why the "did it reach the device" question needs a pad probe, not a queue signal**: a
sink that has stopped consuming leaves `output_queue` **full**, which is exactly what
healthy playback also looks like. For the same reason `overrun` is deliberately *not*
instrumented — with a synced sink, upstream decode runs far faster than real time and
backpressure holds that queue at its cap for the whole of normal playback, so `overrun`
fires continuously when nothing is wrong. An empty queue is the anomaly; a full one is the
steady state. `instrument_sink_flow()` probes each main sink's own sink pad instead, and is
event-driven (first buffer, plus any resume after a >1s gap) so it stays readable across a
multi-hour set.

**Sink buffer is runtime-tunable — bisect it by ear, don't rebuild per guess:**

```bash
CUEMARK_SINK_BUFFER_MS=100 CUEMARK_SINK_LATENCY_MS=20 cargo tauri dev
```

Defaults are **200ms/20ms since 2026-08-02** (`pulsesink`'s own defaults), raised from 50ms/10ms
after that value was live-confirmed as the cause of choppy audio on a USB DJ controller. The
50ms was vestigial — chosen in May 2026 to shorten the overlap when rate changes were FLUSH
seeks and 200ms of old-rate audio drained into the new segment ("doubled/detuned" artifact).
Rate changes moved to the `pitch` element's `tempo` (no seek, no flush) long ago, but the value
carried forward through the `pipewiresink`→`pulsesink` switch, where it began actually binding
(`pipewiresink` ignored these properties entirely; it extends `GstBaseSink`, not
`GstAudioBaseSink`).

**Size this against the graph quantum, not by feel.** `pw-top` showed a 2048-frame quantum
(42.7ms at 48kHz), making 50ms ≈ **1.17 quanta** — one late wakeup from a dropout. 200ms is
≈4.7 quanta. Lowering it is legitimate (the buffer is pure added output latency and cueing feels
it), but **always re-test on USB audio**: an onboard codec running native 48kHz has enough margin
to hide the problem, while a USB device doing 48k→44.1k resampling does not.

**Diagnostic pattern worth reusing**: select *two* main output devices at once so one `tee` feeds
both. If one branch is clean and the other jitters, every upstream cause (CPU, decode,
soundtouch) is excluded by construction — they cannot affect one branch and spare its sibling.
That single observation is what cracked this.

### Gating a "flow stopped" probe: a level check is never enough (learned twice)

Any probe that reports "no buffers arrived for N seconds" will also fire on every span where
**no buffers were supposed to arrive**. This project has now built that bug twice and fixed it
the same way both times, so treat the pattern as settled:

| Legitimate silence | What forges a dropout |
|---|---|
| Preroll → play | The gap between the single preroll buffer and the first play buffer |
| Pause → resume | The last pre-pause buffer's timestamp surviving the pause |
| Headphone cue off (`cue_valve` drops everything) | The last pre-close buffer's timestamp surviving the cue-off span |
| A sink reopening after resume | The first measured second after play, which is device-open latency |

**The fix is always two-sided, and the second side is the one people miss:**

1. **Gate** the check on a relaxed `AtomicBool` (never a `current_state()` query — that takes
   `GST_OBJECT_LOCK` on a streaming thread; see the `pipewiresink` deadlock history). Multiple
   conditions compose as a conjunction: the cue sink gates on `at_playing` **and** `cue_open`.
2. **Invalidate** the stored last-buffer timestamp when the gate closes, *from the side that
   closes it* — the bus thread on any transition out of `Playing`, `set_cue_enabled()` on cue
   off. The gate alone leaves a stale timestamp from just before the silence began.

⚠️ **Step 2 is not optional and the cue case shows why most starkly**: the valve drops buffers
*upstream* of the probed pad, so unlike the pause case **no later buffer ever arrives to clear
the stale value** — the probe cannot self-heal, and the next cue-on reports the entire cue-off
span as a dropout. Clear the flag *first*, then the timestamp, so a buffer already in flight
cannot re-stamp it.

**Always ship a positive control arm with the gate.** The cheapest way to pass "no false
positives" is to break the diagnostic entirely, and a suppressed real dropout is strictly worse
than the noise it replaced. Both guards here are two-arm tests — toggle everything and assert
silence, then stall the pad for 2.5s inside a legitimately-open span and assert the warning
still fires:

```bash
cargo test sink_flow_gap_gating -- --ignored --nocapture       # main sinks (D2)
CUEMARK_CUE_DEVICE='…@RL,RR!FL,FR,RL,RR' \
  cargo test cue_sink_flow_gap_gating -- --ignored --nocapture # cue sink
```

Both need a real device and the synthetic soak media (regenerate via the `gst-launch-1.0`
command in `SOAK_A`'s doc comment — it is ~70MB and not committed).

### Occasional brief gap/click that does NOT interrupt playback — multi-device clock drift

**Hypothesis, not yet live-confirmed (2026-08-02).** Distinct from choppiness: a rare,
almost-imperceptible gap, minutes apart, with playback continuing normally.

A GStreamer pipeline has exactly one clock. With **two or more output devices** selected, one
`pulsesink` becomes the pipeline clock and the others must slave to it — but each device
free-runs on its own crystal (typically 20–200 ppm apart), so they cannot stay aligned.
`GstAudioBaseSink`'s default `slave-method=skew` corrects by jumping the ringbuffer pointer
(dropping/inserting a block of samples) once drift exceeds `drift-tolerance`, default **40ms**.

Expected period = `drift-tolerance / relative drift`:

| Relative drift | Gap every |
|---|---|
| 200 ppm | ~3.3 min |
| 100 ppm | ~6.7 min |
| 50 ppm | ~13 min |
| 20 ppm | ~33 min |

**Free diagnostic — no tooling.** Two sinks on the *same* device share one hardware clock and
cannot drift, so a main+cue pair on one controller is immune. **Deselect one of two main devices
and play for a while**: if the gaps stop, confirmed. Same natural-experiment logic that cracked
the `buffer-time` bug.

**Direct confirmation**: `GST_DEBUG=audiobasesink:5` and grep the output for skew/resync/discont
decisions, correlating their timestamps against the audible gaps. Verbose (per-render logging) —
send it to a file and only run it for a couple of minutes.

**Candidate fix**: `CUEMARK_SINK_SLAVE_METHOD=resample` corrects continuously by resampling
instead of jumping. Costs a little CPU and detunes that device by the drift itself (50 ppm =
0.0009 semitone, inaudible) in exchange for never producing a discontinuity. Default is
deliberately left at GStreamer's `skew` until this is confirmed live.

⚠️ A pad probe on the sink pad **cannot** see this — the skew happens inside the sink, after the
pad, so `instrument_sink_flow()` will report perfectly continuous buffer flow throughout. Don't
read its silence as evidence against this hypothesis.

⚠️ **`pw-top -b -n 1` in a loop is useless** — its first batch is a priming snapshot with
all-zero deltas and state `C`, so a loop of one-shot calls reports "nothing is running" no matter
what is playing. This wasted a cycle on 2026-08-02 and produced a confidently wrong "no playback
occurred" conclusion. Use **one** long-lived `pw-top -b -n <N>` and parse its stream.

Full context: `docs/design/output-noise-and-track-reload-silence.md`.

---

## Waveform position clock

The waveform reads position from `getDeckTime(deckId)` in `seekBus.ts`. When playing, that returns
the `audioTimes` map (IPC-driven content position). When paused or right after a seek (before any IPC
resolves), it falls back to `els.get(deckId)?.currentTime`.

### `query_position` returns wall-clock, not content time

GStreamer's `query_position` always returns stream time based on the GStreamer segment rate.
The soundtouch `pitch` element sets its `tempo` property in-place — it never issues a rate-seek —
so the GStreamer segment rate always stays 1.0 regardless of `deck.playbackRate`. At 2× tempo,
`audioPos` (from `query_position`) advances at 1× wall-clock while content actually advances 2×.

**`contentPosTracker` in `App.svelte`** converts wall-clock IPC position to content position by
integrating per-frame deltas at `deck.playbackRate`:

```
contentPos += (audioPos - prev.audioPos) × playbackRate
```

A delta > 500 ms between consecutive IPC responses is treated as a seek: in that case `audioPos`
directly IS the correct content position (GStreamer returns the seek target immediately once the seek
completes), so it is used as-is and `contentPosTracker` is re-anchored from there.

**`resolvedRate` is read at IPC resolution time**, not at the moment the IPC is dispatched. If the
rate changed while the call was in flight (e.g. a 2× → 1× change arriving while a 2× delta is
integrating), the start-rate would overshoot `contentPos` by `IPC-latency × rate-diff`. Reading the
rate from the Svelte store at the moment the Promise resolves avoids this.

### `pendingSeekTarget` filter (stale pre-seek IPC responses)

On a heavy video, GStreamer can take > 1 s to flush and re-preroll after a seek, during which
`query_position` keeps returning the pre-seek position. Without filtering, the RAF loop computes
`contentPos ≈ pre-seek-value`, then the snap `v.currentTime = contentPos` reverts the video to
the old position.

`seekDeck()` records the seek target in `pendingSeekTarget`. The RAF callback checks after computing
`contentPos`: if `|contentPos − seekTarget| > 0.5 s`, the frame is skipped entirely (no snap, no
`setDeckAudioTime`). Once GStreamer's position converges on the seek target, the filter clears.

**Bug found and fixed 2026-07-25: this filter had no time bound, so "seek while playing" could
freeze the waveform position permanently.** The distance check above assumes a stale reading is
always *behind* the target — true for "seek then stay paused," false for "seek while playing"
(the normal case): real playback carries the position *past* the target the instant the seek
actually lands. If the first post-seek reading happens to arrive late enough (slow seek, or
several seeks/rate-changes fired back-to-back) that the position is already `>0.5s` past the
target, it's wrongly discarded as stale — and since the filter never clears, *every* reading
after that is discarded too, freezing `getDeckTime()`/the waveform position clock forever while
GStreamer and the `<video>` element both keep advancing normally underneath. User-reported
symptom: "video keeps playing but the waveform position stopped moving," especially at
non-1.0 rate. Confirmed live both headlessly (via this skill's technique below) and
independently on the real desktop at the same time. **Fix**: `pendingSeekTarget` now stores
`{time, setAtMs}`; `getPendingSeekTarget()` auto-expires and clears the entry after
`SEEK_STALE_TIMEOUT_MS` (1500ms) regardless of distance, so a reading that old is trusted
outright — a wrong one-frame reading self-corrects on the very next poll, unlike the permanent
freeze it replaces. See `project_seek_staleness_freeze_fix` memory for the full writeup and
regression-test repro recipe.

**Diagnostic technique for "cached/derived value frozen but is the underlying thing actually
stuck?"**: call the real Tauri command directly from a WebDriver script, bypassing whatever
frontend caching/derivation is under suspicion, and compare side-by-side:
```js
window.__TAURI__.core.invoke("audio_get_position", {deckId}).then(raw => /* compare raw vs cached */)
```
This is what distinguished "the Rust pipeline is genuinely stuck" (raw position frozen too) from
"only the frontend's cached/derived clock is stuck" (raw keeps climbing, `v.currentTime` keeps
climbing, only `getDeckTime()`'s cached value is frozen) — the latter is what this bug turned out
to be. Reusable any time a value read through app-level state is suspected of lying about the
underlying system's real state.

### `audioTimes.delete` on seek (not `.set(time)`)

`seekDeck()` calls `audioTimes.delete(deckId)` rather than `audioTimes.set(deckId, time)`. If the
GStreamer IPC later returns `null` (common during the EOS → seek → play transition), the callback
exits early without calling `setDeckAudioTime` — leaving `audioTimes` populated with the seek target
would block `getDeckTime`'s fallback, making the waveform return the stale seek-target value
indefinitely. With `delete`, `getDeckTime` falls back to `els.get(deckId)?.currentTime`, which was
already set synchronously by `el.currentTime = time` in `seekDeck()`.

### One in-flight IPC per deck

`pendingPos` map in `App.svelte` ensures only one `audioGetPosition` IPC is in flight per deck at
a time. A stale slow-resolving IPC (e.g. from a mid-rate-change GStreamer hiccup) cannot overwrite
a newer position already written by a subsequent IPC that resolved faster.

---

## Video serving and WebKit canvas/render-loop debugging (2026-06-20)

**Production video no longer uses a custom URI scheme.** `media://` never worked reliably for
`<video>` in WebKitGTK (confirmed: instant `FormatError`, zero GStreamer pipeline construction,
codec-independent — see journal.md 2026-06-20). Both dev and prod now serve local video files over
plain HTTP: dev via the Vite middleware in `vite.config.ts`, prod via `src-tauri/src/media_server.rs`
(a `tiny_http` server on an ephemeral `127.0.0.1` port). If video loads but the deck preview is
black again, first suspect the local HTTP server (is `media_server_port` resolving? is the file
path correct?) — not codec/decoder issues.

**Cross-origin canvas tainting can silently kill the entire render loop.** The `<video>` element's
`src` is a different origin (`http://127.0.0.1:<port>`) than the page (`tauri://localhost`). Without
`v.crossOrigin = "anonymous"` (set in `App.svelte` right after creating the element, before `src`),
any canvas read of the video (`drawImage`/`texImage2D` in `fbo.ts`) throws `SecurityError`. Because
this throw happens inside the `requestAnimationFrame` callback in `App.svelte`, it aborts *before*
the trailing `requestAnimationFrame(frame)` reschedule — the entire render loop dies silently after
one bad frame. Symptom: video/audio keep playing (separate codepaths), but the Output Window stops
updating and the waveform playhead/position freezes, with no console error visible unless devtools
happened to be open at the exact moment. **Every HTTP response from `media_server.rs`, success or
error (404/500), must carry `Access-Control-Allow-Origin`** — a browser permanently marks a media
resource's CORS-taint flag the moment *any* request for it lacks the header, even a transient error
under load, and that taint never clears even once later requests succeed. If the canvas pipeline
worked earlier in a session and then silently breaks again with no code change, suspect taint
accumulation from an intermittent server-side gap, not a regression in whatever you just touched.

**`WatchDogQueue` trap = WebKit's own renderer crashed, not an app hang.** A gray, frozen-looking
window that still plays audio (GStreamer/Rust pipeline is independent of the JS render loop) usually
means `WebKitWebProcess` itself died. Check `pgrep -af WebKitWebProcess` — if it's gone while the main
`cuemark` process is alive and idle, `dmesg | grep WatchDogQueue` (needs `sudo`) will show
`traps: WatchDogQueue[pid] trap int3 ... libglib-2.0.so` — WebKit's internal main-thread
responsiveness watchdog deliberately self-trapped because the JS main thread was blocked too long.
Tauri/wry doesn't currently detect or recover from this; the window stays frozen until killed and
relaunched. Root cause was an unbounded backlog in `outputBus.ts`'s `postFrame()` (no backpressure —
fixed with an in-flight guard) compounding with genuinely heavy per-frame work (WebGL composite +
canvas capture + cross-process `postMessage` for two simultaneous decks). The in-flight guard is
still there and still load-bearing; the work behind it changed on 2026-08-03, when compositing
and canvas capture moved out of this process entirely (the control window no longer has a WebGL
context) and `postFrame()` became per-deck `createImageBitmap` + `postMessage`.

**Debugging WebKit's *internal* GStreamer pipeline requires a global `GST_DEBUG` threshold, not just
named categories.** `GST_DEBUG=uridecodebin:5,decodebin:5` shows plenty for our own Rust process but
nothing for `WebKitWebProcess` — categories not explicitly listed default to `NONE`, and WebKit's own
categories (`webkitmediaplayer`, etc.) aren't in a list built for our pipeline. Use
`GST_DEBUG=2,webkitmediaplayer:7,uridecodebin:5,decodebin:5,...` (leading global number) to see both.
Also: `WEBKIT_DEBUG` (any channel, even definitely-valid ones like `Network`) is fully non-functional
on this machine's webkit2gtk build ("Unknown logging channel" for everything) — don't waste time on
it here. And each `gst_init()` call gets its own debug clock starting at `0:00:00.000`; use the `pid`
field in the log line (the number right after the timestamp), not the timestamp itself, to tell which
process a line came from when merging logs from our pipeline and WebKit's.

**Production builds need `devtools` + `withGlobalTauri` to be debuggable at all.** Both are enabled
permanently in `Cargo.toml`/`tauri.conf.json` now. Without `devtools`, there's no right-click →
Inspect Element on a release build, so `console.error`/`console.log` (where most real signal lives —
CORS errors, taint SecurityErrors) is invisible. Without `withGlobalTauri`, `window.__TAURI__`
doesn't exist, so you can't call `window.__TAURI__.core.invoke('audio_get_position', { deckId:
'deck-0' })` directly from the console to bisect "frontend bug vs. backend bug" without adding
temporary instrumentation.

**`video.duration === Infinity` for non-fast-start MP4s breaks naive "not yet known" guards.**
Common for YouTube-downloaded files where the `moov` atom is at the end of the file. `Infinity` is
truthy in JS, so a guard written as `!s.duration` (meant to mean "we don't have a real duration yet,
apply the GStreamer-derived fallback") never fires once `Infinity` lands there. Downstream,
`WaveformCanvas`'s `playheadX = (currentTime / duration) * W` evaluates to `0` for any `currentTime`
when `duration` is `Infinity` — looks exactly like "playhead frozen at the start," not "duration is
wrong." Fix needs **both** `!s.duration` (catches the real initial placeholder, `0`) and
`!Number.isFinite(s.duration)` (catches `Infinity`/`NaN`) — swapping one check for the other instead
of combining them breaks the other case.

**Every `drawImage(video, ...)` call site needs its own `videoWidth`/`videoHeight === 0` guard —
they don't share one.** `fbo.ts`'s `uploadVideoFrame()` already guarded against drawing a video
element with no video track (audio-only files, e.g. `.mp3`, loaded into a `'video'`-type deck).
`DeckCard.svelte`'s separate preview-canvas draw loop (its own `requestAnimationFrame`, drawing
straight to a 2D canvas for the per-deck thumbnail) did not have this guard, and WebKitGTK throws
`SecurityError` from `drawImage()` when the source video element has `readyState >= 2` but
`videoWidth === 0` (no video track) — Chrome silently no-ops in this case, WebKitGTK doesn't.
Symptom: console shows `readyState=4 ... error=none` (the file loaded fine) immediately followed
by `SecurityError: The operation is insecure` at `texImage2D`/`drawImage`, only when the loaded
file has no video stream. Fixed by adding the same `video.videoWidth > 0 && video.videoHeight > 0`
check (plus a try/catch, since a render loop dying from one bad frame is the same `requestAnimationFrame`
abort-on-throw failure mode as the cross-origin tainting bug above) in `DeckCard.svelte`. **Any new
canvas/texture draw site that reads from a `<video>` element needs this same guard independently —
it is not centralized.**

---

## Known failure modes

### A network (Snapcast) output is silent while local outputs are fine

**Symptom**: a `snapcast://…` target is ticked in Main, the deck plays normally on the booth
monitor, and the room hears nothing.

⚠️ **Diagnose from the server end first.** Everything on cuemark's side reports healthy in
this failure, by construction: an output branch that cannot attach is deliberately non-fatal
(`attach_output_graph()` leaves the appsink swallowing buffers rather than blocking the deck),
so there is no error, no underrun, and no gap warning — the deck cannot tell.

🔴 **First, check whether the *booth* is silent too — that is a different bug entirely, and
it is client-side, not server-side.** Live-hit 2026-08-14: right after the network target was
first added in Settings, deck-0's main0, main1, main2 (network) *and* cue all failed to
attach in the same batch — total silence on every output, not just the room. Cause: the
frontend (Vite HMR) had picked up the just-committed network-output feature, but
`cargo tauri dev`'s backend was still running the **previous** commit — Rust changes need a
full rebuild+restart (see `feedback_dev_server_lifecycle.md`), and that never happened after
the feature landed. The stale `make_sink()` had no `snapcast://` dispatch at all, so it
handed the literal id straight to `pulsesink device="snapcast://host:port"`, which is not a
real PipeWire node and fails to reach `PLAYING` — and that single failure took the other
main branches and cue down with it in the same `attach_output_graph()` pass.

Two cheap checks settle it before touching the server at all:

```bash
# Does the build running right now actually contain the feature you just committed?
grep "\[build\] cuemark" ~/.local/share/com.cuemark.app/logs/cuemark.log | tail -1
git log --oneline -1        # compare the sha — if the log's sha is an ancestor, restart the dev server

# Smoking gun: a correctly-built backend NEVER constructs this. If this line is in the log,
# the running binary predates the feature — full stop, restart, don't touch snapserver.
grep 'sink: pulsesink device=.*snapcast://' ~/.local/share/com.cuemark.app/logs/cuemark.log
```

If the booth is fine and only the network target is silent, it's a real server-side question —
walk it in this order; each step distinguishes a different cause:

```bash
# 1. Is the server even offering a tcp:// source? (the usual answer — it is a one-line
#    config change on the server that is easy to forget after a rebuild/restore)
ssh plex "grep -n '^source = tcp' /etc/snapserver.conf"

# 2. Is snapserver seeing the stream as playing?  idle here = nothing is arriving
curl -s -X POST http://10.20.2.97:1780/jsonrpc \
  -d '{"id":1,"jsonrpc":"2.0","method":"Server.GetStatus"}' | grep -o '"id":"Cuemark","status":"[a-z]*"'

# 3. Did cuemark actually connect?
ss -tnp | grep 4953

# 4. What did the sink say it built?
grep "sink: snapcast" ~/.local/share/com.cuemark.app/logs/cuemark.log
```

**And check which group is on which stream — check this FIRST, before anything on cuemark's
side.** Live-confirmed 2026-08-14: cuemark attached cleanly, played, `Server.GetStatus` showed
the `Cuemark` stream healthy, and the room was *still* silent, because both client groups had
`stream_id: "House"` (the pre-existing Spotify/AirPlay meta stream) instead of `Cuemark`. A
`tcp://` source is deliberately *not* part of a meta stream (cuemark's silent keepalive would
capture it permanently), so nothing points a speaker at it automatically — a group has to be
switched with `Group.SetStream` explicitly, every time, since **this does not persist**: a
snapserver restart or anyone using Spotify/AirPlay again silences cuemark with zero indication
anywhere in cuemark's own logs (the attach is still healthy from cuemark's point of view).
"Snapserver's `Cuemark` stream says playing/idle-because-nothing's-loaded, room says silent" is
nearly always this, not a cuemark or network bug:
```sh
curl -s -X POST http://10.20.2.97:1780/jsonrpc -d '{"id":1,"jsonrpc":"2.0","method":"Server.GetStatus"}' \
  | python3 -c "import json,sys; [print(g['id'],'->',g['stream_id']) for g in json.load(sys.stdin)['result']['server']['groups']]"
# fix: Group.SetStream with the group id and {"stream_id":"Cuemark"}
```

To test the sink without a server at all: `scripts/probes/snapcast_tcp_sink_probe.py`.
Full design: `docs/design/network-audio-output.md`. Network reachability facts (the NAT that
makes AirPlay impossible here, plus a second network path on `underground` with its own ACL
gotcha): `docs/network-topology.md`.

**Not this entry**: audio that arrives but *late* is working as designed — see the
`tuning-knobs` skill §6 for the delay setting. Audio that stalls **every** output including
the booth when the server dies would be the leaky queue having been removed (§7 there). The
*whole app* freezing (not just the network output going silent) when you press play on an
unreachable target is the next entry, not this one.

### Pressing play freezes the *whole app* (not just the network output) when a Snapcast target is unreachable — FIXED 2026-08-14

**Symptom**: distinct from the entry above — this isn't "the room is silent while everything
else looks healthy," it's total unresponsiveness. Press play with a `snapcast://` target
configured that nothing answers on, and *every* deck's play/pause stops working for **about
two minutes**, then a delayed error finally appears. The render loop (`raf`/`poll-stats`) keeps
ticking at a healthy fps the whole time, so it doesn't look like a crash or a spin — it looks
like input is being silently dropped. The tell in the log: a burst of
`detached-pipeline IPC received: play` (or `pause`) lines roughly every 200ms — the frontend's
own transport retry loop hammering a backend call that never returns in time — followed, only
after that ~2-minute gap, by:
```
[audio/deck-N/mainM] could not attach main output to the shared output graph
([out/snap-<host>:<port>] set_state(Playing): Element failed to change its state) — THIS OUTPUT IS SILENT.
```
The ~2-minute gap between the first retry and that error is the signature — it's the Linux TCP
SYN-retry timeout for a target that never sends so much as a RST, not a GStreamer timeout (there
isn't one — see below).

**Root cause, two layers, both now fixed** (full writeup:
`docs/design/network-audio-output.md` "App-wide freeze"):
1. `tcpclientsink` has **no `timeout` property** (verified with `gst-inspect-1.0
   tcpclientsink` against gst-plugins-base 1.28 — don't assume one exists from memory or from
   how other sink elements behave, check the actual element). Its `connect()` blocked
   synchronously inside `pipeline.set_state(Playing)` for as long as the OS took to give up.
2. That call runs in `OutputGraph::create_node()` (`mixer.rs`) while
   `attach_output_graph()` (`pipeline.rs`) holds the **shared output graph's mutex** — the
   same lock every other deck's play/pause/attach needs. This is the same class of bug as "Play
   never starts, and the whole machine's audio hangs with it" and "UI freeze on first track
   load" below: a blocking call made while holding a lock other unrelated operations also need.
   Whenever a *new* symptom looks like "the whole app hangs, not just the thing I touched,"
   check what mutex the slow call is running under before assuming it's isolated.

Fixed by pre-flighting the target with a bounded `TcpStream::connect_timeout()` (3s) in
`make_snapcast_sink()` *before* the graph lock or `tcpclientsink` are ever touched. An
unreachable target now fails in ~3s with a clear message instead of freezing everything for
minutes. Regression guard: `unreachable_target_fails_fast_not_after_minutes` in `pipeline.rs`.

**How to tell "nothing is listening" from "an ACL/firewall is silently dropping it"** — both
produce the identical multi-minute hang, and this matters because the fix is completely
different (server config vs. network policy): ping the host first. `ping` succeeding while a
`TcpStream::connect`/`nc`/`curl` to the specific port hangs with **no connection-refused** is
the signature of a firewall or ACL silently dropping the SYN — a genuinely closed port refuses
instantly. This is exactly how a Tailscale ACL grant that omitted the needed ports was found
live 2026-08-14 (`docs/network-topology.md`'s "Tailscale subnet route" section) — the target
looked "down" until that distinction was made.

**Also fixed alongside this**: the failure used to be `log::error!`-only, so Settings kept
showing the target as configured/checked with no sign it never came up. `attach_output_graph()`
now emits an `output-attach-status` Tauri event (both success and failure) and
`AudioSettings.svelte` shows a `⚠ not connected` badge on the target's row, cleared
automatically once a later attach succeeds. Check that badge first, before logs.

### Play never starts, and the whole machine's audio hangs with it (pipewiresink deadlock)

**Symptom**: pressing Play does nothing — no audio, position clock never advances, no bus
ERROR, no crash, just silence after the Playing transition begins. Simultaneously *every
other* audio app on the machine stalls, and `pw-cli` / `pw-dump` / `wpctl` / `pw-play` /
`gst-launch-1.0` all hang. Looks exactly like the PipeWire daemon has died. It has not.

**Root cause**: AB-BA lock inversion in `libgstpipewire.so`. cuemark's PipeWire
thread-loop, holding its own loop lock, dispatches a node state change and calls into
gstpipewire, which waits on a `GCond` only the GStreamer state-change thread can signal —
and that thread is blocked acquiring the loop lock. Needs ≥2 `pipewiresink` elements in
one process plus a delay between PAUSED and PLAYING. See
`docs/design/pipewiresink-play-hang.md`.

**Triage, in order**:

1. `pgrep -a cuemark` — **do this before trusting any external tool.** A stuck cuemark
   makes every PipeWire client on the box hang, so any "it reproduces without our code"
   test run while one is alive is meaningless. This mis-diagnosed the bug for a whole
   session as an OS/PipeWire-release problem.
2. `cat /proc/<pid>/task/*/comm` + `/proc/<pid>/task/*/wchan` — a `pipewire-main-l` thread
   in `futex_do_wait` confirms it. No debugger needed.
3. `wpctl status` — stream links stuck in `[init]` instead of `[active]`, and `pw-top -b`
   showing quantum `0` on every node, both mean the graph never started.
4. `kill <cuemark-pid>` (the client, **not** the daemon) — releases the whole system
   immediately.

**Not the cause** (all separately ruled out): the cue channel remap, a starved cue valve,
two sinks sharing one node, `async=false`, `node.latency`, the Hercules Starlight, or its
44100-only rate. The built-in HDA card deadlocks identically.

### UI freeze on first track load (mutex held during preroll)

**Symptom**: the app feels completely unresponsive for 1–5 seconds immediately after dropping a file onto a deck. After the freeze everything works normally.

**Root cause**: `audio_load` in `mod.rs` was holding `Mutex<AudioManager>` for the entire duration of `pipeline.load()`. GStreamer preroll — the `pipeline.state(Some(gst::ClockTime::from_seconds(5)))` call at the end of `load()` — can block for up to 5 seconds (typically 0.5–2 s). Any other audio command that needed the mutex (`audio_get_position`, `audio_play`, `audio_set_volume`, …) blocked for the full preroll duration.

**Fix**: `audio_load` now removes the pipeline from the map, releases the mutex inside a scoped block, runs `pipeline.load()` without holding any lock, then re-acquires the mutex briefly to re-insert the pipeline. The pattern:

```rust
// In mod.rs audio_load:
let mut pipeline = {
    let mut mgr = state.lock().unwrap();
    mgr.pipelines.remove(&deck_id).unwrap_or_else(|| { /* create new */ })
    // mutex released here ↑
};

let result = pipeline.load(&file_path); // preroll runs WITHOUT holding the mutex

state.lock().unwrap().pipelines.insert(deck_id, pipeline);
result
```

While the pipeline is out of the map, other commands that look up `deck_id` will get a "no pipeline for deck" error — correct behaviour, since there is nothing to query during a load.

**`audio_analyze_file`** was also changed from a sync command (`pub fn`) to `pub async fn` with an explicit `spawn_blocking`. The sync version implicitly consumed a Tokio blocking thread for the full GStreamer audio decode; the async version makes the threading contract explicit.

**If the freeze returns**: open `src-tauri/src/audio/mod.rs`, find `audio_load`. Confirm the `state.lock()` guard closes (`}`) **before** `pipeline.load()` is called. If the lock is still held during `load()`, preroll will re-introduce the freeze.

### `set_rate →` log lines stop but MIDI events keep firing

With the pitch element, `set_rate()` has no guards — if MIDI events are arriving but no `set_rate →`
lines appear, the issue is upstream of pipeline.rs:

1. **`inner` is None** — no pipeline loaded (check for a failed `load()` earlier in the log)
2. **`at_eos` not set but no inner** — `Ok(())` returned silently from the `None` branch
3. **Regression** — someone reintroduced guards or the old seek-based logic

If `set_rate →` lines appear but audio is not changing, check that the `pitch` element compiled in
(look for `[audio/deck-N] sink:` line on load — if missing, load() failed and inner is None).

### Tempo has no effect after reloading a file

`load()` calls `pitch.set_property("tempo", self.rate)` before storing `inner`. If that line is missing
or moved after the `inner = Some(...)` assignment, a fresh load always resets tempo to 1.0.

### Audio stops after waveform-click seek or cue jump

These go through `seek()` → `seek_simple(FLUSH | KEY_UNIT, pos)`. Unlike rate-change seeks (which are
gone), user-initiated seeks are infrequent one-shots and the pipeline recovers normally. If audio stops:
- Check bus log for ERROR after the seek
- Check whether `at_eos` was true at seek time (EOS restart seek in `play()` is a separate path)

### EOS restart plays at wrong tempo

`play()` calls `seek_simple(FLUSH | KEY_UNIT, ZERO)` when `at_eos` is set, then sets state to Playing.
After the seek, the `pitch` element's `tempo` property is unchanged — it was set at load time and isn't
reset by seeks. No special handling needed. If tempo is wrong after EOS restart, check that `load()` is
setting `pitch.set_property("tempo", self.rate)` (not defaulting to 1.0).

### Non-ASCII filenames fail to load

`file_to_uri()` percent-encodes every non-ASCII byte individually — covers multi-byte UTF-8 sequences.
If a file fails to load and the path contains special characters, check `file_to_uri()` is intact.

### Elements disposed in READY/PAUSED state → GStreamer CRITICAL warnings

`load()` preroll failure path calls `bus.set_flushing(true)` + `set_state(Null)` before early return.
`Drop` impl does the same. If you see CRITICAL warnings on teardown, check these paths.

### UI freeze — FIRST check whether it is a spin or a deadlock (they look identical, fixes are opposite)

Before reaching for any freeze playbook, read the watchdog's own diagnostic line for the stuck
`WebKitWebProcess`:

```
[watchdog]   descendant pid=NNN comm=WebKitWebProces state=R etimes=295s Δutime=103 Δstime=0
```

| Reading | Meaning | Where to go |
|---|---|---|
| `state=R`, `Δutime` large | **Spin** — running flat out, doing work | `perf top -p <pid>` during the freeze. See "CPU profiling a live chokes-up freeze" below. |
| `state=S`/`D`, `Δutime≈0` | **Deadlock** — blocked, consuming nothing | The two-mechanism entry below; `gdb` per "Catching an intermittent GStreamer-side stall". |

A deadlock playbook applied to a spin (or vice versa) wastes a whole session — `gdb` on a spinning
process shows a busy stack that looks meaningless, and `perf` on a blocked one shows nothing at all.

**A third reading the table above does not cover: `state=R` with the thread *permanently*
pegged.** A spin and a saturated thread look identical in the watchdog line, and the fix is
different again — there is no culprit loop to find, because nothing changes at the stall
boundary. Distinguish them by slicing profiler samples to the stall window (recipe below); a
real spin shows a CPU discontinuity at the gap edges, saturation does not.

**Resolved this way, 2026-08-02 — the ~22s "near end of track spin" was neither.** The
watchdog line (`state=R Δutime=103 Δstime=0`) correctly says "runnable, burning userspace
CPU", and the natural inference — a tight JS loop in the WebCodecs path — was wrong on every
count: not a spin (main thread at 100% *identically inside and outside* the rAF gap), not
near-EOS (playing the incident file's last 68s to natural EOS was clean), and not in app code
(`[JIT]` = 1.4% of samples; the codec Worker thread = ~1%). It is chronic main-thread
saturation in WebKit's **software rasteriser**, forced by `WEBKIT_DISABLE_DMABUF_RENDERER=1`
in `main.rs` — a workaround for `drawImage(video)` on VA-API DMA-BUF surfaces, a code path
that stopped existing when WebCodecs became the default video path in `f6b94ea`. The main
thread sits at 84% of a core with a *single* deck playing. Full evidence, the A/B
(`CUEMARK_ENABLE_DMABUF=1`: 87% → 62%, 6 rAF stalls → 0) and the remaining open items:
`docs/design/output-noise-and-track-reload-silence.md`, "Bug E re-diagnosis".

⚠️ **UPDATE 2026-08-02 (late): `WEBKIT_DISABLE_DMABUF_RENDERER=1` is now OFF by default**
(`CUEMARK_DISABLE_DMABUF=1` restores it). A second, independent condemnation landed the same
day: it also **corrupts the WebGL compositor canvas**, rendering growing horizontal bands of
uninitialised memory. That was the long-running "output window renders noise" bug — which was
never an output-window bug at all. The compositor canvas was `display:none` from `ee91c54`
until 2026-08-02, so nobody had ever *looked* at what the compositor produced; making it
visible showed the identical corruption in the **control** window. One stale workaround, two
bugs that looked unrelated, chased separately for weeks. See "ROOT-CAUSED 2026-08-02 (late)"
in the same doc.

⚠️ **UPDATE 2026-08-03: the *remaining* half of that bug was a GPU driver defect, not WebKit.**
Retiring the env var fixed the compositor canvas but the output window still showed noise. Cause:
**all GPU→CPU readback from WebGL fails on this machine's Mesa `crocus` driver** — `readPixels`
returns `INVALID_OPERATION` + a zeroed buffer even from a complete, non-multisampled FBO, and
every canvas snapshot returns transparent, none of it raising. Every route passes under
`LIBGL_ALWAYS_SOFTWARE=1`; that A/B is the only way to tell, because WebKit masks `RENDERER`
("WebKit WebGL", "Apple GPU"). **Before blaming WebKitGTK for any rendering fault, run the
software arm.** The noise itself was not corruption at all: nothing was ever drawn to the output
canvas (a transparent source under `source-over` writes nothing, and it was never cleared), so
the screen showed uninitialised surface memory. The compositor now lives in the output window.
See `docs/upstream/webgl-canvas-readback-broken.md` and Bug A's "BUILT 2026-08-03" section.

**Debugging technique worth stealing**: when output is wrong and every log says the data is
fine, *display the intermediate surface*. Give the hidden canvas a real size and a bright
border. That single change cracked a bug that survived two fix attempts, permanent
instrumentation, and a conclusion of "the JS data path is provably healthy" — which was true,
and irrelevant, because the corruption was upstream of everything being measured.

**Three techniques from that session, reusable:**

- **`scripts/probes/thread-cpu-sampler.sh` before reaching for `perf`.** The watchdog's
  `Δutime` is process-wide; this attributes CPU to a *named thread* (main vs.
  `WebCore: Worker` vs. `HeapHelper`/`ollector Thread` vs. `eoDecoder queue`), which is
  usually the whole diagnosis, and it needs no `sudo`.
- **Slice `perf` samples to the stall window.** `perf` timestamps are `CLOCK_MONOTONIC`;
  the app log is wall-clock. Offset = `time.time() - float(open('/proc/uptime').read().split()[0])`.
  Then `perf report --time "<s1>,<e1> <s2>,<e2>"` (space-separated ranges, in one quoted
  arg — comma-joining them silently matches nothing), or bucket
  `perf script -F time,tid` per 100ms. **`-F time,tid` prints tid *first*, then time.**
- **Disassemble the hot region when symbols are stripped.** `libwebkit2gtk` exports only
  ~2259 dynamic symbols, so `perf`/`nm -D` resolve everything to `WebProcessMain+0x28e…`.
  But a tight cluster of hot addresses spanning a few hundred bytes is a loop body:
  `objdump -d --start-address=… --stop-address=…` identifies what it *does* even with no
  symbol at all (here: `psrld`/`pand`/`cvtdq2ps`/`mulps` over 4-byte-strided loads with a
  16-entry coefficient array ⇒ a 16-tap RGBA resampling filter).

⚠️ **A CPU-delta A/B is meaningless on a saturated resource.** An
`imageSmoothingQuality` experiment during that session scored ~87% vs ~88% main-thread CPU
and read as "no effect" — but the thread was pegged in *both* arms, so CPU could not move by
construction. Score throughput instead (rAF stall count, `position-poll` latency).

**Also note**: `App.svelte`'s rAF heartbeat now logs `[heartbeat] rAF stalled <N>ms` with a measured
duration on recovery, so a *recovered* stall is a positive log line, not a gap you must spot.

### UI frozen solid, audio keeps playing, rAF heartbeat log stops forever — check which of two distinct causes

**Shared symptom**: the frontend's rAF loop stops permanently — no further log output of
any kind — while GStreamer's independent Rust audio pipeline keeps playing.

> **Log-line change (2026-08-02)**: `App.svelte`'s `frame()` used to emit
> `[heartbeat] rAF alive` once per second unconditionally, and this entry was written
> against watching those lines stop. It no longer does — every log file was ~100%
> heartbeat noise, which actively obstructed at least two investigations (see
> `docs/design/pipewiresink-play-hang.md`, whose live log "contained nothing but
> `[frontend] [heartbeat] rAF alive` lines"). It now logs only `[heartbeat] rAF stalled
> <N>ms` when consecutive ticks are >1s apart. **For a permanent freeze the tell is
> unchanged — no output at all** — but a *recovered* stall now announces itself with a
> measured duration instead of a gap you have to spot by eye. Rust-side liveness is
> unaffected: `watchdog_heartbeat` still reports every second (`watchdog.rs`).

Found live, root-caused
via `gdb`, 2026-07-24/25 — full writeup in `docs/design/pcm-buffer-playback.md`, "Ninth
mechanism". Two different mechanisms produce this identical externally-observable
symptom; don't assume it's the first one just because the shape matches:

1. **A real deadlock inside WebKitGTK's own `MediaPlayerPrivateGStreamer`** — the GTK/JS
   main thread stuck inside a synchronous `gst_element_send_event()` (a `<video>` seek),
   holding a GStreamer element mutex, while one of WebKit's own internal GStreamer
   streaming threads is parked on a `WTF::ParkingLot` condition variable waiting for that
   same main thread's run loop to service a "new sample ready" signal. Classic AB-BA
   deadlock, confirmed via a live `gdb -p <pid> thread apply all bt` on the actual
   still-hung `WebKitWebProcess`. Not a cuemark/Rust bug — a real WebKitGTK bug. Trigger:
   `App.svelte`'s drift-correction resync (`v.currentTime = contentPos` when audio/video
   drift exceeds a threshold) fires this exact seek call on essentially every
   position-poll for as long as any deck plays at a non-1.0 rate, not just during scratch.
   Mitigation (not a fix — can't fix a bug in WebKitGTK itself): widen the drift threshold
   (`App.svelte`, currently 250ms) so the seek — and thus this deadlock's trigger window —
   fires far less often. **Diagnostic tell**: if you can still get a `gdb`/WebDriver JS
   execution response from the frozen process, it's NOT this one — see #2.
2. **A near-end-of-track decode stall at non-1.0 rate, unrelated to seeks or
   networking** — WebKit's `<video>` element itself genuinely stops advancing
   (`readyState` stuck at 2 `HAVE_CURRENT_DATA`, `networkState` stuck at 2
   `LOADING`, every internal GStreamer streaming thread parked in
   `futex_do_wait`) while the **JS main thread stays fully responsive**
   (WebDriver JS execution and the rAF loop itself keep working). **First
   hypothesis (media_server.rs cache-lookup race) turned out to be wrong** —
   disproven live when the exact same stall recurred with `buffered` already
   reporting the *entire file* downloaded (`[0, duration]`), which rules out
   any network race by definition (nothing left to fetch). `media_cache.rs`'s
   `lookup_wait()` is still a real, worthwhile fix for the race it *does* fix
   (kept), just not the cause of this stall. **Actual root cause, confirmed via
   a control test**: WebKitGTK's internal video-only GStreamer pipeline runs at
   `segment.rate = deck.playbackRate` once `v.playbackRate` ≠ 1.0, and its own
   EOS/segment-boundary bookkeeping doesn't land cleanly at a non-1.0 rate — a
   downstream element waits forever for one more buffer that a rate-scaled
   calculation thinks should exist but doesn't. Confirmed by seeking near the
   end and playing to true EOS at `playbackRate=1.0`: clean every time, vs. 2
   stalls in 3 attempts at 0.87×. A bug inside WebKitGTK itself, same family as
   #1 above (both triggered by non-1.0 `v.playbackRate`) but a different
   manifestation — a decode-thread stall with the main thread free, not a
   main-thread deadlock. **A mitigation (reset `<video>` to `playbackRate=1.0`
   near track end) was built, live-tested, and fully reverted the same day
   (2026-07-25)** after three compounding regressions — see "Eleventh
   mechanism" in the design doc for the full sequence (a store-effect-gated
   guard that never fired; a switch to `v.currentTime` for reliability; a real
   audio-truncation regression from letting `onended` stop the still-playing
   real audio early; a worse attempt to fix that by waiting on `deck-eos`,
   which doesn't reliably arrive and left audio playing forever). **Currently
   unmitigated by deliberate choice** — every attempted fix cost more than the
   rare freeze it avoided. Root-cause research (same session): `libwebkit2gtk
   -4.1` is already at the latest Ubuntu 24.04 apt version (2.52.3, no upgrade
   path); WebKit's own `setRate()` issues a standard `FLUSH|ACCURATE` seek with
   `stop=GST_CLOCK_TIME_NONE`, not obviously wrong in isolation — the actual
   bug likely lives in `multiqueue`'s rate-scaled buffering-level accounting
   never resolving to real EOS once `segment.rate != 1.0`. No matching public
   WebKit bug report found. A real structural fix would mean either never
   setting `v.playbackRate` away from 1.0 at all (raises mechanism-#1
   exposure instead) or a custom Rust/GStreamer video-decode pipeline
   bypassing WebKit's `<video>` element entirely (mirrors the PCM-buffer
   approach already built for audio scratch) — neither attempted; both are
   substantial projects, not quick patches.
   **Diagnostic tell**: check the video element's
   `paused`/`ended`/`readyState`/`networkState`/`buffered` via the debug hook
   or devtools. `readyState < 3` mid-playback (not `paused`, not `ended`) means
   a genuine stall; `buffered` already covering the full duration at the time
   of the stall rules out a network cause and points at internal
   decode/segment bookkeeping instead. Don't assume a stuck position value is a
   freeze at all until you've checked these — reaching a legitimate
   end-of-track also freezes the polled position (WebKitGTK resets
   `currentTime` to 0 after `ended` fires, with `paused=true`), which looks
   identical to a stall from a single polled number alone. A control run at
   `playbackRate=1.0` (the setting a rate-related hypothesis predicts should
   *not* fail) is a cheap, decisive way to confirm or rule out this whole
   class before trusting any fix.

**Catching either one live, cheaper than a fresh repro**: if a process from a *real*
incident is still alive and hung (check `ps -o etimes,stat -p <pid>` — an old, sleeping
`cuemark`/`WebKitWebProcess` pair is worth investigating before anything else), attaching
`gdb` to it directly (`gdb -p <pid> -batch -iex "set debuginfod enabled off" -ex "thread
apply all bt"`) hands you the actual incident's state instead of needing to reproduce
from scratch. This still needs root — `ptrace_scope=1` blocks attaching to a
non-descendant process even with the harness's sandbox override disabled (confirmed: that
override only lifts the harness's own restrictions, not the kernel's). If you don't have
passwordless `sudo`, ask the user to run the `gdb -p` command themselves via `!` so the
password prompt reaches them directly, and paste the backtrace back.

**Systemic plan (2026-07-25 architecture review) — read before adding any new
`<video>`-element mitigation**: both mechanisms above are bugs inside WebKitGTK's
`MediaPlayerPrivateGStreamer`, and the mitigation-stacking approach was explicitly
retired after the Eleventh mechanism. The agreed direction is in `docs/design/`:
`freeze-watchdog.md` (Rust-side heartbeat watchdog + session-of-record + webview
reload recovery — makes ANY webview freeze a few-second blink instead of a
show-ender), `webcodecs-video-path.md` (replace the `<video>` element with
`VideoDecoder` slaved to the Rust audio clock — removes both mechanisms'
trigger operations entirely; feasibility spike passed same day, see its results
table), and `native-output-pipeline.md` (shelved escalation path). Upstream bug
drafts with evidence: `docs/upstream/`. Key empirical facts to not re-discover:
WebCodecs decode is mature/default-on and works correctly here (1080p software
decode 153–165 fps), but **any use of `VideoEncoder` (`isConfigSupported` or
`configure`) SIGABRTs the web process** — recording must stay in Rust. Probe
harnesses: `scripts/probes/` (see `verify-ui` skill's "Lightweight webview
probes" section for the technique).

### Fresh machine: tracks load (filename shows) but never play, no waveform, black video preview

Confirmed root cause on a clean Ubuntu install (2026-06-19): `gstreamer1.0-plugins-bad` was never
installed — only `libgstreamer-plugins-bad1.0-0` (the runtime *library*, pulled in transitively) was
present, not the actual plugin package. This is a silent failure: `cargo build`/`cargo tauri dev`
compile and launch fine, because the Rust code only links against `gstreamer`/`gstreamer-audio`
headers, not against specific plugin .so files — the missing element is only discovered at pipeline
construction time, deep in `load()`.

Two independent symptoms, same one cause:
- Rust audio pipeline: `GStreamer element 'pitch' not found: Failed to find element factory with name
  'pitch'` in the WebKit devtools console (right-click deck → Inspect Element → Console — this does
  **not** appear in `cargo tauri dev`'s terminal output or `~/.local/share/com.cuemark.app/logs/cuemark.log`,
  since it's a JS-side `console.error` from a rejected `audioLoad()` promise, not a Rust `log::` call).
  Pipeline construction throws before `inner` is ever set → "no pipeline loaded" / "no audio pipeline
  for deck" on every subsequent call → no waveform (waveform analysis also goes through the Rust
  pipeline, not `decodeAudioData` — see CLAUDE.md).
- `<video>` element: `NotSupportedError`, `error.code === 4` — WebKit's own internal GStreamer instance
  also needs `h264parse` (also shipped in `plugins-bad`) to demux H.264-in-MP4, so it fails too. Looks
  identical to the unrelated VA-API DMA-BUF black-screen bug (see journal.md 2026-06-19 entry) but has
  a different fix — don't reach for the VA-API rank-demotion fix first; check `gst-inspect-1.0 pitch`
  before assuming it's the GPU driver issue.

Fix: `sudo apt-get install gstreamer1.0-plugins-bad`, then **fully restart** the app (`cargo tauri dev`
caches the GStreamer plugin registry per-process — a frontend hot-reload is not enough, kill and
relaunch). Verify with `gst-inspect-1.0 pitch` before relaunching. See `run-app` skill's prerequisites
section, which now lists this as a separate "runtime plugins" install step from the build-time
`-dev` headers, since the two are easy to conflate.

---

## Bus message guide

| Message | What it tells you |
|---|---|
| `EOS` | Track ended. `at_eos` flag triggers seek-to-zero on next `play()`. **The bus thread also calls `pipeline.set_state(Paused)` directly right here** (added 2026-07-25) — GStreamer does not stop a pipeline's clock on EOS by itself; `PLAYING` state keeps ticking with nothing left to render, so `query_position` climbs forever (real-time, unbounded, well past the track's actual duration) until something explicitly pauses it. This used to rely entirely on the frontend's `deck-eos` Tauri-event handler calling `audio_pause()` in response — live-tested and found that round-trip doesn't reliably land in every scenario, leaving audio playing forever with an ever-growing, silently-wrong position. Self-pausing here makes the pipeline correct regardless of frontend timing/behavior. Safe to call `set_state` from this thread: it's a dedicated bus-consumer thread via `bus.iter_timed()`, not a GStreamer streaming thread or the GLib main loop (the documented-unsafe case for synchronous state changes). |
| `ERROR` | Fatal pipeline error. Log names the element and GStreamer flow return. Sets `at_error`. |
| `WARNING` | Non-fatal. Usually codec quirks. |
| `StateChanged` (pipeline-level) | Shows NULL→READY→PAUSED→PLAYING lifecycle. An unexpected drop to PAUSED mid-playback is a sign of a seek interaction problem. |
| `AsyncDone` | Seek completed (user-initiated seek or EOS restart). Logs position — **raw `query_position()`, not `DeckAudioPipeline::position()`**: no output-graph latency subtracted, no `last_scratch_frame` correction. That is exactly what makes it the right instrument for diagnosing the position pipeline itself, and the wrong one for "what does the frontend see". |

---

## Reconstructing an IPC-ordering race from the log alone (2026-08-13)

A user report of the form "I did X and Y happened, then I did Z and it fixed itself" is often
a *race*, and this log has enough in it to prove the ordering without a reproducer. The
2026-08-13 "video played back very fast after a scratch" event was root-caused this way in
one pass, with no live repro at any point (`docs/design/scratch-play-race.md`).

**The three log families that interleave into a timeline.** All are millisecond-stamped from
the same clock, so they can be read as one sequence:

| Line | What it pins down |
|---|---|
| `[frontend] [video-path] … calling audioPlay/audioPause (was=…)` | the frontend *decided* to change transport, and what it believed the previous state was |
| `[audio/<deck>] detached-pipeline IPC received: <op>` | that IPC *arrived in Rust* — this is the ordering ground truth, and `op` names it |
| `[bus/<deck>] pipeline: A → B` | the pipeline actually changed state |

The gap between line 2 and line 3 is the whole game. **A `detached-pipeline IPC received:
play` with no `Paused → Playing` after it means the play was accepted and had no effect.**
Nothing logs an error for that — `play()` returning `Ok` and `play()` doing something are
different statements, and only the bus distinguishes them.

**Search all the rotated logs for a second instance before believing the mechanism.** One
occurrence is a story; two independent ones with the same signature is a mechanism. Scan for
the *pair* within a time window rather than for either line alone:

```python
# play arriving before stop_scratch = the race. Run over cuemark*.log, not just cuemark.log.
if e == 'IPC received: play':
    for t2, e2 in later_events_within(2.0):
        if e2 == 'IPC received: stop_scratch':
            report(f'play {ms(t2-t)}ms ahead of stop_scratch')
```

That found a second instance two days earlier that nobody had reported, which is what turned
"a weird thing happened once" into a fix.

**The user's own corrective action is telemetry.** "I pressed pause/play and it fixed itself"
appears in the log as a `pause` then `play` a few seconds after the fault — a marker for
where the user *noticed* something wrong. In both instances the corrective pair sat 3s after
the racing pair. Searching for an unexplained manual pause/play is a way to find faults that
were never reported at all, and the fact that it recovers the deck is itself a strong clue:
it says the fault is in state that a `Paused → Playing` transition rebuilds.

**Position errors: check additive before multiplicative.** The bad position here was 130.006s
against a true 61.355s. The ratio is 2.12 — a completely plausible tempo, and this codebase
has a real, documented, previously-shipped *multiplicative* position bug to pattern-match
against (`rate-position-drift.md`, "seek-domain scaling"). It was not that. The decomposition
that actually fit was additive, to 4ms:

```
130.006 = 61.355 (content) + 43.671 (pipeline position before the gesture) + 24.976 (gesture playing time)
```

Rate was 1.0 the whole time, which the log proves independently: the pre-gesture
`async-done pos=43671ms` after exactly 43.63s of playback. **Get the rate from an independent
line before reading any ratio as a rate.**

---

## MIDI log throttle

High-frequency MIDI controls throttled to one log line per 500ms per `(status, d1)` key in `midi.rs`.
To see every event, remove the key from `log_throttle` or set threshold to 0.

**Debugging trap (confirmed 2026-07-21 jog-wheel session)**: the throttle only suppresses the
*log line* — `MidiAction` dispatch to the frontend fires for every real message, unthrottled.
Counting `=> JogNudge` (or any continuous-control) log lines and comparing against a downstream
counter (e.g. real seeks/IPC calls) will show what looks like 5–13x "amplification" that isn't
there — it's just many real events for each logged one. Don't chase a duplicate-listener or
double-dispatch theory from this mismatch alone. To get a real 1:1 count for debugging, add a
temporary counter/log at the effect site itself (e.g. inside the Tauri command being called),
not by comparing against the throttled MIDI log line count. This cost real time in that session:
a plausible-looking "5 HMR reloads ≈ 5x duplicate seeks" coincidence turned out to be a red
herring once a Rust-side `audio_seek` call counter proved the real ratio (238 IPC calls for 92
logged events) was fully explained by the log throttle, not by stacked event listeners.

## Burst delivery: never derive a rate from inter-event timing (2026-08-08)

The same fact that makes the log throttle misleading has a second, worse consequence. USB
MIDI does not deliver ticks evenly — several land in one JS macrotask, then a gap. So the
inter-event interval is an artefact of *delivery*, not of how fast the user moved, and any
control that divides by it is measuring the wrong thing.

Vinyl-mode jog was built that way and it made the position jump around erratically. Three
compounding failures, all traceable to the same root:

1. `queueScratchRate`-style rAF coalescing **overwrites**, so a burst collapses to one
   update and the rest of the wheel motion is discarded outright. Coalescing a *rate* is
   lossy; coalescing a *position* is not.
2. The divisor collapses onto its floor (`SCRATCH_MIN_DT_MS`), saturating the computed rate
   at the mode cap. An EMA smooths this but cannot remove it — a hard rolling window was
   tried first and was worse, and both attempts are documented at length in `handler.ts`.
3. With no absolute reference, every over- and undershoot accumulates for the whole gesture.

**The fix is structural, not a tuning problem**: for anything driven by direct
manipulation, accumulate events into an **absolute target position** and servo to it
(`scratch_to()` in `pipeline.rs`, the scrub bus in `seekBus.ts`). N ticks then move the
track by exactly N ticks of travel whenever they arrive. Velocity remains correct for
controls that are *supposed* to free-run between events — shuttle-mode jog deliberately
keeps it.

Reach for this whenever a continuous control feels erratic rather than merely mis-scaled:
mis-scaled is a constant, erratic is usually timing dependence. Full write-up:
`docs/design/waveform-scrub.md` (`VINYL_SEC_PER_TICK` is calibrated — `1.8 / 256`; the
Starlight encoder reports plain ±1 deltas, measured, so accumulation is exact).

⚠️ **One bounded exception, added 2026-08-08 — read it before citing the rule above at a
velocity estimate.** `HandTracker` in `pipeline.rs` *does* derive a hand speed from
inter-event intervals, and it is correct to. What makes it safe is not the estimator but
its role: velocity is **not the control variable** there, position still is. Every real
target re-anchors the cursor absolutely, so an estimate error cannot accumulate, and its
only effect is a bounded extrapolation (300ms, capped at 50ms of content) that the next
event corrects. The rule is really "never let a burst-derived rate be the thing that
*determines* position" — an unbounded, uncorrected integration. A bounded, self-correcting
one is a different animal.

---

## A scrub/scratch that drops out: distinguish *absence* of input from *late* input first

Root-caused 2026-08-08 (`docs/design/scratch-audio-downstream-delivery.md`). Three sessions
were spent fixing this in the feeder, the servo and the scrub bus — all wrong, because the
only available measurement was the gap between calls *arriving in Rust*, which cannot tell
"no event fired" from "an event fired and took 800ms to get here". **Those have opposite
fixes**, so measure the frontend legs before touching either end:

```
device ──evQueue──► JS handler ──rafWait──► bus flush ──dispatchLag──► invoke ──ipc──► resolved
```

`src/lib/audio/scrubStats.ts` reports all of them, one burst of lines per gesture
(`[scrub-deliver/…]`, `[scrub-sec/…]`). Read them against the Rust `[scratch-tel/…]` line —
same cadence, and `sent/s` there is the same quantity as `targets N/s` here.

| Shape | Cause |
|---|---|
| `gap` large, `evQueue` large | events queued behind a blocked main thread |
| `gap` large, `evQueue` ≈ 0 | **no events were produced** — nothing downstream can fix it |
| `gap` small, `rafWait` large | the scrub bus's own rAF coalescing |
| `gap`/`rafWait` small, `ipc` large | IPC backpressure — check `[ipc-ping]` |
| all small, but Rust-side `gap max` large | between `invoke()` and GTK dispatch (`toRust`) |

What it actually was, and the finding worth carrying forward: **a slowly-moving hand does
not produce a steady event stream.** At 16s over 1224px the gentle drag moved 13–27 px/s and
the DOM delivered **5–12 events/s** (~2.3px each) with gaps to 1180ms, while `rafWait` was
13ms and `evQueue` on the gap-ending event was 4ms — freshly stamped, not late. The servo
then converged inside its epsilon and faded **by design**, so `arrived%` tracked hand speed
inversely and exactly: 15–45% muted below 0.35×, 0% above 0.96×.

🔴 **Burstiness mutes a position servo, not sparseness** — measured, and it inverts the
intuition. A *uniform* 300ms cadence never converges (each jump is large, closing it takes
about as long as the period) and measures 0% silent. A **burst** ends with a small jump the
servo closes in ~150ms, and then nothing arrives for the rest of the period. Live delivery
is bursty (`gap p50=18ms` with `gapMax` 376–1180ms), which is why "11–45 updates/s" reads as
survivable on paper and is not.

Fix shipped: coast, don't mute (`HandTracker`, above). A platter has mass; when the hand
stops feeding it motion it doesn't stop dead. Window deliberately too short (300ms) to bridge
the 1180ms outlier — covering that makes it a flywheel, and a hand that crosses no pixel for
1.2s has genuinely stopped, where a held record *is* silent. User-confirmed live: "the audio
stays playing the whole time that an action is happening, in both directions", with mild
residual wobble — the dead-reckoning overshoot, accepted.

⚠️ **Two designed silences will masquerade as this bug** and cost a session if you forget:
`arrived%` on a hand slowing to a stop, and `snaps` on a coarse overview drag that saturates
`SCRATCH_TARGET_MAX_RATE`. Ask for **slow, smooth, zoomed** gestures when requesting a repro.

---

## CPU profiling a live "chokes up" freeze — `pidstat` + `perf`

For a freeze that JS-side timing (`frontend_log`/rAF heartbeat, see the pcm-buffer
design doc) has already localized to "the WebKit main thread stopped responding,"
the next question is *why* — busy doing something, or genuinely blocked. That
distinction is invisible from `top`/a single CPU% snapshot and from reading code; it's
immediate from a continuous per-thread trace spanning the repro. Two conflated
freezes in the PCM-scratch feature (2026-07-23) turned out to be different mechanisms
entirely — one CPU-bound (a runaway canvas redraw loop), one blocked-on-I/O (an SMB
network stall) — and `pidstat` is what told them apart. See
`docs/design/pcm-buffer-playback.md`'s "second"/"third freeze mechanism" sections for
the full writeups.

**Step 1 — `pidstat -t -p <cuemark PID>,<WebKitWebProcess PID> 1 -h`**, backgrounded
for the whole test session (`nohup ... > pidstat.log 2>&1 &`). Find PIDs via
`pgrep -af "target/debug/cuemark|WebKitWebProcess"`. Sustained ~100%+ CPU on one
thread during the freeze window = compute-bound (profile it, step 2). Sustained
near-0% CPU on both = blocked on a syscall (a GStreamer seek, a network mount, a lock)
— check what Rust is waiting on instead of profiling JS.

**Step 2 — if CPU-bound, `perf record -g -F 999 -p <WebKitWebProcess PID> -o out.data
-- sleep <N>`.**

- Needs `kernel.perf_event_paranoid` ≤ 1 for non-root profiling. Check with
  `cat /proc/sys/kernel/perf_event_paranoid`; if it's higher, ask the user to run
  `sudo sysctl -w kernel.perf_event_paranoid=1` (temporary, resets on reboot, no
  config file touched — don't ask for anything more permanent than the session needs).
- **A live-hardware repro needs a generous, explicit capture window** — the user is
  looking at the controller, not the terminal. A 25s or 60s window reliably closes
  before they get there (confirmed twice). Use 120s, say clearly that recording has
  started and give a wide "any time in the next two minutes" instruction, then once
  `pidstat` confirms the freeze already happened, stop early with `kill -INT <perf
  pid>` (flushes the file cleanly) rather than waiting out the rest.

**Step 3 — symbolizing the capture: `DEBUGINFOD_URLS="" perf report -i out.data
--stdio -g none -n`.**

- **The `DEBUGINFOD_URLS=""` prefix is not optional on this machine.**
  `DEBUGINFOD_URLS=https://debuginfod.ubuntu.com` is set in the environment; any
  `perf` command that resolves symbols (`perf report`, or `perf script` with a
  `sym`/`dso` field) will try to fetch missing debug info from that URL and can hang
  for many minutes with zero CPU usage and zero output — indistinguishable from perf
  itself being stuck. Always disable it for these commands.
- `-g none` (skip call-graph aggregation) resolves in seconds; `-g flat`/`-g graph`
  (the default) can hang or take minutes on `libwebkit2gtk`'s huge symbol table even
  with debuginfod disabled — start with `-g none` and only reach for a full call graph
  if the flat profile doesn't already answer the question.
- `perf script -F time,comm,tid` (no symbol fields at all) is unaffected by either
  slowdown and resolves instantly — useful as a fast sanity check that the capture
  actually spans the repro window before running the slower symbolized report.
- Expect JS application code to show up as `[JIT] tid <pid>` with no further symbol —
  perf can't resolve JIT-compiled JS without a `jitdump` integration this setup
  doesn't have. High `[JIT]` percentage plus hot *named* leaf symbols in `libm`/`libc`
  (e.g. `__round`, `__memmove`) is itself a useful signal: it means the app's own JS is
  the hot path, not GStreamer/WebGL/video-decode C++ — go look at per-frame `$effect`s
  and RAF loops in the frontend rather than the Rust pipeline.

---

## Catching an intermittent GStreamer-side stall live with `gdb` (not `perf`)

`pidstat`/`perf` (above) answer "CPU-bound or blocked?" and, if CPU-bound, "which JS
line?". For a **blocked** stall inside Rust/GStreamer/GLib — the audio pipeline just
went quiet, `pidstat` shows near-0% CPU — the right tool is `gdb` attached live, to get
an actual C-level thread backtrace at the moment of the block, rather than guessing
from syscall timing. Found and used successfully in `docs/design/pcm-buffer-playback.md`'s
"Seventh mechanism" section (root-caused the "reverse scratch is silent" bug this way).

**`ptrace`/`gdb`/`strace` are not actually blocked in this environment** — a prior
session's note to that effect was a self-inflicted testing mistake, not a real
restriction. This system's default `yama.ptrace_scope=1` only allows a tracer to
attach to its own **descendants**. Attaching `strace`/`gdb` to an independently
backgrounded process makes them **siblings** (both children of the same shell), which
`ptrace_scope=1` correctly rejects with `Operation not permitted` — easy to misread as
"ptrace is disabled here." The fix: launch the target **under** the tracer from the
start (`gdb --args <bin> ...` / `strace -f <bin> ...`), which makes the tracer the true
parent — works with no `sudo`/`sysctl` changes. Attaching to an *already-running*
arbitrary process (e.g. the live app via `gdb -p <pid>`) still needs `sudo sysctl
kernel.yama.ptrace_scope=0` first.

**The `DEBUGINFOD_URLS` gotcha applies to `gdb` too, not just `perf`.** On `run`, `gdb`
prompts interactively "Enable debuginfod for this session? (y or [n])" the first time
it needs symbols — this silently hangs any scripted/non-interactive `gdb` session
(indistinguishable from the program itself hanging). Fix: launch with `-iex "set
debuginfod enabled off"`.

**Unfiltered `strace -f` measurably perturbs GStreamer/PipeWire scheduling races away
(or into worse ones)** — confirmed again this session: one run under `strace -f` with a
*filtered* syscall set hit a 60+ second stall on the very first `Paused→Playing`
transition, far outside anything ever seen untraced. `gdb` launched normally (it only
traps on breakpoints/signals, not every syscall) does **not** perturb timing-sensitive
GStreamer races the way `strace` does — every `gdb`-launched repro run reproduced the
target stall at the same rate/magnitude as untraced runs.

**Pattern for catching an intermittent stall live** (see `scripts/gdb-stall-catcher.py`
for a working implementation using Python's `pexpect`):
1. Launch the target under `gdb --args` with debuginfod disabled, `run` it.
2. Watch the **interleaved stdout** (gdb doesn't separate its own output from the
   inferior's — the same pty carries both) for whatever signal indicates the stall is
   *currently* happening — here, two consecutive identical counter values printed by
   the test itself.
3. The instant that fires, send `Ctrl-C` (`sendintr()` in `pexpect`) to stop the
   inferior while the stall is still in progress, run `thread apply all bt` to see
   every thread's C stack, then `continue`.
4. To resolve a specific thread's `??` frames (common for stripped system `.so`s with
   no debug info but still-present dynamic symbols) regardless of ASLR: switch to it
   by name (`gdb`'s Python API: `for t in gdb.selected_inferior().threads(): if
   t.name == "...": t.switch()`), then `frame N; info symbol $pc` per frame — resolves
   to `<function> + <offset> in section .text of <library>` using the live process's
   actual load addresses, no manual base-address arithmetic needed.

This combination found the actual blocking call in one session: a thread stuck several
frames inside `gst_pad_push()`, blocked on a condition variable inside
`libgstcoreelements.so` — i.e. ordinary `GstQueue` backpressure, not a mysterious
PipeWire scheduling bug. A vague "idle, waiting for work"-looking backtrace on an
**earlier** catch of the *same* stall turned out to be a red herring from too small a
sample (n=1) — re-run a few times (intermittent races need several catches) before
trusting what the first one shows.

## Verifying a fix for an intermittent GStreamer stall: always A/B the same binary

Once a stall is root-caused (as above) and a fix is written, **measure it with a
same-binary, same-environment before/after comparison — never just "run it a few
times and eyeball it."** Pattern used successfully fixing the "reverse scratch is
silent" bug (`docs/design/pcm-buffer-playback.md`, "Eighth mechanism"):
1. Build the fixed test binary, run the repro test (e.g.
   `scratch_second_gesture_reverse_repro`) untraced 10–25 times, tally stalls.
2. Temporarily disable *only* the fix (e.g. set a widened constant back to its
   original value) — not `git stash`, which on a branch with other uncommitted
   work-in-progress can revert far more than intended (stashed an entire
   feature's implementation once this session before the mistake was caught).
   Rebuild, run the *same* test the *same* number of times as the "baseline."
3. Compare hit rates and stall magnitudes side by side. A fix that isn't clearly
   better on this comparison (not just "didn't stall on the 3 runs I tried") isn't
   verified — intermittent races need double-digit sample sizes in both arms to
   trust a delta.

This caught a real mistake in the same session: an initial fix (widen
`output_queue`'s cap at scratch-gesture start, narrow it back after a fixed
grace-period timer) looked plausible and compiled clean, but the A/B comparison
showed it made things *worse* — 8/8 runs stalled with the "fix" vs. ~75% (6/8)
on the disabled-fix baseline. Without the baseline run, "it still stalls
sometimes" could easily have been misread as "the underlying race is just still
there, fix is a partial improvement" — the side-by-side made it obvious the fix
had gone from making things *better* to *reliably worse*, which prompted
looking for what the fix itself was causing (see next section) rather than
concluding the earlier root-cause diagnosis was wrong.

**The same rule applies to a unit test, and it is cheaper there — run the test with the fix
disabled and confirm it fails.** A test written from a correct diagnosis can still fail to
discriminate, and then it silently certifies nothing forever. Two instances in this project,
both in the same feature:

- `scratch_to_smoke` passed throughout the "scrubbing plays no audio" bug and would pass again
  on the broken code: it asserts the cursor *arrives*, and it did — in one chunk, then sat
  silent. The defect was the *shape* of the motion, a whole-gesture statistical property.
- The first schedule written for `sparse_slow_hand_stays_audible` (2026-08-08) measured 1.5%
  silent with the coast disabled, comfortably under its own 5% threshold. Only the disabled-fix
  arm exposed that; re-pointed at a 400ms burst period it reads **19.7% disabled / 0.0%
  enabled**.

The disabled-fix arm also caught a **harness** fault the same session: `replay_sampled` was
counting the chunks before the target had ever moved, where `arrived` is correct, which made
one arm read "7.5% silent" no matter what the servo did. The tell was that the number did not
move *at all* across the A/B. A metric that is identical in both arms is either measuring
nothing or measuring the harness.

For a behaviour with two failure directions, write **two opposed tests** so a wrong constant
fails one of them — `sparse_slow_hand_stays_audible` (sound where there should be sound) and
`long_input_gap_still_comes_to_rest` (silence where there should be silence, failing with "the
coast has become a flywheel" if the window is too long).

## GStreamer gotcha: narrowing a live `queue`'s `max-size-*` cap while it's over
## the new limit re-applies backpressure immediately, not once it "catches up"

Setting `max-size-time` (or `-buffers`/`-bytes`) on a `GstQueue` element while
the pipeline is running takes effect immediately — the queue re-evaluates its
current fill against the *new* limit on the next internal check, not just for
future buffers. If the queue is currently holding more than the new (lower)
limit, it blocks the pushing thread right then, exactly as if it had just now
filled up to that point live. There is no grace period or graceful drain-down
to the new cap.

This matters for any "widen a queue's cap temporarily, then narrow it back"
mitigation: **narrow it only in response to a real signal that the backlog is
actually gone** (e.g. the event that ends the condition the wider cap was
compensating for), never on a fixed timer independent of the pipeline's actual
state. A timer that fires before the backlog has drained will self-inflict a
new, *more* deterministic stall right at the timer's deadline — which is
exactly what happened in the first attempt at the `output_queue` fix above (see
docs/design/pcm-buffer-playback.md, "Eighth mechanism," and the A/B-testing
section just above for how this was caught).

---

## Svelte reactive-storm freezes: when a "no-op guard" doesn't actually no-op

Found 2026-07-23 (PCM-scratch feature): a redraw loop in `WaveformCanvas.svelte` had
a correct pixel-movement gate on its `requestAnimationFrame` loop, yet the WebKit main
thread still pegged at ~100% CPU for the whole scratch gesture. The gate wasn't
broken — something else was tearing down and recreating the *entire effect* (which
cancels and restarts the gated rAF loop) tens of times per second, and every
recreation paid for one full ungated redraw before the gate was ever reached.

**Root cause**: a `writable<Set<...>>` store (`scratchingDecks` in `seekBus.ts`) had a
guard *inside* its `.update()` callback meant to skip notifying subscribers when
membership didn't change:
```js
scratchingDecks.update((s) => {
  if (active === s.has(deckId)) return s; // looks like a no-op guard — isn't one
  ...
});
```
This does not work. Svelte's `writable` store equality check (`safe_not_equal` from
`svelte/store`) treats **any object or function value as always "changed,"**
regardless of reference equality — `(a && typeof a === 'object')` short-circuits the
whole comparison to `true` whenever the *old* value is a truthy object. A `Set`, `Map`,
array, or plain object always satisfies this, so returning the *same* reference from
inside `update()` still notifies every subscriber. The guard only skips constructing a
*new* Set; it never skips the notification it was written to prevent.

**Fix — move the check outside the `update()`/`set()` call entirely**, using `get()`:
```js
export function setScratching(deckId: string, active: boolean): void {
  if (active === get(scratchingDecks).has(deckId)) return; // never touches the store
  scratchingDecks.update((s) => { const next = new Set(s); ...; return next; });
}
```

**Rule**: any `writable<Set<...>>` / `writable<Map<...>>` / `writable<Array<...>>` /
`writable<object>` in this codebase needs its dedup/no-op guard placed *before* the
`update()`/`set()` call, never inside the updater callback — a guard inside the
callback that "returns the same reference to skip" is a silent no-op for any
object-valued store. Grep for `writable<` and check every `.update()` callback for
this pattern if a similar high-frequency freeze shows up elsewhere.

**Diagnostic technique — isolated single-dependency probe effects.** When a manual
snapshot comparison ("did any field I can think of change?") says nothing changed but
an effect keeps re-running anyway, don't keep expanding the snapshot — the framework's
own dependency tracking is more reliable than a hand-written comparison, which can
have blind spots you haven't thought of. Add one throwaway probe effect per candidate
reactive value, each depending on exactly one thing:
```js
$effect(() => { deck; deckOnlyRuns++; });
$effect(() => { $someStore; someStoreOnlyRuns++; });
```
Flush the counters periodically via `debugLog`/`frontend_log` (see the pcm-buffer
design doc's JS-timing pattern) and compare rates. This isolates the true trigger in
one step instead of iterating on what a manual comparison might be missing — it's what
found this bug after a manual `deck`-field snapshot had already (correctly) ruled out
`deck` itself, leaving `$scratchingDecks` as the only remaining candidate.

**Diagnostic technique — `/proc/<pid>/task/<tid>/wchan` sampling when `perf`/`sudo`
isn't available.** `perf_event_paranoid` may be locked down with no way to lower it
(e.g. a sandboxed session where `sudo` itself is blocked). Sampling every thread's
`wchan` (the kernel function it's blocked in) and `comm` on a fixed interval needs no
elevated permissions and gives the same CPU-bound-vs-blocked-on-I/O distinction
`pidstat` gives at the process level, but additionally names *what* a blocked thread is
waiting on:
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
Unfiltered on purpose (idle threads produce a lot of routine `futex_do_wait`/
`poll_schedule_timeout` noise) — grep the log for the exact stall window after the
fact rather than trying to pre-filter what's "interesting" live.

---

## Files

| File | Concern |
|---|---|
| `src-tauri/src/audio/pipeline.rs` | Per-deck GStreamer pipeline, bus monitor, tempo/pitch element |
| `src-tauri/src/audio/mod.rs` | AudioManager, Tauri command handlers |
| `src-tauri/src/midi.rs` | MIDI event loop, log throttle, 14-bit rate decoding |
| `src-tauri/src/media_server.rs` | Local HTTP server for prod video serving (replaces `media://`) |
| `src/App.svelte` | Video element creation (muted, crossOrigin), rAF-throttled syncVideoElements, render loop |
| `src/lib/renderer/outputBus.ts` | Output Window frame transport (sender) — per-deck ImageBitmaps, has backpressure guard |
| `src/lib/renderer/outputProtocol.ts` | Control<->output message contract, and why frames rather than snapshots |
| `src/output.ts` | Output Window — **owns the Compositor** since 2026-08-03 |
| `journal.md` | Session notes — decisions and symptoms from past debugging |

## VA-API hardware decode status (as of 2026-06-20)

🔴 **Scoped to the 2012 MacBook Pro only — do not treat "H.264 hardware decode is
enabled" as true of whatever machine you're currently on.** `CLAUDE.md` states plainly
that the MacBook Pro has **no VA-API driver for any codec** — re-verified 2026-08-05 by
checking for Intel `*_drv_video.so` under `/usr/lib/x86_64-linux-gnu/dri` (none; only
d3d12/nouveau/r600/radeonsi/virtio_gpu), for `gstreamer1.0-vaapi` (not installed), and
`gst-inspect-1.0 va` (`0 features`). Everything decodes in software *there*. The
`GST_PLUGIN_FEATURE_RANK` demotion below is a **no-op** on that machine specifically —
there's nothing for it to demote.

🔴 **Confirmed false on `mele`, a second cuemark dev/test machine** (2026-08-12): `mele`
has a fully working VA-API stack (`iHD_drv_video.so`, `gstreamer1.0-vaapi` installed,
`gst-inspect-1.0 va` → 12 features including VP9 hardware decode). The "sandbox not being
the same environment session to session" theory once floated here was wrong — it's not
drift, it's two different physical machines, never distinguished in this doc before. See
`docs/environment.md` for the full per-machine matrix and the (currently open) question
of whether `main.rs`'s demotion list is correct on `mele`'s hardware.

**Never explain a codec-specific cost/behavior difference by hardware decode without
re-running those three checks first, on whichever machine you're actually on** — the
paragraphs below describe a `mesa-va-drivers`/`webkit2gtk` state from 2026-06-20 on the
MacBook Pro specifically. They're kept for historical/mechanism context (the
avc-vs-annexb finding itself doesn't depend on which decoder was active), not as a
current hardware-decode status for any given machine.

`src-tauri/src/main.rs` sets `GST_PLUGIN_FEATURE_RANK` to demote specific VA-API decoders to rank 0,
forcing software decode fallback for codecs where this GPU's DMA-BUF export was confirmed broken.
**Current state: only AV1 (`vaav1dec`/`vaapiav1dec`) is demoted.** H.264 hardware decode was
re-enabled 2026-06-20 after a `mesa-va-drivers`/`webkit2gtk` update and confirmed working (real
video, no corruption, lower CPU than dual software decode). If a black-screen or solid-garbage-color
symptom returns for H.264, or shows up freshly for AV1/VP9/HEVC, re-add the codec's `va*dec`/
`vaapi*dec` factory name to the rank string in `main.rs` — see the comment there and the
2026-06-19/2026-06-20 journal entries for the full history before assuming it's fixed for good.

## Verifying a GStreamer bug fix without the full app: replicate the pipeline logic standalone (2026-08-12)

To confirm `pipeline.rs`'s `autoplug-select` video-decoder-skip actually protects a
*different* machine's VA-API stack (`mele`, see `docs/environment.md`), a full app launch
wasn't needed — a ~40-line standalone `python3-gi` + `Gst` script built the same
`uridecodebin` + `autoplug-select` shape and pointed it at a real AV1 library file, with
`fakesink` standing in for the real audio graph. This is faster to iterate and easier to
read the result from (no log-grepping through app noise) than driving the real app for a
pipeline-shape question — reuse this pattern for any "does this GStreamer element
selection/caps/signal behavior hold on this machine" question that doesn't depend on the
rest of the app. It also makes a clean A/B: running the *same* script with the skip logic
deliberately broken reproduced the original bug's exact GStreamer error
(`GstVaAV1Dec:vaav1dec0: no valid frames found`) as the control arm, which is stronger
evidence than a single passing run alone.

**Gotcha**: `Gst.ElementFactory`'s klass string (what `autoplug-select` checks — see
`pipeline.rs`'s `is_video_decoder` comment) is not exposed as `factory.get_klass()` in
the `python3-gi` bindings, despite that being the natural-looking method name and despite
Rust's `gstreamer` crate exposing exactly that. It's `factory.get_metadata('klass')`.
Calling the wrong one raises `AttributeError` from inside a signal handler, which
GStreamer swallows silently and falls through to the *default* autoplug behavior (TRY,
not SKIP) — so a broken skip filter doesn't error loudly, it just quietly stops skipping,
and the result looks exactly like "the fix isn't there" rather than "the check crashed."
Confirm any `autoplug-select`/signal-handler probe actually fires its intended branch
(e.g. print inside both branches) before trusting a clean or a failing result from it.

## WebCodecs H.264 hardware decode requires `description` (avc), not annexb (2026-07-25)

⚠️ **This section's root-cause narrative assumes `vah264dec` (hardware) was actually
selected, which the 2026-08-05 re-verification says isn't possible on this machine (no
VA-API driver at all — see the correction at the top of "VA-API hardware decode status"
above).** The **fix still stands and is what shipped** (always build avc+`description`,
never rely on annexb-without-description) — that recipe works regardless of which decoder
is active, which is presumably why it was never noticed as wrong. What's stale is only the
causal story ("`vah264dec` doesn't tolerate annexb-without-description, `avdec_h264` does")
— treat it as an unconfirmed hypothesis from an environment state that may not have existed
the way this section describes, not a settled explanation.

**Symptom**: `VideoDecoder.configure({codec: 'avc1.PPCCLL'})` (no `description`) + `decode()` on
real Annex-B chunks (start-code-delimited NALs, in-band SPS/PPS) — the WebCodecs-documented
"annexb" mode — decodes **zero frames** and `flush()` rejects with `EncodingError: Decode error`.
Confirmed both for real demuxed file data (`video_demux.rs`) and for
`scripts/probes/webcodecs_decode_only_probe.py`'s own **host-encoded synthetic** AUs — re-running
that exact spike script today reproduces the failure it originally reported as a 60/60-frame pass.

**Root cause**: with `GST_DEBUG=h264*:6,webkitvideodecoder:6`, WebKitGTK 2.52.3's internal
`webkitvideodecoder` harness selects `vah264dec` (hardware, VA-API) for `avc1.*` codecs — H.264
hardware decode is enabled in this app's env (see "VA-API hardware decode status" above, only AV1
is demoted) — and **unconditionally signals `stream-format=avc` downstream**, regardless of
whether `configure()` was called with or without `description`. Its internal `h264parse0` then logs
`H.264 AVC caps, but no codec_data` → `refused caps`, and no frames ever reach the decoder. Forcing
software decode instead (`GST_PLUGIN_FEATURE_RANK=vah264dec:0,vaapih264dec:0`) makes the exact same
annexb-without-description call succeed (60/60 frames, pixel-exact) — `avdec_h264` (software) tolerates
annexb-without-description; `vah264dec` (hardware) does not. The spike's originally-recorded pass
was unknowingly exercising the software path only; it does not hold for this app's actual env, which
leaves H.264 hardware decode on.

**Fix**: always build an **avc**-format `description` (AVCDecoderConfigurationRecord: version,
profile_idc/compat/level_idc from the SPS, `lengthSizeMinusOne`, then length-prefixed SPS/PPS) from
the stream's first keyframe, and re-mux each chunk from Annex-B (start-code-delimited, includes
AUD/SPS/PPS/SEI) to avc format (4-byte-length-prefixed slice NALs only, parameter sets stripped —
they live in `description` instead) before calling `decode()`. `App.svelte`'s `probeWebCodecs` debug
hook tries annexb first, falls back to avc+description on failure, and reports which `mode` actually
decoded — use that fallback (or just go straight to avc+description, skipping the doomed-on-hardware
annexb attempt) in `codecPlayer.ts` (phase 2), not annexb-only as the design doc's spike table implied.
**Don't trust a probe result recorded before this app's real env was re-verified against it live** —
same lesson as "GStreamer/audio still runs for real inside Xvfb" in `verify-ui`'s gotcha list, one
level up: even a *result*, not just a mechanism, needs re-confirming once the surrounding env
(feature ranks, driver versions) can plausibly have shifted since it was recorded.

## WebCodecs frame upload: `texImage2D(gl, VideoFrame)` works direct, no Y-flip (2026-07-25)

Phase 2 of `docs/design/webcodecs-video-path.md` re-verified two open questions from the
phase 1 spike, on this app's real GPU (not the spike's Xvfb/llvmpipe software GL):

- **`gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoFrame)` works
  directly** — no SIGTRAP, no scratch-canvas detour needed (unlike `<video>`→`texImage2D`,
  which does crash and is why `fbo.ts`'s `uploadVideoFrame` has the scratch-canvas
  workaround at all). `DeckFBO.uploadVideoFrameFromCodec()` still keeps a scratch-canvas
  `drawImage(VideoFrame)` fallback behind a one-time try/catch (cached in a module-level
  static, not per-instance — this is a GPU/driver capability, not a per-deck one), but on
  this GPU the direct path is what actually fires, confirmed by the compositor output
  screenshot rendering correctly with no fallback exception logged.
- **Do NOT apply `UNPACK_FLIP_Y_WEBGL`** for `VideoFrame` uploads — `uploadVideoFrame`'s
  flip (needed because canvas Y=0 is top but WebGL texture Y=0 is bottom) does **not**
  apply here. A `VideoFrame`'s pixel data from `VideoDecoder` output is already in the
  orientation WebGL expects. Confirmed by screenshot: applying the flip renders upside
  down; omitting it (what `uploadVideoFrameFromCodec` does) renders correctly.

Both findings verified via `canvas.toDataURL()` screenshot comparison against the legacy
`<video>` path rendering the same source file, not just by absence-of-error — a black or
garbled frame is a failure even if no exception was thrown (see `verify-ui`'s new gotcha
on why `toDataURL()` was used instead of WebDriver's `/screenshot` endpoint).

## Clipping / muddy output — gain chain and master volume

**Symptom**: output sounds clipped or distorted even when per-deck volume and gain sliders are
turned down. Master volume slider appears to have no effect.

**Root cause confirmed 2026-06-28**: `MasterMix.set_master_volume()` (`mixer.rs`) was a stub —
it stored the value but never applied it to GStreamer. The actual master volume is implemented
in `AudioManager` directly (see below).

> ⚠️ **Updated 2026-08-11: `MasterMix` is gone.** `mixer.rs` now holds `OutputGraph`, the real
> one-`pulsesink`-per-node topology, and on the shared-output path master volume is applied by
> a `volume` element per node after the mixer — the stage it always belonged in.
>
> 🔴 **Corrected 2026-08-13.** The sentence that used to follow said the per-deck factor was
> applied as well and that "the deck-side one is 1.0 unless moved". That was **wrong in the
> code and wrong here**: `apply_volume()` multiplied by `master_volume` unconditionally, so on
> the shared path the factor was **squared** — an extra −9 dB at the usual ~0.35, on every
> output, from the default flip until it was fixed. The deck side is now gated by
> `DeckAudioPipeline::deck_master_factor()`, which returns 1.0 whenever the shared graph is in
> use. See "Master volume applied twice" below.

**Gain chain per deck** (as of 2026-08-13):

```
deck volume element = gain × vol × deck_master_factor()
    deck_master_factor() = 1.0                       on the shared-output path (default)
                         = master_volume             on the legacy path, or with no graph

node volume element = master_volume                  once per output node, after the mixer
```

- `gain` — pre-fader trim (0–4, default 1.0); UI slider in DeckCard
- `vol` — post-fader level (0–1, default 1.0); driven by crossfader or UI slider
- `master_volume` — global factor (0–1, default 1.0); set via `audio_set_master_volume` IPC

`master_volume` is stored in `AudioManager.master_volume` and propagated to all active deck
pipelines via `set_master_volume_factor()`. New pipelines inherit it at `audio_load` time.

**Summing**: on the legacy path each branch has its own `pulsesink` and PipeWire sums the
streams at hardware level; on the shared-output path an `audiomixer` sums them per node before
the single sink. Either way the arithmetic below is the same. With N decks at gain=1, vol=1, master=1 you can get up to N× summed
amplitude. Reduce master volume if two fully-loaded decks clip: pulling to ~0.6 gives ~4 dB of
headroom for two simultaneous sources.

### "Audio works on one device but not the other" — suspect gain staging before routing (2026-08-13)

**Symptom**: a deck plays fine on one main output and is silent on another (the Starlight,
main *and* headphones), with every in-pipeline instrument green — `[level] main vol0`,
`[deliver-tel]` at full rate, `lag=0 drop=0`, the right `[audio/remap] idx=[0,1]`/`[2,3]`
lines, both nodes attached, no bus error.

**It presented as a routing regression and was two independent attenuations stacking.** The
device difference was never in the app:

| | contribution | where |
|---|---|---|
| master volume applied twice | −9 dB, **both** devices | `apply_volume()` × node master stage |
| wireplumber's untouched default volume | −23.75 dB, Starlight only | `default-volume = 0.064` (= 0.4³) |

−9 dB alone is quiet-but-working, which is why the CODEC still played; the Starlight had both
and landed 33 dB down, i.e. inaudible. **The device-to-device difference is what makes this
look like routing, and it is exactly the part the app does not control.**

**The order that actually resolves it:**

1. **Compare the two devices at the PipeWire layer before reading any app code.** One command
   settles whether the app is even involved:
   ```bash
   pw-dump | python3 -c "import json,sys;[print(o['id'], o['info']['props'].get('node.name'), [p.get('channelVolumes') for p in o['info']['params'].get('Props',[]) if 'channelVolumes' in p]) for o in json.load(sys.stdin) if o.get('type')=='PipeWire:Interface:Node' and o.get('info',{}).get('props',{}).get('media.class')=='Audio/Sink']"
   ```
   A sink at `[0.064 × N]` with `softVolumes` at 1.0 is **wireplumber's untouched default,
   realised in hardware** — the card has no entry in `~/.local/state/wireplumber/default-routes`
   and comes up at 40% (cubic) on every plug. Cross-check with
   `amixer -c <card> sget PCM`; −23.75 dB is that value exactly.
2. **Capture both device monitors and compare the digital signal.** If the failing device's
   stream is *bit-identical* to the working one (`max abs diff = 0.0`), the app's routing is
   correct and everything downstream of the monitor tap is suspect — hardware volume, the
   controller's own mixer, cabling. That comparison is the fastest way to end the routing
   theory, and it needs the 4-channel capture above, not `pw-record`.
3. **Only then read the gain chain** — and read it *end to end*, because the app cannot.

⚠️ **`wpctl set-volume <id> 1.0` returned exit 0 and did nothing** on this card (still read
`Volume: 0.40` after). `amixer -c Starlight sset PCM 400` took immediately, and wireplumber
then wrote the route so it persists. Verify the readback; do not trust the exit code.

### Master volume applied twice — why no probe could see it

Every deck-side instrument sits **upstream of the node's master stage**, so all of them read
correct while the output was 9 dB down. There is no in-process instrument that can see the
product of the two stages — which is why the regression test asserts the *factor*
(`deck_master_factor() == 1.0`) rather than a level.

Generalise this before adding the next gain stage:

> A gain applied in two places is invisible to any probe that sits between them, and uniform
> attenuation has no A/B arm inside the app — nothing stands out by comparison. The only
> instrument that can see it is a capture of the device output compared against the level the
> app *believes* it is sending.

The tell, if you have both numbers: `[level/deck-N] main vol0 (reference)` against the device
monitor's RMS. They differed by 10.1 dB where they should have matched to within the level
element's windowing; 20·log₁₀(0.346) = −9.2 dB named the culprit immediately.

**What is still a stub**:
- `set_eq()` in `pipeline.rs` — EQ sliders show in the UI but do nothing to GStreamer
- `record.rs` — `audio_record_start/stop` returns `Ok` and writes nothing. The shared output
  graph is the natural place to tap for this (one node, one mix, post-master) and did not
  exist when the stub was written.
- ~~`MasterMix`~~ — built 2026-08-11 as `OutputGraph`; see the topology section above.
