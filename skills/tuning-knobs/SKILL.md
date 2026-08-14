---
name: tuning-knobs
description: The small set of numeric constants that actually change cuemark's live feel — video frame ring, scrub delivery, scratch servo, decode-ahead, network output delay — with each knob's live symptom, where it lives, how to change it without a rebuild, and which knobs are known traps that must not be turned. Load when a feature "works but feels wrong" live, when about to tune a constant, or when a shipped fix reads as not working.
---

# Tuning knobs

When a cuemark feature is *running and correct* but feels wrong live, it is usually one
constant sized against the wrong content. This is the map. Each entry names the live
symptom first — that is what you actually have to go on.

**Rule zero: confirm the code is running before you tune it.** Every knob below logs its
resolved value. If the log line is absent, you are debugging a build, not a constant — see
"Is the running app current?" at the bottom.

---

## The knobs

### 1. Video frame ring — reverse scrub shows a frozen picture

| | |
|---|---|
| **Symptom** | Scrubbing/jogging *backward* freezes the picture; forward is smooth. Audio is fine throughout. |
| **Where** | `FRAME_RING_BYTES = 192MB` in `src/lib/video/codecPlayer.ts` — the only sizing input, plus the `MAX_HELD_FRAMES` cap below |
| **Log line** | `[codecPlayer:deck-0] frame ring: 17 frames (3840x2026, ~189.4MB, ~0.68s of reverse scrub)` |
| **Read it as** | The last figure is the whole story: **how many seconds of backward travel are served for free.** Compare it to the gesture you are making. A 1-second jog against a 0.16s ring will look broken. Frame rate does not enter the sizing, only this readout — so the same budget is a long window on a slow file and a short one on a fast file, by design. |
| **Live override, no rebuild** | `localStorage['cuemark:codecFrameRing'] = '24'` — a raw frame count, applied at the next deck load. |
| **Ceiling** | `MAX_HELD_FRAMES = 32`. **Do not raise it casually**: a `VideoFrame` pins a decoder buffer until `close()` and `VideoDecoder` recycles from a bounded pool, so the failure mode is decode stalling *outright*, not gradual memory growth. |
| **Tell that you overshot** | *Forward* playback stops updating; `[codecPlayer] first decoded frame` appears and then nothing follows. Drop the override before suspecting anything else. |

This is the knob that has actually bitten, twice, in opposite directions. A 48MB byte budget
gave 16 frames at 1080p but **4 frames / 0.16s** on a real 3840×2026 file — the fix was live
and read as "not working". The correction — sizing by a *duration target* instead — fixed 4K
and cut 720p from 32 frames to 9, a regression on most of the library, because the target was
chosen against the single 4K file in front of the person choosing it. 🛑 **Do not reintroduce
`RING_TARGET_SECONDS`**: raising the byte ceiling gets 4K its window without taking anyone
else's. Whichever way you turn this, **check what the new value does to both a 4K and a
sub-1080p file** — the log line above tells you in one deck load each.
Full write-up: `docs/design/codec-frame-cache.md` §5a.

### 1b. Scrub GOP fill — scrub still freezes, just further out

| | |
|---|---|
| **Symptom** | Scrub stays smooth for the ring's ~1s and *then* freezes; or freezes only after changing direction; or the opposite complaint — scrub works but something is glitching audio while cueing. |
| **Where** | `FILL_*` constants in `src/lib/video/codecPlayer.ts` and `codecWorker.ts` |
| **Log line** | `[frame-cache/deck-0] 4.2s \| stuck=0 (worst run 2) frozen=146 \| req=248 hit=246 (99%) ring=91 fill=155 stale=2 \| travelled 18.30s` then `fills req=2 done=2 frames=64 aus=498 decode=612ms held=61` |
| **Read `stuck` FIRST** | 🔴 Neither `hit` nor raw `frozen` is evidence. `hit` read **100%** on live run 1 during a visible freeze; `frozen` is ~58% on a *healthy* gesture (60fps rAF over 25fps content). `stuck` counts runs of ~130ms+ on one frame — the only counter that matches what a user sees. |
| **`fills req=` ≫ `done=`** | Replies are not coming back; this was the latch that killed the feature silently on live run 1. |
| **`fills req=` in the hundreds** | The request loop is back — 179 in one 22s gesture was defect 2. |
| **`fills req=0` on a long gesture** | Trigger never armed. Check `reasons:` and that the deck was **paused** (it never runs on a playing deck, by design). |
| **Live overrides, no rebuild** | `localStorage['cuemark:codecReverseBackfill'] = '0'` (off) · `localStorage['cuemark:codecBackfillRing'] = '24'` (total retained fill frames). Keys keep their original names. Applied at next deck load. |
| **Smoothness vs. span** | `fillPerGop()` (half of `MAX_FILL_FRAMES`) buys **smoothness across one GOP**, not more span: 32 → ~3.2fps. Raising it does not make a gesture reach further; only fetching the next GOP does. |
| **If audio suffers** | Raise `FILL_PACE_MS` (4ms) or `FILL_TRIGGER_SECONDS` (0.35) first, then the kill switch. 🛑 **Not `BACKWARD_JUMP_SECONDS`** — see §5, different mechanism, its own reverted history. |
| **🛑 Do not shorten `FILL_PROBE_LEAD_SECONDS`** | A GOP decodes from its keyframe *forward*, so in reverse travel the frames nearest the gesture arrive **last**. Too short a lead means scrubbing into a region still being decoded. |
| **🛑 Do not make the trigger reverse-only** | The primary decoder covers exactly one direction (forward from where it is parked) and does not move during a gesture, so a reverse-only fill leaves the other direction frozen. Live symptom: "the first direction I scrub works, the other sticks", in both orders. |
| **Refused outright** | `gop-too-long(N)`: the file's GOP exceeds `FILL_MAX_GOP_AUS = 600`. Deliberate — reaching any frame in a GOP costs decoding it from its keyframe, so a single-keyframe encode would be minutes of decode. |

🟢 **Live-verified 2026-08-13** (run 2): both directions, direction changes mid-gesture, audio
clean, decode down 28× per second of travel. Run 1 found three defects that all passing unit
tests missed — defect record: `docs/design/codec-frame-cache.md` §7a. Healthy reference
numbers for comparison: `fills req=15 done=15 aus=720 decode=1007ms` over 43.9s of travel.

### 2. Silent-scrub seek throttle — jog feels laggy/steppy on a *playing* deck

| | |
|---|---|
| **Symptom** | Jog or drag on a playing deck moves in visible steps rather than continuously. |
| **Where** | `SILENT_SCRUB_SEEK_MS = 50` in `src/lib/renderer/seekBus.ts` |
| **Log line** | `[scrub-deliver/deck-N] … sent=183 (16/s) skipped=383` — a high `skipped` against `sent` is this throttle doing its job. |
| **Before turning it** | Check the gesture said `midi silent` / `pointer silent`. If you expected *audible*, the throttle is not your problem — see §5. |
| **Caution** | This exists because 60 FLUSH seeks/sec is seek congestion this pipeline has stalled on before. Costs nothing visually by design: `getDeckTime()` reports the target, so the playhead already tracks at full rate and only audio catches up in steps. |

### 3. Vinyl jog scale — jog moves too much or too little per detent

| | |
|---|---|
| **Symptom** | One revolution of the jog wheel moves the track by the wrong amount. |
| **Where** | `VINYL_SEC_PER_TICK = 1.8 / 256` |
| **Log line** | `[jog-cal/deck-N] msgs=1678 absSum=1678 net=82 maxAbs=1 values=[-1,1] over 11.54s … VINYL_SEC_PER_TICK = 0.00107` |
| **Read it as** | The suggested value is only meaningful **if that gesture was exactly one revolution**. `net` ≪ `absSum` means the wheel went back and forth, so the suggestion is garbage — redo the calibration as one clean revolution in one direction. |
| **Calibrated** | The Starlight encoder reports plain ±1 deltas (`maxAbs=1`, `values=[-1,1]`), measured live. If `maxAbs` > 1 you are on a different controller and the whole mapping needs revisiting, not this constant. |

### 4. Scratch servo coasting — audio drops out during a *slow* gesture

| | |
|---|---|
| **Symptom** | Scratch audio mutes in the gaps of a slow, gentle hand movement. |
| **Where** | `HandTracker` in `src-tauri/src/audio/pipeline.rs` — 300ms taper, 50ms content cap |
| **Log line** | `[scrub-deliver]` / `[scrub-sec]` — look at `gap` percentiles |
| **🛑 Do not re-tune the servo lag** | Three sessions blamed the servo by mistake. A slow hand produces only **5–12 pointer events/s with gaps to 1180ms**; the coasting already exists for exactly this. Read the delivery legs first. |
| **Designed silence** | `arrived%` on a decelerating hand and `snaps` on a coarse drag are silence **by design**. A sustained negative delivery margin during a scratch is **the fix working**, not a fault. `output_queue underrun` fires once per chunk by construction (66.8/s against a 66.7/s chunk rate) and adjudicates nothing. |

### 4c. Platter mass — the scratch sounds frantic / buzzy / jittery

| | |
|---|---|
| **Symptom** | Scratching or jogging *works*, at the right speed and with no dropouts, but the sound is rough, buzzy or "frantic" — the pitch audibly jumps with each MIDI detent instead of gliding. Worst at the slow speeds cueing actually uses; barely noticeable above ~0.5x. |
| **Where** | **Settings → Audio → Platter** (0–90ms, default 40). `cuemark:scrubInertiaMs`; `SCRATCH_RATE_INERTIA_MS` in `pipeline.rs` is the default only. |
| **Log line** | `[scratch-tel/deck-0] … rate mean=0.152 max=0.31 jerk=0.029 (inertia 40ms, lag 5.3ch)` |
| **Read `jerk`** | Mean chunk-to-chunk change in playback speed as a fraction of the mean speed. **~0.17 is the un-smoothed behaviour at cueing speed; ~0.03 is the shipping default.** Compare two gestures at the same `rate mean` — that is the only fair comparison, since the metric is normalised but the *input* jitter is not. |
| **Why it exists** | A jog wheel delivers **detents**, not a hand: one fixed 7.0ms of content at a time, which at 0.15x is 3 chunks' worth of cursor travel arriving at once every 47ms. The servo answered each with a rate spike, so pitch ran as a ~21Hz sawtooth peaking at twice its own mean. `docs/design/waveform-scrub.md`, "Platter mass". |
| **Applies live** | Sent with every `scratch_to` call, so **move the slider mid-gesture and listen.** No reload, no rebuild. |
| **The trade** | Smoothness against immediacy, and there is no free value — every ms here is a ms the cursor trails the hand, plus 2 more from the servo lag it is coupled to. 0ms → jerk 0.173 / 60ms lag · 40ms → 0.029 / 120ms · 90ms → 0.008 / 270ms. The return flattens long before the lag does; past ~60ms you are mostly buying latency. |
| **Kill switch** | 0 — bit-identical to the pre-2026-08-14 path, asserted by `zero_inertia_is_exactly_the_old_behaviour`. |
| **🛑 Not the knob** | `SCRATCH_SERVO_LAG_CHUNKS` directly. It is now *derived* (`servo_lag_chunks()` holds it at ≥2× the inertia) and that coupling is what keeps the servo loop damped — decoupling it makes a large setting ring, which is audibly **rougher**, not smoother, and reintroduces the 2026-08-09 gain-ramp storm. |
| **🛑 Also not the knob** | The coast (`SCRATCH_COAST_*`). It is already working; §4 applies. |

⚠️ **If you change the mechanism rather than the setting, `snap_frames()` is load-bearing.**
A first-order servo sustains a standing error of `hand_speed × lag`, so a *fixed* snap
threshold becomes reachable by an ordinary fast drag as soon as the lag widens — measured at
**78% of chunks silent with the cursor going nowhere**, which reads as "scratch stopped
working" and not at all as a tuning problem. It scales with the lag for that reason.

### 4b. Shared output graph — cue gates during a scratch, or a jog feels laggy

| | |
|---|---|
| **Symptom A** | Headphone cue chops to silence during a scratch while main plays normally, on a device where main and cue are two channel pairs of the *same* node (the DJControl Starlight). |
| **Fix, not a knob** | One `pulsesink` per device node instead of one per deck branch (`docs/design/shared-output-pipeline.md`). **Default since 2026-08-11**, after a 600s real-hardware soak; `CUEMARK_SHARED_OUTPUT=0` reverts to the old per-branch-sink path. |
| **Log line** | `[audio/out/<node>] attached deck-0/cue (2 branch(es) now on this node, 4 ch)` — two branches, **one** node, is the whole point. |
| **Symptom B** | With the shared graph on, a scratch gesture feels laggy while `late%` in the feeder telemetry is unchanged (so it is not the feeder). |
| **Where** | `MIX_QUEUE_NS = 30ms` in `src-tauri/src/audio/mixer.rs` — the jitter buffer between each handoff and its mixer pad. |
| **Read it as** | Added latency on the scratch path, on top of the sink's own `buffer-time`. It only has to absorb handoff jitter; the deck's `output_queue` (100ms) is upstream and does the real buffering. |
| **🛑 Not the knob** | The scratch servo constants (§4). Three sessions have already blamed the servo for something else. |
| **🛑 Also not the knob** | `sink_buffer_times()` / `CUEMARK_SINK_BUFFER_MS`. Lowering it reaches a smaller PipeWire quantum, which *once* made the gating go away — but it was re-tested and **the gating returns after a short playback duration**. It moves the symptom without fixing it, and it walks into the 2026-08-02 choppiness regression. Dead lever. |

⚠️ **Three properties of the shared graph are load-bearing and silent when broken** — if you
are changing `mixer.rs` rather than tuning it, run
`scripts/probes/shared_output_mixer_probe.py` (always with its `--not-live` control arm):
`is-live=true` on every output `appsrc` (false ⇒ **zero** buffers while any branch is idle,
i.e. one paused deck silences the node); the deck pipelines' `use_clock()`; and `position()`
subtracting the graph's latency (**measured 171.3ms** — uncorrected, video leads audio by that
much, constantly).

⚠️ **Two instruments read differently on this path and neither is a fault.**
`output_queue underrun` fires continuously during ordinary playback (the appsink renders
just-in-time, so the queue empties between every buffer) — it is logged at *info* there for
that reason. And the scratch alignment report says `appsink0=SKIPPED(no property)`, correct
because `appsink` is not a `GstAudioBaseSink`.

### 5. Decode-ahead gate — do not tune to fix reverse scrub

| | |
|---|---|
| **Where** | `aheadSeconds()` in `src/lib/video/codecWorker.ts`, `BACKWARD_JUMP_SECONDS` in `codecPlayer.ts` |
| **🛑 Known trap** | Lowering `BACKWARD_JUMP_SECONDS`, or making the `setClock` anchor accumulate backward travel, was built, unit-tested and **reverted as a live audio regression** (2026-08-09). Each seek re-decodes ~125 frames of 1080p in software (no VA-API on this machine), starving the main thread and the GStreamer audio threads. |
| **Instead** | Widen the frame ring (§1), or tune reverse backfill (§1b), which serves travel past the ring without ever moving the primary decoder. The cost is the seek itself, not the seek policy. |
| **Load-bearing coupling** | Reverse motion stops the decoder feeding on its own as `clockPos` retreats — that is *why* the ring survives a backward gesture. Changing the gate can silently break the ring. |

### 6. Network output delay — the projector runs ahead of the room

| | |
|---|---|
| **Symptom** | Audio and video look in sync in the booth, but on a network (Snapcast) output the video is visibly *ahead* of what the room hears — by a constant amount, on every deck, forever. |
| **Where** | **Settings → Net → delay (ms)**, per target. Not a code constant — it is a property of the *receiving server*, so it is configured, persisted in `cuemark:networkOutputs`, and pushed by `audio_set_output_latency`. |
| **Start at** | The server's own end-to-end buffer. For the house Snapcast server that is `buffer = 400` in `/etc/snapserver.conf` (Snapcast's own default is 1000). Then tune by ear against the room. |
| **Log line** | `[audio/out/snap-…] created for …: latency=571ms (queried 171ms + network 400ms)`, and on a change `extra latency now 400ms … applied live to N attached branch(es)`. |
| **Applies live** | Deliberately — it is shared with the node as an `Arc<AtomicU64>`, not copied at attach. Change it while a deck plays; no reload, no rebuild. |
| **🛑 Only moves the video when the network target is FIRST in Main** | `attach_output_graph()` takes the position correction from branch 0. That *is* the choice of which output the projector is in sync with, and **you cannot have both**: booth monitor first = video synced to the booth; house first = synced to the room. If turning this knob does nothing, check the ordering before anything else. |
| **Not this knob** | Booth-and-house echoing in one room is a *different* offset (`ts-offset` on the local sink, not built). And a network output that is silent rather than late is not a latency problem at all — see the audio-debugging skill. |

### 7. Network sink queue — 🛑 do not make it non-leaky

| | |
|---|---|
| **Where** | `SNAPCAST_QUEUE_NS` (500ms) and `leaky=downstream` in `make_snapcast_sink()`, `audio/pipeline.rs` |
| **🛑 Known trap** | `leaky=downstream` looks like sloppiness — it drops audio. It is the only thing stopping a dead or wedged server from stalling **the booth monitor and the cue**: the deck's `tee` has no per-branch queue, so backpressure from any branch stalls every branch. Measured with a control arm: without it, the booth branch received **0 buffers**; with it, the full healthy rate. |
| **Verify** | `scripts/probes/snapcast_tcp_sink_probe.py --stall` (must pass) **and** `--stall --no-leaky` (must fail). ⚠️ Needs ~35s — kernel socket buffers absorb ~21s of audio first, so a shorter run passes regardless and proves nothing. |
| **If the room glitches** | Raise `SNAPCAST_QUEUE_NS`. Never remove the leak. |

---

## Before you turn anything

### Is the running app current?

A frontend change is baked into the release binary at build time, so the desktop launcher
does **not** pick it up until someone rebuilds. Three checks, cheapest first:

```bash
./scripts/check-launcher-staleness.sh          # exit 0 fresh / 1 stale / 2 not built
grep -a '\[build\]' ~/.local/share/com.cuemark.app/logs/cuemark.log | tail -1
find src -newer dist/index.html -type f        # any hit ⇒ dist is behind source
```

Then confirm the code *ran*, not just that it shipped — grep the log for the knob's own log
line. A constant that never printed its resolved value is not in play.

```bash
npm run tauri build -- --no-bundle             # rebuild the launcher binary
```

### Is the deck even loaded?

Costs one command and has already explained one "the jog wheel is not working" report in
full — the wheel was bound to an empty deck:

```bash
python3 -m json.tool ~/.local/share/com.cuemark.app/session-recovery.json \
  | grep -A2 '"id"'
```

`"source": null` means that deck has no track and no audio pipeline, so every scratch IPC
rejects with `no audio pipeline for deck 'deck-N'`. The gesture then degrades to the
throttled silent path and reports `err=1` with a large `skipped` — **which looks exactly
like a tuning problem and is not one.** Note the frontend logs the underlying cause via
`console.warn`, which is *not* forwarded to the log file, so the log shows only the
consequence.

### Is it actually silence-by-design?

Several of these paths are deliberately silent in specific gestures. Before treating
silence as a bug, check the designed cases in §4 and in
`docs/design/scratch-audio-downstream-delivery.md`. When asking for a repro, ask for a
**slow, smooth, zoomed** gesture — coarse or fast gestures hit the by-design silence.

---

## Adding a knob (rather than turning one)

🛑 **Promoting a tuned constant to a user-facing setting promotes every margin that constant
was silently protecting into a live failure mode.** Those margins were never written down as
constraints — they were true by arithmetic accident and had never had to hold.

Establishing case, 2026-08-14, adding §4c's platter mass: the new filter widened the servo
lag, fixed at 4 chunks since it was tuned. Three defects fell out, **none of them in the new
code**, all latent for months. The snap threshold was a fixed 0.5s against a legitimate
standing error of `hand_speed × lag`, which at the old lag topped out at 0.48s — a **4% margin
nobody had stated** — so widening the lag collapsed a fast drag into snap-mute-snap, 78% of
chunks silent. Arrival was defined by position alone, safe only while the cursor could not
have momentum. And the filter is a second pole *inside* the servo loop, so damping is set by
the *ratio* of the two constants — uncoupled, turning the knob up made it **rougher**.

Before shipping a slider:

1. **List every constant whose correctness depends on the one you are freeing**, and re-derive
   each as a *function* of the knob rather than a number.
2. **Write a table test before the assertion tests** — a `#[test]` that just prints a matrix
   (knob × input → each metric), run with `--nocapture`. Thresholds then get read off real
   numbers instead of guessed, and the wrong cell is visible at a glance. `servo_test::
   inertia_table` is the worked example; it is what surfaced the snap collapse while every
   hand-written assertion passed.
3. **Sweep the full range and measure.** The knob must be *monotone* in the thing it claims to
   improve, and 0 (or the old value) must be bit-identical to the old path — assert both.
4. **Bound it by something real.** `SCRATCH_RATE_INERTIA_MAX_MS = 90` is where spin-down would
   start racing the frontend's `SCRUB_HOLD_MS` to end the same gesture, not a round number.

⚠️ **When the complaint is about *texture* — rough, frantic, buzzy, jittery — log the
derivative, not the envelope.** `rate mean` and `max` had been in `[scratch-tel]` all along
(`mean=1.026 max=1.424` inside one second of a *steady* gesture) and nobody had connected them
to what a listener heard. A normalised chunk-to-chunk delta (`jerk`) makes the same fault
legible at a glance. Simulate the real input chain and validate the model against existing
logs *before* writing code — the evidence was already six days old.

---

## The general rule

**Size a constant in the units its consumer spends, not the units the resource is billed
in.** The frame ring's consumer spends *seconds of reverse travel*; the resource is billed
in *bytes*. Sizing by bytes let the real window vary 4× across resolution and 10× across
frame rate while the constant sat reassuringly fixed — a feature that was live, correct and
useless. Convert to the consumer's units, apply the resource limit as a ceiling, and **log
the result in the consumer's units** so a wrong answer is visible at a glance rather than
after a session of live testing.

Corollary: unit tests do not validate any knob here. The reverted reverse-scrub change
passed all of its tests; `scratch_to_smoke` passed while the feature it covered was
inaudible. These are verified live, against audio, or not at all.
