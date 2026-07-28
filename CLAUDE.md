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

**Audio is the master clock.** The `<video>` element is muted and used only for frame decode; the RAF loop
integrates GStreamer position deltas (via `contentPosTracker`) to recover actual content position at
`deck.playbackRate`, since `query_position` always returns wall-clock stream time. Rate changes go through
the `pitch` (soundtouch) element's `tempo` property (0.1–4.0) — pitch-preserving, no seek/flush needed.
Device routing defaults to `autoaudiosink`, or a specific `pipewiresink target-object=<node-name>`.

**Full gotchas and rationale** — position-tracking drift math, the `pendingSeekTarget` seek-race filter,
why `v.playbackRate` writes must be rAF-throttled, rate-then-seek ordering, EOS handling, PipeWire quantum
sizing, preroll, the `uridecodebin` video-decoder-skip signal, and the tee/`async=false` sink topology:
`docs/design/av-sync-architecture.md`. **Read it before touching** video playback, seeking, rate changes,
or the MIDI-to-audio path — several of these are subtle, previously-fixed races that are easy to reintroduce.

### Rendering pipeline

```
<video> element (muted)
  └─► drawImage() ──► scratch HTMLCanvasElement (per FBO)
        └─► texImage2D (UNPACK_FLIP_Y_WEBGL=true) ──► WebGL texture
              └─► [FBO N] ──► alpha composite ──► preview canvas + output window
```

Each FBO renders at full output resolution. Compositor alpha-blends decks back-to-front by `opacity`.
WebGL texture upload uses `UNPACK_FLIP_Y_WEBGL=true` (HTML canvas Y=0 is top; WebGL texture Y=0 is bottom).
The crossfader is a UI/MIDI convenience that drives two selected decks' opacities inversely — not a
structural field in the data model.

**`WEBKIT_DISABLE_DMABUF_RENDERER=1` must be set in `main.rs`** before `cuemark_lib::run()` — prevents
VA-API DMA-BUF canvas corruption (decoded frames render as random static without it). Also demote broken
VA-API decoders via `GST_PLUGIN_FEATURE_RANK` in `main.rs` (currently
`vaav1dec:0,vaapiav1dec:0,vah264dec:0,vaapih264dec:0`). See `audio-debugging` skill for
the full VA-API investigation, debugging tips, and env-var override pitfalls.

**Waveform analysis uses `audio_analyze_file` Tauri command** (Rust/GStreamer, `analysis.rs`), not
`decodeAudioData` — avoids VA-API corruption in the separate WebKitWebProcess. It returns
`{ peaks, envelope }` (30/s display peaks + 210/s RMS envelope) used by `detectBeatGrid()` (`bpm.ts`)
to fit a fractional BPM and beat-level grid anchor, auto-populating `deck.bpm`/`deck.downbeat` on load.
A saved grid (DeckCard SET BEAT button) beats the auto-fit — see `gridSource.ts`. `Session.snapToBeat`
(SNAP toolbar toggle) routes seeks/hot-cues/loop points through `quantizeToGrid()` in `seekBus.ts`.

**Canvas sizing rule — always use JS, never rely on scoped CSS width**: WebKitGTK does not reliably
apply CSS width to a `<canvas>` inside a flex child (falls back to the 300px intrinsic default).
Every canvas must size its pixel buffer via a `ResizeObserver` + `c.style.width/height` set in a
`resize()` function — never via CSS `width:`. Reassigning `canvas.width`/`height` resets 2D context
state (re-apply `imageSmoothingQuality` after every resize).

**Full gotchas and rationale** — the grid-persistence trust-flag bug, the RAF actual-change-check
discipline, why MIDI-driven `syncVideoElements` must be rAF-throttled, the 14-bit fader tolerance fix,
and the `audioSync.ts` Svelte-store-bypass pattern for continuous MIDI controls:
`docs/design/av-sync-architecture.md`. **Read it before touching** the render loop (`App.svelte`
`frame()`), `WaveformCanvas`, grid persistence, or the MIDI handler's continuous controls.

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
  volume: number          // 0–1 post-fader level (driven by crossfader); effective audio = gain × volume × masterVolume
  opacity: number         // 0–1 visual compositor weight
  loop: boolean
  cuePoint: number        // seconds
  hotCues: number[]       // up to 4 time markers
  bpm: number | null      // fractional (beat-grid fit) or tapped BPM for this deck
  downbeat: number | null // beat-level grid anchor (seconds); auto-set from the grid fit on load
  loopIn: number | null   // custom loop region start (seconds); null = full track
  loopOut: number | null  // custom loop region end (seconds); null = full track
  // When loop=true and both loopIn/loopOut are set, ontimeupdate seeks back to loopIn
  // at loopOut (native video.loop is disabled in that case — App.svelte manages it).
}

interface Session {
  decks: Deck[]           // ordered array; render back-to-front
  masterVolume: number
  bpm: number | null      // master/reference BPM; set via tap tempo or "Main Beat" button
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
        bpm.ts                  # detectBeatGrid(envelope, rate) — fractional BPM + grid phase (comb fit); detectBpm() integer fallback; tapTempo()
        gridSource.ts           # Per-deck (deckId → trusted filePath) map gating saved-grid vs auto-fit precedence; see "Grid persistence" gotcha above
        audioSettings.ts        # Svelte stores: mainOutputDeviceIds, cueOutputDeviceId, cueGain
      midi/
        handler.ts              # Tauri IPC listener → session mutations
    components/
      DeckCard.svelte           # Per-deck controls: transport, hot cues, BPM/Main Beat/Sync, loop in/out + bar presets, sliders
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
        mixer.rs                # MasterMix — stub for future shared audiomixer topology (not yet active)
        devices.rs              # list_audio_devices() — PipeWire/PulseAudio sink enumeration
        analysis.rs             # Audio analysis (FFT, peak detection)
        record.rs               # RecordingSink — audio recording (Opus/FLAC)
      grid_store.rs             # grid_get_saved/grid_save Tauri commands — local sidecar (grids.json) for saved bpm/downbeat
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
  docs/
    design/                     # Feature/architecture design docs (see below)
    upstream/                   # Draft WebKitGTK bug reports (with evidence + reproducers)
  scripts/
    probes/                     # Headless WebKitGTK feature probes (python3-gi; see verify-ui skill)
```

## Active architecture plan (2026-07-25)

The WebKitGTK freeze mechanisms (see `skills/audio-debugging` "UI frozen solid" entry)
are being fixed structurally, not mitigated further. Read these before touching video
playback, the drift-resync path, or anything freeze-related:

- `docs/design/freeze-watchdog.md` — **build first**: Rust heartbeat watchdog +
  session-of-record + webview reload recovery.
- `docs/design/webcodecs-video-path.md` — **build second**: replace the `<video>`
  element with WebCodecs `VideoDecoder` slaved to the Rust audio clock. Feasibility
  spike passed (results table in the doc).
- `docs/design/native-output-pipeline.md` — shelved escalation path; do not start
  without an explicit decision.

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
npm test               # vitest — beat-grid / BPM algorithm tests (bpm.test.ts)
cd src-tauri && cargo check   # Rust type check only
cd src-tauri && cargo test    # includes analysis.rs decode smoke test (needs GStreamer)
```

**Dev server lifecycle**: `cargo tauri dev` watches frontend files and hot-reloads them instantly.
Rust changes (`src-tauri/`) require a full recompile — Tauri detects them and rebuilds automatically,
but **the old binary keeps running until the rebuild finishes and the window restarts**.
If managing the dev server from Claude Code: kill the background process before making Rust changes,
then restart after. A change that was edited but never recompiled has no effect at runtime.

**The desktop-launcher release binary is a separate build that never auto-rebuilds** — unlike
`cargo tauri dev`, nothing watches `src-tauri/` for the launcher build (`~/.local/bin/cuemark`,
see `run-app` skill's "Desktop launcher" section). It only updates when someone explicitly runs
`npm run tauri build -- --no-bundle`. Caught stale by a month on 2026-07-26: a live-session freeze
was diagnosed against a binary built 2026-06-22, missing the *entire* webcodecs-video-path effort
(phases 1-5) and everything after — the freeze was old, already-fixed behavior, not a regression.
**Rebuild the launcher binary periodically, and always after a troubleshooting/design-doc session
that touched `src-tauri/`, before trusting a direct (non-`cargo tauri dev`) launch to reflect
current code.**

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

Several automated test scripts build on `verify-ui`'s setup (tauri-driver + Xvfb +
`VITE_ENABLE_DEBUG_HOOK=1`):

| Script | When to run |
|---|---|
| `scripts/perf-idle-test.sh [video]` | CPU regression — samples `WebKitWebProcess` CPU% across empty/paused/playing scenarios. Run after touching the render loop (`App.svelte` `frame()`), `WaveformCanvas`, or `DeckCard`'s preview canvas. |
| `scripts/latency-test.sh <video> [backend]` | Full deck workflow — load track → waveform renders → position clock advances → `audio_set_rate` IPC latency stats → 200-event MIDI-rate burst with CPU check. `backend` is `legacy` (default) or `webcodecs` (docs/design/webcodecs-video-path.md phase 2 A/B toggle — added phase 4); on webcodecs the "video position" checks read `getCodecFramePts()` instead of `getVideoTime()` and a final step confirms zero legacy `<video>` DOM writes for the whole run. Run after touching the MIDI handler, `audioSync.ts`, or the GStreamer audio pipeline. |
| `scripts/rehydration-test.sh <video>` | `docs/design/freeze-watchdog.md` phase 2 gate — forced-reload session rehydration (deck/bpm/downbeat intact, audio position continuous, no stray `audioLoad`). Run after touching `session_store.rs`, `sessionRecovery.ts`, or `App.svelte`'s onMount rehydration path. |
| `scripts/watchdog-test.sh <video>` | `docs/design/freeze-watchdog.md` phase 3 gate — tiered recovery (`kill -STOP`/`freezeMainThread(0)`/`kill -KILL`) plus a 15s false-positive smoke check. Run after touching `watchdog.rs` or the recovery/adoption path. |
| `scripts/watchdog-soak-test.sh <video> [seconds]` | The design doc's full 10-minute false-positive soak (default 600s) — looped playback + a MIDI-rate burst every 60s, asserts zero watchdog triggers. Run before relying on recovery in prod, not on every change. |

## Constraints

- No hardcoded 2-deck limit — `Session.decks` is always an array
- Cross-platform: avoid platform-specific code outside Tauri's abstraction layer
- Wayland primary target; X11 fallback via GTK
- Open source goal — keep dependencies permissively licensed
- **Never use WebCodecs `VideoEncoder`** — `isConfigSupported()` or `configure()`
  SIGABRTs WebKitWebProcess on WebKitGTK 2.52.3 (100% reproducible; see
  `docs/upstream/videoencoder-crash.md`). Recording stays in Rust (`record.rs`).
  `VideoDecoder` is fine and is the basis of `docs/design/webcodecs-video-path.md`.
