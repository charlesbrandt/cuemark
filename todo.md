# todo

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

### waveform display
- Full-track analysis on load: fetch file as ArrayBuffer (HTTP in dev, `readFile` Tauri command in prod)
  → `AudioContext.decodeAudioData()` → compute peak/RMS per ~1000 chunks → `Float32Array`
- New module `src/lib/audio/waveform.ts`: `computeWaveform(buffer, chunkCount)` → peaks
- New component `WaveformCanvas.svelte`: canvas element, draws peaks + colored playhead scrubber
- Mount one `WaveformCanvas` per deck; show above (or below) the deck card area
- Click on waveform seeks to that position (`seekDeck`)
- Draw cue point marker (white line) and hot cue markers (colored lines) on waveform
- Draw loop region as a translucent highlight when loop is active

### hot cue set/clear UI [done]
- DeckCard: row of 4 pad buttons labeled 1–4; empty = dim, occupied = green with timestamp
- Empty pad: click = stamp current time; occupied pad: click = jump, shift+click = re-stamp, right-click = clear
- MIDI `hot_cue` handler: seeks to `hotCues[index]` if set
- MIDI `hot_cue_set` handler: stamps `getDeckTime()` into `hotCues[index]`
- Shift+pad on Starlight: hardware sends note+8 on same channel → maps directly to HotCueSet (no host modifier state)
- Hot cue markers on waveform canvas: pending (see waveform display task)

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

### tap tempo + BPM detection
- Tap tempo button in toolbar: record timestamps of last 4+ taps → compute average interval → BPM
- Auto-detect on load: onset detection on waveform data → inter-beat intervals → BPM estimate
  (simple energy-peak approach is sufficient; no FFT-based autocorrelation needed for MVP)
- Per-deck BPM stored in `Deck` (add `bpm: number | null` to types.ts)
- `session.bpm` = master/reference BPM; per-deck shown in DeckCard

### beat sync
- "Sync" button per deck: sets `playbackRate` to `(deckBpm / masterBpm)` ratio
- "Master" toggle per deck: marks which deck is the BPM reference
- Phase nudge: brief ±playbackRate spike to align beat phase to the master deck
- MIDI: map Vinyl/Scratch button `(0x91/0x92, 3)` to sync toggle per deck

### N-bar quantized looping
- Loop in/out point model: add `loopIn: number | null`, `loopOut: number | null` to `Deck`
- Bar-length presets: 1/2, 1, 2, 4, 8 bars — compute `loopOut = loopIn + (barCount * beatsPerBar * secPerBeat)`
- UI: loop length selector buttons in DeckCard; loop region highlighted on waveform
- Requires per-deck BPM for bar-length calculation; manual loop in/out points work without BPM

---

## Batch C — Audio routing

### EQ per deck
- Three biquad filter nodes per deck in the Web Audio chain (low shelf, mid peak, high shelf)
- AudioAnalyzer needs to support per-deck source chains (currently single chain into one analyser)
- UI: three small knobs or sliders per deck (range ±12 dB)
- MIDI: Bass/Filter toggle `(0x90, 1)` could cycle EQ focus for the hardware knobs

### audio output device selection
- Enumerate `audiooutput` devices: `navigator.mediaDevices.enumerateDevices()`
- Settings panel (modal or sidebar): dropdown for main output device
- `AudioContext({ sinkId: deviceId })` — verify WebKitGTK support before relying on it
- Fallback: instruct user to route via system audio mixer if sinkId unsupported

### headphone cue / pre-listen
- Second `AudioContext` routed to headphone output device
- "CUE" button per deck routes that deck's pre-fader signal to headphone context
- Headphone gain separate from main volume
- Split-cue mode option: left ear = cued deck, right ear = main mix
- MIDI: Headphone Cue buttons `(0x91/0x92, 12)` → toggle cue for that deck

---

## Batch D — Shader visuals (Phase 2)

### shader deck source
- `DeckSource` type already has `{ type: 'shader'; fragmentSrc: string; uniforms: ... }`
- UI in DeckCard: "Load Shader" button (opens built-in picker or text editor)
- `FBO.renderShader(src, uniforms)`: compile + link fragment shader, draw fullscreen quad
- Uniforms: `u_time`, `u_resolution`, `u_bass`, `u_mid`, `u_high`

### audio-reactive shader uniforms
- `AudioAnalyzer.read()` feeds analysis each frame → compositor passes to shader FBOs
- Waveform as 1D texture (optional enhancement)

### built-in shader library
- Plasma / color wash
- Tunnel / radial zoom
- Particle field
- Feedback / echo trail
- VU bar / waveform scope

### shader overlays on video
- Per-deck effect chain: array of shader passes applied after video texture upload
- Blend mode selection per overlay (additive, multiply, screen, etc.)

---

## Batch E — Queue, history, and Digger integration

Media library management lives in `~/repos/digger` (FastAPI + SQLite, `http://localhost:8000`).
Cuemark does not embed a file browser — Digger feeds cuemark.

### play queue
- Sidebar panel: ordered list of upcoming tracks
- Items can be added from: Digger `GET /queue/next` suggestion, Digger search results, or
  OS drag-and-drop into the queue (not into a deck directly)
- Load to deck: clicking an item calls `GET /tracks/{id}/cuemark` → loads filePath +
  cuePoint + hotCues[] onto the target deck
- Drag-to-reorder; remove items from queue
- Auto-advance option: when a deck's clip ends, auto-load next queue item to that deck

### session playback history
- Running log of what has played this session: deck id, title, artist, timestamp, duration played
- Scrollable history panel (sidebar or below decks)
- "Re-add to queue" action per history entry
- "Push markers to Digger" — after editing cue/hot-cues on a loaded track, write them back
  via `POST /tracks/{id}/markers`; requires cuemark to track which Digger track ID is on each deck

### Digger connection
- Quick search widget in toolbar: text input → `GET /search?q=` → mini dropdown of results →
  click to add to queue
- Settings: configurable Digger base URL (default `http://localhost:8000`)
- Graceful degradation: if Digger is unreachable, show a notice; drag-and-drop and
  manual load still work unaffected

---

## Batch F — MIDI expansion

### MIDI output / LED control (Starlight)
- Add MIDI output port enumeration + connection in `midi.rs` (midir supports output)
- On startup: open Starlight output port; sending any Note On/Off typically hands LED control
  to software and stops the standalone light show
- Experiment to discover Starlight LED protocol: send Note On to output port; log which buttons
  light up at which note numbers
- Sync LEDs to app state: play button on → Note On `0x91/7`; loop on → Note On `0x91/5`; etc.
- Goal: static/off LEDs during performance so they don't distract

### MIDI learn mode
- Rust: always emit raw `midi-raw` events alongside mapped `midi-action` events
- Frontend: "MIDI Learn" mode button; clicking a mapped UI control → listens for next
  incoming `midi-raw` → saves `(status, d1) → action` mapping
- Custom mappings override the default Hercules map at runtime; persist to `~/.config/cuemark/midi-map.json`

### multi-controller support
- Open all connected MIDI input ports (not just the first/named one)
- Per-port mapping: if port name matches known controller, load that map; else load custom map
- UI: settings panel listing connected MIDI devices + their mapping files

---

## Batch G — Polish / Phase 3

### output window configuration
- Settings: output resolution (720p / 1080p / custom), aspect ratio, frame rate target
- Display selection: enumerate displays via Tauri, open output window on specified display
  (currently user manually moves window to projector)
- Fullscreen-on-open option (skip manual `F` press)

### project save / load
- Serialize session to JSON: deck sources, cue points, hot cues, BPMs, crossfader mapping
- Load: restore state, re-open video sources from stored paths
- Auto-save on exit; manual save/load via file picker

### pitch lock
- Preserve audio pitch when `playbackRate ≠ 1.0` (avoids chipmunk / slow-motion pitch shift)
- `video.preservesPitch = true` (already the browser default; verify in WebKitGTK)
- For extreme rates, AudioWorklet pitch correction may be needed

### key detection
- Detect musical key from audio on load (FFT-based chroma analysis or call ffprobe)
- Display key in Camelot/Open Key notation in DeckCard
- Pitch-shift recommendation for harmonic mixing

### remote control
- WebSocket server: small axum handler in Rust backend (Tauri plugin or manual setup)
- Phone-friendly minimal web UI: play/pause, crossfader, cue jump per deck
- OSC input as alternative transport (some setups prefer OSC over MIDI)

### video capture / recording
- Record compositor output to file via WebCodecs API (`VideoEncoder`) or Rust + ffmpeg
- Screenshot shortcut (capture current frame)
