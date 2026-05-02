# todo

What about   Phase nudge (brief rate spike for beat phase alignment) is the
  one todo
    sub-item deferred — it needs beat phase tracking, which is a non-trivial
    addition.
  What is involved with beat phase tracking?

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
