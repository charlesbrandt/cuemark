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

### MIDI calibration
- Connect Hercules DJ Control Starlight
- Run `aseqdump` to find actual CC/note numbers
- Update `hercules_starlight_map()` in `src-tauri/src/midi.rs`
- Test: crossfader, jog wheels, play/pause, volume faders

### audio crossfade
- `AudioAnalyzer` connects each deck's `<video>` element via `connectMediaElement()`
- Master volume applied to `AudioContext.destination` gain node

---

## Phase 2 — Audio-reactive visuals
- Shader source type on a deck
- FFT uniforms fed to shader (bass/mid/high, waveform)
- Built-in shaders: plasma, tunnel, particle field
- BPM detection
- MIDI learn mode

## Phase 3 — Polish
- Shader effect overlays on video
- Media browser / clip library
- Remote control (network, phone as secondary)
