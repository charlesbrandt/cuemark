# 2026.05.01 — MIDI calibration round 2 + waveform layout fix

## What shipped

**Waveform canvas layout** — waveforms were rendering in a ~300px strip on the left instead of
filling the waveform area, and the OVR toggle appeared misaligned (at the right edge of the window
near the master volume). Root cause: `width: 100%` for `.waveform-canvas` was in global `app.css`,
but in practice Svelte + WebKit does not reliably apply global `width: 100%` to a `<canvas>` in a
flex child component — the canvas fell back to its 300px intrinsic CSS default. Fix: moved the
canvas layout styles (`width: 100%; height: 72px; display: block; cursor: crosshair`) into
`WaveformCanvas.svelte`'s own scoped `<style>` block and removed them from `app.css`. Rule: scope
canvas layout styles to the component that owns the canvas.

**Tempo fader direction** — the Starlight sends *higher* 14-bit values for negative pitch (pushing
down = faster). `rate_from_14bit` was negating in the wrong direction; swapped to
`delta = (8192 − combined) / 8192` so lower combined value → rate > 1.0 (faster). Tempo slider
now moves in the expected direction. Center calibration still needs live verification (assumed
CC 8 = 64 / 14-bit = 8192 → 1.0×).

**Playback stuck during tempo adjustments** — the 14-bit tempo fader fires MSB+LSB events (up to
200+/sec). Each arrived as a separate Tauri IPC macro-task, bypassing `queueMicrotask` coalescing.
At that rate, GStreamer's pipeline was being hammered with `playbackRate` changes and stalling.
Two fixes:
1. Switched `queueMicrotask` → `requestAnimationFrame` in the `$effect` gate so `syncVideoElements`
   runs at most once per rendered frame (≤ 60/s).
2. Added `playPromises: Map<deckId, Promise<void>>` — only one `v.play()` per deck can be in-flight
   at a time; overlapping `play()` calls were aborting each other with AbortError, leaving the
   video stuck. Now a pending play() is simply not re-called until it settles.

**Pre-existing TS error fixed** — `handler.ts` jog_nudge case used `a.deck_id` inside a
`setTimeout` closure; TypeScript couldn't narrow the type there. Captured as `const deckId = a.deck_id`
before the closure.

## Still to verify live

- Tempo fader center at physical detent = 1.0× rate
- Tempo fader full throw values (confirm ±50% range)
- Loop/Sync button note swap (3=Loop, 5=Sync) — needs raw MIDI dump to confirm
- Jog wheel rate-only nudge behavior (user noticed "shuttle along with rate"; may just be the
  speed change being perceptible; no code change yet)

---

# 2026.04.29 00:00

Moving the following complete items out of todo.md

## Phase 1 — Two decks, crossfader, MIDI

### video playback [done]
- File picker via `tauri-plugin-dialog` → `open()` → sets `deck.source`
- Hidden `<video>` per deck, managed in `App.svelte` via `$effect`
- RAF loop: `fbo.uploadVideoFrame(videoEl)` → `compositor.composite()`
- `deck.playing`, `deck.loop`, `deck.playbackRate`, `deck.volume` wired to video element
- `loadedmetadata` event updates `deck.source.duration`
- Dev: files served via Vite HTTP middleware at `/media/<abs-path>` (GStreamer speaks plain HTTP)
- Prod: Rust `media://` custom URI scheme handler with Range support

### OS drag-and-drop [done]
- Tauri intercepts native file-drop before HTML5 DataTransfer is populated
- `getCurrentWebview().onDragDropEvent()` → path + screen position → `elementFromPoint` + `[data-deck-id]`
- Visual drag-over state on DeckCard (`isDragOver`, `drag-over` CSS class)

### cue-jump seek [done]
- On `cue_jump` MIDI action: `seekDeck(id, cuePoint)` via `seekBus.ts` + stop playing
- On ⏮ button: same — seeks to `deck.cuePoint` (not 0)
- "Cue" button in DeckCard: captures `video.currentTime` → sets `deck.cuePoint`
- `seekBus.ts` holds module-level video element refs; App.svelte registers on create/destroy

### output window [done]
- "Output Window" button in toolbar calls `open_output_window` Tauri command
- Rust creates a 1280×720 resizable `WebviewWindow("output", "output.html")` (idempotent)
- Move to projector display and press `F` to fullscreen; `Esc` to exit
- Main window: `compositor.composite()` → `postFrame(canvas)` via `BroadcastChannel('cuemark-output')`
- Output window (`output.html` / `src/output.ts`): receives `ImageBitmap` frames, blits to full-viewport canvas
- `preserveDrawingBuffer: true` on compositor's WebGL context ensures frame is readable by `createImageBitmap`

### MIDI calibration [done]
- Connect Hercules DJ Control Starlight
- Run `aseqdump` to find actual CC/note numbers
- Update `hercules_starlight_map()` in `src-tauri/src/midi.rs`
- Test: crossfader, jog wheels, play/pause, volume faders

### unmapped MIDI controls — to decide
- Shift button `(0x90, 3)` — hardware handles in firmware (remaps pad notes +8); no standalone action needed
- Vinyl / Scratch button `(0x91/0x92, 3)` — could toggle jog scratch vs. pitch-bend mode or beat sync
- Headphone Cue buttons `(0x91/0x92, 12)` — flag a deck for pre-listen / solo monitor (see Batch C)
- Bass/Filter toggle `(0x90, 1)` — could switch bass knob between EQ mode and shader `u_bass_gain`
- Hot-cue mode / Loop mode buttons `(0x91, 15/16)` — context switches for the 4-pad row
- Headphone volume `(0xB0, 4)` — defer to Batch C monitor mix

### audio crossfade [done]
- `AudioAnalyzer` connects each deck's `<video>` element via `connectMediaElement()`
- Per-deck `GainNode` drives `deck.volume`; master `GainNode` drives `session.masterVolume`
- `AudioContext` resumed on first play to satisfy autoplay policy

---

## Batch A — UI polish (next up)

### video preview in deck card [done]
- `getVideoEl(deckId)` exported from `seekBus.ts`; DeckCard binds a `<canvas class="deck-preview">`
- Per-deck RAF loop in `$effect` calls `drawImage(videoEl, ...)` each frame; cancels on cleanup
- Filename shown as truncated label + tooltip; duration shown below
- Placeholder text for shader and no-source states
- `crossfaderTargets: ('opacity' | 'volume')[]` added to Session; crossfader now drives audio by default
- `loop` defaults to `false`

### waveform display [done]
- Full-track analysis on load: fetch file as ArrayBuffer → `AudioContext.decodeAudioData()` →
  30 peaks/second (amplitude) → `Float32Array`; re-analyzes on source change
- `src/lib/audio/waveform.ts`: `computeWaveform(buffer)` + pre-computed 256-entry color LUTs
  (dark blue → cyan → green → yellow → orange keyed to amplitude; played region dimmed ~40%)
- `WaveformCanvas.svelte`: amplitude-colored bars, depth gradient overlay, ResizeObserver sizing
- **Overview mode**: full track, played region dimmer, playhead as red line
- **Zoom mode** (OVR/ZOOM toggle button): 16s window by default; playhead pinned at 25% from left
  so both decks' playheads share the same canvas X — beat alignment visible by waveform shape
  - Scroll on canvas to adjust zoom window (4–32s)
  - Second-interval tick marks (longer every 4s) for rhythm reference
  - Out-of-bounds regions (before/after track) shaded darker
- Click on waveform seeks to that position (works in both modes)
- Cue point (white) and hot cue markers (colored) drawn in both modes; clipped when off-screen
- Loop region highlight: pending (no loop in/out points in model yet)

### hot cue set/clear UI [done]
- DeckCard: row of 4 pad buttons labeled 1–4; empty = dim, occupied = green with timestamp
- Empty pad: click = stamp current time; occupied pad: click = jump, shift+click = re-stamp, right-click = clear
- MIDI `hot_cue` handler: seeks to `hotCues[index]` if set
- MIDI `hot_cue_set` handler: stamps `getDeckTime()` into `hotCues[index]`
- Shift+pad on Starlight: hardware sends note+8 on same channel → maps directly to HotCueSet (no host modifier state)
- Hot cue markers drawn on waveform canvas in both overview and zoom modes

### crossfader deck selector
- Crossfader component: add two `<select>` dropdowns (left / right) listing all deck IDs
- On change: `session.update(s => ({ ...s, crossfaderMapping: { left, right } }))`
- Session already has `crossfaderMapping`; MIDI `setCrossfader()` already uses it
- Show which decks are currently cross-linked visually (highlight their DeckCards)

### elapsed / remaining time display
- Show current position and remaining time in DeckCard
- Update from `video.currentTime` on the `timeupdate` event (or every RAF is fine)
- Click elapsed/remaining label to toggle between `+0:00` and `-0:00` display formats
- Pass video element ref to DeckCard so it can read `currentTime` directly (or expose from seekBus)

---

## Batch B — BPM and beat matching

### tap tempo + BPM detection [done]
- Tap tempo button in toolbar: record timestamps of last 4+ taps → compute average interval → BPM
- Auto-detect on load: energy-onset detection on peak amplitude array → inter-onset histogram → BPM estimate
  (`src/lib/audio/bpm.ts`: `detectBpm(peaks, peaksPerSecond)` + `tapTempo(timestamps[])`)
- Per-deck `bpm: number | null` in `Deck`; `analyzeFile()` now returns `{ peaks, bpm }`
- `WaveformCanvas` fires `onBpmDetected` callback after analysis → `updateDeck(id, { bpm })`
- `session.bpm` = master/reference BPM; per-deck shown in DeckCard; TAP button + ✕ reset in toolbar

### beat sync [done]
- "Master" button in DeckCard: sets `session.bpm = deck.bpm`
- "Sync" button in DeckCard: sets `playbackRate = deck.bpm / session.bpm`
- MIDI: Vinyl/Scratch `(0x91/0x92, 3)` → `SyncToggle` → applies sync rate when both BPMs are set
- Phase nudge: pending (requires beat phase tracking)

### N-bar quantized looping [done]
- `loopIn: number | null`, `loopOut: number | null` added to `Deck`
- Custom loop: when both points set + `deck.loop`, `ontimeupdate` seeks back to `loopIn` at `loopOut`
- IN/OUT buttons in DeckCard: stamp current time; display stamped time next to label
- Bar-length presets: ½, 1, 2, 4, 8 — sets loopIn + loopOut from current position, enables loop
- Loop region (green tint + edge lines) drawn on waveform in both overview and zoom modes
- Manual IN/OUT points work without BPM; bar presets require `session.bpm`



# 2026.04.25 17:59:39 — project initialized
Set up repo with todo.md / journal.md notes convention.

---

# 2026.04.26 — output window, drag-and-drop, video playback

## What shipped

**Output window** — second `WebviewWindow` opens at 1280×720 (not fullscreen by default so
it's usable on a single display). Press `F` to fullscreen once moved to the projector; `Esc`
to exit. Compositor frames posted via `BroadcastChannel('cuemark-output')` as `ImageBitmap`
— no Rust round-trip. `preserveDrawingBuffer: true` on the WebGL context lets
`createImageBitmap(canvas)` read the backbuffer after composite.

**OS drag-and-drop** — Tauri intercepts native file-drop before HTML5 DataTransfer is
populated (`e.dataTransfer` is always empty in the DOM handler). Fix: `onDragDropEvent()`
from `@tauri-apps/api/webview` gives the real filesystem paths + screen position.
`elementFromPoint` + `[data-deck-id]` attribute identifies the target deck.

**Video playback** — four separate bugs found and fixed:

1. **`$effect` never re-ran after mount** — `compositor` was a plain `let`, not `$state`.
   In Svelte 5, `$effect` only tracks reactive reads that actually execute. Because
   `if (!compositor) return` fired before `$session.decks` was ever read, Svelte never
   registered the session dependency and the effect stayed dead after mount. Fix: declare
   `compositor = $state(...)` and read `$session.decks` before the early-return guard.

2. **Video restarted on every effect run** — `v.src` (the DOM property) returns the
   absolute URL (`http://localhost:1420/media/...`) but `src` was a relative string
   (`/media/...`). They're never equal → `v.load()` called on every session change →
   video looped every ~30 s. Fix: compare with `v.getAttribute('src')` which returns
   the raw attribute value.

3. **Direct `video → texImage2D` crashes WebKitGTK** — calling
   `gl.texImage2D(..., videoElement)` triggers a SIGTRAP assertion failure in
   `libwebkit2gtk`. Fix: draw video onto an `HTMLCanvasElement` scratch buffer first
   (`drawImage(video, ...)`), then upload the canvas. Clean, stable path in WebKit.

4. **Video upside-down** — HTML canvas Y=0 is top; WebGL texture Y=0 is bottom.
   Fix: `gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)` around the `texImage2D` call.

**GStreamer / file serving** — GStreamer (WebKitGTK's media backend) cannot speak
WebKit custom URI schemes (`asset://`, `media://`) for `<video>` elements. `file://`
is blocked by same-origin policy when the page is served from `http:`. Solution: Vite
dev middleware serves local files as plain `http://localhost:1420/media/<abs-path>` with
Range support — GStreamer's `souphttpsrc` handles this perfectly. Production will use the
Rust `media://` custom scheme handler.

---

# 2026.04.27 — hot cue UI and MIDI set/jump

## What shipped

**Hot cue pad row in DeckCard** — four buttons per deck (1–4) matching the physical pads.
Empty pads are dimmed; occupied pads show green with the stamped time. Click behaviour:
- Empty: stamp current playback position
- Occupied: jump (seek + keep playing)
- Shift+click: re-stamp at current position (overwrite)
- Right-click: clear

**MIDI hot cue wiring** — the `hot_cue` stub in `handler.ts` now seeks to `hotCues[index]`
when set. A new `hot_cue_set` action stamps `getDeckTime()` into the slot.

**Shift+pad on the Starlight** — initial approach tracked shift state in Rust via `AtomicBool`,
emitting `HotCueSet` when the shift flag was set. This was wrong: the Hercules handles Shift
entirely in hardware. When Shift is held, the hot cue pads send note+8 on the same channel
(`(0x96, 8–11)` left, `(0x97, 8–11)` right) instead of their normal notes 0–3. The fix is
simply to add direct `HotCueSet` map entries for those notes — no host-side modifier tracking.
Verified by running with the debug eprintln and pressing each shifted pad in sequence.

---

# 2026.04.27 — canvas quality fixes

Video previews and output window were grainy and slightly zoomed-in. Three root causes:

1. **Hardcoded small canvas buffer CSS-stretched** — `DeckCard.svelte` had
   `width="160" height="90"` on the preview canvas but CSS set `width: 100%`. A 160 px
   canvas filling a 300–400 px slot causes ~2–3× upscale blur. Fix: `ResizeObserver`
   resizes `canvas.width/height` to `entry.contentRect.width/height × devicePixelRatio`
   so the buffer always matches the rendered pixel count exactly.

2. **2D context image smoothing defaults to low quality** — `HTMLCanvasElement.getContext('2d')`
   defaults to `imageSmoothingQuality = 'low'` when resampling. Set it to `'high'`
   on the FBO scratch canvas (used to feed the WebGL texture) and the output window canvas.
   **Gotcha**: resizing a canvas (`canvas.width = ...`) resets *all* 2D context state,
   including `imageSmoothingQuality`. Must be re-applied after every resize.

3. **`mediump` precision in blit shader** — minor improvement, changed to `highp float`
   in the compositor fragment shader.

---

# 2026.04.28 — Batch A: waveform, crossfader selectors, elapsed/remaining time

## What shipped

**Waveform display** (`WaveformCanvas.svelte`, `waveform.ts`) — full-track amplitude analysis
at 30 peaks/second runs after load via `AudioContext.decodeAudioData`. Two display modes:

- *Overview*: full track, played region dimmed ~40%, playhead as red line
- *Zoom*: 16s window (4–32s adjustable by scroll), playhead pinned at 25% from left so both
  decks' waveforms align — beat-matching by visual shape. Tick marks every second (longer
  every 4s). Out-of-bounds regions darkened.

Amplitude color uses pre-computed 256-entry LUTs (dark blue → cyan → green → yellow → orange).
Cue point (white arrow) and hot cue markers (colored arrows) drawn in both modes.
Click anywhere to seek; ResizeObserver keeps buffer in sync with layout.

**Crossfader deck selectors** (`Crossfader.svelte`) — two `<select>` dropdowns list all deck
IDs; changing either updates `session.crossfaderMapping`. The visual/audio target toggles
(`crossfaderTargets`) allow the fader to drive opacity only, volume only, or both.

**Elapsed/remaining time** (`DeckCard.svelte`) — reads `video.currentTime` on every RAF
frame via `getVideoEl(deckId)`. Shows `M:SS` elapsed and `-M:SS` remaining side by side.

---

# 2026.04.29 — Batch B: BPM detection, beat sync, N-bar looping

## What shipped

**BPM detection** (`src/lib/audio/bpm.ts`) — `detectBpm(peaks, peaksPerSecond)` uses an
energy-onset approach: squares peak amplitudes → rolling 1s average via prefix sum → find
local maxima above 1.8× average with ≥200ms separation → inter-onset histogram over
60–200 BPM range with ±1-bin spread and 2× harmonic folding → return peak-bin BPM.
Runs automatically after `analyzeFile()`; result surfaced via `onBpmDetected` callback from
`WaveformCanvas`. `analyzeFile` now returns `{ peaks, bpm }`.

**Tap tempo** — TAP button in toolbar records `Date.now()` timestamps; 2-second idle
resets the buffer; `tapTempo(timestamps[])` averages the last 8 inter-tap intervals
(200ms–2000ms valid range = 30–300 BPM). Updates `session.bpm` live from the first
two taps. A ✕ button clears the master BPM.

**Beat sync** — per-deck BPM row in `DeckCard`:
- *Master* button: sets `session.bpm = deck.bpm` (highlights when already the reference)
- *Sync* button: sets `playbackRate = deck.bpm / session.bpm`; disabled without both BPMs
- MIDI: Vinyl/Scratch buttons `(0x91, 3)` / `(0x92, 3)` → new `SyncToggle` action → same
  sync logic applied from the MIDI handler

**N-bar quantized looping** — `loopIn` / `loopOut` added to `Deck` model:
- IN/OUT buttons stamp current playback position; display the stamped time next to the label
- Bar preset buttons (½, 1, 2, 4, 8) — require `session.bpm`; compute
  `loopOut = loopIn + bars × 4 × 60 / bpm`, set `loopIn` from current position if not
  already set, enable `deck.loop`
- ✕ button clears both loop points
- When `deck.loop && loopIn !== null && loopOut !== null`: native `video.loop` is disabled;
  an `ontimeupdate` handler on the `<video>` element seeks to `loopIn` when
  `currentTime >= loopOut`. Handler is re-assigned on every `$effect` run so it always
  captures the latest in/out values.
- Waveform shows a green-tinted region + edge lines when loop is active in both modes.
