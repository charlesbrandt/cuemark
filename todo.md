# todo

## Phase 1 — Two decks, crossfader, MIDI

### video playback [next]
- File picker → set `deck.source` (Tauri `dialog` plugin or `open` command)
- `<video>` element per deck, hidden off-screen
- Render loop: `requestAnimationFrame` → `texImage2D` each playing video into its FBO → `compositor.composite()`
- Wire `deck.playing`, `deck.loop`, `deck.playbackRate`, `deck.volume` to the video element
- Seek to `deck.cuePoint` on cue-jump

### output window
- Open a second Tauri `WebviewWindow` for the projector output
- Output window renders only the compositor canvas, fullscreen on display 2
- Share compositor state between windows via Tauri events or a shared canvas approach

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
