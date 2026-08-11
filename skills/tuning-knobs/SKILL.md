---
name: tuning-knobs
description: The small set of numeric constants that actually change cuemark's live feel — video frame ring, scrub delivery, scratch servo, decode-ahead — with each knob's live symptom, where it lives, how to change it without a rebuild, and which knobs are known traps that must not be turned. Load when a feature "works but feels wrong" live, when about to tune a constant, or when a shipped fix reads as not working.
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

### 1b. Jog scale — a slow jog makes no *audible* sound (but the meters look fine)

| | |
|---|---|
| **Symptom** | Turning the jog wheel slowly produces a burst at the start of the motion and then near-silence, while the wheel is still turning. Meters, `arrived%`, delivery counters all healthy. |
| **Where** | **Settings → Jog scale** (`jogSecondsPerRev`, default 1.8s/rev = 33⅓ rpm). No rebuild, no restart — it is read per gesture. |
| **What it actually is** | **Not a fault.** At 0.10–0.26x the audio is pitched ~2.7 octaves down: full level, sub-100 Hz, inaudible on most monitoring. `rms` cannot see this — it is blind to frequency. |
| **Confirm before turning** | `[scratch-tel] … rate mean=` under ~0.35 across the gesture. Or capture it: `scripts/scratch-capture.sh` → verdict `PITCHED`. |
| **The trade** | Lower s/rev = higher pitch for the same hand motion = **coarser positioning**, in exact proportion. There is no free value; this is a taste call, which is why it is a UI setting and not a constant. |
| **🛑 Not the knob** | `VINYL_TICKS_PER_REV = 256` is a *measured hardware fact* (five calibration gestures, 243–276). Do not "tune" it to compensate for feel — that hides a wrong hardware value inside a preference and defeats every later calibration. |

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

### 4b. Shared output graph — cue gates during a scratch, or a jog feels laggy

| | |
|---|---|
| **Symptom A** | Headphone cue chops to silence during a scratch while main plays normally, on a device where main and cue are two channel pairs of the *same* node (the DJControl Starlight). |
| **Fix, not a knob** | `CUEMARK_SHARED_OUTPUT=1`. One `pulsesink` per device node instead of one per deck branch. This is the actual fix (`docs/design/shared-output-pipeline.md`), live-confirmed 2026-08-11. Still defaults **off** pending the multi-deck pass. |
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
| **Instead** | Widen the frame ring (§1). The cost is the seek itself, not the seek policy. |
| **Load-bearing coupling** | Reverse motion stops the decoder feeding on its own as `clockPos` retreats — that is *why* the ring survives a backward gesture. Changing the gate can silently break the ring. |

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
