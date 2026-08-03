# Control-window frame budget: why the position poll is slow

Status: **root-caused, one large fix landed, one residual unexplained.** Started
2026-08-03 from a report of `audio_get_position` round trips of 300–424ms.

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

## The residual — this is what is still open

With `postFrame` disabled, playback **still costs ~23ms/frame**: 25fps while playing versus
62fps idle, with `frame-dur` at ~1ms. So a second consumer, smaller but real, sits outside
the synchronous render loop. Candidates, none yet measured:

- software H.264 decode on the WebCodecs path (`VideoDecoder` output callbacks)
- the DeckCard preview canvases (`drawImage` per deck per frame)
- `WaveformCanvas` — the user separately reported "difficulty updating position on the
  waveform view", which would fit this same budget

## Where to pick up

The app has been restarted on a build where the listener gate actually works. **The A/B has
not been run against a working gate yet.** Do this first:

1. Launch (`skills/run-app`, or `src-tauri/target/debug/cuemark` directly — the Vite dev
   server on :1420 serves the frontend).
2. **Arm 1 — output window closed.** Load a track, play ~20s, jog a few seconds.
3. **Arm 2 — output window open.** Same again.
4. Read `~/.local/share/com.cuemark.app/logs/cuemark.log`:
   - `[raf] n=… (~Nfps) | gap … | frame-dur …`
   - `[poll-stats] <deck>[/scratch] n=… | total … | toRust … | inRust … (lock …, query …) | toJs …`
   - `[ipc-ping] noop …` — the control arm
   - `[post-frame] n=… bitmaps=… | sync … | to-postMessage …` — only in arm 2 now

Expected: arm 1 ≈ 25fps and poll p50 ≈ 20ms (matching the accidental run); arm 2 reveals
what the projector actually costs per frame, split into the part inside the rAF tick
(`sync`) and the part in the microtask afterwards (`to-postMessage` — `createImageBitmap`
resolving plus the cross-process clone, which `frame-dur` cannot see).

Then chase the residual ~23ms with the same method: instrument one suspect at a time and
keep a control arm.

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

**Recommendation: not yet.** Most of the bottleneck turned out to be a fixable defect
(`postFrame` building bitmaps for a window that was not open). Measure the residual first.
If the loop still cannot hold 60fps with two decks after that, the doc deserves a real
reopen — and the numbers in this file are the argument for it.

## Files touched

Instrumentation (kept — this is a permanently useful measurement, not a one-off):

- `src/lib/audio/pollStats.ts` (new) — percentile accumulation and the 5s flush for
  `[poll-stats]`, `[raf]`, `[post-frame]`, `[ipc-ping]`; `maybePingIpc()` control arm
- `src-tauri/src/audio/mod.rs` — `PositionSample` with entry/exit epoch stamps + lock/query
  timing; `with_pipeline_detached` takes an `op` label and times itself
- `src-tauri/src/lib.rs` — `epoch_ms()`, `ipc_ping`, log rotation 8MB/`KeepAll`
- `src/lib/audio/pipeline.ts` — `PositionSample` type, `ipcPing()`
- `src/App.svelte` — poll call site records legs; `frame()` records rAF gap/duration

Fixes:

- `src/App.svelte` — one transport retry chain per deck (`transportChains`,
  `cancelAudioTransport`); `[frame-error]` logs message + stack
- `src/lib/renderer/outputBus.ts` — listener gate, `recordPostFrame` timing
- `src/lib/renderer/outputProtocol.ts` — `OutputAliveMessage`, interval/timeout constants
- `src/output.ts` — sends the `alive` beacon
