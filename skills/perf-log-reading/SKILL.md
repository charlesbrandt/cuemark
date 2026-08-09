---
name: perf-log-reading
description: How to read cuemark's standing performance instrumentation log lines ([poll-stats], [raf], [aux-loop], [deliver-tel], [scrub-deliver]/[scrub-sec]) — field meanings, known-silence-by-design cases, and attribution pitfalls. Load this when investigating a performance regression or reading a perf log dump, not on every session.
---

# Standing performance instrumentation

`src/lib/audio/pollStats.ts` emits one percentile line per bucket every 5s while a deck plays.
Threshold-only logging was deliberately abandoned here: `if (ms > 300)` shows the tail and hides
the distribution, which is what made a slow baseline look like an outlier problem.

```
[poll-stats] deck-0[/scratch] n=… | total … | toRust … | inRust … (lock …, query …) | toJs …
[raf]        n=… (~Nfps) | gap … | frame-dur … | busy …%
[aux-loop]   preview/deck-0 | waveform[/zoom]/deck-0@<W>x<H>   n=… drew=… | dur … | busy …%
[post-frame] n=… bitmaps=… | sync … | to-postMessage …
[ipc-ping]   noop n=… | total … | toRust … | toJs …
```

The Rust side adds one, from `spawn_delivery_reporter()` in `pipeline.rs` — **sampled every 1s,
emitted every 5s, only while a deck is playing**. It is the only instrument that reports what
reaches each *sink* during ordinary playback (`[scratch-tel]` reports the same counters, but
only for the duration of a gesture):

```
[deliver-tel] deck-0  vol0=…/s(min …) margin …(min …) | sink0=… | cuevol=… | cuesink=…
```

- ⚠️ **`min` is the field to read, not the mean.** The faults these counters exist for are
  second-scale stalls that a 5s mean averages into nothing; `min 0/s` means a whole second
  delivered nothing. The mean alone has never distinguished a healthy branch from a stalling one.
- ⚠️ **A `cue*` row reads `0/s` whenever headphone cue is closed — that is `cue_valve` working**,
  not a fault. Check the surrounding `cue ON`/`cue OFF` lines before reading a cue zero as
  evidence, exactly like `arrived%`/`snaps` in `[scratch-tel]` being silence by design.
- ⚠️ **The branches' rates are not comparable to each other** (measured 15/s main against 9/s
  cue on the same deck — different channel counts and buffer sizing). Compare a branch against
  *itself* over time.
- `margin` is buffer running time minus element running time — the sink's slack. Steadily
  negative means buffers arrive already late, which is a fault that never trips the gap warning.
- The first two ticks after a resume are baselined rather than measured, because `pulsesink`
  reopening the device lands in the second one and forged a `min 0/s` on every play press.

`src/lib/audio/scrubStats.ts` adds two more, emitted **once per scrub/scratch gesture** (not on
an interval) — buffered in memory for the whole gesture and flushed at the end, because
`debugLog` is itself an `invoke()` on the bridge under measurement:

```
[scrub-deliver/deck-0] pointer audible 18.7s | inputs n=… (…/s) gap … | evQueue … (floor …ms, n=…) | sent=… (…/s) skipped=… err=… coalesced …
[scrub-deliver/deck-0] rafWait … | dispatchLag … | ipc …
[scrub-deliver/deck-0] worst: gap …ms @…s (evQueue …ms on the arriving event) | rafWait …ms @…s | ipc …ms @…s
[scrub-sec/deck-0]     t=… in=… sent=… | gapMax=… qMax=… rafMax=… lagMax=… ipcMax=…
```

- `sent/s` is the same quantity as `targets N/s` in the Rust-side `[scratch-tel]`, counted at the
  other end of the bridge — a disagreement between them localizes a stall to the transport.
  `[scrub-sec]` shares `[scratch-tel]`'s one-line-per-second cadence so the two join directly.
- The leg a stall lands in decides the fix, and they are different fixes: `gap`+`evQueue` large =
  events queued behind a blocked main thread; `gap` large with `evQueue` ≈ 0 = no events were
  produced at all; `rafWait` large = the scrub bus's own rAF coalescing (cross-check `[raf] gap`);
  `ipc` large = backpressure (cross-check `[ipc-ping]`). Full table in the module doc comment.
- ⚠️ `evQueue` is **calibrated, not absolute**. `event.timeStamp` is platform-derived here
  (verified — `pointer_events_probe.py`'s `stale` arm) but sits on an origin offset from
  `performance.now()` by a constant that differs per page load, so only variation above the
  session's running minimum is meaningful. A first gesture with a single-digit `n=` in the floor
  field has not calibrated yet; discard it.
- ⚠️ MIDI ticks carry no platform stamp, so a vinyl-jog gesture reports `evQueue —`. A gap there
  is an upper bound on delivery latency, not an attribution.

How to read them (full derivation in `docs/design/control-window-frame-budget.md`):

- A synchronous `#[tauri::command]` runs on the GTK main thread, so an IPC round trip splits into
  `toRust` (dispatch) / `inRust` (the actual work) / `toJs` (the reply reaching the JS callback).
  Only `inRust` is the backend. Epoch ms is the **only** clock the Rust process and the webview
  share — `performance.now()` and `Instant` have per-process origins and cannot be differenced.
- **`[ipc-ping]` is the control arm.** If a command that does nothing is as slow as the one you
  are blaming, the callee is exonerated — no leg arithmetic required. During a scratch you get a
  second free control: `position()` returns the feeder's atomic cursor and never touches GStreamer.
- **A position poll can never resolve faster than one main-loop turn** — but a main-loop turn
  is **not** an rAF turn. When the thread is saturated the two track each other and `toJs` is a
  fair proxy for the frame period; when rAF is throttled while the thread is idle they diverge
  hard (13ms poll against a 41ms gap, 2026-08-03). **Check `busy%` before reading `toJs` as the
  frame budget.**
- **`frame-dur` covers only `App.svelte`'s `frame()`.** Two more rAF loops run per playing deck
  — `DeckCard`'s preview `draw()` and `WaveformCanvas`'s playhead `loop()` — in the same rAF
  turn. They report into `[aux-loop]`. `busy%` (share of wall-clock time) is the field that
  settles attribution: sum it across every loop and subtract from 100 to see what is
  *unaccounted*, which is how the residual was shown to be outside JS entirely.
- ⚠️ **Only compare windows with a deck playing.** Idle windows contain no polls at all, so an
  idle `62fps / frame-dur=0` line is not a control for a playing one. Reading them as comparable
  produced a wrong conclusion on the first pass.
- ⚠️ **`busy%` measures the JS that *records* canvas drawing, not the paint that follows it.**
  WebKit's canvas 2D builds a display list and rasterizes it after the JS call returns, in a
  phase no JS timer can observe. Symptoms of being in this regime: `busy%` low while
  `WebKitWebProcess` CPU is high, and fps that does not respond to removing JS work. **Never
  conclude "this canvas is cheap" from `busy%` alone — confirm with fps.** Fewer, cheaper draw
  *calls* is the lever; the number of primitives per draw matters more than how often you draw.
- ⚠️ **The converse bites just as hard: a change can take `busy%` to zero and move ~1fps.**
  Caching `WaveformCanvas`'s overview bars cut per-draw JS 13–15ms → ≤1ms and `busy%` 8–9% → 0%
  for **+1.0fps**, because the real limit was a half-vsync rAF throttle behind it
  (`docs/design/control-window-frame-budget.md` §4). Worth keeping for the tail — gap p90
  −13ms, max −140ms — but **report both numbers**; either one alone tells a false story.
- ⚠️ **Bar count scales with canvas width, so record the width.** Two runs of the same file in
  the same mode disagreed by 2× until the `[aux-loop]` label carried `@<W>x<H>`. Never A/B a
  canvas cost across runs whose dimensions were not captured — and prefer A/Bing in one
  session with only the code path switched.
- ⚠️ **A DOM text mutation is expensive here; a canvas redraw is not.** Measured 2026-08-04:
  rewriting one small `<span>` in a deck card costs **~20ms of `WebKitWebProcess` CPU per
  mutation**, while `WaveformCanvas` redrawing a 2496×144 surface ~6×/s costs nothing
  measurable. Publishing a per-frame readout at 60Hz held a playing deck at ~21fps; gating
  both writes to the resolution they actually render at restored a flat ~61fps
  (`docs/design/control-window-frame-budget.md` §6–§7). **Never write a `$state` that feeds
  text on every rAF tick — gate it on the rendered string changing.** Throttling helps far
  less than it should: the cost saturates between 1Hz and 5Hz, and `contain` / `will-change`
  do not help at all (both measured; `will-change` was worse).
- ⚠️ **`ps %cpu` is a lifetime average, not current load.** On a 2-hour-old process it read 7%
  while the process was actually at 64%. Use `top -b -n 2 -d 3 -p <pid>` and take the *second*
  sample. **Pair it with `busy%` always** — `busy%` low + CPU high is the signature of cost in
  the paint phase, and it is the only way to see work `busy%` structurally cannot report.
- ⚠️ **An IPC leg is a load gauge, not a cost.** `toJs` on the *no-op* ping reads 0ms on an
  idle thread and 8ms on a busy one, and the position poll's `total` moves 2–3ms → 9ms across
  the same switch, with nothing about the transport changed. A slow leg says "the main thread
  is late getting back to callbacks", never "the callee is slow" — only an arm that changes
  the callee can say that.
- ⚠️ **Validate that an arm is really playing before believing its numbers.** A wedged
  GStreamer pipeline produces a flawless-looking 62fps window: `deck.playing` is true, rAF is
  full rate, and nothing errors. The tells are `[poll-stats] total` p50 ≈2ms instead of ≈9ms,
  `[aux-loop] … drew=0`, and a `play` IPC retry storm every ~203ms in the log. Re-loading the
  track (fresh `audio_load`) unwedges it; a bare play does not.

