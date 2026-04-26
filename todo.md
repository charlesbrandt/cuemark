# todo

## Phase 1 — Two decks, crossfader, MIDI

### video playback [done]
- File picker via `tauri-plugin-dialog` → `open()` → sets `deck.source`
- Hidden `<video>` per deck, managed in `App.svelte` via `$effect`
- RAF loop: `fbo.uploadVideoFrame(videoEl)` → `compositor.composite()`
- `deck.playing`, `deck.loop`, `deck.playbackRate`, `deck.volume` wired to video element
- `loadedmetadata` event updates `deck.source.duration`
- `convertFileSrc` + asset protocol serves local files to WebKit

### cue-jump seek [done]
- On `cue_jump` MIDI action: `seekDeck(id, cuePoint)` via `seekBus.ts` + stop playing
- On ⏮ button: same — seeks to `deck.cuePoint` (not 0)
- "Cue" button in DeckCard: captures `video.currentTime` → sets `deck.cuePoint`
- `seekBus.ts` holds module-level video element refs; App.svelte registers on create/destroy

### output window [next]
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
