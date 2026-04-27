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
- **`<video>` element → 2D canvas → texImage2D** — video decode into WebGL texture via a scratch canvas intermediary (direct video→texImage2D triggers SIGTRAP assertion failures in WebKitGTK; see `fbo.ts`)
- **Vite dev middleware** — in dev mode, local video files are served as `http://localhost:1420/media/<abs-path>` by a Node.js middleware in `vite.config.ts`; GStreamer's `souphttpsrc` speaks plain HTTP fine. In production the Rust `media://` custom scheme is used instead. Never use `asset://` or `file://` from an `http:` origin — WebKit blocks them silently.

## Architecture

### Rendering pipeline

```
<video> element
  └─► drawImage() ──► scratch HTMLCanvasElement (per FBO)
        └─► texImage2D (UNPACK_FLIP_Y_WEBGL=true) ──► WebGL texture
              └─► [FBO N] ──► alpha composite ──► preview canvas + output window
```

Each FBO renders at full output resolution. Compositor alpha-blends decks back-to-front by `opacity`.

**WebGL Y-flip**: HTML canvas Y=0 is top; WebGL texture Y=0 is bottom. `UNPACK_FLIP_Y_WEBGL=true`
corrects this on upload so video appears right-side up.
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
  src/                          # Frontend (TypeScript/Svelte 5)
    main.ts                     # Svelte mount entry point
    App.svelte                  # Root component — deck grid + toolbar
    app.css                     # Global dark UI styles
    lib/
      state/
        types.ts                # Deck, Session, AudioAnalysis interfaces
        session.ts              # Svelte writable store + addDeck/updateDeck/etc.
      renderer/
        fbo.ts                  # DeckFBO — allocates WebGL texture + framebuffer
        compositor.ts           # Compositor — syncDecks(), composite()
        seekBus.ts              # Module-level video element registry; seekDeck() / getDeckTime()
      audio/
        analyzer.ts             # AudioAnalyzer — Web Audio API FFT
      midi/
        handler.ts              # Tauri IPC listener → session mutations
    components/
      DeckCard.svelte           # Per-deck controls (opacity, volume, rate, play, loop, cue set/jump)
      Crossfader.svelte         # Hardware crossfader UI (maps to two deck opacities)
  src-tauri/                    # Rust backend (Tauri 2)
    src/
      main.rs                   # Binary entry point
      lib.rs                    # Tauri builder + setup
      midi.rs                   # midir listener → MidiAction events
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

## MIDI calibration

The CC/note numbers in `src-tauri/src/midi.rs → hercules_starlight_map()` are initial estimates.
Verify against your unit:

```
aconnect -l                   # find the Hercules port number
aseqdump -p <port>            # wiggle each control, read the output
```

Then update the `(0x90, ...)` / `(0xB0, ...)` keys in the map to match.

## Constraints

- No hardcoded 2-deck limit — `Session.decks` is always an array
- Cross-platform: avoid platform-specific code outside Tauri's abstraction layer
- Wayland primary target; X11 fallback via GTK
- Open source goal — keep dependencies permissively licensed
