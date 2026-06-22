# Cuemark

VJ / live A/V mixing software for Linux. Built for live performance: garage dance parties,
projector output, MIDI controller integration. Open source goal.

Domain: cuemark.com (Charles Brandt's former DJ name)

## Tech stack

- **Tauri** (Rust backend + WebKit frontend) — cross-platform, Wayland-native on Linux via GTK4
- **WebGL** — GPU-accelerated rendering, FBO-per-deck compositing
- **GStreamer** (Rust, `gstreamer` + `gstreamer-audio` crates, `features = ["v1_18"]` required) — audio playback, gain/EQ, device routing, headphone cue mix, recording. Each deck has its own `DeckAudioPipeline` (uridecodebin → queue → audioconvert → audioresample → capsfilter(48kHz) → pitch → output_queue → volume → pipewiresink/autoaudiosink). Audio is the master clock; video element syncs to it.
- **Web Audio API** — FFT analysis for BPM detection and audio-reactive visuals (not used for playback or waveform peak extraction — that runs in Rust via `audio_analyze_file` to avoid VA-API corruption)
- **GLSL shaders** — effects and audio-reactive visualizations
- **Rust `midir` crate** — MIDI input (Web MIDI API unreliable in WebKitGTK); events piped to frontend via Tauri IPC
- **`<video>` element → 2D canvas → texImage2D** — video decode into WebGL texture via a scratch canvas intermediary (direct video→texImage2D triggers SIGTRAP assertion failures in WebKitGTK; see `fbo.ts`). The `<video>` element is **muted** — audio is owned by the GStreamer pipeline.
- **Local HTTP media server** — WebKitGTK's GStreamer media backend cannot reliably resolve custom URI
  schemes (`media://`, `asset://`) for `<video>` elements: confirmed empirically (instant `FormatError`,
  no GStreamer pipeline ever constructed, regardless of codec or `WEBKIT_DISABLE_DMABUF_RENDERER`). Both
  dev and prod instead serve local video files over plain HTTP, which `souphttpsrc`/WebKit handle natively:
  - **Dev**: a Node.js middleware in `vite.config.ts` serves `http://localhost:1420/media/<abs-path>`.
  - **Prod**: `src-tauri/src/media_server.rs` runs a `tiny_http` server on an ephemeral `127.0.0.1` port
    (Range-request support for seeking), started in `lib.rs` `run()` and exposed to the frontend via the
    `media_server_port` Tauri command. `App.svelte` fetches the port once in `onMount` and builds
    `http://127.0.0.1:<port>/<abs-path>` for video `src`.
  Never use `asset://` or `file://` from an `http:` origin — WebKit blocks them silently.

## Architecture

### Audio pipeline

```
GStreamer (Rust, per deck):
  uridecodebin → queue(2buf) → audioconvert → audioresample
    → capsfilter(48kHz) → pitch(tempo) → output_queue(500ms) → tee
                                                                  ├─ volume₀ → sink₀  ┐ one branch per main device
                                                                  ├─ volume₁ → sink₁  ┘ (≥1; empty → system default)
                                                                  └─ cue_valve → cue_volume → cue_queue → cue_sink
```

`AudioManager` (held in Tauri managed state as `Mutex<AudioManager>`) owns all `DeckAudioPipeline` instances.
Tauri commands (`audio_load`, `audio_play`, `audio_pause`, `audio_seek`, `audio_set_rate`, `audio_set_gain`,
`audio_set_volume`, `audio_set_eq`, `audio_set_cue`, `audio_get_position`, `audio_set_master_volume`,
`audio_set_main_devices`, `audio_set_cue_device`, `audio_set_cue_gain`, `audio_record_start/stop`) expose the
pipeline to the frontend. The frontend wrapper lives in `src/lib/audio/pipeline.ts`.

**Audio is the master clock.** The `<video>` element is muted and used only for frame decode. In the RAF loop,
`audioGetPosition(deckId)` polls the GStreamer position (one in-flight IPC per deck via `pendingPos` map) and
snaps the video element's `currentTime` to it if drift exceeds 80 ms. The resolved position is also written to
`setDeckAudioTime(deckId, pos)` in `seekBus.ts`, where the waveform reads it. This keeps the waveform playhead
tracking the audio clock rather than `video.currentTime` (which drifts and snaps at non-1× tempos).

**`v.playbackRate` must only be set when changed** — WebKitGTK rebuilds its internal GStreamer pipeline on
each `v.playbackRate` write. At MIDI tempo rates (60/sec after rAF throttle) this causes CPU spikes that starve
the audio thread → PipeWire xruns → cascade failure. `syncVideoElements` tracks `lastPlaybackRate` per deck and
skips the write if the value is unchanged. The rebuild also loses `v.muted`; fix: also set `v.volume = 0` (a JS
property, not pipeline state — survives rebuilds). Both are applied unconditionally every pass and re-applied after
each `v.playbackRate` write.

**Device routing**: default output uses `autoaudiosink` (selects PipeWire/PulseAudio/ALSA automatically).
A specific sink is targeted via `pipewiresink target-object=<node-name>`; falls back to `autoaudiosink` if
the `gstreamer1.0-pipewire` plugin is absent.

**EOS handling**: Each `DeckAudioPipeline` spawns a background thread that watches the GStreamer bus.
When an `EOS` message arrives the thread sets an `Arc<AtomicBool>` (`at_eos`). The next call to `play()`
checks this flag and seeks back to zero before resuming, so the track replays cleanly instead of stalling
at end-of-stream. The bus thread is stopped via `bus.set_flushing(true)` before pipeline teardown and in
`Drop`.

**Rate changes**: `set_rate()` sets the `tempo` property on the `pitch` element (soundtouch, `gst-plugins-bad`).
This adjusts playback speed without changing pitch, with no seek or pipeline flush — the change is applied
to the ongoing audio stream in-place. The `tempo` property accepts 0.1–4.0 (1.0 = normal speed).

**PipeWire quantum**: the `capsfilter(rate=48000)` ensures pipewiresink always negotiates at 48000 Hz,
matching PipeWire's native graph rate. Without it, 44100 Hz source files produce a non-power-of-two quantum
(e.g. 3969) in PipeWire → scheduling irregularities → xruns. The `output_queue(500ms)` after `pitch` absorbs
soundtouch's variable output chunk sizes so pipewiresink's pull callback always finds buffered data.

Earlier approaches using `FLUSH | ACCURATE` seeks, `INSTANT_RATE_CHANGE`, and `scaletempo` were all tried
and abandoned — see `journal.md` for the full history. The core problem was that any seek-based approach
requires a pipeline flush, which temporarily moves a live PipeWire sink to PAUSED for re-preroll. With
MIDI firing at 200+ events/second this becomes unrecoverable. Property-based tempo change avoids the
pipeline state machine entirely.

**Preroll**: `load()` waits synchronously (up to 5 s) for the pipeline to reach `PAUSED` before returning,
so callers can seek and play immediately without an extra wait.

**`uridecodebin` must skip video decoder factories**: `uridecodebin` internally uses `decodebin3`,
which attempts to decode *every* stream in a container — including video — even when only audio pads
are connected. For video+audio containers, `decodebin3` instantiates the VA-API hardware video decoder
(`vaav1dec` / `vaah264dec`), which can fail and emit a pipeline ERROR. That ERROR also corrupts the
VA-API driver state for the entire process, breaking the `<video>` element and waveform analysis for
the rest of the session. Fix in `pipeline.rs` `load()`, using the `autoplug-select` signal:
```rust
src.connect("autoplug-select", false, |values| {
    let factory = values.get(3).and_then(|v| v.get::<gst::ElementFactory>().ok())?;
    let klass = factory.metadata("klass").unwrap_or_default();
    let is_video_decoder = klass.contains("Decoder") && klass.contains("Video");
    let result_int = if is_video_decoder { 2i32 } else { 0i32 }; // SKIP=2, TRY=0
    let enum_class = glib::Type::from_name("GstAutoplugSelectResult")
        .and_then(glib::EnumClass::with_type)?;
    enum_class.to_value(result_int)
});
```
**Why factory klass, not caps**: stream caps like `video/quicktime` describe the *container* (MP4/MOV
demuxer), not just the video track inside. A caps-based check accidentally skips the demuxer itself,
preventing the file from opening. Checking `klass.contains("Decoder") && klass.contains("Video")`
skips only actual video decoder elements.
**Why `autoplug-select` not `autoplug-continue`**: returning `false` from `autoplug-continue` exposes
the encoded video pad with nothing downstream to accept it → `not-linked` ERROR crashes the pipeline.
`autoplug-select` returning SKIP (2) causes `decodebin` to try the next factory candidate, and when
all are exhausted it emits an `unknown-type` WARNING (benign) — not an ERROR.
**Return type pitfall**: the signal requires a `GstAutoplugSelectResult` enum value, not a plain `i32`.
Use `glib::EnumClass::with_type` and `to_value()` — returning a raw integer fails at runtime with a
type mismatch error.
Symptom if missing: `[bus/<deck>] ERROR: No valid frames decoded … GstVaAV1Dec:vaav1dec0` followed by
subsequent tracks showing waveform `—` and blank video previews for the rest of the session.

**Multiple sinks and `async=false`**: Every `GstBaseSink` with `async=true` (the default) must receive a
preroll buffer before the pipeline can report PAUSED — it blocks the READY→PAUSED state transition until
that buffer arrives. In a `tee` topology with N real sinks, GStreamer requires *all* of them to preroll
simultaneously, but the tee pushes to each pad sequentially in one thread, so they can deadlock each other.
**Rule: only one sink per pipeline should have `async=true`.** All additional sinks must be set to
`async=false` before being linked. With `async=false`, a sink skips preroll and starts accepting buffers
when the pipeline reaches PLAYING, synchronized to the clock provided by the `async=true` sink.
This applies to every branch: the cue sink already uses `async=false`; secondary main output sinks do too.
Symptom of getting this wrong: `[bus/<deck>] pipeline: Null → Ready (pending Paused)` followed by
`[audio/<deck>] preroll still pending after 5s timeout` with no further state-change log lines.

### Rendering pipeline

```
<video> element (muted)
  └─► drawImage() ──► scratch HTMLCanvasElement (per FBO)
        └─► texImage2D (UNPACK_FLIP_Y_WEBGL=true) ──► WebGL texture
              └─► [FBO N] ──► alpha composite ──► preview canvas + output window
```

Each FBO renders at full output resolution. Compositor alpha-blends decks back-to-front by `opacity`.

**`WEBKIT_DISABLE_DMABUF_RENDERER=1` is required**: When WebKit's `<video>` element decodes video via
VA-API hardware (h264, AV1, VP9), the decoded frames are stored in DMA-BUF / VA-API surfaces. When
`drawImage(video)` is called on a 2D canvas, these surfaces don't transfer to CPU-side pixel reads
correctly — the canvas gets colorful random static instead of the video frame. Setting this env var
forces WebKit to use a CPU-side compositing path for video frames, which handles color-space
conversion correctly. Set before `cuemark_lib::run()` in `main.rs`:
```rust
std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
```
Symptom if missing: video deck preview shows colorful noise (random RGB static) instead of the video.
Note: this affects all WebKit rendering, not just video. There's a small GPU compositing performance
cost but it's imperceptible at VJ workloads.

**This GPU's VA-API DMA-BUF export is fundamentally broken — demote the hardware decoder, don't just
hide the symptom**: confirmed via `GST_DEBUG=2`: `driver bug: fd size (3670016) is bigger than object
descriptor size (3194880)` plus `Cannot map/copy External OES textures` from WebKit's GL compositor.
This single underlying bug surfaces two different ways depending on `WEBKIT_DISABLE_DMABUF_RENDERER`:
- **Unset**: hardware VA-API decode succeeds, but the corrupted DMA-BUF frame renders as a solid
  garbage color (e.g. solid blue) in both the `<video>` element and any `drawImage()` canvas read.
- **Set to `1`**: WebKit's decoder autoplugging for that codec fails outright with *no* software
  fallback — `<video>` never fires `loadedmetadata`, `error.code === 4` (`MEDIA_ERR_SRC_NOT_SUPPORTED`),
  preview stays solid black. This is what broke H.264 playback even though `avdec_h264` is installed
  and works fine via plain `gst-launch-1.0` — WebKitGTK's own autoplugging logic, not a missing system
  package.

Fix: demote the VA-API decoder's GStreamer rank to 0 for every affected codec, forcing `decodebin` to
fall through to the software decoder (`av1dec`/aom for AV1, `avdec_h264`/libav for H.264) — this avoids
the broken DMA-BUF path entirely and works correctly with `WEBKIT_DISABLE_DMABUF_RENDERER=1` still set:
```rust
std::env::set_var(
    "GST_PLUGIN_FEATURE_RANK",
    "vaav1dec:0,vaapiav1dec:0,vah264dec:0,vaapih264dec:0",
);
```
If VP9 or HEVC show the same black-screen (`FormatError`/code 4) or solid-garbage-color symptom, add
their `va*dec`/`vaapi*dec` factory names here too — check with `gst-inspect-1.0 | grep -i <codec>`.

**Debugging tip — `std::env::set_var` calls in `main.rs` cannot be overridden from the outside**: to
test "what if this env var weren't set," editing/commenting the `main.rs` line and rebuilding is
required — launching the binary with a different value of the same var in the shell has no effect,
since the Rust call runs after the process starts and unconditionally overwrites it.

**Debugging tip — WebKit's own GStreamer warnings don't reach the Tauri log file**: `tauri-plugin-log`
only captures our own Rust `log::` call sites. WebKit's internal media pipeline (the separate
`WebKitWebProcess`) logs straight to stderr via its own GStreamer instance. To see decoder-level errors
(`FormatError`, `No decoder available for type ...`, DMA-BUF driver warnings), launch the binary
directly from a terminal with `WEBKIT_DEBUG=Media GST_DEBUG=2 ./path/to/cuemark 2>&1 | tee /tmp/out.log`
rather than relying on `~/.local/share/com.cuemark.app/logs/cuemark.log`.

**Waveform analysis runs in Rust, not `decodeAudioData`**: WebKit's `OfflineAudioContext.decodeAudioData()`
routes through a GStreamer pipeline in the WebKitWebProcess (a separate process). That internal pipeline
also instantiates VA-API video decoders for video+audio containers — the same corruption path as the
audio pipeline, but in a process we can't control. The fix: `analyzeFile()` in `waveform.ts` calls the
`audio_analyze_file` Tauri command instead of `decodeAudioData`. The Rust implementation in
`analysis.rs` (`compute_peaks()`) uses the same `autoplug-select` factory klass guard as
`DeckAudioPipeline` and returns 30 peaks/sec via `appsink`. The `gstreamer-app` crate is required.

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

**Every per-frame RAF loop must gate its expensive work on an actual-change check, not just
playback intent**: `App.svelte`'s `frame()`, `WaveformCanvas.svelte`, and `DeckCard.svelte`'s
preview each ran full-resolution `drawImage`/`texImage2D`/`createImageBitmap` unconditionally
every tick, regardless of whether the deck was playing. A paused video still re-uploads and
re-composites an identical frame 60×/sec forever — confirmed in production: a real session with
two paused decks loaded sat at 97-99% `WebKitWebProcess` CPU before this fix, ~2.4% after.
The pattern used throughout: track the last-seen value that actually determines a different
output (`video.currentTime` for frame uploads/canvas draws; a signature of
id/source/opacity/visualization-opacity for the composite+`postFrame()` call) and skip the
work when it's unchanged from the previous tick. `scripts/perf-idle-test.sh` is an automated
regression test for this — re-run it after touching the render loop, `WaveformCanvas`, or the
`DeckCard` preview.

### Dual output

- Window 1 (control): deck previews, crossfader, media browser, MIDI status
- Window 2 (output): compositor result fullscreen on projector (display 2)

### Data model

```typescript
type DeckSource =
  | { type: 'video'; filePath: string; duration: number }
  | null

// Global visualization layer — NOT a DeckSource. Composited above all decks in the
// output stage (see "Visualization layer" below), with its own opacity. Selecting a
// visualization never touches deck state or audio.
interface Visualization {
  fragmentSrc: string
  uniforms: Record<string, number>
  name?: string
}

interface Deck {
  id: string              // 'deck-0', 'deck-1', etc. — no hardcoded limit
  source: DeckSource
  playing: boolean
  playbackRate: number    // 0.25–4.0
  gain: number            // 0–1 pre-fader trim (normalize source level between tracks)
  volume: number          // 0–1 post-fader level (driven by crossfader); effective audio = gain × volume
  opacity: number         // 0–1 visual compositor weight
  loop: boolean
  cuePoint: number        // seconds
  hotCues: number[]       // up to 4 time markers
  bpm: number | null      // auto-detected or tapped BPM for this deck
  loopIn: number | null   // custom loop region start (seconds); null = full track
  loopOut: number | null  // custom loop region end (seconds); null = full track
  // When loop=true and both loopIn/loopOut are set, ontimeupdate seeks back to loopIn
  // at loopOut (native video.loop is disabled in that case — App.svelte manages it).
}

interface Session {
  decks: Deck[]           // ordered array; render back-to-front
  masterVolume: number
  bpm: number | null      // master/reference BPM; set via tap tempo or "Master" button
  crossfaderMapping: {    // which two decks the hardware crossfader controls
    left: string          // deck id
    right: string         // deck id
  }
  crossfaderValue: number              // 0.0 (full left) – 1.0 (full right)
  crossfaderTargets: CrossfaderTarget[] // 'opacity' | 'volume' — what the fader drives
  effects: Effect[]       // global post-process chain
  visualization: Visualization | null   // global layer, composited above all decks
  visualizationOpacity: number          // 0–1; default 0.5 so video stays visible underneath
}

interface AudioAnalysis {
  bass: number            // 0–1 normalized
  mid: number
  high: number
  waveform: Float32Array
}
```

### MIDI architecture

Rust backend (`midir`) receives raw MIDI → maps to structured actions → emits via Tauri `emit()` → frontend applies to session state → calls audio Tauri commands for gain/rate/play/pause changes. MIDI mappings reference `deckId` strings.

## MIDI controller

**Hercules DJControl Starlight** (USB)

### Channel layout (verified)

The Starlight uses separate MIDI channels per deck — do **not** mask the channel nibble in the map key:

| MIDI bytes | Deck / purpose |
|---|---|
| `0x91` Note On, `0xB1` CC | Left deck (ch 2) |
| `0x92` Note On, `0xB2` CC | Right deck (ch 3) |
| `0x96` Note On | Left hot-cue pads (ch 7) |
| `0x97` Note On | Right hot-cue pads (ch 8) |
| `0xB0` CC | Global — crossfader, master volume (ch 1) |

14-bit CC pairs: every continuous control sends a coarse MSB on CC N and a fine LSB on CC N+32.
For volume/crossfader, mapping the MSB only (7-bit = 128 steps) is sufficient.
For the **tempo fader**, map **both** MSB (CC 8) and LSB (CC 40): the MSB barely moves for small
slider adjustments — the real fine data is in the LSB. Both are combined via `rate_from_14bit(msb, lsb)`:
14-bit center = 8192 (MSB=64) → 1.0×; full range ±50% (0.5–1.5×).
**Direction**: the Starlight sends *higher* values for negative pitch (pushing down = faster). The
formula negates the delta so lower combined → rate > 1.0.

### Control map

| Physical control | MIDI key | Action |
|---|---|---|
| Play/Pause L | `(0x91, 7)` | DeckPlayToggle deck-0 |
| Play/Pause R | `(0x92, 7)` | DeckPlayToggle deck-1 |
| Cue L | `(0x91, 6)` | CueJump deck-0 |
| Cue R | `(0x92, 6)` | CueJump deck-1 |
| Loop L | `(0x91, 3)` | LoopToggle deck-0 |
| Loop R | `(0x92, 3)` | LoopToggle deck-1 |
| Vinyl/Scratch L | `(0x91, 5)` | SyncToggle deck-0 (apply master BPM / deck BPM rate) |
| Vinyl/Scratch R | `(0x92, 5)` | SyncToggle deck-1 |
| Volume fader L | `(0xB1, 0)` | DeckGain deck-0 (pre-fader trim; crossfader drives DeckVolume) |
| Volume fader R | `(0xB2, 0)` | DeckGain deck-1 |
| Tempo fader L | `(0xB1, 8)` MSB + `(0xB1, 40)` LSB | DeckPlaybackRate deck-0 (14-bit combined; center 8192→1.0×; higher=slower) |
| Tempo fader R | `(0xB2, 8)` MSB + `(0xB2, 40)` LSB | DeckPlaybackRate deck-1 |
| Jog wheel L | `(0xB1, 10)` | JogNudge deck-0 (relative ±1 step → ±2% rate; resets after 150ms idle) |
| Jog wheel R | `(0xB2, 10)` | JogNudge deck-1 |
| Crossfader | `(0xB0, 0)` | Crossfader (deck-0 ↔ deck-1 opacity) |
| Master volume | `(0xB0, 3)` | MasterVolume |
| Headphone volume | `(0xB0, 4)` MSB | CueGain |
| Hot cues L (1–4) | `(0x96, 0–3)` | HotCue deck-0 index 0–3 |
| Hot cues R (1–4) | `(0x97, 0–3)` | HotCue deck-1 index 0–3 |
| Shift + Hot cues L (1–4) | `(0x96, 8–11)` | HotCueSet deck-0 index 0–3 (stamp current time) |
| Shift + Hot cues R (1–4) | `(0x97, 8–11)` | HotCueSet deck-1 index 0–3 (stamp current time) |

**Shift note**: The Starlight handles Shift entirely in firmware — it does not pass a modifier flag through
MIDI. Instead, Shift+pad sends a different note number on the same channel (note += 8). No host-side
shift-state tracking is needed; the shifted notes map directly to `HotCueSet` bindings.

Intentionally unmapped: Bass/filter toggle `(0x90,1)`, mode-switch buttons `(0x91,15/16)`.

Phase 2: MIDI learn mode (click control in UI, wiggle knob to map).

## Deck sources

Decks are video-only — `DeckSource` is `{ type: 'video'; filePath; duration } | null`.
Load a file, loop, control playback rate. `<video>` element → WebGL texture.

## Visualization layer

Shader visualizations (Plasma, Tunnel, Particles, Feedback, Scope, …) are **not** a deck
source. They live as a single global layer on `Session.visualization` (`fragmentSrc`,
`uniforms`, `name`) with its own `Session.visualizationOpacity` (default `0.5`, so deck
video stays visible underneath — turn it up to 1.0 for visualization-only).

**Why this is a separate layer, not a per-deck source (architecture decision, 2026-06-21)**:
the original design let a deck's source switch between `'video'` and `'shader'`. Selecting
a visualization on a deck replaced that deck's source, and `syncVideoElements()` in
`App.svelte` treats any non-video source as "tear this deck down" — it called
`audioUnload()`, killing music playback the instant a visualization was picked. Since VJs
want visualizations *blended over* a playing track, not swapped in for it, the fix is
structural: visualizations never touch deck state at all.

**Rendering**: `Compositor` (`src/lib/renderer/compositor.ts`) holds one extra `DeckFBO`
(`vizFbo`) and one cached GLSL program (`vizProgram`) outside the per-deck `fbos`/
`shaderPrograms` maps — there is always at most one active visualization, so no map is
needed. `renderVisualization(fragmentSrc, uniforms, time, analysis)` renders into `vizFbo`
exactly like `renderShader()` does for a deck. `composite(decks, visualizationOpacity)`
blends all deck FBOs back-to-front as before, then — if `visualizationOpacity > 0` — blits
`vizFbo` on top as a final pass using the same shared blit shader. Driven from `App.svelte`'s
`frame()` loop, which renders the visualization once per frame (if `session.visualization`
is set) before calling `composite()`, independent of the per-deck video-upload loop.

Standard uniforms fed to every visualization shader: `u_time`, `u_resolution`,
`u_bass`/`u_mid`/`u_high` (from `AudioAnalysis`, max-across-playing-decks), plus any custom
uniforms declared on `Visualization.uniforms`.

**UI**: controls live in `src/components/VisualizationPanel.svelte` (shader picker + opacity
slider), toggled from a toolbar button in `App.svelte` — mirrors the existing `Audio`/`Queue`
panel-toggle pattern. `DeckCard.svelte` no longer has any shader-picker UI.

## Directory structure

```
cuemark/
  src/                          # Frontend (TypeScript/Svelte 5)
    main.ts                     # Svelte mount entry point
    App.svelte                  # Root component — deck grid + toolbar
    app.css                     # Global dark UI styles
    lib/
      state/
        types.ts                # Deck, Session, AudioAnalysis interfaces
        session.ts              # Svelte writable store + addDeck/updateDeck/setCrossfaderMapping/etc.
      renderer/
        fbo.ts                  # DeckFBO — allocates WebGL texture + framebuffer
        compositor.ts           # Compositor — syncDecks(), composite()
        seekBus.ts              # Module-level registry: video elements + audio clock cache; seekDeck() / getDeckTime() / setDeckAudioTime()
      audio/
        pipeline.ts             # Typed TS wrappers around all Rust audio Tauri commands (audioLoad, audioPlay, …)
        analyzer.ts             # AudioAnalyzer — Web Audio API FFT (waveform analysis only; not used for playback)
        waveform.ts             # analyzeFile() → calls audio_analyze_file Tauri command (Rust/GStreamer); computeWaveform() for AudioBuffer; amplitude color LUTs
        bpm.ts                  # detectBpm(peaks, peaksPerSecond) — energy-onset histogram; tapTempo(timestamps[])
        audioSettings.ts        # Svelte stores: mainOutputDeviceIds, cueOutputDeviceId, cueGain
      midi/
        handler.ts              # Tauri IPC listener → session mutations
    components/
      DeckCard.svelte           # Per-deck controls: transport, hot cues, BPM/Master/Sync, loop in/out + bar presets, sliders
      Crossfader.svelte         # Hardware crossfader UI — deck selectors (left/right), slider, Visual/Audio toggles
      WaveformCanvas.svelte     # Per-deck waveform: overview + zoom (16s window); loop region highlight; fires onBpmDetected callback
      VisualizationPanel.svelte # Global visualization shader picker + opacity slider (toggled from toolbar)
  src-tauri/                    # Rust backend (Tauri 2)
    src/
      main.rs                   # Binary entry point
      lib.rs                    # Tauri builder + setup; registers all Tauri commands
      midi.rs                   # midir listener → MidiAction events
      audio/                    # GStreamer audio backend
        mod.rs                  # AudioManager (Mutex-wrapped), AudioState type, all Tauri command handlers
        pipeline.rs             # DeckAudioPipeline — per-deck GStreamer graph (uridecodebin→volume→sink)
        mixer.rs                # MasterMix — master volume + cue routing
        devices.rs              # list_audio_devices() — PipeWire/PulseAudio sink enumeration
        analysis.rs             # Audio analysis (FFT, peak detection)
        record.rs               # RecordingSink — audio recording (Opus/FLAC)
    capabilities/
      default.json              # Tauri 2 capability config
    icons/                      # App icons (placeholder PNGs)
    build.rs
    Cargo.toml
    tauri.conf.json
  index.html
  package.json
  vite.config.ts
  tsconfig.json
  svelte.config.js
  todo.md
  journal.md
```

## Development phases

### Phase 1 — Two decks, crossfader, MIDI
- Load video clips to deck-0 and deck-1
- Loop playback, crossfade (video + audio)
- Hercules controller: jog wheels, crossfader, play/pause, volume faders
- Fullscreen output to display 2

### Phase 2 — Audio-reactive visuals
- Global visualization layer (composited above all decks, see "Visualization layer" above)
- FFT uniforms fed to shader (bass/mid/high, waveform)
- Built-in shaders: plasma, tunnel, particle field, feedback, scope
- BPM detection

### Phase 3 — Polish
- MIDI learn mode
- Shader effect overlays on video
- Media browser / clip library
- Remote control (network, phone as secondary)

## N-deck guarantee

Every layer is deliberately free of hardcoded deck counts:

| Concern | File | Mechanism |
|---|---|---|
| Data model | `src/lib/state/types.ts` | `Session.decks: Deck[]` — no count anywhere |
| Session store | `src/lib/state/session.ts` | `addDeck()` / `removeDeck()` / `updateDeck(id, patch)` by string ID |
| Compositor | `src/lib/renderer/compositor.ts` | `syncDecks(ids[])` allocates one FBO per deck; `composite(decks[])` iterates all |
| UI | `src/App.svelte` | `{#each $session.decks as deck (deck.id)}` — `+ Deck` button in toolbar |
| Seek | `src/lib/renderer/seekBus.ts` | `Map<deckId, HTMLVideoElement>` — `seekDeck(id, t)` works for any deck ID |
| MIDI | `src-tauri/src/midi.rs` | `MidiMap: HashMap<(u8,u8), ControlBinding>` — bindings reference deck IDs as strings |

The crossfader maps to two *named* deck IDs (`crossfaderMapping.left/right`), not indices 0 and 1.
Adding a third deck and reassigning the crossfader mapping is fully supported.

## Running

```
cargo tauri dev        # starts Vite dev server + Tauri window
npm run check          # TypeScript + Svelte type check
cd src-tauri && cargo check   # Rust type check only
```

**Dev server lifecycle**: `cargo tauri dev` watches frontend files and hot-reloads them instantly.
Rust changes (`src-tauri/`) require a full recompile — Tauri detects them and rebuilds automatically,
but **the old binary keeps running until the rebuild finishes and the window restarts**.
If managing the dev server from Claude Code: kill the background process before making Rust changes,
then restart after. A change that was edited but never recompiled has no effect at runtime.

**First-time / new machine setup** (in addition to Rust + Node toolchains):
```bash
# GStreamer dev headers — runtime packages alone aren't enough
sudo apt install \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-pipewire   # optional: enables device-specific routing

npm install                              # JS deps (node_modules not committed)
cargo install tauri-cli --version "^2"  # CLI subcommand; compiles from source (~5 min)
```

## Logging

`tauri-plugin-log` is wired up unconditionally in `lib.rs` `run()` (not gated to debug builds), at
`LevelFilter::Info`, targeting both stdout and the platform log directory. All backend `eprintln!`/
`println!` call sites (audio pipeline, MIDI, device enumeration, analysis) use `log::info!`/`warn!`/
`error!` instead, so output lands in the log file regardless of how the app was launched — including
from a desktop launcher with no attached terminal.

Log file: `~/.local/share/com.cuemark.app/logs/cuemark.log` (rotates per Tauri's default log plugin
behavior). Tail it live to see MIDI events, GStreamer bus messages, and pipeline state changes:
```bash
tail -f ~/.local/share/com.cuemark.app/logs/cuemark.log
```

## Desktop launcher (GNOME)

Mirrors the Fieldnote pattern: build a release binary, symlink it onto `PATH`, and hand-write a
`.desktop` entry pointing at the symlink — no `.deb` packaging needed.

```bash
npm run tauri build -- --no-bundle    # npm run build + cargo build --release, no installer packaging
ln -sf "$(pwd)/src-tauri/target/release/cuemark" ~/.local/bin/cuemark
mkdir -p ~/.local/share/icons/hicolor/{32x32,128x128}/apps
cp src-tauri/icons/32x32.png ~/.local/share/icons/hicolor/32x32/apps/cuemark.png
cp src-tauri/icons/128x128.png ~/.local/share/icons/hicolor/128x128/apps/cuemark.png
update-desktop-database ~/.local/share/applications/
```

The `.desktop` file lives at `~/.local/share/applications/cuemark.desktop` (`Exec=cuemark`, relying on
`~/.local/bin` being on `PATH`). After any Rust or frontend change meant for the launcher build, rerun
`npm run tauri build -- --no-bundle` — the symlink means no reinstall step is needed, just relaunch from
the app grid (or `gtk-launch cuemark`) to pick up the new binary.

## Adding or re-calibrating a MIDI controller

To map a new controller or verify an existing one:

1. Add a one-line debug print inside the MIDI callback in `midi.rs` (before the map lookup):
   ```rust
   eprintln!("[midi] raw: msg[0]=0x{:02X} d1={} d2={}", msg[0], msg[1], msg[2]);
   ```
2. Run `cargo tauri dev` and wiggle each physical control. The terminal shows the raw bytes.
3. `msg[0]` is the **full status byte** — high nibble = message type (`0x90`=Note On, `0xB0`=CC), low nibble = MIDI channel. Keep the full byte as the map key; do **not** mask off the channel nibble — DJ controllers use different channels for left/right decks.
4. Identify 14-bit CC pairs: if two CC messages fire together where `d1_B = d1_A + 32`, the coarse (MSB) is `d1_A` and the fine (LSB) is `d1_B`. Map the MSB and ignore the LSB.
5. Add entries to `hercules_starlight_map()` (or a new `foo_map()` function) using `(msg[0], d1)` as the key.
6. Remove the debug print when done.

## Integration: Digger

Media library management lives in a **separate project** (`~/repos/digger`).
Cuemark does not embed a media browser — Digger owns that concern.

**What Digger provides** (FastAPI REST at `http://localhost:8200` by default):

| Endpoint | Used for |
|---|---|
| `GET /queue/next` | Weighted-random track suggestion to push to the cuemark queue |
| `GET /search?q=` | Quick track search from the cuemark toolbar |
| `GET /tracks/{id}/cuemark` | Deck-ready payload: `filePath`, `cuePoint`, `hotCues[]` |
| `POST /tracks/{id}/markers` | Write cue/hot-cue positions back after editing in cuemark |

The `/cuemark` payload maps directly to cuemark's `Deck` source interface:
```json
{ "filePath": "/media/charles/music/artist/track.mp4", "cuePoint": 4.2, "hotCues": [32.0, 128.5] }
```
File preference in Digger: video > audio > any. Marker mapping: first `cue` → `cuePoint`, first 3 `hot_cue` → `hotCues[]`.

**What cuemark owns:**
- Current play queue — ordered list of upcoming loads; may be populated from Digger or manually
- Session playback history — what has played this session (deck, title, artist, timestamp)
- Runtime cue/hot-cue state; persisting them across sessions = push back to Digger markers API

**Boundary rules:**
- Cuemark calls Digger; Digger never calls cuemark
- Graceful degradation: if Digger is unreachable, drag-and-drop and manual load still work
- No embedded file browser in cuemark

## Skills

Project-specific skills live in `skills/`. Load one with `/audio-debugging` (or via the Skill tool) when needed — don't load them on every session.

| Skill | When to load |
|---|---|
| `audio-debugging` | GStreamer bus errors, rate-change issues, layered/detuned audio, pipeline recovery |
| `run-app` | Launch and monitor the app; stop/restart for Rust changes; read log patterns |
| `verify-ui` | Screenshot/click/inspect the real webview headlessly via tauri-driver + Xvfb, without touching the user's live desktop session |

`scripts/perf-idle-test.sh` automates a CPU regression check on top of `verify-ui`'s setup —
samples `WebKitWebProcess` CPU% across empty/paused/playing scenarios. Run it after touching
the render loop (`App.svelte` `frame()`), `WaveformCanvas`, or `DeckCard`'s preview canvas.

## Constraints

- No hardcoded 2-deck limit — `Session.decks` is always an array
- Cross-platform: avoid platform-specific code outside Tauri's abstraction layer
- Wayland primary target; X11 fallback via GTK
- Open source goal — keep dependencies permissively licensed
