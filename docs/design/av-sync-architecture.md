# Audio/video sync architecture — detailed gotchas and rationale

Status: **reference doc, not a build plan.** Extracted from `CLAUDE.md` 2026-07-26 to keep the
always-loaded project instructions lean — this file holds the detailed "why is the code shaped
this way" rationale for the audio pipeline and rendering pipeline; `CLAUDE.md` keeps only the
topology diagrams and short summaries, with a pointer here. Read this before touching video
playback, seeking, rate changes, the render loop, `WaveformCanvas`, grid persistence, or the
MIDI-to-audio path — several of these are subtle, previously-fixed races that are easy to
reintroduce if the code is refactored without this context.

## Audio pipeline

**Audio is the master clock.** The `<video>` element is muted and used only for frame decode. In the RAF loop,
`audioGetPosition(deckId)` polls the GStreamer position (one in-flight IPC per deck via `pendingPos` map).
**`query_position` always returns wall-clock stream time** — the soundtouch `tempo` property never issues a
rate-seek, so the GStreamer segment rate stays 1.0 regardless of `deck.playbackRate`. To recover actual content
position, `App.svelte` integrates per-frame deltas at `deck.playbackRate` via the `contentPosTracker` Map:
`contentPos += Δaudio × playbackRate`. A seek is detected by comparing `Δaudio` against the wall-clock time that
actually elapsed since the last poll (`nowMs - prev.tsMs`) — since `audioPos` is literally wall-clock, a normal
poll always has `Δaudio ≈ elapsed wall time`, however long the IPC round-trip took; only a real seek makes them
diverge by more than ~500 ms. **Fixed 2026-07-26**: this used to compare `Δaudio`'s raw magnitude against a fixed
500 ms constant, which false-positived as a "seek" whenever an IPC round-trip ran long (Mutex contention can push
it past 500 ms) — misdetection snapped `contentPos` to the raw unscaled `audioPos`, permanently drifting the
displayed position ahead of true content position for the rest of playback at any non-1.0 rate. **`resolvedRate`
is read at IPC resolution time** (not at IPC start time) — if the rate changed while the call was in flight (e.g.
2× → 1×), using the start rate would overshoot `contentPos` by `IPC-latency × rate-diff`. The computed `contentPos`
is written to `setDeckAudioTime(deckId, contentPos)` in `seekBus.ts` where the waveform reads it, and snapped to
`v.currentTime` if drift exceeds 80 ms.

**Seeks must be converted from content time to `query_position`'s domain before being issued — they are NOT the
same domain at any rate != 1.0.** `pitch` (soundtouch) scales every seek position it forwards upstream to the
decoder by the `tempo` ratio, but `query_position`/`query_duration` (and therefore `audioPos` above) stay in that
same tempo-scaled "output" domain (`query_duration` on a 288.5s file at tempo 0.852 reports 338.6s = 288.5/0.852).
Content time = `audioPos × rate`; conversely a seek to content time `C` must be issued at `C / rate`, or the
audio lands at `C × rate` instead — confirmed empirically with a GStreamer `identity` probe upstream of `pitch`
(**fixed 2026-07-27**, `docs/design/rate-position-drift.md` "Bug #0"). Once a real seek IS detected in the RAF
loop above, `contentPos = audioPos * currentRate` — NOT `audioPos` directly, which was the bug (self-consistent
with the also-broken seek value, so the display looked "right" while the actual audio was off by the same ratio).
`DeckAudioPipeline::seek()` (`pipeline.rs`) does this conversion once, at the single Rust choke point every
content-time seek call site (`seekBus.ts`, MIDI cue jumps, loop wrap-around) goes through — plus two related
instances of the same domain mix-up in the scratch code path (`scratch()`'s PCM-buffer start position,
`stop_scratch_feeder()`'s post-gesture resync seek), fixed the same way. See the design doc for the full
before/after measurements.

**`pendingSeekTarget` filter in `seekBus.ts`** — on a heavy video, GStreamer can take >1 s to process a seek
while still returning the pre-seek position from `query_position`. `seekDeck()` records the seek target in
`pendingSeekTarget`; the RAF callback drops any IPC result whose computed `contentPos` is > 0.5 s from that
target. Once GStreamer's position converges on the seek target, the filter clears itself. `seekDeck()` also
calls `audioTimes.delete(deckId)` rather than `.set(deckId, time)` — `getDeckTime()` then falls back to
`v.currentTime` (set synchronously by `el.currentTime = time`), so the waveform shows the seek target
immediately without waiting for GStreamer.

**`v.playbackRate` must only be set when changed** — WebKitGTK rebuilds its internal GStreamer pipeline on
each `v.playbackRate` write. At MIDI tempo rates (60/sec after rAF throttle) this causes CPU spikes that starve
the audio thread → PipeWire xruns → cascade failure. `syncVideoElements` tracks `lastPlaybackRate` per deck and
skips the write if the value is unchanged. The rebuild also loses `v.muted`; fix: also set `v.volume = 0` (a JS
property, not pipeline state — survives rebuilds). Both are applied unconditionally every pass and re-applied after
each `v.playbackRate` write.

**Rate-then-seek ordering**: when both `deck.playbackRate` and seek position change together, always apply the
rate change first, wait ~200 ms for the WebKit pipeline rebuild to settle, then seek. If the seek fires while
a rebuild is in progress, the new WebKit pipeline re-reads GStreamer's current position mid-seek (still the
pre-seek value) and overwrites `v.currentTime` with it, silently undoing the seek. The `pendingSeekTarget`
filter in the RAF loop catches this race for programmatic seeks, but the correct fix is ordering.

**Device routing**: default output uses `autoaudiosink` (selects PipeWire/PulseAudio/ALSA automatically).
A specific sink is targeted via `pipewiresink target-object=<node-name>`; falls back to `autoaudiosink` if
the `gstreamer1.0-pipewire` plugin is absent.

**EOS handling**: Each `DeckAudioPipeline` spawns a background thread that watches the GStreamer bus.
When an `EOS` message arrives the thread sets an `Arc<AtomicBool>` (`at_eos`) and **pauses the pipeline
itself** (`set_state(Paused)`, called directly from this bus thread — safe, since it's a dedicated
`bus.iter_timed()` consumer thread, not a GStreamer streaming thread or the GLib main loop). This matters
because GStreamer does not stop a pipeline's clock on EOS by itself — left in `PLAYING`, `query_position`
keeps climbing at wall-clock rate forever with nothing left to render. The thread also notifies the
frontend (`deck-eos` Tauri event) so it can update `Session` state, but playback correctness no longer
depends on that round-trip arriving. The next call to `play()` checks the `at_eos` flag and seeks back to
zero before resuming, so the track replays cleanly instead of stalling at end-of-stream. The bus thread is
stopped via `bus.set_flushing(true)` before pipeline teardown and in `Drop`.

**Rate changes**: `set_rate()` sets the `tempo` property on the `pitch` element (soundtouch, `gst-plugins-bad`).
This adjusts playback speed without changing pitch, with no seek or pipeline flush — the change is applied
to the ongoing audio stream in-place. The `tempo` property accepts 0.1–4.0 (1.0 = normal speed).

**PipeWire quantum**: `capsfilter(rate=48000)` ensures pipewiresink always negotiates at 48000 Hz.
`output_queue(100ms)` after `pitch` absorbs soundtouch's variable output chunks. **Keep `output_queue`
at 100ms or below** — 500ms was tried originally but caused audible tempo-change lag (old-rate audio
must drain before the new tempo is heard).

**Preroll**: `load()` waits synchronously (up to 5 s) for the pipeline to reach `PAUSED` before returning,
so callers can seek and play immediately without an extra wait.

**`uridecodebin` must skip video decoder factories** via the `autoplug-select` signal — checks factory
klass (`klass.contains("Decoder") && klass.contains("Video")`) and returns SKIP(2). Without this,
`decodebin3` instantiates VA-API hardware video decoders for audio+video containers, which can corrupt
VA-API driver state for the entire session. See `audio-debugging` skill for the full code and pitfalls
(why caps-based check fails; why `autoplug-continue` is wrong; return type gotcha).

**Multiple sinks and `async=false`**: In a `tee` topology, only **one** sink per pipeline should have
`async=true`. All additional sinks must be set to `async=false` before linking — they would otherwise
deadlock each other during preroll. See `audio-debugging` skill for details.

## Rendering pipeline

**Waveform analysis uses `audio_analyze_file` Tauri command** (Rust/GStreamer, `analysis.rs`), not
`decodeAudioData` — avoids VA-API corruption in the separate WebKitWebProcess. It returns
`{ peaks, envelope }`: 30/s display peaks plus a 210/s RMS envelope used by `detectBeatGrid()`
(`bpm.ts`) to fit a **fractional** BPM and beat-level grid anchor (`ENVELOPE_RATE = 210` is
declared in both `analysis.rs` and `waveform.ts` and must stay in sync). On track load the fit
auto-populates `deck.bpm` and `deck.downbeat`; the integer `detectBpm()` remains as fallback.
`gridOffset`/`downbeat` marks *a* beat, not bar-beat-1 — all consumers (`getPhase`, phase nudge)
work mod one beat. Algorithm details and tuning notes: `bpm.ts` comments + todo.md handoff spec;
acceptance tests in `src/lib/audio/bpm.test.ts` (`npm test`).

**Grid persistence and the trust-flag gotcha**: a saved `bpm`/`downbeat` pair (set via the
DeckCard SET BEAT button) beats the auto-fit on load — persisted locally (`grid_store.rs` →
`grids.json` in `app_data_dir()`, keyed by absolute file path) and, if the deck has a
`diggerTrackId`, also pushed to Digger (`tracks.bpm` column + a `downbeat` marker). Precedence
is tracked per-deck by `src/lib/audio/gridSource.ts`'s `(deckId → trusted filePath)` map:
`hasSavedGrid`/`markGridSaved`/`clearSavedGrid`. **This map must be explicitly cleared whenever
a deck loads a path that doesn't match its trusted one** — `App.svelte`'s new-source handler
calls `clearSavedGrid(deck.id)` on any path mismatch before conditionally re-fetching. Omitting
this (the original implementation did) causes a stale-trust bug: load track A (saved grid) →
load track B (no saved grid, auto-fit runs) → reload A — the deck gets stuck showing B's
leftover values forever, because the old `deck→A` trust entry survives B's load untouched and
incorrectly reports "already trusted" when A comes back, skipping the re-fetch that would
restore A's real grid. Found via live headless testing (`verify-ui` skill), not by
code review or unit tests — the bug only manifests across a *sequence* of loads on one deck
slot. Fixed in `060de16`; see `journal.md` 2026-07-06 entry for the full repro.

**Snap-to-beat**: `Session.snapToBeat` (toggled by the SNAP toolbar button) routes every seek
target — waveform clicks, hot-cue jump/set, loop in/out/bar-buttons — through
`quantizeToGrid(deckId, t)` in `seekBus.ts`, which snaps to the nearest `downbeat + k·(60/bpm)`
for any integer k (including negative, before the anchor). A no-op when `snapToBeat` is false
or the deck has no `bpm`/`downbeat` yet.

**WebGL Y-flip**: HTML canvas Y=0 is top; WebGL texture Y=0 is bottom. `UNPACK_FLIP_Y_WEBGL=true`
corrects this on upload so video appears right-side up.
The crossfader is a UI/MIDI convenience that drives two selected decks' opacities inversely — not a
structural field in the data model.

**Canvas buffer sizing**: Any `<canvas>` displayed in the UI must have its pixel buffer sized to
its rendered CSS width × `devicePixelRatio` — never hardcode a small resolution and rely on CSS
to scale it up; that causes blurry upscaling. Use a `ResizeObserver` to keep buffer dimensions in
sync with layout. Use `imageSmoothingQuality = 'high'` on 2D contexts.
**Gotcha**: assigning `canvas.width` or `canvas.height` resets all 2D context state, including
`imageSmoothingQuality` — re-apply it after every resize.

**Canvas sizing rule — always use JS, never rely on scoped CSS width**: WebKitGTK does not reliably
apply `width: 100%` from scoped Svelte CSS (or from global `app.css`) to a `<canvas>` inside a flex
child component. The canvas falls back to its 300 px intrinsic default, making waveforms appear
smooshed to the left and preview thumbnails blurry. The fix applied throughout this codebase:

1. **Set `c.style.width` and `c.style.height` in the `resize()` function** — inline styles always
   win over CSS classes, bypassing any scoping ambiguity.
2. **Never put `width: X` in CSS for canvas elements** — leave canvas width to JS only.
3. **For WaveformCanvas**: observe the *wrapper div*, not the canvas — a canvas's default CSS width
   is 300 px, so observing the canvas directly returns `width=300` before flex layout resolves.
   Also include `deck.source.filePath` as a reactive dependency in the resize `$effect` so the
   effect re-runs on track load (the initial call may have run with `width=0` before layout).
4. **For DeckCard preview**: observe the canvas itself via `entry.contentRect` (not a sync
   `getBoundingClientRect()` call) so aspect-ratio resolves before we measure. Set inline styles
   from the `contentRect` values.

**MIDI-driven `syncVideoElements` must be rAF-throttled**: MIDI CC events arrive as separate
Tauri IPC macro-tasks, so `queueMicrotask` does not coalesce them. The 14-bit tempo fader can
fire 200+ events/second. Calling `v.play()` or setting `v.playbackRate` that frequently overloads
GStreamer's pipeline and causes playback to stall. Solution: use `requestAnimationFrame` as the
throttle gate so `syncVideoElements` runs at most once per rendered frame (≤ 60/s).

**14-bit fader LSB produces a slightly different rate than MSB alone — use a tolerance guard, not
strict equality.** A 14-bit controller fires CC N (MSB) then CC N+32 (LSB) for each fader
position. The Rust MIDI handler emits a `DeckPlaybackRate` action for *both* — correct behavior,
since either byte changing should update the rate. But the MSB-only value (e.g. `0.8984375`) and
the combined MSB+LSB value (e.g. `0.8950195`) differ by ~0.002–0.004. A strict `!==` guard lets
both fire through: two `v.playbackRate` writes → two WebKit pipeline rebuilds per position, and
two `audio_set_rate` IPC calls → two soundtouch `tempo` property sets per position. On a loaded
CPU this reliably triggers a PipeWire xrun cascade (observed: 5,788 xruns → audio silence within
~4 minutes). Fix: use `Math.abs(rate - last) < 0.005` in both the `lastPlaybackRate` check in
`syncVideoElements` (`App.svelte`) and the `rateMap` check in `syncRate` (`audioSync.ts`). A 0.5%
tolerance is imperceptible for video sync and completely absorbs the MSB/LSB oscillation while
still responding immediately to any intentional fader movement.

**Every per-frame RAF loop must gate its expensive work on an actual-change check**, not just
playback intent. Track the last-seen value that determines a different output (`video.currentTime`
for frame uploads/canvas draws; a signature of id/source/opacity/visualization-opacity for the
composite+`postFrame()` call) and skip the work when it's unchanged from the previous tick.
`scripts/perf-idle-test.sh` is an automated regression test for this — re-run it after touching
the render loop (`App.svelte` `frame()`), `WaveformCanvas`, or the `DeckCard` preview.
`scripts/latency-test.sh` covers the full deck workflow (load → waveform → playback → IPC latency
→ MIDI-rate burst) and is the right script to run after touching the MIDI handler, `audioSync.ts`,
or the GStreamer audio pipeline.

**Audio IPC for rate/gain/volume must NOT live in `syncVideoElements`** — that function is
rAF-gated (runs at most once per animation frame, up to 16ms delay). `v.playbackRate` stays
there (WebKitGTK rebuilds its GStreamer pipeline on each write — must be rAF-throttled).

**The `session` store is coarse-grained — bypass it for the audio path entirely.**
`session` is a Svelte `writable<Session>`. Any call to `updateDeck()` (including every MIDI
tempo/gain/volume event at 200+/sec) creates new Session + Deck objects and notifies ALL
subscribers: every `$effect`, `compositor.syncDecks()`, and component re-renders. Fix:
`src/lib/audio/audioSync.ts` — idempotent `syncRate`/`syncGain`/`syncVolume` functions with
shared Maps. The MIDI handler calls them directly (before any store update); the `App.svelte`
`$effect` calls the same functions for UI-slider-triggered changes. For continuous controls
(rate, gain, volume, crossfader), `queueDeckPatch()`/`queueCrossfader()` buffer the latest
value and flush to the store once per rAF — capping Svelte re-renders at 60fps instead of 200/sec.

**`$effect` reading `$session.decks` fires at MIDI event rates**: for high-frequency continuous
controls (rate/gain/volume), a last-value Map guard alone is not enough — those must go through
`audioSync.ts` directly from the MIDI handler, not via the store at all. `audioSetCue` still
uses the guard-only pattern (fires infrequently, on button press).

**Every last-seen-value guard Map keyed by deck ID must be cleared on deck teardown, not just
on the value it guards.** Found live 2026-08-02: `App.svelte`'s `_prevCueStates` (gating the
`audioSetCue` guard above) was never cleared in `teardownVideoBackendFull` or the deck-removal
cleanup loop. `audio_unload` drops the Rust-side `DeckAudioPipeline` entirely, so a reloaded
deck gets a brand-new pipeline with `cue_enabled` defaulting to `false` — but if `deck.cueEnabled`
in the *store* was already `true` before the reload, `_prevCueStates` still says `true` too, the
guard sees no change, and `audioSetCue` never re-fires to open the fresh pipeline's cue valve.
Symptom: headphone cue goes silently dead after any deck reload, recoverable only by manually
toggling cue off and back on. The general rule: any Map whose key is a deck ID and whose purpose
is "only send this again if it changed" is implicitly asserting the receiving side's state is
still what the Map remembers — that assertion breaks the moment the receiving side gets rebuilt
from scratch (reload, backend teardown, deck removal + ID reuse), so every such Map needs a
`.delete(deckId)` alongside the other per-deck Maps (`stallWatch`, `backendState`,
`contentPosTracker`, etc.) in whichever teardown path rebuilds that deck's backend.
