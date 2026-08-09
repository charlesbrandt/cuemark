# 10.8 seconds of silence mid-track, with the pipeline in PLAYING

Status: **open, not root-caused. One confirmed occurrence. A reproducer was attempted on
2026-08-05 on the real hardware and the fault did not reproduce** — see "2026-08-05 reproducer
attempt" below for what was run and what that does and does not rule out. Found 2026-08-05
while reading back a live set (the "Cassius 1999" session). Distinct from — and *not* explained
by — `legacy-video-fallback-cost.md`: this happened on the fast path, with the frame rate
healthy.

D2 (the 6:1 false-positive rate in the sink-gap warning) is **shipped and verified**. As of
2026-08-08 the **cue branch is instrumented** (it previously carried no probes at all) and the
delivery counters are read during ordinary playback as `[deliver-tel]` — so a wild occurrence
is now readable rather than ambiguous. See "Where to pick up".

**One-line version**: at `01:38:31` the deck-0 `output_queue` ran dry and **no buffer reached
the output sink for 10.8 seconds**, with no state transition, no bus error, no seek and no
scratch gesture — while the control window was running at ~50 fps. Headphone cue had been
switched on 21 s earlier, and the main and cue sinks are two `pulsesink`s on the *same* USB
device.

**If you are picking this up fresh, read "Where to pick up" at the bottom first.**

---

## Provenance

Same session and build as `legacy-video-fallback-cost.md`:

- Log: `~/.local/share/com.cuemark.app/logs/cuemark.log`, `2026-08-05 01:37`–`01:59`.
- Build: `cuemark 5909dcb (dirty) profile=debug built=2026-08-04 22:43:29Z`.
- Deck-0 source: Jonas Rathsman — Tobago, H.264 1280×720@25, **webcodecs path** (no legacy
  `<video>` element involved).
- Audio device, for both the main and the cue branch:
  `alsa_output.usb-Guillemot_Corporation_DJControl_Starlight-00.analog-surround-40`,
  `buffer-time=200000us latency-time=20000us`; cue remap `target=RL,RR full=FL,FR,RL,RR
  n_ch=4 mask=0x33 idx=[2, 3]`.

## The event

```
01:37:48.345 [audio/deck-0] main sink 0: first buffer reached the sink — audio is being delivered
01:37:49.904 [bus/deck-0]   pipeline: Paused → Playing (pending VoidPending)
01:38:10.108 [audio/deck-0] cue ON
01:38:31.139 [audio/deck-0] output_queue underrun (total=1) — … Points UPSTREAM …
01:38:42.155 [audio/deck-0] main sink 0: buffer flow resumed after a 10.8s gap
01:38:54.538 [audio/deck-0] output_queue underrun (total=198) — …
01:39:43.436 [audio/deck-0] cue OFF
```

The gap therefore began at `01:38:31.3` — **within 200 ms of the first `underrun`** — and ran
to `01:38:42.2`. Between those two timestamps the pipeline posted nothing at all.

Context from the same 5 s windows, which is what makes this interesting:

```
01:38:43 [raf] 49.7fps | gap p50=16 p90=32 max=63 | frame-dur p50=1 | busy 3%
01:38:43 [poll-stats] deck-0 n=248 | total p50=2 p90=15 max=30 | toRust p50=1 | inRust p50=0
01:38:43 [aux-loop] waveform/deck-0@2448x144 n=249 drew=36 | busy 0%
01:38:43 [aux-loop] preview/deck-0     n=249 drew=86 | dur p50=0.0 p90=6.0 | busy 10%
```

**The control window was healthy.** 49.7 fps, `busy` 13 % across both aux loops, `inRust=0`.
Whatever starved the audio, it was not the frame-budget problem in the sibling doc — that one
does not begin until `01:39:30`.

## What is confirmed

- The stall is **upstream of `output_queue`**. `instrument_queue_flow()`'s doc comment
  (`pipeline.rs:44`) is explicit that `underrun` while Playing means
  `uridecodebin`/`audioconvert`/`pitch` could not produce a second of audio per second of wall
  clock. A sink-side stall would leave the queue *full*, not empty.
- The sink genuinely received **nothing**. `instrument_sink_flow()` (`pipeline.rs:145`) is a
  `BUFFER` pad probe on the sink's own sink pad — the last measurable point before the device.
- The pipeline stayed in `Playing`. No `Paused` transition is logged anywhere between
  `01:37:49.904` and `01:42:34.986`.
- It got worse before it got better: `total=198` underruns by `01:38:54`, twelve seconds after
  flow resumed.

## What is ruled out

| Candidate | Evidence against |
|---|---|
| Scratch / PCM feeder branch | **No `[scratch/deck-0] feeder start` line exists anywhere in the session.** The `input_selector` was on the file branch throughout. |
| A seek | No seek logged; no MIDI jog events in the window. |
| EOS | `[bus/deck-0] EOS` never fires for this deck; the track is 288.5 s and the stall is at ~100 s. |
| A bus error | No `ERROR` from `cuemark_lib::audio` in the whole session. |
| Master volume at 0 | The user was riding the master fader (`MasterVolume 0.0` at `01:38:31.051`, back to `0.99` by `01:38:56`) — but `volume=0` still passes buffers, and the probe counts buffers, not amplitude. Timing is suggestive, mechanism is not. **Do not dismiss it on that basis alone; see H3.** |
| The legacy `<video>` frame-budget bug | Not on this deck (webcodecs), not at this time (starts `01:39:30`), and rAF was 49.7 fps. |
| A wedged GStreamer pipeline | CLAUDE.md's wedged signature is `poll-stats total p50 ≈2ms` **plus** `[aux-loop] … drew=0` **plus** a play-IPC retry storm. Only the first is present, and `waveform/deck-0 drew=36–38` per window says the playhead kept advancing. `p50=2ms` here is just an unloaded main thread — that leg is a load gauge (`control-window-frame-budget.md`). |

## The leading hypothesis

**H1 — the headphone cue branch on the same physical USB device.** Cue was switched on at
`01:38:10`, 21 s before the stall, and off at `01:39:43`. Enabling it opens a second
`pulsesink` on the *same* PulseAudio device as the main sink (main → FL/FR, cue → RL/RR of the
controller's 4-channel surround profile). With both decks loaded that is up to four
`pulsesink`s on one USB device.

This is not a new suspicion — it is the *same symptom class* that
`sink_buffer_times()`'s doc comment (`pipeline.rs:174–213`) describes being fixed on
2026-08-02:

> Audio was choppy and, **with headphone cue enabled, the master output was silent outright.**

That fix (50 ms/10 ms → 200 ms/20 ms `buffer-time`/`latency-time`) was verified over ~106 s of
playback with zero underruns and zero sink-flow gaps. This session is the first multi-hour set
since. **Either the fix is incomplete at longer timescales, or a second mechanism shares the
symptom.** Note the direction of the evidence differs: 2026-08-02's decisive observation was
that one branch of a `tee` jittered while its sibling was clean, which *rules out* upstream
causes — whereas here `underrun` fires, which points upstream. Those two facts are in tension
and reconciling them is most of the work.

**H2 — the deck's own `queue` (2 buffers) after `uridecodebin`.** A 2-buffer queue between
`uridecodebin` and `audioconvert` has essentially no headroom. If the source thread lost the
CPU for a moment the graph could collapse and take a long time to refill through `pitch`
(soundtouch). Does not obviously explain 10.8 s of *zero* output, but it is cheap to check.

**H3 — a `volume` property write racing the streaming thread.** MIDI drove `MasterVolume`
~2×/s across the stall, and `audio_set_master_volume` iterates every pipeline and calls
`set_master_volume_factor()` → `apply_volume()` on each. This is a synchronous
`#[tauri::command]` on the GTK main thread taking `Mutex<AudioManager>`, while GStreamer
streaming threads hold their own locks. This project has lost multiple sessions to
lock-ordering deadlocks in the audio path (`pipewiresink-play-hang.md`), so a 10.8 s pause is
worth taking seriously as a lock-contention window rather than a starvation one — even though
`inRust=0` on the *position* command in the same window argues against broad mutex contention.

**H4 — the USB device itself.** PipeWire/ALSA xruns on the Guillemot controller, invisible to
GStreamer. `journalctl` and `pw-top` would show it; neither was captured.

---

## Secondary finding: the sink-gap warning has a ~6:1 false-positive rate

Seven `buffer flow resumed after a Ns gap` warnings fired in the session. **Six of them are
artifacts**, logged in the same millisecond as a `Paused → Playing` transition — they are
measuring how long the deck sat prerolled before someone pressed play:

```
01:37:49.904  gap 1.6s   ← same ms as  [bus/deck-0] pipeline: Paused → Playing
01:39:34.964  gap 1.8s   ← same ms as  [bus/deck-1] pipeline: Paused → Paused
01:39:39.203  gap 4.2s   ← same ms as  [bus/deck-1] pipeline: Paused → Playing
01:41:53.190  gap 1.1s   ← same ms as  [bus/deck-0] pipeline: Paused → Playing
01:42:48.112  gap 1.2s   ← same ms as  [bus/deck-1] pipeline: Paused → Playing
01:45:25.935  gap 7.3s   ← same ms as  [bus/deck-0] pipeline: Paused → Playing
01:38:42.155  gap 10.8s  ← NO transition. This is the only real one.
```

*(Fixed 2026-08-05 — see D2 below. The rest of this section is kept as the record of why.)*

`instrument_sink_flow()` does not gate on the `playing` atomic, while its sibling
`instrument_queue_flow()` deliberately does and documents exactly why (`pipeline.rs:70–80`:
relaxed `AtomicBool` rather than a `current_state()` query, so a diagnostic on a streaming
thread cannot introduce a lock acquisition). The same `Arc<AtomicBool>` is already threaded
into `load()` and is available at the `instrument_sink_flow()` call site.

This matters beyond tidiness: **the noise is what made the one real dropout hard to find**, and
a future session grepping for "gap" will get six wrong answers first.

---

## The plan

Two work items. **D2 is a prerequisite for diagnosing D1 cleanly** and is a few lines.

### D2 — Gate `instrument_sink_flow` on `playing` — ✅ **SHIPPED 2026-08-05**

Pass the existing `&Arc<AtomicBool>` into `instrument_sink_flow()` and skip the gap check (not
the first-buffer line) when it is false, mirroring `instrument_queue_flow()`. Keep the relaxed
atomic load — **do not** substitute a `current_state()` query on the probe's streaming thread.

Consider also logging the gap's *start* time, not just its resumption: right now the onset has
to be back-computed from the duration, which is how the correlation with the `underrun` at
`01:38:31.139` was nearly missed.

Verify: preroll a deck, wait 5 s, press play — no warning should be emitted.

**What shipped** (`src-tauri/src/audio/pipeline.rs`):

- `instrument_sink_flow()` takes `&Arc<AtomicBool>` and reads it with a relaxed load on the
  sink's streaming thread. No `current_state()` query was added.
- The `first buffer reached the sink` line stays **ungated** — it is the whole answer to Bug B
  and it is asked of a deck that has only just prerolled.
- **A level gate alone is not enough, and this is the part worth remembering.** "Was the deck
  playing when this buffer arrived" still misreports a pause/resume: the last buffer before the
  pause is recorded while the pipeline is still `Playing`, and the bus message announcing the
  pause routinely loses the race to the first buffer after the resume — so the stale timestamp
  survives and a 6 s pause is reported as a 6 s dropout. The fix is that the probe's `last`
  timestamp is *invalidated* whenever the deck is not playing, from **both** sides: by the probe
  itself when a buffer arrives with the flag false, and by the bus thread's `StateChanged`
  handler on any transition out of `Playing` (which is why the function now returns its state
  handle). A gap is therefore only ever measured between two buffers both delivered inside one
  continuous `Playing` span. Confirmed empirically — the naive version emits the pause/resume
  false positive on this machine every run.
- The warning now carries the gap's onset, formatted as UTC time-of-day to match `lib.rs`'s log
  formatter, so it can be grepped directly against surrounding lines:
  ```
  [audio/deck-0] main sink 0: buffer flow resumed after a 2.5s gap (began 04:13:22.723) —
    the device received no audio for that span, and the pipeline was Playing throughout.
  ```

**Verification** — `cue_dropout_soak`'s sibling test, `sink_flow_gap_gating`
(`pipeline.rs`, `#[ignore]`d, needs a real device):

```
cargo test sink_flow_gap_gating -- --ignored --nocapture
```

It runs both arms in one process against a real `pulsesink`, and a capturing `log::Log` backend
asserts on the warnings rather than leaving them to be eyeballed:

| Arm | What it does | Before D2 | After D2 |
|---|---|---|---|
| 1 (negative) | preroll → hold 6 s → play 4 s → pause → hold 6 s → play 4 s | **2 gap warnings** (6.0 s, 6.1 s) | **0** |
| 2 (positive control) | a second pad probe sleeps 2.5 s on the sink's streaming thread while `Playing` | 1 | **1**, with onset |

The "before" column is not a number from the live log — it was **re-measured in this session**
by neutralising the gate in place (`let is_playing = true;` plus disabling the bus-thread
invalidation) and re-running the same test, which fails with exactly the two false-positive
classes the live set produced: one preroll→play, one pause→play. Restoring the gate takes both
to zero while arm 2 still fires. Both classes matter: the live log's six artifacts include
`Paused → Paused` and `Paused → Playing` cases.

Arm 2 exists because the cheapest way to pass arm 1 is to break the diagnostic entirely, and a
suppressed real dropout is strictly worse than the noise it replaced.

Also verified in the real shipping app (see D1's log below) — the app-level run is what proves
the gate is live in the binary rather than only in a test harness.

### D1 — Root-cause the real dropout — ⚠️ **STILL OPEN. Reproducer attempted 2026-08-05 and it did NOT reproduce.**

See "2026-08-05 reproducer attempt" below for exactly what was run, on what, for how long, and
what did not happen. The plan that produced it, unchanged:

There is no reproducer. Build one before theorising further:

1. **Soak with cue on.** `scripts/watchdog-soak-test.sh` already does looped playback for 10
   minutes; the missing variable is the headphone cue. Run a two-deck soak with cue toggled on
   and off periodically on the real USB controller (not Xvfb — this is a device-timing
   question) and count `underrun` and post-D2 sink gaps.
2. **Carry a control arm**: the same soak with the cue branch never enabled, and if possible
   the same soak with the cue sink pointed at a *different* device (the onboard PCI codec).
   The 2026-08-02 investigation's decisive move was exactly this — a two-sink deck where one
   branch was clean and the other jittered rules out every upstream cause by construction.
   Reuse it.
3. Capture `pw-top` and `journalctl -k` alongside, so H4 can be settled rather than assumed.
4. If it reproduces, `GST_DEBUG=queue:5,pulsesink:5` on the affected deck for the stall window.

Exit criterion: the stall reproduced on demand, with one named element or device shown to be
the one that stopped.

---

## 2026-08-05 reproducer attempt — the fault did NOT reproduce

**Result: negative.** Roughly 40 minutes of continuous playback on the real Guillemot
DJControl Starlight, across four arms including the live cue configuration, produced **zero**
sink-flow gaps of any length. Nothing here contradicts the live observation — it only means the
trigger is not any of the variables these arms hold.

### The harness

Two pieces, both in-tree:

- `DeckAudioPipeline::cue_dropout_soak` (`src-tauri/src/audio/pipeline.rs`, `#[ignore]`d) — real
  `DeckAudioPipeline` instances on the real device, no webview involved. Env-configured:
  `CUEMARK_SOAK_ARM`, `CUEMARK_SOAK_SECS`, `CUEMARK_SOAK_DECKS`, `CUEMARK_MAIN_DEVICE`,
  `CUEMARK_CUE_DEVICE`, `CUEMARK_OTHER_DEVICE`. Every arm carries the same
  MIDI-rate master-volume churn (2 writes/s through `set_master_volume_factor()`, including
  `0.0`), so H3's conditions are a constant rather than a variable, and loops each deck back to
  the top at 300 s so the arm measures playback rather than silence.
- A real-app driver over `tauri-driver` + Xvfb (adapted from `scripts/latency-test.sh`), which
  drives `__cuemarkDebug.updateDeck()` to load, play/pause and toggle `cueEnabled`. It picks up
  the app's **persisted** device settings — which are still the live set's:
  `mainOutputDeviceIds = ["…analog-surround-40@FL,FR!FL,FR,RL,RR"]`,
  `cueOutputDeviceId = "…analog-surround-40@RL,RR!FL,FR,RL,RR"`.

Media: a synthetic 6-minute 48 kHz stereo pink-noise WAV, and a 5-minute H.264 1280×720@25 +
AAC MP4 generated with `gst-launch-1.0` (regeneration command is in `SOAK_A`'s doc comment).
**The user's music library lives on `/media/memory/t7`, which was not mounted**, so the live
track itself could not be used. Every hypothesis in this doc is about sink and device
scheduling, not about decoded content, so synthetic media is adequate — but it is a real
difference from the live run and is the first thing to change if a later attempt also comes up
empty.

`pw-top -b` and `journalctl -k` ran alongside every arm, so H4 is measured rather than assumed.

### What ran

| Arm | Topology | Duration | Cue toggles | Sink-flow gaps | `output_queue` underruns (per deck) |
|---|---|---|---|---|---|
| `cue-same` | 2 decks, main **and** cue both on the Starlight — 4 `pulsesink`s on one USB node | 600 s | 20 on/off cycles | **0** | 1500 |
| `cue-off` | same 4 sinks built, cue valve never opened | 600 s | none | **0** | 1501 |
| `cue-other` | 2 decks, main on the Starlight, cue on the onboard PCI codec | 600 s | 20 on/off cycles | **0** | see below |
| (first attempt) | `cue-same`, 2 decks | 360 s of real playback | 12 | **0** | — |

The first attempt is listed because it is a real 6 minutes of the live configuration, but it is
otherwise superseded: the 6-minute file hit EOS mid-arm, the bus thread paused the pipeline as
it is supposed to, and the remaining 9 minutes measured silence with every counter frozen at a
healthy-looking value. **A soak that stops playing looks exactly like a soak that is going
well.** The looping guard exists because of that.

`pw-top` confirmed the intended graph each time rather than assuming it: in `cue-same`, four
`cuemark` streams on the Starlight node — two `F32LE 2 48000` (main) and two `F32LE 4 48000`
(the channel-remapped cue) — against a device running `S24LE 4 44100` at a 2048-frame quantum.
That is the live topology reproduced, not merely requested.

### What did not happen

- **No sink-flow gap of any duration, in any arm.** The metric is the post-D2 one, so a warning
  now means what it says.
- **No PipeWire xruns.** `pw-top`'s `ERR` column stayed `0` for every node and every stream in
  every arm, including the USB device.
- **No kernel USB or ALSA messages.** `journalctl -k` for the runs contains nothing but a
  Broadcom wifi driver (`wl_cfg80211_get_tx_power`) logging an error once a second, which
  predates and outlives the soak. **H4 has no supporting evidence and no refuting evidence** —
  the device was never observed misbehaving, but it was also never observed under the live
  trigger.
- **No bus `ERROR`, no unexpected state transition, no wedged pipeline.** Positions advanced at
  1× throughout.

### What it did establish

- **The cue branch is not, by itself, sufficient.** `cue-same` and `cue-off` are
  indistinguishable — 0 gaps each, and 1500 vs 1501 underruns over 600 s. Opening the valve on a
  second `pulsesink` sharing the USB node, twenty times, changed nothing measurable. H1 is
  therefore *not* "the cue branch, on its own, starves the main sink"; if H1 survives, it needs a
  co-factor these arms did not carry.
- **The `output_queue` underrun background is upstream and device-independent**, exactly as
  `instrument_queue_flow()`'s doc comment claims. It ran at a steady ~2.5/s per deck in *every*
  arm regardless of cue routing. It is a property of this harness (a synthetic WAV pushed in
  ~21 ms buffers through a 2-buffer upstream `queue`), not of the sinks — which is a small piece
  of live support for **H2**, since the same 2-buffer `queue` is what caps how fast
  `output_queue` can refill. ⚠️ **Consequence for whoever runs the next soak: underrun counts
  from this harness are only comparable between its own arms, never against the live log.** The
  live session ran at `total=1` at the moment of the stall.

### What was NOT tested, and why it matters

These are the honest gaps, roughly in order of how likely each is to matter:

1. **The real track.** Synthetic pink noise, not the live H.264/AAC file — the media library
   volume was unmounted. Different demux chunking, different decoder, different `pitch` load.
2. **A multi-hour set.** The live stall was ~50 s into the *session*, so elapsed time is not an
   obvious factor, but nothing here ran longer than 10 minutes at a stretch.
3. **A real MIDI controller sending events.** The master-volume churn was synthesised in-process
   at 2 Hz. The live path is `midir` → Tauri `emit()` → frontend → IPC back into
   `Mutex<AudioManager>`, which is the part H3 is actually about — the lock traffic, not the
   property write. **H3 is not ruled out by these arms.**
4. **A `cue-other` arm with the cue on a device that is not also the pipeline clock master.**
   Worth noting the arm exists but is not the sharpest form of the 2026-08-02 move, which put
   *two main sinks* on one `tee` and compared siblings directly.
5. **`GST_DEBUG=queue:5,pulsesink:5`** — pointless without a reproducer, still the right next
   step the moment there is one.

### Where D1 goes next

Do **not** attempt a fix. In priority order:

1. Re-run `cue-dropout_soak`'s arms with the user's real library mounted and the actual live
   track, ideally for 30+ minutes. That is the cheapest remaining variable.
2. Add an arm driven by the real controller's MIDI, so H3's lock path is exercised rather than
   simulated.
3. If it still will not reproduce, accept that this may need to be caught in the wild instead:
   the D2 warning now carries an onset timestamp, and `scripts/gdb-stall-catcher.py` is the
   existing tool for attaching to a live stall. Leaving it instrumented and waiting is a
   legitimate plan for a one-occurrence fault.

### Not in scope for this doc

The later underruns in the same session (`01:42:27` deck-1 `total=1` → 2.0 s gap; `01:43:40`
`total=31`; `01:43:48` `total=41`) occurred while the control window was at 5.6–13 fps because
of the legacy-`<video>` bug. Those are **downstream of `legacy-video-fallback-cost.md`** and
should be re-measured only after that fix lands — treating them as evidence here would confound
the two.

---

## Where to pick up

🟢 **2026-08-08 (night): the cue branch is instrumented at last, and a short clean run on the
live topology is on record. D1 is still open and still waiting to be caught in the wild — but
a wild occurrence is now readable instead of ambiguous.**

### The instrumentation that was missing

Until now the cue sink carried **no probes of any kind** — not `instrument_sink_flow()`, not
`instrument_delivery()`. Both were attached inside `load()`'s `for dev in main_devs` loop and
nothing outside it. So the one branch H1 blames was the one branch that could not be measured,
and a live occurrence would have produced exactly the 2026-08-05 log again. Now shipped:

- **`instrument_sink_flow()` on the cue sink**, so "did anything ever reach the headphones"
  and "did the cue sink stall while Playing" are answerable per-branch. Its gate is now a
  **conjunction** (`gates: Vec<Arc<AtomicBool>>`): main sinks pass `at_playing`, the cue sink
  passes `at_playing` **and** a new `cue_open`.
- **`instrument_delivery()` on `cue_volume`'s src and the cue sink's pad**, bracketing the cue
  branch's last stage the same way the main branch is bracketed.
- Both skipped when cue falls back to `fakesink`. That pad still sees buffers, but `sync=false`
  makes its margin meaningless — a reading that looks like evidence and is not.

⚠️ **D2's trap recurs here in a nastier form, and the fix is again two-sided.** `cue_valve`
drops every buffer while cue is off, so a cue-off span forges a dropout perfectly. The gate
alone does not fix it: the last buffer before the valve closes is recorded with both flags
true, and — unlike the pause case — **no later buffer ever arrives to clear the stale
timestamp**, because the valve drops them upstream of the probed pad. So `set_cue_enabled()`
invalidates `last` itself, clearing `cue_open` *first* so a buffer already in flight cannot
re-stamp it. Guarded by `cue_sink_flow_gap_gating` (`#[ignore]`d, needs a real cue device),
which mirrors its D2 sibling's two-arm shape — arm 1 asserts toggling is silent, arm 2 stalls
the cue sink pad for 2.5s and asserts the warning still fires, because the cheapest way to
pass arm 1 is to break the probe.

Both arms verified on the real Starlight, 2026-08-08:
```text
CUEMARK_CUE_DEVICE='alsa_output.usb-Guillemot_Corporation_DJControl_Starlight-00.analog-surround-40@RL,RR!FL,FR,RL,RR' \
  cargo test cue_sink_flow_gap_gating -- --ignored --nocapture
```
```
[audio/…] cue sink: first buffer reached the sink — audio is being delivered to the device
[arm-1] OK — a 6s cue-off span and a 4s pause produced zero cue gap warnings
[WARN] [audio/…] cue sink: buffer flow resumed after a 2.5s gap (began 01:07:15.302) — …
```
Note the test media is not committed (~70MB of synthetic pink noise); regenerate it with the
`gst-launch-1.0` command in `SOAK_A`'s doc comment.

### `[deliver-tel]` — the counters are finally read during ordinary playback

`DeliveryProbe`'s counters existed since 2026-08-08 but were read **only by the scratch
feeder's telemetry loop**, which lives for the duration of a gesture. During ordinary playback
— the entire scenario this doc is about — nothing read them at all. `spawn_delivery_reporter()`
now logs them while the deck is playing:

Real output, from `cue_sink_flow_gap_gating` on the Starlight (cue open, healthy):

```
[deliver-tel/cue-gate-test] vol0=15/s(min 15) margin +142ms(min +142ms) | sink0=15/s(min 15) margin +142ms(min +142ms)
                          | cuevol=9/s(min 0) margin +89ms(min +82ms)  | cuesink=9/s(min 0) margin +89ms(min +82ms)
```

**Sampled every 1s, emitted every 5s.** The 5s cadence matches the rest of the standing
instrumentation; the 1s sampling is what preserves resolution, because the fault is a
second-scale stall that a 5s mean averages into nothing. **`min` is the field to read** — a
healthy branch reports a min within a buffer or two of its mean, and `min 0/s` means a full
second delivered nothing, which is D1's signature and is invisible in the mean. `margin`'s
minimum is the H5 field: steadily negative means buffers arrive already late and the sink has
no slack, whether or not any gap grows long enough to trip `instrument_sink_flow()`.

This directly answers the question the 2026-08-05 evidence could not settle — *did the sink
keep receiving buffers during the 10.8s gap?* — and it answers it per-branch.

**Three things to know before reading a `min 0/s`, all observed while building this:**

1. ⚠️ **A cue row reads `0/s` whenever the valve is closed, by construction** — that is
   `cue_valve` doing its job, not a fault. Both `cuevol=9/s(min 0)` values in the sample above
   are windows the test toggled cue off inside. Same class as the scratch doc's standing
   caution that `arrived%` and `snaps` are silence *by design*: check `cue ON`/`cue OFF` in the
   surrounding lines before treating a cue zero as evidence.
2. ⚠️ **The two branches' rates are not comparable to each other** — 15/s main against 9/s cue
   above, because the cue branch is a 4-channel remap with different buffer sizing. Compare a
   branch against *itself* over time, never against its sibling.
3. **The first two ticks after a resume are baselined, not measured** (`RESUME_SKIP_TICKS`).
   One skip was not enough: the first tick's delta straddles the pause and the *second* second
   is where `pulsesink` reopening the device lands, which produced a legitimate-but-uninteresting
   `min 0/s` on every play press in the first run of the test. That is D2's cry-wolf problem
   arriving in the one field this doc tells people to read, so it is gated at the source.

### A clean 80s on the live H1 topology — and why that settles nothing

The user reported no longer being able to hear the clipping and asked for a log review. The
run (`2026-08-09 00:04–00:06` UTC, build `dfdb0e0`) was on the real H1 configuration:
`main sink 0` and the cue sink both `pulsesink` on
`…DJControl_Starlight-00.analog-surround-40`, cue remapped to `RL,RR`. Play at `00:04:50`,
cue ON at `00:04:57`, paused at `00:06:10` — **80s of playback, ~72s with cue open.** In that
window:

- **zero** `output_queue underrun`
- **zero** sink-flow gaps
- **zero** bus `ERROR`, no unexpected state transition, no play-IPC retry storm
- rAF flat at 58–60fps, `inRust` p50 0ms

⚠️ **Do not read this as a fix.** Three reasons, in order:

1. **80 seconds proves nothing at this fault's rate.** The 2026-08-05 attempt ran ~40 minutes
   across four arms on this same controller and also found zero gaps. A clean short run *is*
   the established baseline, not new information.
2. **One deck, two sinks.** The live set's H1 topology is up to **four** `pulsesink`s (2 decks
   × main+cue) on one USB node. This run carried half that.
3. 🔴 **Nothing currently logged can see clipping at all.** `instrument_sink_flow()` fires only
   on a >1s gap; `output_queue underrun` fires on starvation. Brief glitching or distortion —
   the symptom actually being reported — is below the resolution of every instrument in this
   pipeline. **"The log is clean" and "the clipping is gone" are very nearly independent
   statements**, and conflating them is the fastest way to close this wrongly. `[deliver-tel]`'s
   `margin(min …)` is the first field that gets anywhere near it, and even that measures
   *slack*, not audible artifacts.

Nothing in the scratch work that landed earlier the same day plausibly changed steady-state
playback with cue open: the sink alignment-tolerance widening is scoped to the duration of a
gesture, and `HandTracker` only affects the servo. **There is no known mechanism by which this
would have been fixed** — so treat the absence as unexplained, not as progress.

### The prior state of this section

🔴 **2026-08-08 (evening): the hoped-for shared reproducer did NOT pan out. D1 is still
blocked on catching this in the wild.**

Earlier the same day it looked like `docs/design/scratch-audio-downstream-delivery.md`
might have handed D1 an on-demand reproducer: scratch audio dying within a second or two,
every gesture, on a deck configured exactly as H1 describes (three `pulsesink`s, two on one
USB device). That doc then **ran its device-routing A/B to completion**, and the result
removes the connection:

- Arm **A4** — a single `pulsesink`, on the onboard PCM2902C, cue on a `fakesink`, the USB
  controller carrying no audio at all — **still dies**. H1's configuration is absent and
  the fault is unchanged.
- New pad probes there count **67 buffers/s reaching the sink's own sink pad, unbroken,
  through the silence**. That fault is not a delivery stall at all; it is inside the sink's
  render stage or below it.

So the scratch fault is **not** the device-contention mechanism D1 is about, and its
reproducer does not transfer. Everything in "Where D1 goes next" below stands unchanged.

🟢 **What *does* transfer is the instrument.** `DeliveryProbe` (`pipeline.rs`) is not
scratch-specific — it counts buffers and measures clock margin at `volume`'s src pad and
each `pulsesink`'s sink pad. Wired into a non-scratch log line it would answer D1's central
question directly ("did the sink keep receiving buffers during the 10.8 s gap?"), which is
the one thing the 2026-08-05 evidence could not settle. **That is the cheapest useful thing
to do here before the next long set**, and it makes a wild occurrence readable instead of
ambiguous.

0. ~~Instrument the cue branch and read the delivery counters during ordinary playback.~~
   Done 2026-08-08 (see the top of this section). **This was the "cheapest useful thing to do
   before the next long set" and it is now done** — the next wild occurrence should be
   readable. What to grep for, in order: `cue sink: buffer flow resumed`, then
   `[deliver-tel]` lines around the timestamp, reading `min` on the branch that went quiet.
1. ~~Ship **D2** first.~~ Done 2026-08-05. The gap warning is now trustworthy and carries an
   onset timestamp; `cargo test sink_flow_gap_gating -- --ignored` is its regression guard.
2. **Start from "2026-08-05 reproducer attempt" → "Where D1 goes next"**, not from a blank
   page. Four arms on the real controller are already spent; the untested variables are listed
   there, ordered. **Do not attempt a fix before a reproducer exists** — the 2026-08-02
   buffer-time change was made against a live-reproducible symptom and that is why it could be
   verified; this one still cannot be.
3. Do not re-investigate: the scratch/PCM feeder branch (never engaged), `query_position`
   (`inRust=0`), or the frame budget (healthy at 49.7 fps during the stall). Add to that list,
   as of 2026-08-05: **"just enable the cue branch and wait"** — 20 on/off cycles across
   10 minutes on the live device changed nothing at all, and `cue-off` was its exact twin.

### Files that will be touched

| File | Why |
|---|---|
| `src-tauri/src/audio/pipeline.rs` | `instrument_sink_flow()` (D2, shipped; gate is now a `Vec` conjunction so the cue sink can add `cue_open`), `instrument_queue_flow()` as its model, `instrument_delivery()`/`DeliveryProbe` and `spawn_delivery_reporter()` (`[deliver-tel]`), `set_cue_enabled()` for the cue probe's two-sided invalidation, `sink_buffer_times()` for the 2026-08-02 history, the 2-buffer `queue` sizing in `load()` for H2 — and the three `#[ignore]`d tests `sink_flow_gap_gating` (D2 guard), `cue_sink_flow_gap_gating` (cue-gate guard) and `cue_dropout_soak` (D1 harness) at the bottom |
| `src-tauri/src/audio/mod.rs` | `audio_set_master_volume` iteration, for H3 |
| `scripts/watchdog-soak-test.sh` | the closest existing soak harness to extend |

### Related docs

- `pipewiresink-play-hang.md` — why locks on streaming threads are treated as radioactive here.
- `output-noise-and-track-reload-silence.md` — Bug B is "the deck plays silently with an
  identical log", the reason `instrument_sink_flow()` exists at all.
- `scratch-feeder-underruns.md` — the *other* underrun class in this codebase; not this one.
- `legacy-video-fallback-cost.md` — the same session's other, larger finding.
- `control-window-frame-budget.md` — how to read `[poll-stats]`, and why `total p50=2ms` is
  ambiguous rather than diagnostic.
