# Visualization plugins (ISF + Milkdrop)

**Status (2026-09-25): DESIGN ONLY, nothing built.** Scope was decided with the user in
conversation: build on **ISF** and **Milkdrop** (via Butterchurn); **no arbitrary JS plugins**.
Richer and controllable visualizations are to be explored separately later (see "Out of scope").

Written to be picked up phase by phase, possibly by a smaller model. Each phase has its own
files, steps and a "done when". **Read "Hazards" before starting any phase.**

## The ask

Visualizations work more like screensavers: people can drop in ones that are not built
into the app, pick between them, and customize them. Audio has to be routable into them, along
with any track metadata that could inform the visual.

## What exists today (read these files first)

| Piece | Where | Notes |
|---|---|---|
| Data model | `src/lib/state/types.ts`, `Visualization` | `{ fragmentSrc, uniforms: Record<string,number>, name? }`: one raw GLSL string |
| Built-ins | `src/lib/renderer/shaders.ts`, `BUILT_IN_SHADERS` | 5 hand-written GLSL ES 3.00 shaders |
| Picker UI | `src/components/VisualizationPanel.svelte` | Hardcoded to `BUILT_IN_SHADERS`, plus an opacity slider |
| Render | `src/lib/renderer/compositor.ts`, `renderVisualization()` | One `vizFbo`, one cached `vizProgram`. Uniforms: `u_time`, `u_resolution`, `u_bass/u_mid/u_high`, plus custom floats |
| Transport | `src/lib/renderer/outputProtocol.ts` | `viz` message (source, only on change) and `frame` message (`time`, `analysis`, `vizUniforms`, `vizOpacity` every tick) |
| Output side | `src/output.ts` | Receives messages, calls `renderVisualization` then `composite` |
| Audio analysis | `src-tauri/src/audio/pipeline.rs` (`spectrum` element), `analysis.rs` (`AudioFftEvent`) | Per deck, 32 bands, ~30 fps, emitted as the `audio-fft` event |
| Band combine | `src/App.svelte`, `frame()` (~line 765) | Max of bass/mid/high across all `deckAnalysis` entries |
| Beat phase | `src/lib/renderer/seekBus.ts`, `getPhase(deckId)` | `[0,1)` from `deck.bpm` + `deck.downbeat` + position; `null` if no grid |
| Track metadata | `src/lib/digger/api.ts` | `title`, `artist`, `album`, `bpm`, `duration_ms`, `era`, `is_liked`, mix-zone markers. Mood/genre tags exist in Digger (`digger/docs/design/mood-analysis.md`) but cuemark doesn't fetch them. **Digger has no album art.** |

**Gaps this doc fixes:**

1. The shader list is compiled in; there's no way to add one.
2. The `AudioFftEvent` carries **32 bands** (`bands`), but the frontend keeps only 3.
3. The analysis tap is **pre-fader** (after `pitch`, before EQ, volume and crossfader). A
   playing deck that is faded out still drives the visuals, so audio isn't really routable.
4. There's no waveform or PCM data anywhere on the frontend. `AudioAnalysis.waveform` exists
   in the types but is never filled.
5. No multipass or persistent buffers: the "Feedback" built-in doesn't actually feed back.
6. A shader compile error goes to `console.error` in the output window, which never reaches
   `cuemark.log`. A broken plugin would just show nothing, silently.

## Decisions

- **ISF (Interactive Shader Format) is the primary plugin format.** It's the standard shared by
  VDMX, Resolume, Magic, Synesthesia and others. A `.fs` GLSL file has a JSON header in a
  leading `/*{ … }*/` comment that declares parameters, image/audio inputs, passes and
  persistent buffers. Thousands of existing shaders; authors already know it. Spec:
  <https://github.com/mrRay/ISF_Spec> (ISFVSN 2.0).
- **Milkdrop presets via Butterchurn** (npm `butterchurn`, MIT) are the second format. This is
  the classic screensaver-style visualizer with a large preset library. It gets its own
  renderer; it's never translated into ISF.
- **No arbitrary JS plugins.** The output window has Tauri IPC access
  (`src-tauri/capabilities/default.json` lists `"output"`), so untrusted JS there could call any
  command. A slow plugin would also stall the projector. If this is ever wanted, it needs a
  sandboxed iframe with no IPC, and that's its own project.
- **Plugins are data.** Cuemark discovers them in a folder, reads them and ships them to the
  output window. Plugins never ask the host for anything.
- **The global visualization layer stays as it is structurally**: one active visualization,
  above all decks, with its own opacity. The renderer is built as **instances**, though, so
  `track-visual-override.md`'s per-deck viz can reuse it without a rewrite.

## Package layout

```
~/.local/share/com.cuemark.app/visualizations/     (Tauri app data dir; create if missing)
  my-plasma.fs                        ← a bare ISF file is a valid plugin
  starfield/                          ← or a folder, when there are extras
    starfield.fs
    starfield.vs                      ← optional ISF vertex shader
    noise.png                         ← image inputs referenced by the ISF IMPORTED key
    thumbnail.png                     ← optional, shown in the picker
    LICENSE                           ← shown in the picker if present
  milkdrop/
    *.milk  |  *.json                 ← Milkdrop presets (Butterchurn's converted JSON form)
```

- The plugin id is the path relative to the folder. It's stable across launches, so it can be
  persisted and later stored per track.
- Built-ins ship inside the app (a `src/lib/renderer/builtin-isf/` directory imported with
  Vite `?raw`), but they are ordinary ISF files that go through the same loader. There's no
  separate code path.
- Hot reload: watch the folder (Rust `notify` crate, or polling mtimes every 2 s, which is
  enough). On change, re-read and re-ship if that plugin is active. This is what makes authoring
  pleasant.

## Inputs a plugin can use (audio routing + metadata)

### Standard ISF inputs (host must implement)

| ISF | Meaning | Source in cuemark |
|---|---|---|
| `TIME`, `TIMEDELTA`, `FRAMEINDEX`, `RENDERSIZE`, `DATE`, `PASSINDEX` | Built-in uniforms | Output window clock; `RENDERSIZE` = FBO size (1920×1080) |
| `float`/`bool`/`long`/`color`/`point2D`/`event` inputs | User parameters | Generated UI controls (phase 2), later MIDI |
| `image` input + `IMPORTED` | Texture from the package | Loaded in the output window, see "Serving assets" |
| `audioFFT` input | Spectrum as a 1-row float texture | The 32 bands (phase 3). `MAX` caps the width |
| `audio` input | Waveform as a texture, one row per channel | PCM tap (phase 5). Until then, bind a flat silent texture and log once |

### Cuemark bindings: metadata and routing, with graceful degradation

ISF has no concept of track metadata. **Don't add a preamble of magic uniforms**: that makes a
shader fail to compile in every other ISF host. Instead, a plugin declares an ordinary `float`
(or `bool`) input with an extra key the host recognises:

```json
{ "NAME": "beat", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0,
  "CUEMARK_BIND": "beatPhase" }
```

Cuemark drives a bound input every frame and hides its slider. Any other ISF host ignores the
unknown key and shows a normal slider. The shader stays portable.

Initial binding vocabulary. Keep this list in one place in code (e.g. `vizBindings.ts`) and in
this doc:

| `CUEMARK_BIND` | Type | Value | Source |
|---|---|---|---|
| `bass` / `mid` / `high` | float 0–1 | Band energy of the routed source | Existing 3-band values |
| `level` | float 0–1 | Overall energy of the routed source | Mean of the 32 bands |
| `beatPhase` | float [0,1) | Position within the current beat | `getPhase(deckId)` of the **dominant deck** |
| `hasBeatGrid` | bool | Whether `beatPhase` means anything | `getPhase() !== null` |
| `bpm` | float | Dominant deck's BPM, 0 if unknown | `deck.bpm` × playback rate. ⚠️ Confirm whether `deck.bpm` already includes the rate before multiplying |
| `trackProgress` | float 0–1 | Position / duration | Deck position + `DeckSource.duration` |
| `inMixOut` | float 0–1 | Ramp from 0 to 1 across the outgoing mix zone, 0 elsewhere | `effectiveZones()` in `autoMix.ts`; 0 without markers |
| `crossfader` | float 0–1 | Crossfader position | `Session` |
| `liked` | bool | Track is liked in Digger | `is_liked` |

⚠️ **`beatPhase` is per beat, not per bar.** `deck.downbeat` is a beat-level anchor
(`beatmatching.md`); nothing detects bar-beat-1. Don't add a `barPhase` binding until bar
detection exists. A binding that looks right but is actually random is worse than none.

**The "dominant deck"** is the audible deck with the highest effective gain (see Routing). Ties
go to the crossfader side it's on. Expose which deck that is in the debug log when it changes.

**Text metadata** (title, artist, genre, mood tags) can't enter GLSL. Its use is *choosing and
parameterising* a plugin, not being read by one. That's the rules layer in phase 6, which
belongs with `track-visual-override.md`.

### Routing: which audio drives the visualization

A per-session setting, `Session.vizAudioSource`:

- `'mix'` (default): what the room hears. Each deck's bands are weighted by that deck's
  **effective audible gain** (deck volume × crossfader audio gain × master), then combined.
  Weighted max is fine for v1. A power-sum is more "correct", but the bands are normalised
  values, not linear power, so it's not obviously better.
- `'deck:<id>'`: one deck, regardless of fader. Useful for cueing a visual to the next track.
- `'cue'`: decks with `cueEnabled`.

⚠️ **Reuse the existing crossfader gain calculation.** Don't write a second copy of the curve
maths. Find where the crossfader's audio curve turns into per-deck volume sent to
`audio_set_volume` (start from `setCrossfader` / `setCrossfaderAudioCurve` in
`src/lib/state/session.ts` and follow to `src/lib/audio/`). Export that function if it isn't
exported, and call it. Two copies of a curve will drift apart silently.

⚠️ The tap is **pre-EQ**. A bass kill won't show in the visual under `'mix'` until phase 5b
moves analysis to the output node. Note it in the UI tooltip rather than faking it.

## Rendering architecture

### ISF renderer (`src/lib/renderer/isf/`)

- **Parser**: npm `interactive-shader-format` (MIT, the reference JS implementation) has
  `ISFParser`, which parses the header and converts the ISF dialect into complete GLSL. It
  targets **WebGL 1**. Options:
  1. use its parser output and do a small GLSL 1.00 → ES 3.00 rewrite (`gl_FragColor` →
     `out vec4`, `texture2D` → `texture`, `varying` → `in`) to share the compositor's WebGL2
     context, or
  2. compile ISF shaders as GLSL ES 1.00, which WebGL2 still accepts. **Prefer this**: no
     source rewriting at all. Check the parser's output compiles unmodified on WebGL2 first.

  Fallback if the package is unsuitable: the header is plain JSON and the ISF helper macros
  (`IMG_PIXEL`, `IMG_NORM_PIXEL`, `IMG_THIS_PIXEL`, `isf_FragNormCoord`…) are a short list.
  Writing our own is a day's work. **Check the package's licence and its last-release date
  before depending on it.**
- **`IsfInstance`** class: owns its program(s), one FBO per `PASSES` entry with a `TARGET`,
  ping-pong pairs for `PERSISTENT` passes, textures for `image`/`audio`/`audioFFT` inputs, and
  a `render(inputs) → WebGLTexture` method. `FLOAT: true` passes need `EXT_color_buffer_float`:
  check for it and fall back to 8-bit with a single log line.
- `Compositor` replaces `vizFbo`/`vizProgram` with `vizInstance: VizRenderer | null`.
  `composite()` blits the instance's final texture exactly as it blits `vizFbo` now.
- **Dispose on switch**: delete programs, FBOs and textures. Switching plugins 50 times in a
  set must not leak GPU memory.

### Milkdrop renderer (Butterchurn)

Butterchurn is built around Web Audio: `createVisualizer(audioContext, canvas, opts)`, then
`connectAudio(node)`, and it reads **time-domain samples** from an `AnalyserNode`. Cuemark has
no Web Audio on the playback path. Two things to verify in a spike before building anything:

1. **Feeding it audio without Web Audio.** Butterchurn's `render()` accepts an `audioLevels`
   override (`timeByteArray`, `timeByteArrayL`, `timeByteArrayR`, Uint8 arrays of 1024
   samples). Confirm this in the version being installed. Either way, **Milkdrop requires the
   PCM tap from phase 5a**; it can't run from 32 bands. So Milkdrop comes after phase 5a.
2. **Getting its pixels into the output without GPU→CPU readback.** Butterchurn creates its
   own WebGL context on the canvas it's given. Uploading that canvas into the compositor's
   context (`texImage2D(butterchurnCanvas)`) may go through readback, which is **broken on the
   MacBook Pro's `crocus` driver** (see CLAUDE.md), and would fail silently as transparent
   pixels. The recommended approach avoids the question: **stack Butterchurn's canvas above
   the compositor canvas in `output.html` and set CSS `opacity` to `vizOpacity`.** The global
   viz is always the top layer, so DOM compositing gives the same result as the blit. Only a
   per-deck Milkdrop (track-visual-override) would need the texture route, and that is out of
   scope here.

Preset formats: Butterchurn ships presets as converted JSON (`butterchurn-presets`); raw `.milk`
files need `milkdrop-preset-converter`. Support the JSON first. ⚠️ **Check the licensing of any
preset pack before bundling it.** Milkdrop preset collections have mixed or unknown licences.
Bundle none by default; let the user drop packs into the folder.

### Transport changes (`outputProtocol.ts`)

- `OutputVizMessage` becomes
  `{ kind: 'viz'; plugin: { id; format: 'isf' | 'milkdrop'; source: string; vertexSource?: string; assets: Record<string,string> /* name → URL */ } | null }`.
  It's still sent only on change and still re-sent on `hello`.
- `OutputFrameMessage` gains `audio: { fft: Float32Array /* 32 */; pcm?: Uint8Array }`,
  `bindings: Record<string, number>` (every `CUEMARK_BIND` value) and
  `params: Record<string, number | number[] | boolean>` (user parameter values). This replaces
  `vizUniforms`. Keep `analysis` for one release so nothing else breaks; remove it after.
- A new message from output to control:
  `{ kind: 'vizError'; pluginId; stage: 'parse' | 'compile' | 'link' | 'runtime'; message }`.
  **Also `debugLog()` it from the output window** so it lands in `cuemark.log`.

### Serving assets

The output window can't read files directly. Image inputs and thumbnails go over the existing
local media server: `http://127.0.0.1:<port>/<abs-path>` in prod, `/media/<abs-path>` in dev
(see CLAUDE.md "Local HTTP media server"). Never `asset://` or `file://`: WebKit silently
blocks them from an `http:` origin.

## Hazards (read before any phase)

- **A shader can hang the GPU.** An infinite loop in a plugin can cause `webglcontextlost`.
  The output window must handle that event: stop rendering the viz, record the plugin id as
  bad in `localStorage` (`cuemark:vizQuarantine`), post `vizError`, and restore the context
  without the plugin. **The freeze-watchdog reloads the output window, and the `hello` resend
  would load the same plugin again**, causing a reload loop mid-set. The quarantine check must
  run before the resend's plugin is compiled. See `docs/design/freeze-watchdog.md`.
- **Pixel checks can't verify this on the MacBook Pro.** WebGL readback returns transparent
  pixels there. A screenshot test that "passes" there proves nothing. On `mele` readback
  works (`docs/environment.md`); otherwise verify by looking at the output window. Put the
  instrument in the log: `[viz] plugin=… passes=… compile=ok frame_ms=…`.
- **Frame budget.** The output window also composites the decks. Log a per-plugin render time
  (`performance.now()` around `render`, median over 5 s). A plugin that takes longer than
  ~8 ms should be flagged in the picker, not silently allowed to stall the projector.
- **Don't touch the audio path lightly** (phase 5). Any tap on the shared output graph needs a
  `queue leaky=downstream` in front of anything that can block: the deck `tee` has no
  per-branch queue, and a stalled branch stalls the booth monitor and the cue
  (`network-audio-output.md`). Read `shared-output-pipeline.md` first.
- **localStorage is shared with headless test instances** (`skills/verify-ui/SKILL.md`). A test
  that picks a plugin will change the live app's persisted choice. Tests should use a
  namespaced key or reset it.
- **The control window has no WebGL** and must not get one just for previews. Use thumbnails.
- **Unsure what `bands` holds?** Log a few `AudioFftEvent`s and look at the values before
  designing the texture's normalisation. Don't assume dB vs. linear.

## Phases

Each phase is independently useful and live-testable. Do them in order unless noted.

### Phase 1: ISF loader, built-ins moved to ISF

1. Rust: `viz_plugins_dir()` (create if missing) and `viz_list_plugins()` returning
   `[{ id, format, name, description, credit, categories, thumbnailPath?, licensePath?, error? }]`
   plus `viz_read_plugin(id)` returning sources and absolute asset paths. Parse only enough in
   Rust to list; full ISF parsing happens in TS.
2. TS: `src/lib/renderer/isf/` with the parser wrapper and `IsfInstance`. Single pass only in
   this phase; `PASSES` is phase 4.
3. Port the 5 built-ins to ISF files that use `CUEMARK_BIND` for `bass`/`mid`/`high`. They must
   look the same as before; compare side by side on the output window.
4. `VisualizationPanel` lists built-ins plus discovered plugins, with name, thumbnail and an
   error badge. Selection is persisted (`cuemark:vizPluginId`).
5. `vizError` message plus `debugLog`.
6. Replace `Visualization.fragmentSrc` with `Visualization.pluginId` (+ params). Migrate a
   persisted old value to "None".

**Done when:** a stock ISF shader downloaded from the web (e.g. from the ISF examples repo)
dropped into the folder appears in the picker and renders; a deliberately broken one shows an
error in the panel and a line in `cuemark.log` instead of a black layer.

### Phase 2: parameters

1. Generate controls from ISF `INPUTS` (float → slider, bool → toggle, color → picker,
   point2D → two sliders, long → select from `VALUES`/`LABELS`, event → button). Hide inputs
   that have `CUEMARK_BIND`.
2. Values are sent in `params` every frame, and persisted per plugin
   (`cuemark:vizParams:<id>`).
3. Hot reload of the plugins folder.

**Done when:** editing a `.fs` file while it is showing updates the output within a couple of
seconds, and its parameter slider values survive an app restart.

MIDI mapping of parameters is **not** in this phase. It depends on the controller profile
system (`controller-mapping.md`) and a MIDI-learn flow that don't exist yet. Record it as a
follow-up.

### Phase 3: audio routing and bindings

1. Keep the 32 bands from `audio-fft` in `deckAnalysis` (currently dropped).
2. Implement `Session.vizAudioSource` (`'mix'` / `'deck:<id>'` / `'cue'`) with gain weighting
   that reuses the existing crossfader gain function (see Routing).
3. `audioFFT` texture (32×1, `R32F` or `R8`), `bindings` map, the whole binding vocabulary
   except anything that needs PCM.
4. Source selector in `VisualizationPanel`.
5. Log a line when the dominant deck changes: `[viz] dominant deck-1 (gain 0.82)`.

**Done when:** with two decks playing and the crossfader hard left, the viz reacts only to
the left deck; moving it right moves the reaction with it; `'deck:<id>'` follows one deck
regardless of the crossfader. A shader bound to `beatPhase` flashes on the beat of a gridded
track (watch it, and check a deck without a grid reports `hasBeatGrid = 0`).

### Phase 4: multipass and persistent buffers

`PASSES` with `TARGET`, `PERSISTENT`, `WIDTH`/`HEIGHT` expressions and `FLOAT`. Rewrite the
Feedback built-in to use a real persistent buffer.

**Done when:** a feedback/trails ISF shader from the ISF examples renders its trails, and
switching plugins 50 times doesn't grow the output window's memory (compare
`WebKitWebProcess` RSS before and after).

### Phase 5a: PCM tap (Rust), needed by Milkdrop and the ISF `audio` input

- Tap point: the **shared output graph node** (`audio/mixer.rs`, `OutputGraph`), after the
  `audiomixer`, so it is genuinely the post-fader, post-EQ mix. For `'deck:<id>'` / `'cue'`
  sources, either add per-deck taps or accept that the waveform always shows the mix (decide
  in the phase; the mix-only version is much smaller).
- `queue leaky=downstream max-size-buffers=2` → `appsink drop=true max-buffers=1 sync=false`,
  downmix to mono plus L/R, 1024 samples, quantised to Uint8 (Milkdrop's native shape), and
  emitted at ≤60 Hz. Measure the IPC cost with `[poll-stats]`-style logging before and after.
- `master volume` is applied at the node's `volume` element (see CLAUDE.md). Tap **before**
  it so the visual doesn't die when the booth is turned down, or after it deliberately.
  Decide, and write the decision in this doc.

**Done when:** a 600 s soak with the tap on shows no new `output_queue` warnings compared
with the same soak with it off, and a waveform ISF shader shows a waveform.

### Phase 5b (optional): move band analysis to the output node

A `spectrum` element on the node makes `'mix'` reflect EQ kills and the real mix, instead of
the gain-weighted pre-EQ approximation. Only if phase 3's approximation feels wrong live.

### Phase 6: Milkdrop via Butterchurn

1. Spike the two questions in "Milkdrop renderer" first and write the answers here.
2. `MilkdropInstance` driving a stacked canvas in `output.html`, fed from `pcm`.
3. List `milkdrop/*.json` presets in the picker (with a "Milkdrop" group). Preset blend time is
   a parameter.
4. Auto-cycle (screensaver behaviour): an optional "next preset every N bars/seconds", using
   the dominant deck's beat grid when it has one.

**Done when:** a preset from a user-supplied pack runs on the projector, reacts to the music,
and auto-cycle changes presets on a beat.

### Phase 7: metadata-driven selection (joins `track-visual-override.md`)

- Fetch mood/genre tags from Digger when a track loads (the endpoint exists in Digger; see
  `digger/docs/design/mood-analysis.md` and load the `digger` skill first). Note they are
  **not deployed** to the live instance as of that doc; check before relying on them.
- Rules: `{ when: { genre?: string; mood?: string; bpmRange?: [n, n] }, plugin: id, params? }`,
  evaluated on dominant-deck change. A per-track override from `track-visual-override.md`
  always wins over a rule.
- Numeric Digger fields (mood scores, energy, if they exist) become new `CUEMARK_BIND` names.

## Out of scope (explore separately)

- **Arbitrary JS / three.js plugins**: requires sandboxing (see Decisions).
- **Controllable / generative scenes**: visualizations with state, scene graphs, or deeper
  interaction than ISF parameters. The user wants to explore these separately.
- **Per-deck visualizations**: `track-visual-override.md`. This design keeps the renderer
  instance-based so that doc can reuse it.
- **Album art**: Digger stores none. A cover-art source would be a Digger change first.
- **Text overlays** (track title on screen): a host feature, not a plugin one.

## Open questions

1. `interactive-shader-format` package: licence, maintenance, and whether its GLSL ES 1.00
   output compiles unmodified in WebGL2. (Phase 1, first thing.)
2. Butterchurn's `audioLevels` override and the stacked-canvas approach. (Phase 6 spike.)
3. PCM tap before or after master volume. (Phase 5a.)
4. Should the viz pause when every deck is paused? Today it animates continuously. The
   screensaver framing suggests "keep going".
