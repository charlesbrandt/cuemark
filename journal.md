# 2026.05.10 — multi-channel cue routing for DJControl Starlight

## Context

The Headphones cue output was routing to the Master output (FL+FR) of the DJControl Starlight
even when the user selected the Rear / Headphones output (RL+RR).

## Root cause

The DJControl Starlight uses the ALSA `surround40` profile, which PipeWire exposes as a single
4-channel `Audio/Sink` node (`analog-surround-40`) with channel layout FL,FR,RL,RR.
Channels 0+1 (FL,FR) = Master output; channels 2+3 (RL,RR) = Headphones output.

Three approaches were tried, with only the third working:

### Attempt 1: `audio.position` in pipewiresink stream-properties — FAILED

Setting `audio.position=RL,RR` in `stream-properties` has no effect on routing. Stream-properties
are node metadata; PipeWire's session manager (WirePlumber) does not use them to decide which
sink ports to connect to.

### Attempt 2: GStreamer caps channel-mask relabeling (2-channel) — FAILED

Adding `audioconvert (identity 2×2 matrix) → capsfilter(channel-mask=0x30 = RL+RR)` before
`pipewiresink`. The audio passed through without silence but WirePlumber still connected the
stereo stream to the first pair (FL,FR = Master). WirePlumber ignores channel-position labels
when routing a stereo stream to a multi-channel sink — it always connects to ports 0+1.

### Attempt 3: N-channel stream with silence in non-target channels — IMPLEMENTED

The working approach: match the sink's full channel count (4). Output a 4-channel GStreamer
stream where the target channels carry audio and all other channels are silent. WirePlumber
sees a 4:4 channel count match and creates a 1:1 port connection, so silence goes to
ports 0+1 (Master) and audio goes to ports 2+3 (Headphones).

## Implementation

**`devices.rs`**:
- `parse_pw_dump` reads `audio.position` from each PipeWire sink node.
- Sinks with >2 channels are expanded into one entry per adjacent stereo pair.
- Device ID format: `node_name@target_pair!full_layout`
  e.g. `alsa_output.usb-...-surround-40@RL,RR!FL,FR,RL,RR`
- The `!full_layout` suffix tells the pipeline how many channels the sink has and in
  which order, so it can place the audio in the right buffer positions.

**`pipeline.rs`** (`compute_cue_remap`):
- Parses `target!full_layout` from the device ID.
- Computes a GStreamer channel-mask bitmask for the full layout.
- Finds each target channel's buffer index by counting set bits below it in the mask.
- Builds an N×2 mix-matrix: target rows get [1,0] or [0,1]; all other rows are [0,0].
- For Starlight Rear (RL,RR on FL,FR,RL,RR): matrix rows = [[0,0],[0,0],[1,0],[0,1]].

**`pipeline.rs`** (`load()`):
- When cue device has `@target!full`, inserts `audioconvert(mix-matrix) → capsfilter`
  between `cue_volume` and `cue_queue` in the cue branch.
- `audioconvert`'s mix-matrix must be set explicitly — GStreamer's default matrix for
  cross-position conversions (FL→RL) is all-zeros (silence), not identity.

## Key PipeWire insight

WirePlumber routes based on channel *count* match before channel *position* match:
- Stereo (2-ch) → 4-ch sink: always connects to ports 0+1, ignores position labels.
- 4-ch → 4-ch sink: 1:1 port mapping by position. This is the mechanism that works.

---

# 2026.05.05 — waveform clock sync, PipeWire xrun cascade fixes

## Problems

### Waveform position indicator jumping by several seconds during tempo changes

The waveform reads position via `getDeckTime(deckId)` → `video.currentTime`. The video element plays
at `v.playbackRate = deck.playbackRate` and the RAF loop snaps `v.currentTime` to the GStreamer
position when drift exceeds 80ms. At 1.5× tempo, video and audio diverge at 0.5s per real second;
drift hits 80ms in ~160ms. Each snap causes a visible multi-second jump in the waveform playhead
(the video is at second 10 but gets snapped to second 15 — that's the "jump").

A second problem: the RAF loop fired one `audioGetPosition` IPC call per frame per deck (60/sec).
Responses could resolve out of order (GStreamer busy mid-rate-change → old call returns late →
overwrites a newer snap with a stale, lower position). This caused the playhead to occasionally
jump backward.

### Fix — audio position cache in seekBus + one-in-flight IPC

**`seekBus.ts`**: added `audioTimes: Map<string, number>` and `setDeckAudioTime(id, t)`. Updated
`getDeckTime()` to return the cached audio-clock position (set by the RAF loop from IPC) instead
of `video.currentTime`. Falls back to `video.currentTime` when no cache entry exists (e.g., when
paused). `seekDeck()` writes the seek target to the cache immediately so the waveform shows the
new position before the GStreamer IPC round-trips.

**`App.svelte` RAF loop**: added `pendingPos: Map<string, boolean>`. Next IPC call is only issued
after the previous one resolves (one in-flight per deck). This eliminates stale-response backward
jumps and reduces IPC pressure from 60 calls/sec to ~IPC-latency-bounded throughput.

### PipeWire xrun cascade — two separate root causes

#### Cause 1: 44100 Hz source files → wrong quantum

When a 44100 Hz audio file is loaded, pipewiresink negotiates at 44100 Hz with PipeWire. PipeWire's
graph runs at 48000 Hz (hardware DAC rate). The adapter assigns a non-power-of-two quantum to the
stream (observed: 3969 at 44100 Hz, vs. 1024 at 48000 Hz). This mismatch produces scheduling
irregularities and xruns visible in `pw-top`'s ERR column.

**Fix**: added `capsfilter` between `audioresample` and `pitch` that constrains output to 48000 Hz.
`audioresample` now always converts to 48000 Hz before downstream. The whole chain (pitch, volume,
pipewiresink) runs at 48000 Hz, matching PipeWire's native graph rate and the `node.latency=1024/48000`
quantum hint.

Note: existing pipelines (decks loaded before a Rust rebuild) are not affected until the track is
re-loaded, since each `load()` builds a fresh pipeline.

#### Cause 2: `v.playbackRate` changes on every MIDI tempo event → WebKit pipeline rebuilds

`syncVideoElements` set `v.playbackRate = deck.playbackRate` on every call. With MIDI tempo fader
at 200+ events/sec (rAF-throttled to 60/sec), this fires up to 60 times/sec. WebKitGTK's comment
in the code already noted it "may rebuild its internal GStreamer pipeline on rate changes". That
rebuild is CPU-intensive and starves the audio streaming thread, producing PipeWire xruns that
cascade: xruns → audio gaps → the "neat effect" artifact (rhythmic skips at 48kHz/1024 = ~47/sec
cadence) → eventually pipeline ERROR state with 1300+ accumulated xruns.

**Fix**: added `lastPlaybackRate: Map<string, number>`. `syncVideoElements` now only writes
`v.playbackRate` when the value actually changes. MIDI tempo CC events no longer cause WebKit
pipeline rebuilds.

#### Cause 3: soundtouch variable output chunks vs. PipeWire 1024-sample quantum

soundtouch's time-stretch algorithm produces output chunks whose size depends on the tempo ratio
(e.g. at 1.5× it consumes ~1.5× input per output chunk, but the exact sizes vary). Without buffering,
PipeWire's pull callback can fire before soundtouch has produced a full 1024-sample quantum → xrun.

**Fix**: added a time-based `output_queue` (200ms, no count/byte limits) between `pitch` and `volume`.
This absorbs size mismatches between soundtouch's output cadence and PipeWire's pull schedule.

## Final pipeline topology

```
uridecodebin → queue(max-bufs=2) → audioconvert → audioresample
  → capsfilter(rate=48000) → pitch(tempo) → output_queue(200ms) → volume → pipewiresink
```

---

# 2026.05.05 — seek-based rate changes abandoned; switched to soundtouch pitch element

## The problem

All seek-based approaches to rate change (FLUSH | ACCURATE, scaletempo, INSTANT_RATE_CHANGE) share a
fundamental flaw: any seek on a playing pipeline with a live PipeWire sink temporarily moves the pipeline
to PAUSED for re-preroll. With a time-stretching element like scaletempo, re-preroll can take ~90ms while
the WSOLA ring buffer refills. The MIDI tempo fader fires 200+ events/second. The 200ms AsyncDone timeout
fires mid-refill, issues a second conflicting seek, and the pipeline never recovers. Visible in logs as
`pipeline: Paused → Paused (pending Paused)` immediately after a rate seek, followed by silence.

`scaletempo` was tried first (one session) — eliminated doubled audio but introduced the PAUSED freeze
on the first real rate-change attempt.

## The fix

Replaced `scaletempo` with the `pitch` element from `gst-plugins-bad` (soundtouch). The `tempo`
property sets playback speed without pitch change, in-place, with no seek and no pipeline state
transition. `set_rate()` is now three lines.

```
uridecodebin → queue → audioconvert → audioresample → pitch → volume → pipewiresink
```

`pitch` element: `tempo` property (0.1–10.0, default 1.0) — set at any time, takes effect immediately.
Requires `gstreamer1.0-plugins-bad` (`sudo apt install gstreamer1.0-plugins-bad`).
`libsoundtouch1` was already present on the system; only the GStreamer wrapper package was missing.

## What was stripped from pipeline.rs

- `applied_rate`, `last_rate_seek`, `duration_secs` fields from `DeckAudioPipeline`
- `seek_in_flight` from `PipelineInner`
- `last_async_done` (`Arc<Mutex<...>>`) and all dead-reckoning position estimation
- 300ms dwell gate, 200ms AsyncDone gate, 50ms debounce, safety timeout
- Error recovery / pipeline rebuild in `set_rate()`
- All QOS / xrun bus message handling

## History of seek-based attempts (for the record)

1. `FLUSH | ACCURATE` — correct position but ~90ms dropout per seek; 300ms dwell gate needed
2. `INSTANT_RATE_CHANGE` — no flush, but qtdemux emits GST_FLOW_ERROR (-5) on MP4 files → crash
3. `KEY_UNIT` — snaps to keyframes → same audio segment replays → doubled/detuned sound
4. HW buffer shrink (200ms → 50ms) — reduced doubling window but didn't fix root cause
5. `scaletempo` with flush seeks — eliminated doubled audio, but WSOLA re-preroll ~90ms caused
   PAUSED freeze with rapid MIDI events; second conflicting seek made it unrecoverable

---

# 2026.05.04 — pipewiresink investigation: doubling resolved, rate-change regression open

## What's still open

**Rate changes unresponsive with pipewiresink + 300ms dwell** — after switching to pipewiresink (which eliminated doubling), raising the dwell gate to 300ms appeared to break rate changes entirely. Not yet confirmed with terminal log (`set_rate →` lines). Next session: capture those lines while moving the tempo fader to confirm whether seeks are being issued. If yes, it's a UX perception issue (300ms feels sluggish); if no, something upstream broke (MIDI → frontend → Tauri chain).

**Dwell gate tuning unresolved** — 200ms = choppy but responsive; 300ms = smooth but possibly unresponsive. 250ms is the next value to try. Current code is at 300ms.

**WebKit PipeWire stream** — WebKitGTK opens a second audio stream for every `<video>` element even when `v.muted = true` (~90ms quantum / 3969 samples @ 44100). Tried `createMediaElementSource(v)` to suppress it — this created a THIRD stream instead of redirecting the existing one. Reverted. Stream appears to be genuinely silent (muted at the sink); not the doubling source.

## What shipped this session

**Switched `make_sink()` to prefer `pipewiresink`** — `autoaudiosink` on a PipeWire+pipewire-pulse system picks `pulsesink` (rank 266 > pipewiresink rank 0), routing through three layers. Direct pipewiresink eliminates the PA emulation hop. FLUSH seeks propagate directly to PipeWire; no ring buffer accumulation → no doubling.

**`pipewiresink` properties corrected** — it extends `GstBaseSink`, not `GstAudioBaseSink`. Setting `buffer-time` or `latency-time` on it crashes. Latency is via `stream-properties` GstStructure with `node.latency = "1024/48000"` (~21ms).

**pipewiresink xruns explained** — FLUSH seeks create ~90ms audio gaps; with 21ms quantum that's ~4 xruns per seek. Appear in pw-top `ERR` column. Do NOT generate GStreamer bus ERROR messages. Benign.

**Dwell gate raised 200ms → 300ms** — to give more stable play time between dropout gaps. May have overcorrected (rate changes became unresponsive). Not yet confirmed.

---

# 2026.05.04 — Doubled audio during tempo changes, HW buffer fix

## What shipped

**Diagnosed and fixed doubled/detuned sound during tempo fader use** — the audio sink (PipeWire / PulseAudio) was buffering 200ms of audio by default (`GstAudioBaseSink` `buffer-time` property). With rate-change seeks gated at 200ms (dwell window to allow playback between seeks), old audio was still draining from the HW buffer as the new seek's audio segment arrived, producing two simultaneous audio streams at slightly different pitches/positions = "doubled" effect.

Fix: `make_sink()` now sets `buffer-time=50000us` (50ms, down from 200ms default) on all audio sinks. For `pipewiresink` (specific device), applied directly. For `autoaudiosink` (default device), hooked the `child-added` signal to apply the setting to whichever sink it picks (pipewiresink, pulsesink, etc.) at runtime.

**Added diagnostics:**
- `set_rate()` now logs `target=Xms elapsed-since-async-done=Yms prev_rate=Z` to verify position estimation and dwell gating
- `make_sink()` logs the actual chosen sink type and its buffer-time / latency-time after application

**Updated docs:**
- CLAUDE.md: documented ACCURATE vs KEY_UNIT distinction, AsyncDone gate, 200ms dwell, and HW buffer fix
- audio-debugging skill: added HW buffer overlap as root cause of doubling, explains the 50ms fix, updated diagnostics

---

# 2026.05.02 — Batch C: EQ, audio output device selection, headphone cue

## What shipped

**EQ per deck** — three biquad filter nodes inserted into each deck's signal chain:
`gain → lowShelf(250Hz) → midPeak(1kHz,Q=1) → highShelf(4kHz) → analyser`
- `DeckEQ { low, mid, high }` added to `Deck` type; `eq: { 0, 0, 0 }` default
- `setDeckEQ(deckId, low, mid, high)` on `AudioAnalyzer`; synced via `$effect` in App.svelte
- Three ±12 dB sliders + reset button (enabled only when any band is non-zero) in each DeckCard
- `cueEnabled: boolean` added to `Deck` type in the same pass (used by headphone cue)

**Audio output device selection** — settings bar toggled from toolbar "Audio" button:
- `src/lib/audio/devices.ts`: `listAudioOutputs()` enumerates `audiooutput` devices;
  `sinkIdSupported()` checks `'setSinkId' in AudioContext.prototype`
- `AudioAnalyzer.setOutputDevice(deviceId)` calls `ctx.setSinkId(deviceId)` if supported
- Falls back gracefully: shows "unavailable in this runtime" message if WebKitGTK doesn't expose `setSinkId`
- Settings bar also exposes headphone device selector and cue gain slider (see below)
- `src/lib/audio/audioSettings.ts`: module-level Svelte stores (`mainOutputDeviceId`, `cueOutputDeviceId`, `cueGain`)
  keep device selections accessible without prop drilling

**Headphone cue / pre-listen** — second `AudioContext` routed to the selected headphone output:
- Bridge: `highShelf → MediaStreamDestinationNode` in main ctx → `MediaStreamSource` in cue ctx
  (cross-context routing; Web Audio contexts can't share nodes directly)
- `setCueDeck(deckId, enabled)` on `AudioAnalyzer`: connects / disconnects each deck's post-EQ
  pre-fader signal to the cue mix; `cueStreamDest` node is created lazily and kept alive for reconnection
- `setCueOutputDevice(deviceId)`: tears down and rebuilds the cue `AudioContext` when device changes;
  reconnects all currently-enabled cue decks automatically
- `setCueVolume(v)`: headphone master gain
- CUE toggle button added to transport row in each DeckCard
- `cueGain` slider appears in the Audio settings bar only when a headphone device is selected
- MIDI: headphone cue buttons `(0x91, 12)` / `(0x92, 12)` → new `HeadphoneCue` action → toggles `cueEnabled`
- `HeadphoneCue` added to `MidiAction` and `ControlBinding` enums in `midi.rs`

---

# 2026.05.02 — MIDI calibration complete + Gain/Volume split

## What shipped

**MIDI calibration complete** — all Starlight controls verified on hardware:
- Tempo fader center at physical detent = 1.0× confirmed
- Tempo fader full throw range confirmed (≈±50%)
- Loop=note3, Sync=note5 confirmed by raw MIDI dump (d2=127 note-on triggers, d2=0 note-off unmapped — correct)
- Jog wheel feel acceptable for now

**Deck gain/volume split** — `deck.gain` (pre-fader trim) is now separate from `deck.volume`
(post-fader crossfader level). Effective audio = `gain × volume`.
- Hardware volume faders (CC B1/0, B2/0) remapped from `DeckVolume` → `DeckGain`
- Crossfader still drives `deck.volume` as before
- GainNode applies `gain × volume` so both scale correctly together
- Gain slider added to DeckCard UI (between Opacity and Volume)
- Waveform bars in both overview and zoom modes now scale height and color intensity by `deck.gain`

**Auto-stop on track end** — when a non-looping clip finishes, `onended` fires and sets
`deck.playing = false`. The play button now correctly shows ▶ after a clip runs out.

---

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

## Audio-reactive shader uniforms — bug fix (2026-05-09)

The shader visualizations (`u_bass`, `u_mid`, `u_high`) were not responding to music despite
the GStreamer `spectrum` element being present in each deck pipeline.

**Root cause**: `pipeline.rs` used `structure.get::<gst::Array>("magnitude")` to extract the
FFT magnitude data from the spectrum bus message. GStreamer's spectrum element posts magnitude
as a `GstValueList`, which maps to `gst::List` in gstreamer-rs — not `gst::Array` (`GstValueArray`).
These are distinct GLib types. The type mismatch caused every `let Ok(magnitude)` to fail silently
(hitting `continue`), so the bus thread never emitted any `audio-fft` Tauri events. The frontend
`deckAnalysis` map stayed empty and all shaders received `bass=0 mid=0 high=0` every frame.

**Fix**: changed `gst::Array` → `gst::List` in the `MessageView::Element` arm.

**Also found**: `src/lib/audio/shaderAnalyzer.ts` was written as a Web Audio API alternative
(analysis-only AudioContext tapping the muted `<video>` elements) but was never imported in
`App.svelte`. Left as dead code — the GStreamer path is the right approach since it uses the
actual audio being played rather than a re-decode through the browser.

Band sensitivity is functional but coarse; the linear dBFS-to-linear mapping and the
bass/mid/high frequency splits can be tuned in future once there's more performance time to
evaluate what looks good.
