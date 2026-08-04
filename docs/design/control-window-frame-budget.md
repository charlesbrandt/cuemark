# Control-window frame budget: why the position poll is slow

Status: **root-caused. Two fixes landed, both A/B-confirmed. The waveform-cache fix removed
the cost it targeted (per-draw JS 14ms → 1ms, `busy%` 8–9% → 0%) but bought only ~1fps —
because a *third* limit was hiding behind it: while any deck plays, rAF is pinned to exactly
half vsync (gap p50 32ms) with the main thread ~98% idle. That is now the open question; see
"Where to pick up".** Started 2026-08-03 from a report of `audio_get_position` round trips of
300–424ms.

**If you are picking this up fresh, read "Where to pick up" at the bottom first.**

## The question it started from

`audio_get_position` is the master clock's transport: every playing deck polls it once per
rAF frame, and a video resync hangs off each resolution (`av-sync-architecture.md`). Round
trips of 300–424ms were being logged, against a documented baseline of ~140–190ms which was
itself never questioned. The suspicion was GStreamer's `query_position`.

**It is not, and never was.** The whole Rust/GStreamer layer contributes ~0ms.

## How the round trip decomposes

`audio_get_position` is a *synchronous* `#[tauri::command]`, so it is dispatched on the GTK
main thread. Three legs, only one of which is the backend:

```
JS invoke ──toRust──► GTK main thread ──inRust──► reply ──toJs──► promise callback
```

`PositionSample` (in `src-tauri/src/audio/mod.rs`) carries the backend's own entry/exit
epoch stamps back with every reply, so the frontend can attribute the latency instead of
guessing. Epoch ms is the only clock the Rust process and the webview share —
`performance.now()` and `Instant` have per-process origins and cannot be differenced across
the boundary.

Measured, every 5s window, in every state including mid-scratch:

| leg | p50 | what it is |
|---|---|---|
| `toRust` | **2ms** | JS → GTK main thread dispatch |
| `inRust` | **0ms** | the entire command body |
| ├ `lock` | **0ms** | `Mutex<AudioManager>` contention |
| └ `query` | **0ms** (max 2) | GStreamer `query_position` |
| `toJs` | **65–220ms** | reply → the JS promise callback actually running |

Two independent controls confirm the attribution rather than assuming it:

1. **`ipc_ping`** (`src-tauri/src/lib.rs`) — a no-op command fired on the same transport in
   the same tick. Identical profile: `toRust` 1–2ms, `toJs` 59–219ms. A command that does
   *nothing* is exactly as slow as the position poll.
2. **The scratch bucket** — during a gesture `position()` returns the feeder's atomic
   cursor and never touches GStreamer at all (`pipeline.rs`). Same shape as the normal
   bucket. This control is free and always available; use it.

## The actual mechanism

**`toJs` ≈ the rAF gap, in every window.** At the worst sample: rAF gap p50=380ms, poll
total p50=376ms, ping total p50=356ms. The reply is not being starved in any exotic sense —
it waits for the next turn of the main loop, and the loop was only turning 7–17 times per
second while playing.

So the position poll's latency is a *symptom*: **a poll can never resolve faster than one
main-loop turn.** At 8fps that is 125ms no matter what the backend does. Fixing the poll
means fixing the frame rate.

The `[raf]` line (`gap` since the previous tick, synchronous `frame-dur` of this one) is the
discriminator that made this legible, and it is worth restating because the first reading of
it was wrong:

- `gap` ≈ `dur` ≈ latency → the render loop's own synchronous work saturates the thread.
- `gap` large, `dur` small → something the loop *schedules* but does not execute inline.
- `gap` ≈ 16ms with large `toJs` → the thread keeps up and reply delivery itself is starved.

⚠️ **Only compare these while a deck is playing.** The initial conclusion here was the third
case — drawn from 62fps/`frame-dur=0` windows that contained *no polls at all*, because
nothing was playing. Polls and the collapse only ever coexist during playback. An idle
window is not a control for a playing one.

## What was found and fixed

### 1. `postFrame()` ran unconditionally — the dominant cost

`outputBus.postFrame()` built a full-resolution `drawImage` + `createImageBitmap` per
changed deck, at up to 60fps, **whether or not an output window existed**. There was no
listener gate. This is why closing the projector did not help.

Measured by accident, and it is the cleanest arm in the investigation: a `ReferenceError`
thrown at the top of `postFrame` (see "Vite" below) disabled frame construction entirely
for a whole run.

| metric | postFrame active | postFrame off |
|---|---|---|
| poll total p50 | ~90ms | **19–21ms** |
| rAF while playing | 7–12fps | **20–33fps** |
| `frame-dur` p50 | 13–16ms | **0–1ms** |

`postFrame` was essentially *all* of the synchronous frame cost and roughly 60% of the frame
period — a 4.7× improvement in the reported number.

**Fixed** by an `alive` beacon: the output window announces itself every second
(`OUTPUT_ALIVE_INTERVAL_MS`), and the sender skips all frame construction after 3s of
silence. A beacon rather than a goodbye-on-unload, deliberately: a window killed by the
freeze-watchdog or the window manager never gets to say goodbye, and believing a dead window
is alive wastes work permanently. Erring toward "still listening" for two seconds after a
close costs nothing; erring the other way freezes the projector mid-set. A beacon with no
preceding `hello` (watchdog reload, HMR) is adopted and triggers a full re-send.

### 2. Transport retry chains amplified instead of converging

`reconcileAudioTransport` retried every 200ms, and `lastAudioPlaying` is only set on
*success* — so while attempts failed, `deck.playing !== wasAudioPlaying` stayed true in
`syncVideoElements()`, which runs on every session-store mutation, which during a jog is
every rAF tick. Each run started an independent chain; chains accumulated linearly (~60/sec
of jogging), each retrying 5×/sec for up to 10s.

Failures there are routine, not exceptional: `with_pipeline_detached` removes the pipeline
from the map for the duration of a play/pause/stop_scratch, and `audio_load` removes it for
the whole preroll, so every concurrent transport call in those windows fails by design.
Jogging a deck that is loading or mid-teardown is exactly the case that piled chains up.

Observed as a sustained 200ms-periodic burst of 15–25 `detached-pipeline IPC received`/sec
(the period is `AUDIO_TRANSPORT_RETRY_MS` exactly). **Fixed** — one chain per deck,
cancel-and-replace on state flip, cancel on unload. After: 5 detached calls in 90 seconds.

⚠️ Not yet confirmed across a track load, which is the case that piled them up worst.

### 3. Supporting fixes

- **`with_pipeline_detached` now names its caller and times itself.** A burst of anonymous
  lines said only "something detached 25 times a second" when play, pause, stop_scratch and
  a device rebuild have wildly different costs.
- **Log rotation was destroying the evidence.** The plugin defaults (40KB, `KeepOne`) let a
  session self-erase in under two minutes — including the build-provenance line CLAUDE.md
  says to check first. Now 8MB + `KeepAll`.
- **`[frame-error]` logged stack without message.** WebKit's `e.stack` is bare frames with
  no message line (unlike V8), so a per-frame `ReferenceError` reached the log as an
  anonymous `hasListener@…outputBus.ts:29:102` and read like a crash inside working code.
  Now logs name + message + stack.

## The A/B against a working gate — run 2026-08-03, complete

Run on `8eb2a33`-dirty (the tree that became `d5a9a41`), one deck, H.264 on the WebCodecs
path. The two arms are separated by a natural experiment rather than a config change: the
output window's `WebKitWebProcess` spawned at 01:07:59 UTC, between them. Arm 1 contains no
`[post-frame]` line at all, which is the gate returning at `outputBus.ts:183` *before*
`recordPostFrame` — absence of the line is the proof the gate fired, not missing data.

| | idle | **arm 1** — output closed | **arm 2** — output open |
|---|---|---|---|
| rAF | 62fps, gap 16 | **~24fps, gap p50 40** | **9–13fps, gap p50 67→105** |
| `frame-dur` p50 | 0ms | **1ms** | **7–8ms** |
| poll `total` p50 | — | **13–19ms** | **59–86ms** |
| `ipc-ping` p50 *(control)* | — | 9–19ms | 57–196ms |
| `post-frame` | — | *no lines* | sync **7ms**, to-postMessage **38–56ms** |
| `inRust` p50 | — | 0ms | 0ms |

Arm 1 reproduces the accidental run's ~25fps / ~20ms poll almost exactly, so that run was a
valid measurement of the gate and the fix is confirmed on a real build.

**What the projector costs, and where.** The frame gap goes 40 → ~88ms: **+48ms per frame**.
It decomposes with nothing left over:

| leg | cost | visible to |
|---|---|---|
| in-tick `drawImage` onto the scratch canvas | **+7ms** | `frame-dur`, and `post-frame sync` |
| `createImageBitmap` resolving + cross-process structured clone | **+41ms** | `post-frame to-postMessage` only |

So **~85% of the projector's per-frame cost is the async bitmap/clone path, not the render
loop** — and `frame-dur` cannot see any of it. Anyone reading only `[raf]` would conclude the
loop is nearly free and mis-attribute the collapse. This is why `post-frame` splits its two
legs; keep that split.

⚠️ **Arm 2 degrades monotonically within a single run** — 13.2 → 8.8fps over 45s of
continuous playback, while both `post-frame` legs stay flat (`sync` 7–8ms, `to-postMessage`
38–56ms throughout). Something accumulates that is in neither leg. Not yet chased; a longer
arm-2 hold is needed to see whether it plateaus or keeps sliding.

## The residual — measured 2026-08-03, and it is not what the candidate list assumed

With `postFrame` correctly skipped, playback **still costs ~24ms/frame**: 23fps while playing
versus 62fps idle (gap 41 vs 16), with `frame-dur` at **1ms**.

### The control window runs three rAF loops, not one

`frame-dur` measures only `App.svelte`'s `frame()`. Two more rAF loops run **per playing
deck**, in the same rAF turn, and were invisible to every measurement in this doc until now:

| loop | file | counted by `frame-dur`? |
|---|---|---|
| `frame()` | `App.svelte:750` | ✅ — this is the 1ms |
| preview `draw()` | `DeckCard.svelte:98` | ❌ |
| playhead `loop()` | `WaveformCanvas.svelte:143` | ❌ |

`recordAuxLoop()` in `pollStats.ts` now times the latter two into `[aux-loop]`, reporting
per-tick percentiles **and `busy%`** — the share of wall-clock time the loop consumed. `[raf]`
reports `busy%` too. That total is the number that settles attribution, because summing it
and subtracting from 100 exposes the *unaccounted* share instead of hiding it.

### The answer: all three loops together are ~14% of wall time, and none of them is the limit

One deck, H.264/WebCodecs, output window closed:

| | overview waveform | zoom waveform |
|---|---|---|
| rAF | **23.3fps, gap p50 41** | **23.0fps, gap p50 41** |
| `frame()` busy | 1% | 1% |
| `preview/deck-0` busy | 5% (drew ~63/116, p50 3ms) | 5% |
| `waveform/deck-0` busy | **8%** (drew ~38/116, p90 10ms) | **2%** (drew 114/114, p50 1ms) |
| **total JS busy** | **14%** | **8%** |
| poll `total` p50 | 13ms | 15ms |

**The zoom toggle is a free control arm and it is decisive.** Zooming changes the waveform's
cost profile completely — it redraws on *every* frame instead of ~1 in 3 (the ≥1-device-pixel
guard clears far more often at 16s span), yet each redraw is ~10× cheaper than an overview
redraw of thousands of peak bars. Net effect: waveform work drops 8% → 2%, total JS work
drops 14% → 8%, **and the frame rate does not move at all** (23.3 → 23.0fps). Removing 6% of
wall-clock main-thread work bought exactly zero frames.

So the preview and waveform loops are real costs but **not** the constraint, and the original
candidate list was aimed at the wrong layer.

### What the residual actually is: rAF is throttled, not blocked

Three facts that only make sense together:

- The main thread is **~86% idle** during playback (14% busy across all three loops).
- IPC replies come back in **13–15ms**, comfortably *inside* the 41ms frame period — so the
  main loop is turning several times per rAF tick and nothing is queued behind rendering.
- rAF nevertheless fires only **23 times/sec**, versus 62 with the identical components
  mounted and idle.

The thread is not saturated and replies are not starved. **rAF itself is being scheduled at
23fps**, and the gap is not main-thread work of any kind. Whatever throttles it lives outside
JS — WebKit's rendering/compositing cadence, or CPU contention from the decode worker
(`codecWorker.ts` runs `VideoDecoder` off the main thread, so software decode does *not*
consume the main thread, but it does consume cores).

⚠️ **This corrects the doc's own headline rule.** "A poll can never resolve faster than one
main-loop turn" holds, but a main-loop turn is **not** an rAF turn. In arm 2 the two tracked
each other and the distinction did not matter; in arm 1 the poll resolves in 13ms against a
41ms rAF gap. Reading `toJs` as a proxy for the frame period is only valid when the thread is
actually saturated — check `busy%` before assuming it.

### The video path is exonerated: an audio-only file is *worse*

Arm: a 6:26 `.wav` (no video track), output window closed. Codec demux fails as designed
(`timed out waiting for parsebin to expose a video stream`), so it falls back to the legacy
`<video>` path — no decode, no preview `drawImage`, `preview/deck-0 drew=0`.

| | mp4, overview | **wav, overview** |
|---|---|---|
| rAF | 23.3fps | **12–14fps** |
| preview busy | 5% | **0%** (drew 0) |
| waveform busy | 8% (p90 10ms) | 11% (p90 34ms, max 54ms) |
| total JS busy | 14% | ~12% |

Deleting decode *and* the preview canvas entirely **halved** the frame rate. Whatever the
residual is, it is not the video path, not WebCodecs, and not the preview canvas.

Instantaneous CPU during this arm: `WebKitWebProcess` **36–64%**, `cuemark` 18–25%. The
webview burns half a core while its main thread reports ~12% busy. (Measure this with
`top -b -n 2 -d 3`, never `ps %cpu` — the latter is a lifetime average and reads ~7% for a
process that is currently at 64%.)

### Root cause: waveform *paint* cost, ~75% of which is invisible to JS

The zoom toggle isolates it, on one file in one contiguous run, reproduced across several
toggles:

| window | mode | rAF | gap p50 | waveform busy | draws |
|---|---|---|---|---|---|
| 01:35:52 | overview | 23.4fps | 43ms | 8% | 28/116 |
| 01:36:02–:17 | **zoom** | **28.4–29.8fps** | **33ms** | **2–3%** | 148/148 |
| 01:36:27 | overview | 21.8fps | 43ms | 8% | 27/110 |

`drawOverview()` iterates **every peak** — 11,583 for this track — while the zoom view draws
only a 16s window. Zoom redraws on *every* frame and is still far cheaper.

The arithmetic is the actual finding:

| | overview | zoom | Δ per frame |
|---|---|---|---|
| wall time per frame | 45.5ms | 34.2ms | **11.3ms** |
| JS time per frame | 3.6ms | 0.9ms | **2.8ms** |
| **unaccounted** | | | **8.5ms (75%)** |

**Only a quarter of the overview waveform's cost is the JS that draws it.** The other ~75%
is WebKit rasterizing and compositing the dirty canvas *after* the JS call returns — canvas
2D records a display list and rasterizes later, so a display list of 11.5k `fillRect`s is
expensive in a phase no JS timer can see. That is why `busy%` and fps disagree, why CPU is at
64% while the main thread is 12% busy, and why the earlier mp4 arm showed no zoom effect
(its overview was cheap enough for paint not to dominate).

⚠️ **One unexplained confound, stated rather than smoothed over.** The same `.wav` in the
same overview mode measured 12–14fps at 01:27 but 21.8–23.4fps at 01:36, with per-draw JS
cost halving (p90 34ms → 14ms). Something about the layout changed between the runs — canvas
width is the obvious candidate, since bar count scales with it — but it was not captured. The
*direction* is consistent (costlier draw → lower fps); the absolute numbers from the 01:27
run should not be compared against the 01:36 ones.

### 4. The waveform bar cache — built and A/B'd 2026-08-03 (late)

`drawOverview()` now rasterizes the static bars **once** per `(peaks, canvas size, gain)` into
two offscreen canvases — one in `COLOR_UPCOMING`, one in `COLOR_PLAYED` — and per frame blits
them with two source-rect `drawImage` calls either side of the playhead. The played/upcoming
split is a pixel-column boundary rather than a per-bar colour decision, so ~11.5k `fillRect`s
plus 11.5k `fillStyle` writes collapse to two blits. `deck.gain` is part of the key
(quantized to 1/100 — it is a MIDI continuous control, and keying on the raw float would
rebuild on every tick of a knob sweep).

**A/B'd properly**: same session, same file, same 2496×144 canvas, only the caching switched,
because the earlier before/after numbers came from runs whose canvas width was never recorded.
Six consecutive 5s windows per arm.

| | direct (per-peak) | cached | Δ |
|---|---|---|---|
| waveform `busy%` | 8–9% | **0%** | −8.5pt |
| per-draw JS (`dur` p90) | 13–15ms | **≤1ms** | **~14×** |
| rAF | 25.4–32.6fps (mean 29.6) | 30.4–30.8fps (mean **30.6**) | **+1.0fps** |
| gap p50 | 30–33ms | 32ms | — |
| gap p90 | 46–49ms | **34–35ms** | −13ms |
| gap max | up to 187ms | **46–47ms** | −140ms |

**The cost it targeted is gone; the frame rate barely moved.** That is the honest result, and
it is worth keeping for the tail alone — p90 gap −13ms, max −140ms, and fps variance collapsing
from a 7fps spread to 0.4fps. It also scales: this is 8–9% of main-thread wall time per playing
deck, so two decks were paying ~17%.

But it did not deliver the predicted jump to ~29fps, **because the control arm already reads
~29.6fps today.** The 21.8–23.4fps overview figure from the earlier session did not reproduce.
Treat the pre-fix absolute numbers in "Root cause" above as unreliable for the same reason
their own ⚠️ note gives — the canvas width was uncontrolled. The *relative* per-draw cost
(direct vs cached, above) is the part that is now measured under control.

Note also that the earlier "11.3ms wall / 2.8ms JS, 75% invisible" split does not survive
re-measurement at a recorded canvas size: the direct path's own JS is 13–15ms per draw here.
The paint-is-invisible mechanism is still real and still the reason `busy%` and fps disagree —
but that specific 75% figure was computed across the same uncontrolled runs, so do not quote it.

## Where to pick up

**A hard 30fps ceiling appears whenever a deck plays, and nothing in JS explains it.**

This is the finding the waveform fix uncovered. In *both* arms above:

- idle (deck loaded, paused): **62fps**, gap p50 16ms
- playing: **~30.5fps**, gap p50 **32ms** — exactly two 16.6ms vsync intervals
- total instrumented `busy%` across all three rAF loops while playing: **~2%**

So the main thread is ~98% idle and rAF is still being served at half rate, snapping to a
vsync multiple rather than degrading smoothly. Removing 8–9% of main-thread work moved it by
1fps, which is what a throttle looks like and not what a saturated thread looks like.

Candidates, cheapest first:

1. **IPC volume from the position poll.** It runs once per rAF frame per playing deck and is
   the one thing that starts when playback starts. `[ipc-ping]` is the control already built
   for this: fire it at the poll's rate with the poll *disabled* and see whether the
   half-rate lock follows the IPC traffic or the audio. If it follows IPC, throttle or batch
   the poll (it feeds a clock that is integrated anyway — it does not need 60Hz).
2. **The GStreamer pipeline's effect on the GTK main loop.** Synchronous commands dispatch
   there; a playing pipeline posts bus messages there too. Test by playing with the poll
   disabled entirely and reading `[raf]` alone.
3. **WebKit's own frame scheduling** under a busy main loop — the hardest to test and the
   last resort, since it would point back at `native-output-pipeline.md`.

Do 1 and 2 before theorizing further; both are one-flag experiments on the existing
instrumentation, and between them they separate "our IPC" from "audio is playing at all".

Then re-run the arm-2 (projector open) numbers, which were measured with the expensive
waveform in play and should improve for free.

Also still open:

- Arm 2's monotonic degradation (13.2 → 8.8fps over 45s), untouched by any of this.
- ~~Capture canvas dimensions in `[aux-loop]`~~ — done; the label is now
  `waveform[/zoom]/<deck>@<W>x<H>`, and it is what made the A/B above trustworthy.

Reproducer for any arm: launch, load one track, play ~30s with the output window **closed**,
then read the paired 5s windows out of `~/.local/share/com.cuemark.app/logs/cuemark.log`:

```
[raf]        n=… (~Nfps) | gap … | frame-dur … | busy …%
[aux-loop]   <label> n=… drew=… | dur … | busy …%    ← per-deck preview / waveform loops
[poll-stats] <deck>[/scratch] n=… | total … | toRust … | inRust … (lock …, query …) | toJs …
[ipc-ping]   noop …                    ← the control arm
[post-frame] n=… bitmaps=… | sync … | to-postMessage …   ← must be ABSENT in arm 1
```

Target to beat: gap p50 **32ms** at ~2% total `busy`. Idle is 16ms, so ~16ms is on the table
and **none** of it is being spent by our own code — see "Where to pick up".

### Should compositing move into GStreamer?

Raised during this session. `native-output-pipeline.md` is the shelved "plan C" and its
reopen list includes "webview rendering itself becomes the bottleneck" — which is now closer
to met, with measurements rather than impressions. Two versions, opposite economics:

- **GStreamer composites → encodes → webview decodes via WebCodecs → displays.** Allowed by
  the constraints (only `VideoEncoder` SIGABRTs WebKitGTK; the encode would be in GStreamer,
  and `VideoDecoder` is fine) — but it reintroduces exactly the cost measured here: a
  decoded `VideoFrame` per frame that still has to reach a canvas or texture in the webview,
  plus an encode/decode round trip of latency.
- **GStreamer composites and owns the projector window natively** (`glvideomixer` →
  `glshader` → fullscreen sink on display 2), control UI fed by ~10fps preview thumbnails.
  This removes per-frame webview work from the output path entirely. This is the doc's
  actual proposal and the one that would pay.

**Recommendation: still not yet, but the case got stronger.** Most of the bottleneck turned
out to be a fixable defect (`postFrame` building bitmaps for a window that was not open).
The A/B above now prices the remaining projector path: **+48ms/frame with one deck**, of
which +41ms is `createImageBitmap` + cross-process clone — i.e. exactly the per-frame webview
work the native pipeline would delete, and it scales with deck count. Two decks on a
projector cannot hold 60fps on this hardware by this route.

That is the reopen argument, but the arm-1 residual (~24ms with *no* projector at all) has to
be measured first: if it turns out to be the same class of cost, moving compositing out will
not deliver a 60fps control window either, and the right fix is upstream of both.

## Files touched

Instrumentation (kept — this is a permanently useful measurement, not a one-off):

- `src/lib/audio/pollStats.ts` (new) — percentile accumulation and the 5s flush for
  `[poll-stats]`, `[raf]`, `[post-frame]`, `[ipc-ping]`; `maybePingIpc()` control arm
- `src-tauri/src/audio/mod.rs` — `PositionSample` with entry/exit epoch stamps + lock/query
  timing; `with_pipeline_detached` takes an `op` label and times itself
- `src-tauri/src/lib.rs` — `epoch_ms()`, `ipc_ping`, log rotation 8MB/`KeepAll`
- `src/lib/audio/pipeline.ts` — `PositionSample` type, `ipcPing()`
- `src/App.svelte` — poll call site records legs; `frame()` records rAF gap/duration
- `src/lib/audio/pollStats.ts` — `recordAuxLoop()` + `busy%` for the two rAF loops
  `frame-dur` never covered
- `src/components/DeckCard.svelte`, `src/components/WaveformCanvas.svelte` — their rAF loops
  report into `[aux-loop]`

Fixes:

- `src/App.svelte` — one transport retry chain per deck (`transportChains`,
  `cancelAudioTransport`); `[frame-error]` logs message + stack
- `src/lib/renderer/outputBus.ts` — listener gate, `recordPostFrame` timing
- `src/lib/renderer/outputProtocol.ts` — `OutputAliveMessage`, interval/timeout constants
- `src/output.ts` — sends the `alive` beacon
- `src/components/WaveformCanvas.svelte` — `rasterizeOverview()` + the two-blit `drawOverview()`;
  canvas dimensions in the `[aux-loop]` bucket label
