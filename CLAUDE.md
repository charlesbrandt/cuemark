# Cuemark

VJ / live A/V mixing software for Linux. Built for live performance: garage dance parties,
projector output, MIDI controller integration. Open source goal.

Domain: cuemark.com (Charles Brandt's former DJ name)

## Tech stack

- **Tauri** (Rust backend + WebKit frontend) — cross-platform, Wayland-native on Linux via GTK4
- **WebGL** — GPU-accelerated rendering, FBO-per-deck compositing
- **GStreamer** (Rust, `gstreamer` + `gstreamer-audio` crates, `features = ["v1_18"]` required) — audio playback, gain/EQ, device routing, headphone cue mix, recording. Each deck has its own `DeckAudioPipeline` (uridecodebin → audioconvert → audioresample → volume → pipewiresink/autoaudiosink). Audio is the master clock; video element syncs to it.
- **Web Audio API** — waveform peak extraction + FFT analysis for BPM detection and audio-reactive visuals (not used for playback)
- **GLSL shaders** — effects and audio-reactive visualizations
- **Rust `midir` crate** — MIDI input (Web MIDI API unreliable in WebKitGTK); events piped to frontend via Tauri IPC
- **`<video>` element → 2D canvas → texImage2D** — video decode into WebGL texture via a scratch canvas intermediary (direct video→texImage2D triggers SIGTRAP assertion failures in WebKitGTK; see `fbo.ts`). The `<video>` element is **muted** — audio is owned by the GStreamer pipeline.
- **Vite dev middleware** — in dev mode, local video files are served as `http://localhost:1420/media/<abs-path>` by a Node.js middleware in `vite.config.ts`; GStreamer's `souphttpsrc` speaks plain HTTP fine. In production the Rust `media://` custom scheme is used instead. Never use `asset://` or `file://` from an `http:` origin — WebKit blocks them silently.

## Architecture

### Audio pipeline

```
GStreamer (Rust, per deck):
  uridecodebin → audioconvert → audioresample → volume → pipewiresink / autoaudiosink
                                                             ↑               ↑
                                               device-specific sink    system default
```

`AudioManager` (held in Tauri managed state as `Mutex<AudioManager>`) owns all `DeckAudioPipeline` instances.
Tauri commands (`audio_load`, `audio_play`, `audio_pause`, `audio_seek`, `audio_set_rate`, `audio_set_gain`,
`audio_set_volume`, `audio_set_eq`, `audio_set_cue`, `audio_get_position`, `audio_set_master_volume`,
`audio_set_main_device`, `audio_set_cue_device`, `audio_set_cue_gain`, `audio_record_start/stop`) expose the
pipeline to the frontend. The frontend wrapper lives in `src/lib/audio/pipeline.ts`.

**Audio is the master clock.** The `<video>` element is muted and used only for frame decode. In the RAF loop,
`audioGetPosition(deckId)` polls the GStreamer position and snaps the video element's `currentTime` to it if
drift exceeds 80 ms — keeping the video texture in sync with what the audience hears.

**Device routing**: default output uses `autoaudiosink` (selects PipeWire/PulseAudio/ALSA automatically).
A specific sink is targeted via `pipewiresink target-object=<node-name>`; falls back to `autoaudiosink` if
the `gstreamer1.0-pipewire` plugin is absent.

**EOS handling**: Each `DeckAudioPipeline` spawns a background thread that watches the GStreamer bus.
When an `EOS` message arrives the thread sets an `Arc<AtomicBool>` (`at_eos`). The next call to `play()`
checks this flag and seeks back to zero before resuming, so the track replays cleanly instead of stalling
at end-of-stream. The bus thread is stopped via `bus.set_flushing(true)` before pipeline teardown and in
`Drop`.

**Rate changes — `INSTANT_RATE_CHANGE`**: `set_rate()` uses the GStreamer ≥ 1.18 `INSTANT_RATE_CHANGE`
seek flag, which adjusts playback speed in-place without flushing the pipeline — no audible click or
position jump during jog-wheel / tempo-fader moves. Falls back to a flush seek if the flag is unsupported.
Two guards prevent pipeline stalls: (1) a no-change guard compares against `applied_rate` (the rate last
confirmed in the pipeline) rather than the last requested value — so loading a new file while the rate is
non-1.0 correctly resets `applied_rate` to 1.0 and forces a re-apply; (2) a 100 ms throttle window limits
rate-change seeks to ~10/s, preventing the rAF loop from hammering GStreamer.

**Preroll**: `load()` waits synchronously (up to 5 s) for the pipeline to reach `PAUSED` before returning,
so callers can seek and play immediately without an extra wait.

### Rendering pipeline

```
<video> element (muted)
  └─► drawImage() ──► scratch HTMLCanvasElement (per FBO)
        └─► texImage2D (UNPACK_FLIP_Y_WEBGL=true) ──► WebGL texture
              └─► [FBO N] ──► alpha composite ──► preview canvas + output window
```

Each FBO renders at full output resolution. Compositor alpha-blends decks back-to-front by `opacity`.

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

**WaveformCanvas ResizeObserver — observe the wrapper, not the canvas**: The `ResizeObserver` in
`WaveformCanvas.svelte` observes the *wrapper div*, not the canvas itself. A canvas's default CSS
width is 300 px; observing the canvas directly causes the first callback to return `width=300` before
the flex layout resolves, producing a mismatched pixel buffer. Observing the wrapper div (whose size
is set by the flex container) gives the correct layout width immediately. Call `resize()` synchronously
after setting up the observer to catch cases where the observer fires asynchronously.

**Svelte CSS scoping for canvas elements**: Canvas layout styles (especially `width: 100%`) must be
declared in the component's own `<style>` block, not in global `app.css`. Global selectors apply
correctly in theory, but in practice the Svelte/WebKit combination does not reliably apply
`width: 100%` to a `<canvas>` from a global stylesheet when the canvas is inside a flex container
in a child component — the canvas falls back to its 300 px default CSS width, making waveforms
appear smooshed to the left and any absolute-positioned overlays misaligned. Rule: scope canvas
styles to the component that owns the canvas.

**MIDI-driven `syncVideoElements` must be rAF-throttled**: MIDI CC events arrive as separate
Tauri IPC macro-tasks, so `queueMicrotask` does not coalesce them. The 14-bit tempo fader can
fire 200+ events/second. Calling `v.play()` or setting `v.playbackRate` that frequently overloads
GStreamer's pipeline and causes playback to stall. Solution: use `requestAnimationFrame` as the
throttle gate so `syncVideoElements` runs at most once per rendered frame (≤ 60/s).

### Dual output

- Window 1 (control): deck previews, crossfader, media browser, MIDI status
- Window 2 (output): compositor result fullscreen on projector (display 2)

### Data model

```typescript
type DeckSource =
  | { type: 'video'; filePath: string; duration: number }
  | { type: 'shader'; fragmentSrc: string; uniforms: Record<string, number> }
  | null

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
| Hot cues L (1–4) | `(0x96, 0–3)` | HotCue deck-0 index 0–3 |
| Hot cues R (1–4) | `(0x97, 0–3)` | HotCue deck-1 index 0–3 |
| Shift + Hot cues L (1–4) | `(0x96, 8–11)` | HotCueSet deck-0 index 0–3 (stamp current time) |
| Shift + Hot cues R (1–4) | `(0x97, 8–11)` | HotCueSet deck-1 index 0–3 (stamp current time) |

**Shift note**: The Starlight handles Shift entirely in firmware — it does not pass a modifier flag through
MIDI. Instead, Shift+pad sends a different note number on the same channel (note += 8). No host-side
shift-state tracking is needed; the shifted notes map directly to `HotCueSet` bindings.

Intentionally unmapped: Headphone cue `(0x91/92,12)`, Bass/filter toggle `(0x90,1)`, Headphone volume `(0xB0,4)`, mode-switch buttons `(0x91,15/16)`.

Phase 2: MIDI learn mode (click control in UI, wiggle knob to map).

## Deck sources

Two modes per deck:

1. **Video clip** — load a file, loop, control playback rate. `<video>` element → WebGL texture.
2. **Shader visualization** — fullscreen GLSL quad with uniforms:
   - `u_time: float`
   - `u_bass: float`, `u_mid: float`, `u_high: float` (from AudioAnalysis)
   - `u_resolution: vec2`
   - Any custom uniforms declared in the shader

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
        seekBus.ts              # Module-level video element registry; seekDeck() / getDeckTime()
      audio/
        pipeline.ts             # Typed TS wrappers around all Rust audio Tauri commands (audioLoad, audioPlay, …)
        analyzer.ts             # AudioAnalyzer — Web Audio API FFT (waveform analysis only; not used for playback)
        waveform.ts             # computeWaveform() at 30 peaks/sec + pre-built amplitude color LUTs; analyzeFile() returns { peaks, bpm }
        bpm.ts                  # detectBpm(peaks, peaksPerSecond) — energy-onset histogram; tapTempo(timestamps[])
        audioSettings.ts        # Svelte stores: mainOutputDeviceId, cueOutputDeviceId, cueGain
      midi/
        handler.ts              # Tauri IPC listener → session mutations
    components/
      DeckCard.svelte           # Per-deck controls: transport, hot cues, BPM/Master/Sync, loop in/out + bar presets, sliders
      Crossfader.svelte         # Hardware crossfader UI — deck selectors (left/right), slider, Visual/Audio toggles
      WaveformCanvas.svelte     # Per-deck waveform: overview + zoom (16s window); loop region highlight; fires onBpmDetected callback
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
  shaders/                      # Built-in GLSL visualizations (Phase 2)
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
- Shader source type on a deck
- FFT uniforms fed to shader (bass/mid/high, waveform)
- Built-in shaders: plasma, tunnel, particle field
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

System dependencies required for the GStreamer audio backend:
```
sudo apt install \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-pipewire   # optional: enables device-specific routing
```

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

**What Digger provides** (FastAPI REST at `http://localhost:8000` by default):

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

## Constraints

- No hardcoded 2-deck limit — `Session.decks` is always an array
- Cross-platform: avoid platform-specific code outside Tauri's abstraction layer
- Wayland primary target; X11 fallback via GTK
- Open source goal — keep dependencies permissively licensed
