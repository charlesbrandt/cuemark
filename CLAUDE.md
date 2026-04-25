# Cuemark

VJ / live A/V mixing software for Linux. Built for live performance: garage dance parties,
projector output, MIDI controller integration. Open source goal.

Domain: cuemark.com (Charles Brandt's former DJ name)

## Tech stack

- **Tauri** (Rust backend + WebKit frontend) — cross-platform, Wayland-native on Linux via GTK4
- **WebGL** — GPU-accelerated rendering, FBO-per-deck compositing
- **Web Audio API** — audio playback + FFT analysis for audio-reactive visuals
- **GLSL shaders** — effects and audio-reactive visualizations
- **Rust `midir` crate** — MIDI input (Web MIDI API unreliable in WebKitGTK); events piped to frontend via Tauri IPC
- **`<video>` element → texImage2D** — hardware-accelerated video decode into WebGL texture (WebKitGTK uses GStreamer under the hood)

## Architecture

### Rendering pipeline

```
decks[0] opacity=1.0 ──► [FBO 0] ──┐
decks[1] opacity=0.6 ──► [FBO 1] ──┤──► alpha composite ──► Output canvas (fullscreen, display 2)
decks[N] opacity=...  ──► [FBO N] ──┘

Control UI: preview FBO per deck + composite preview
```

Each FBO renders at full output resolution. Compositor alpha-blends decks back-to-front by `opacity`.
The crossfader is a UI/MIDI convenience that drives two selected decks' opacities inversely — not a
structural field in the data model.

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
  volume: number          // 0–1 audio
  opacity: number         // 0–1 visual compositor weight
  loop: boolean
  cuePoint: number        // seconds
  hotCues: number[]       // up to 3 time markers
}

interface Session {
  decks: Deck[]           // ordered array; render back-to-front
  masterVolume: number
  bpm: number | null
  crossfaderMapping: {    // which two decks the hardware crossfader controls
    left: string          // deck id
    right: string         // deck id
  }
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

Rust backend (`midir`) receives raw MIDI → maps to structured actions → emits via Tauri `emit()` → frontend applies to session state. MIDI mappings reference `deckId` strings.

## MIDI controller

**Hercules DJ Control Starlight** (USB)

| Controller | Action |
|---|---|
| Jog wheel L | Deck-0 playback rate / scrub |
| Jog wheel R | Deck-1 playback rate / scrub |
| Crossfader | deck-0/deck-1 opacity inverse |
| Channel fader L | Deck-0 volume |
| Channel fader R | Deck-1 volume |
| Play/Pause L/R | Deck play toggle |
| Cue L/R | Jump to cue point |
| Hot cues (3×2) | Jump to / set hot cue |
| Loop L/R | Toggle loop |
| EQ Bass L | Shader `u_bass_gain` / effect param |

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
  src/                  # Frontend (TypeScript/Svelte)
    lib/
      renderer/         # WebGL FBO, compositor, shader runner
      audio/            # Web Audio API, FFT analysis
      midi/             # Tauri IPC MIDI event handler, mapping
      state/            # Session store
    components/         # UI components
  src-tauri/            # Rust backend
    src/
      midi.rs           # midir integration
      main.rs
  shaders/              # Built-in GLSL visualizations
  docs/                 # Design notes
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

## Constraints

- No hardcoded 2-deck limit — `Session.decks` is always an array
- Cross-platform: avoid platform-specific code outside Tauri's abstraction layer
- Wayland primary target; X11 fallback via GTK
- Open source goal — keep dependencies permissively licensed
