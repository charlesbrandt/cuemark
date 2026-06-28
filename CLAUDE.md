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
    → capsfilter(48kHz) → pitch(tempo) → output_queue(100ms) → tee
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
`audioGetPosition(deckId)` polls the GStreamer position (one in-flight IPC per deck via `pendingPos` map).
**`query_position` always returns wall-clock stream time** — the soundtouch `tempo` property never issues a
rate-seek, so the GStreamer segment rate stays 1.0 regardless of `deck.playbackRate`. To recover actual content
position, `App.svelte` integrates per-frame deltas at `deck.playbackRate` via the `contentPosTracker` Map:
`contentPos += Δaudio × playbackRate`. A jump > 500 ms between consecutive frames signals a seek, after which
`audioPos` IS the correct content position. **`resolvedRate` is read at IPC resolution time** (not at IPC start
time) — if the rate changed while the call was in flight (e.g. 2× → 1×), using the start rate would overshoot
`contentPos` by `IPC-latency × rate-diff`. The computed `contentPos` is written to `setDeckAudioTime(deckId,
contentPos)` in `seekBus.ts` where the waveform reads it, and snapped to `v.currentTime` if drift exceeds 80 ms.

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
When an `EOS` message arrives the thread sets an `Arc<AtomicBool>` (`at_eos`). The next call to `play()`
checks this flag and seeks back to zero before resuming, so the track replays cleanly instead of stalling
at end-of-stream. The bus thread is stopped via `bus.set_flushing(true)` before pipeline teardown and in
`Drop`.

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

### Rendering pipeline

```
<video> element (muted)
  └─► drawImage() ──► scratch HTMLCanvasElement (per FBO)
        └─► texImage2D (UNPACK_FLIP_Y_WEBGL=true) ──► WebGL texture
              └─► [FBO N] ──► alpha composite ──► preview canvas + output window
```

Each FBO renders at full output resolution. Compositor alpha-blends decks back-to-front by `opacity`.

**`WEBKIT_DISABLE_DMABUF_RENDERER=1` must be set in `main.rs`** before `cuemark_lib::run()` — prevents
VA-API DMA-BUF canvas corruption (decoded frames render as random static without it). Also demote broken
VA-API decoders via `GST_PLUGIN_FEATURE_RANK` in `main.rs` (currently
`vaav1dec:0,vaapiav1dec:0,vah264dec:0,vaapih264dec:0`) — this GPU's DMA-BUF export is broken; software
fallback works correctly with `WEBKIT_DISABLE_DMABUF_RENDERER=1` set. See `audio-debugging` skill for
the full VA-API investigation, debugging tips, and env-var override pitfalls.

**Waveform analysis uses `audio_analyze_file` Tauri command** (Rust/GStreamer, `analysis.rs`), not
`decodeAudioData` — avoids VA-API corruption in the separate WebKitWebProcess.

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
shared Maps. The MIDI handler calls them directly (before any store update); the `App.svelte
$effect` calls the same functions for UI-slider-triggered changes. For continuous controls
(rate, gain, volume, crossfader), `queueDeckPatch()`/`queueCrossfader()` buffer the latest
value and flush to the store once per rAF — capping Svelte re-renders at 60fps instead of 200/sec.

**`$effect` reading `$session.decks` fires at MIDI event rates**: for high-frequency continuous
controls (rate/gain/volume), a last-value Map guard alone is not enough — those must go through
`audioSync.ts` directly from the MIDI handler, not via the store at all. `audioSetCue` still
uses the guard-only pattern (fires infrequently, on button press).

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

## Skills

Project-specific skills live in `skills/`. Load one with `/skill-name` (or via the Skill tool) when
needed — don't load them on every session.

| Skill | When to load |
|---|---|
| `audio-debugging` | GStreamer bus errors, rate-change issues, layered/detuned audio, pipeline recovery, VA-API details |
| `run-app` | Launch and monitor the app; stop/restart for Rust changes; log patterns; GNOME desktop launcher |
| `verify-ui` | Screenshot/click/inspect the real webview headlessly via tauri-driver + Xvfb |
| `midi` | Hercules Starlight channel layout, full control map, adding or re-calibrating a controller |
| `digger-integration` | Digger API endpoints, WebSocket queue updates, cuemark/Digger boundary rules |

Two automated test scripts build on `verify-ui`'s setup (tauri-driver + Xvfb +
`VITE_ENABLE_DEBUG_HOOK=1`):

| Script | When to run |
|---|---|
| `scripts/perf-idle-test.sh [video]` | CPU regression — samples `WebKitWebProcess` CPU% across empty/paused/playing scenarios. Run after touching the render loop (`App.svelte` `frame()`), `WaveformCanvas`, or `DeckCard`'s preview canvas. |
| `scripts/latency-test.sh <video>` | Full deck workflow — load track → waveform renders → video plays → `audio_set_rate` IPC latency stats → 200-event MIDI-rate burst with CPU check. Run after touching the MIDI handler, `audioSync.ts`, or the GStreamer audio pipeline. |

## Constraints

- No hardcoded 2-deck limit — `Session.decks` is always an array
- Cross-platform: avoid platform-specific code outside Tauri's abstraction layer
- Wayland primary target; X11 fallback via GTK
- Open source goal — keep dependencies permissively licensed
