# Visualization plugins (ISF + Milkdrop)

**Status (2026-09-26):** Phases 1-4 BUILT; Phase 1 and the Feedback built-in (phase 4) judged
good live, Phase 3 judged live ("a bit muted", `fft-bars` visibly reacts). Phase 2 (params UI,
hot reload, image inputs) **verified headless on mele** ("Result 2026-09-26, late" item C), not
yet judged by the user. **Follow-ups 1-3 DONE** (IMPORTED warning, missing-plugin fallback,
`inMixOut`/`liked` removed from the binding vocabulary; see "Follow-up result 2026-09-26").
**Phase 6 BUILT 2026-09-26, headless-verified only** (see "Phase 6 → Result": not heard, not
seen on a projector, not run in a production build). Phase 6 iframe spike: PASS. Output-window **RSS creep reproduced but
unattributed** (not viz-specific, no fix); the **6 s output stall after selecting particles/scope
was not reproduced** in 402 selections. Phases 5-7 not started. Still open: `beatPhase`/`bpm`
live judgement, params persistence across restart and MIDI (Phase 2, uncovered), `inMixOut`/`liked` (need a real source; see
"Cuemark bindings"). Scope was decided with the user in conversation: build on **ISF** and
**Milkdrop** (via Butterchurn); **no arbitrary JS plugins**. Richer and controllable
visualizations are to be explored separately later (see "Out of scope"). Open questions 1-3
were researched on 2026-09-25 (package source read, parser run on test shaders, `mixer.rs`
traced); the answers are folded into the sections below and summarised under "Open questions".

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
  renderer; it's never translated into ISF. ⚠️ **Milkdrop presets are code**: Butterchurn
  compiles each preset's equations with `new Function` (verified, `butterchurn.js`
  `loadPreset`). So Butterchurn runs in a **sandboxed iframe with no IPC** (see "Milkdrop
  renderer"), which is what the "no arbitrary JS" rule below requires anyway.
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
| `crossfader` | float 0–1 | Crossfader position | `Session` |

**Removed 2026-09-26: `inMixOut` and `liked`.** The Phase 3 code hardcoded both to 0 (`inMixOut: 0`,
`liked: false` in `App.svelte`), so a shader binding them silently saw a constant; they are gone
from `BINDING_NAMES`/`computeBindings` now, and a `CUEMARK_BIND` naming them simply gets no
value. The raw data exists (`Deck.mixOutStart/mixOutEnd` + position for `effectiveZones()`;
`DiggerQueueItem.is_liked` matched by `Deck.diggerTrackId`) and the dominant deck now exists
(`routeAudio`), so they can come back once wired to real values. `liked` is queue-scoped: a
track loaded from search results has no queue row.

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

- **Parser: vendor a patched copy of `ISFParser.js` + `MetadataExtractor.js`** from
  `interactive-shader-format` into `src/lib/renderer/isf/vendor/` (keep its licence header and
  add a `NOTICE` line). Researched 2026-09-25:
  - Licence: ISC on npm (2.8.1), relicensed MIT on GitHub (2025-12-31). Permissive either way.
  - Maintenance: last npm release 2020-03-02 (2.8.1 is `latest`; a stray 2.9.0 from 2018
    exists, ignore it). 31 open issues. Effectively unmaintained, hence vendoring.
  - ❌ **It can't parse audio-reactive shaders as shipped.** `typeUniformMap` has no `audio` or
    `audioFFT` entry, so `parse()` throws `Unknown input type [audioFFT]` (verified by running
    it). Patch: add `audio: 'sampler2D', audioFFT: 'sampler2D'` (the ISF spec exposes both as
    2D textures). Also add `IMG_SIZE_<name>` handling for them if the parser doesn't already
    emit it for every sampler; check with a test shader.
  - The parser is separate from its `ISFRenderer` (which takes a caller-supplied `gl` and is
    not used here). `parse(frag, vert?)` gives `.fragmentShader`, `.vertexShader`, `.inputs`,
    `.passes` (`{target, persistent, float, width, height}`), `.type`.
  - Output is plain **GLSL ES 1.00**: no `#version`, no `#extension`, `attribute`/`varying`,
    `gl_FragColor`, `texture2D`, explicit `precision highp`. WebGL2 accepts ES 1.00 when both
    stages agree, so **compile it unmodified** in the compositor's WebGL2 context, as its own
    program. Not compile-checked yet (no `glslangValidator` on the research box): the first
    step of phase 1 is compiling the parser output for the 5 ported built-ins in the real
    output window.
  - Its only runtime dependency, `mathjs-expression-parser`, is used by the renderer, not the
    parser. Don't bring it in (see phase 4 for `WIDTH`/`HEIGHT` expressions).
  - `dist/build.js` references `window` at load time, which breaks under plain Node (vitest).
    Another reason to vendor the `src/` files rather than import the bundle.
- **`IsfInstance`** class: owns its program(s), one FBO per `PASSES` entry with a `TARGET`,
  ping-pong pairs for `PERSISTENT` passes, textures for `image`/`audio`/`audioFFT` inputs, and
  a `render(inputs) → WebGLTexture` method. Pass orchestration (the `PASSINDEX` loop, ping-pong
  swaps) is ours to write: it lives in the upstream renderer, which isn't used. `FLOAT: true`
  passes need `EXT_color_buffer_float`: check for it and fall back to 8-bit with a single log
  line. (Upstream's renderer silently ignores `FLOAT` altogether; don't copy that.)
- `Compositor` replaces `vizFbo`/`vizProgram` with `vizInstance: VizRenderer | null`.
  `composite()` blits the instance's final texture exactly as it blits `vizFbo` now.
- **Dispose on switch**: delete programs, FBOs and textures. Switching plugins 50 times in a
  set must not leak GPU memory.

### Milkdrop renderer (Butterchurn)

Researched 2026-09-25 against `butterchurn@2.6.7` (MIT, last published 2025-07-13), by reading
the un-minified `lib/butterchurn.js` in the npm tarball:

1. **No Web Audio needed.** `createVisualizer(null, canvas, opts)` is supported: every
   `AnalyserNode` setup in `AudioProcessor` is behind `if (context)`, and `AudioLevels` falls
   back to a 44100 Hz sample rate for its band edges. Never call `connectAudio`.
2. **Audio goes in through `render({ audioLevels, elapsedTime? })`**, which calls
   `updateAudio(timeByteArray, timeByteArrayL, timeByteArrayR)`. Each must be a
   **`Uint8Array` of exactly 1024** time-domain samples, unsigned and centred on 128 (the
   `getByteTimeDomainData` format). They're copied with `.set()`, so a shorter array leaves
   stale bytes in the tail. Butterchurn runs its own FFT on them, so it needs PCM, not bands:
   **Milkdrop requires phase 5a.** At 48 kHz, 1024 samples is ~21 ms, so one window per frame
   at 60 Hz covers the signal.
3. **Getting its pixels on screen without readback.** Butterchurn calls
   `canvas.getContext('webgl2', { alpha: false, premultipliedAlpha: false, … })` on the canvas
   it's given (WebGL2 only, no WebGL1 fallback; only optional extension is anisotropic
   filtering). `readPixels`/`toDataURL` appear only in its opt-in `toDataURL()` methods,
   never in `render()`. **Never call those** (readback is broken on the MacBook Pro's `crocus`
   driver). So: **stack Butterchurn's canvas above the compositor canvas in `output.html` and
   set CSS `opacity` to `vizOpacity`.** The global viz is always the top layer, so DOM
   compositing gives the same result as the blit. Because the canvas is opaque
   (`alpha: false`), **whole-layer opacity is the only blend available**. No per-pixel alpha,
   no additive mode unless CSS `mix-blend-mode` on the element turns out to work in WebKitGTK
   (untested). Only a per-deck Milkdrop (track-visual-override) would need the texture route,
   and that is out of scope here.
4. **Sandboxing.** Preset equations become JS via `new Function` on every `loadPreset`. The
   output window has Tauri IPC, so run Butterchurn in an `<iframe sandbox="allow-scripts">`
   (no `allow-same-origin`) served from the media server, positioned where the stacked canvas
   would be. The output window `postMessage`s it `{preset}` on change and
   `{timeByteArray, timeByteArrayL, timeByteArrayR}` per frame (transfer the buffers). Verify
   in the phase-6 spike that: WebGL2 works inside a sandboxed iframe on WebKitGTK; the iframe
   gets no `window.__TAURI__` / `__TAURI_INTERNALS__`; and per-frame `postMessage` of 3 KB
   doesn't cost measurable frame time.

Preset formats: Butterchurn ships presets as converted JSON (`butterchurn-presets`); raw `.milk`
files need `milkdrop-preset-converter` (MIT, last published 2022). Support the JSON first. The
JSON holds `baseVals`, `shapes`, `waves`, `init_eqs_str`/`frame_eqs_str`/`pixel_eqs_str` (JS,
see sandboxing above) and `warp`/`comp` (GLSL bodies). ⚠️ **Don't bundle a preset pack.**
`butterchurn-presets` (2.4.7, last published 2022) is MIT for the package, but the presets
themselves are by many authors, credited only in filenames, with no per-preset licence. That's
an unresolved question for the public Apache-2.0 repo. Let the user drop packs into the
folder.

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
2. TS: `src/lib/renderer/isf/` with the vendored, patched parser (see "ISF renderer"), a
   vitest suite that parses a float-input, an `audioFFT`-input and a multipass test shader,
   and `IsfInstance`. First compile the parser's output for one ported built-in in the real
   output window, before building anything else. That's the one unverified assumption.
   Single pass only in this phase; `PASSES` is phase 4.
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

**Result (2026-09-25): DONE.** Commits `0d048ba` (Rust discovery), `e8b6206` (vendored
parser, `IsfInstance`, built-in ports, 13 vitest tests), `4cc598b` (integration).

- Verified headlessly on `mele` (Xvfb, isolated `XDG_*` dirs, see the verify-ui skill): all 5
  built-ins, a drop-in generator and an `audioFFT` shader load; a GLSL error fails with the
  driver's message (`failed (compile): fragment shader: ERROR: 0:32: 'gl_FragColor' : syntax
  error`); a bad JSON header is flagged by `viz_list_plugins` *and* by the TS parser. A
  screenshot of Plasma was real pixels (readback works on `mele`). Then verified by the user
  in the live output window: built-ins look as before, the drop-in `good-glow.fs` renders.
- **The parser's GLSL ES 1.00 output does compile unmodified in WebGL2 on WebKitGTK** — the
  one open assumption from the research.
- Deviations from the steps above:
  - Selection persists through the session snapshot (`session-recovery.json`, restored in
    `bootRestore.ts` via `migrateVisualization()`), **not** `cuemark:vizPluginId` in
    localStorage: the snapshot already carried `Session.visualization`, and localStorage is
    shared with test harnesses (Hazards).
  - `TIME` counts from plugin load in the output window, not the control window's clock.
  - A single explicit pass with a `TARGET` is rejected as `unsupported` (phase 4), same as
    real multipass.
  - `image` inputs bind a blank 1×1 texture (logged once), so **filter-type ISF shaders
    (`inputImage`) render black** until image loading lands (phase 2 or a small follow-up;
    assets are already listed by `viz_read_plugin` and served by the media server).
  - Parser patch beyond `audio`/`audioFFT`: the vertex skeleton now writes the
    `isf_FragCoord` varying the fragment skeleton declares (upstream mismatch).
- ⚠️ **Audio reactivity was not confirmed.** The user noticed `good-glow.fs` doesn't react
  to audio. That one is expected: it has no `CUEMARK_BIND` input, and most web ISF shaders
  won't either. But the user also isn't sure the built-ins *ever* visibly reacted. Phase 3
  starts by checking that (below).

### Phase 2: parameters

0. Optional small follow-up that fits here: load `image` inputs from `assets` (URLs via the
   media server) so filter-type ISF shaders stop rendering black.
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

**Result (2026-09-25): BUILT, headless-verified on mele (hot reload, `speed` slider, filter test pattern, IMPORTED png from a *folder* plugin, `[viz] bindings` non-zero and moving with real music); user has not yet judged it live.** Commits `aec4f6a` (params
UI: `vizParamControls.ts`, `activeInputs` store, `setVisualizationParams`), `9427a11` (image
inputs + `[viz] bindings` log), `7b32c6a` (asset paths → media-server URLs; `viz_read_plugin`
returns absolute paths), `c954f65` + integration (Rust mtime-poll watcher, 2 s, emits
`viz-plugins-changed` with changed ids; `startVizPluginSync` rescans the list and re-resolves
the active plugin, whose fresh payload object makes outputBus re-send).
- Deviation: params persist with the session snapshot (only while that plugin stays selected),
  not `cuemark:vizParams:<id>`, for the same shared-localStorage reason as Phase 1.
- Non-imported `image` inputs bind a generated 256×256 test pattern, not black.
- Known nits: the event button holds `true` ~100 ms (≈6 frames); `long` inputs without numeric
  `VALUES` get no control; image orientation (flipped on a 2D canvas) unconfirmed.
- Observed by the headless run: `IMPORTED` in a bare-file plugin is silent and renders black (assets exist only for folder plugins) — worth a warning; bands **freeze at their last value while a deck is paused** rather than decaying (Phase 3 routing should decide this); deleting the active plugin file leaves it selected with a `read:` error.
- Not done: MIDI mapping of params (follow-up, depends on controller-mapping.md).

### Phase 3: audio routing and bindings

0. **First, prove audio reaches a shader at all.** Log the `bindings` values the output
   window receives (throttled, e.g. once a second) with a deck playing, and look at them
   before and after this phase. The built-ins' reactions are subtle by design (Plasma's
   `pulse = 1.0 + bass * 0.3`), and the user has never been sure they react. Write a test
   plugin that maps `bass` straight to brightness so the answer is visible.
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

**Result (2026-09-26): BUILT, headless-verified on mele; the user has not yet judged it live.**
Commits `615b015` (`src/lib/viz/vizBindings.ts`: `routeAudio`, `effectiveDeckGain`,
`computeBindings`, unit-tested), `d3b0c00` (`audioFFT` → 32×1 R8 texture from `vizFft`,
`isf/testplugins/fft-bars.fs`), `1898df3` (`Session.vizAudioSource`, panel selector), `68178bc`
(`App.svelte` integration, `bootRestore` restore, `[viz] dominant` log). Verified: bindings move
with music; crossfader 0→1→0 moves the dominant deck; `deck:<id>` ignores the fader; `cue`
follows `cueEnabled` (`none` when nothing is cued); a deck without a grid logs `hasBeatGrid=0`
with `bpm` still non-zero; fft-bars bars visibly move in a real screen grab.
- Decisions: a **paused deck is silent** under `mix`/`cue` (bands no longer freeze); `deck:<id>`
  keeps a paused deck's last values. Crossfader ties go right (`pos >= 0.5`).
- ⚠️ `setCrossfader` already writes the curve gain into `deck.volume` when `crossfaderTargets`
  includes `volume`; `effectiveDeckGain` therefore skips the curve unless
  `crossfaderInVolume:false`. Applying it again would square it — the same class of bug as the
  master-volume one in `shared-output-pipeline.md` "Gain staging".
- `deck.bpm` is the native tempo; the `bpm` binding is `bpm × playbackRate`.
- `Session.vizAudioSource` is **optional** in the type (old test fixtures); readers treat
  `undefined` as `'mix'`. It is persisted via `bootRestore.ts`, which restores globals field by
  field — any new global needs a line there or it silently resets on restart.
- **Not done:** `inMixOut` and `liked` bindings were hardcoded 0 and were removed from the
  vocabulary in the 2026-09-26 follow-up (need `effectiveZones()` + Digger markers, and
  `is_liked` on the deck). Not judged by ear/eye by the user.

### Phase 4: multipass and persistent buffers

`PASSES` with `TARGET`, `PERSISTENT`, `WIDTH`/`HEIGHT` expressions and `FLOAT`. Rewrite the
Feedback built-in to use a real persistent buffer. `WIDTH`/`HEIGHT` are expressions like
`"$WIDTH/2"` or `"floor($WIDTH*$scale)"` (`$` names are `RENDERSIZE` and float inputs).
Evaluate them with a tiny hand-written evaluator: numbers, `$names`, `+ - * /`, parentheses,
`floor`/`ceil`/`max`/`min`. **Never `eval`/`new Function`**: plugins are data.

**Done when:** a feedback/trails ISF shader from the ISF examples renders its trails, and
switching plugins 50 times doesn't grow the output window's memory (compare
`WebKitWebProcess` RSS before and after).

**Result (2026-09-26): BUILT (`6e362d3`), headless-verified on mele; user has not judged Feedback live.**
`expr.ts` (safe evaluator), `PassTarget` in `instance.ts` (ping-pong for PERSISTENT, 16F for FLOAT,
8-bit fallback), Feedback built-in rewritten around a persistent buffer. Verified under Xvfb/X11:
Feedback accumulates trails then plateaus at ~11.6% non-black after ~2s; a quarter-size `TARGET` pass
renders at 480x270; bad expressions surface as `failed (parse)` in the panel and log; 400 plugin
switches added ~16.5 MB of output-process RSS (~40 kB/switch), matching the ~2 MB/min creep seen
idle on a viz, so no per-switch leak of the 16 MB float buffers.
- Not verified: audio reaction of Feedback; the ~2 MB/min creep while a viz is active (source unknown,
  isolate with a long idle run on Feedback alone); one unreproduced 6.1s output-window stall (watchdog
  fired right after selecting particles/scope, recovered).
- ⚠️ A `TARGET` named `half` (or any GLSL reserved word) fails to compile; it does surface visibly.

### Result (2026-09-26, late): RSS creep, stall hunt, Phase 2 live-check (mele, Xvfb, `CUEMARK_DISABLE_DMABUF=1`)

Isolated XDG dirs, one webview at a time, own build (`fc07a9f`), output-window `WebKitWebProcess` RSS sampled every 30 s, slope fitted after a 2 min warm-up. The main window and the app process stayed flat in every arm (<= +0.1 MB/min).

**A. Output-window RSS creep: reproduced, NOT viz-specific, no fix made.**

| arm (12 min unless noted) | output RssAnon slope |
|---|---|
| no viz | +0.40 MB/min |
| `builtin:feedback` | +1.62 |
| `builtin:plasma` (single pass) | +1.85 |
| plasma, opacity 0 (viz never rendered, decks still composited) | +1.78 |
| plasma, 40 min | +1.55 (49 -> 122 MB) |
| bisect: frame messages received, **no GL call** | flat / sawtooth (dropped 92 -> 60 MB once) |
| bisect: only `gl.clear()` per frame, no viz, no composite | +1.86 |
| bisect: same, canvas `preserveDrawingBuffer:false` | +0.32 |
| plasma, `preserveDrawingBuffer:false` | +0.88 |
| plasma, `preserveDrawingBuffer:false`, 25 min | +2.06 |

Reading: the growth needs per-frame GL work in the output process, and is the same size for a single-pass shader, the multipass feedback buffer, and a bare clear, so `instance.ts` (uniforms, textures, pass buffers), `BroadcastChannel` payloads and the message handler are ruled out (receive-only arm is flat). `preserveDrawingBuffer` looked like the cause in the short bisect but the 25 min run refutes it as a fix, so it was not changed. Most likely WebKit/Mesa (llvmpipe, software compositing forced by `CUEMARK_DISABLE_DMABUF=1`) allocation behind the WebGL canvas, possibly collected lazily (one sawtooth drop seen). Unverified on a hardware-composited run, which needs a real display; the user's live app is the place to check whether it exists there. Hoisting `getUniformLocation` out of `composite()` was tried: within noise, not kept.

**B. 6.1 s output stall after selecting particles/scope: NOT reproduced.** 402 selections in total (72 at 1 s spacing, 120 at 0.5 s with a deck loaded, 180 at 0.1 s; every built-in plus None, each pass), 0 failures, 0 `[watchdog]` lines, output process alive throughout. Consistent with the earlier stall being a one-off (a first shader compile on a busy driver or a window-manager event), not a repeatable per-selection cost.

**C. Phase 2 live-check: PASS.**
- Controls: a plugin with float, bool, color, point2D, long and event inputs rendered slider, checkbox, colour picker, two sliders, select and Trigger button.
- Params reach the shader (read from the real screen via `xwd`, not WebGL readback): level 0.2 -> 0.8 moved centre pixel (51,51,0) -> (204,51,0); bool added blue; colour to green; long select moved red; point2D confirmed (0,0,0) -> (128,64,0) at (0.5,0.25); event button held true for ~6 frames then reset.
- Hot reload: file rewritten, output pixel changed after 2.06 s; log `[viz] plugins changed` -> `hot reload` -> `loaded`.
- Compile error: panel `.viz-error` "compile: fragment shader: ERROR: 0:40: 'BROKEN' : syntax error", button badged and `viz-broken`, log `[output] visualization paramtest.fs failed (compile)`. Fixing the file recovered without a restart. A bad JSON header shows `parse: ...` in the panel.
- Not covered: persistence of params across restart, and MIDI.

Harness (not committed): scratchpad `h/vizh.py`, `rss_arm.py`, `cycle_b.py`, `item_c.py`.

### Phase 5a: PCM tap (Rust), needed by Milkdrop and the ISF `audio` input

- **Tap point (decided 2026-09-25): before master volume**, in the shared output graph node
  (`audio/mixer.rs`, `create_node()`). The node is `mixer → caps_el → master_volume_el → sink`
  (linked at `mixer.rs` ~518–522; no tee exists there today). Insert a `tee` between `caps_el`
  and `master_volume_el`. Master volume is the whole node's master fader ("Gain staging" in
  `shared-output-pipeline.md`), so a post-volume tap would go dark when it's pulled to 0 and
  dim as the room gets quieter. The visuals should follow the music, not the room level.
  It's still post-fader and post-EQ per deck, because those are applied on the deck side,
  upstream of the node.
- **Which node, which channels.** An `OutputNode` doesn't know whether it carries main or cue.
  That lives in the branch key (`("deck-0","main0")` / `"cue"` / `"record"`). Tap the node
  that deck `main0` branches attach to. ⚠️ **On a 4-channel device (the Starlight) main and
  cue share one node** (`two_branches_share_one_node` test): main on channels 0–1, cue on
  2–3. Take only the main branch's channel pair (read it from the same remap that builds the
  branch's mix-matrix), or the headphone cue leaks into the projector. Node caps are
  48 kHz F32LE interleaved, 2 or 4 channels. Never tap the `__record__` node.
- `queue leaky=downstream max-size-buffers=2` → `appsink drop=true max-buffers=1 sync=false`,
  downmix to mono plus L/R, 1024 samples, quantised to Uint8 (Milkdrop's native shape), and
  emitted at ≤60 Hz. Measure the IPC cost with `[poll-stats]`-style logging before and after.
- Emitting: follow the `audio-fft` pattern (`pipeline.rs` spectrum bus handler →
  `app.emit("audio-fft", AudioFftEvent{…})`, listened for in `App.svelte`) with a new
  `audio-pcm` event. `OutputGraph` has no `AppHandle` today (`DeckAudioPipeline` does), so
  thread one in. The control window forwards the bytes in the frame message's `pcm` field.
- Only emit while the output window is alive (`viz_set_listening(bool)`, see open question 4).
  A closed projector must cost no PCM work.
- `'deck:<id>'` / `'cue'` sources: the mix-only tap always shows the main mix. Per-deck PCM
  is out of scope for this phase. Record it as a follow-up if it's missed live.

**Done when:** a 600 s soak with the tap on shows no new `output_queue` warnings compared
with the same soak with it off, and a waveform ISF shader shows a waveform.

### Phase 5a → Result (2026-09-26, branch `viz-phase5a-pcm-tap`, mele, headless)

**Built.** `audio/pcm_tap.rs` (pure logic + gate) and `audio/mixer.rs`. Every real-device node
now has a `tee` between `caps_el` and `master_volume_el` (a pass-through with one branch; the
record node has none). The tap branch `tee → valve → queue leaky=downstream max-size-buffers=2
→ appsink drop=true max-buffers=1 sync=false async=false` is built **lazily** on a running node
the first time `viz_set_listening(true)` arrives while a main branch exists, and is then only
gated by the valve (never removed from a PLAYING node). Channels come from the main branch's own
mix-matrix (`main_pair()`), never from the node's first two channels; cue/record keys never
qualify; one node owns the tap. Frame = `mono|L|R`, 1024 samples each, 128 = silence, emitted as
base64 (`audio-pcm`, 4 KB rather than ~12 KB of JSON numbers) on a drift-corrected 60 Hz
schedule. `OutputGraph::set_pcm_emit()` takes a closure built from the `AppHandle` in `lib.rs`
(so `mixer.rs` stays Tauri-free); `viz_set_listening` flips a lock-free flag and reconciles on a
thread (it never waits on the graph mutex). Frontend: `lib/viz/vizPcm.ts` decodes, forwards in
the frame message's `pcm` field, and drives the gate. **The gate is narrower than the doc**: the
tap is on only while the output window's `alive` beacon is fresh, a visualization is selected,
**and the plugin declares an ISF `audio` input** (`pluginWantsPcm`). None of the five built-ins do,
so normal use never builds the tap. Phase 6 must extend `pluginWantsPcm` for Milkdrop.
ISF `audio` inputs are fed: R8 1024x2 texture, row 0 = left, row 1 = right, 0.5 = zero
(`testplugins/waveform.fs` is the sample; not shipped as a built-in).

**Soak (600 s each, real binary, Xvfb + `CUEMARK_DISABLE_DMABUF=1`, isolated XDG dirs, looped
H.264/AAC clip playing on deck-0, audio to a temporary 4-channel PipeWire null sink: main
`FL,FR`, cue `RL,RR`, cue enabled, so the shared 4-ch node was exercised).**
OFF arm = `builtin:plasma` (tap never built); ON arm = `waveform.fs` (tap built, emitting).

| | OFF | ON |
|---|---|---|
| WARN / ERROR lines | 0 / 0 | 0 / 0 |
| `output_queue` lines, underrun, xrun, stall, clock warnings, watchdog | 0 | 0 |
| `[deliver-tel]` sink margin | +56 ms | +56 ms |
| `[deliver-tel]` cue margin | -9 ms | -9 ms |
| RSS (app / control webview) | flat | flat (322 MB / ~275 MB) |
| tap emit rate | n/a | 57/s average (<=60), 601 in 10 s at best |
| tap emit (Tauri `emit`) cost | n/a | mean 0.64 ms, max ~10 ms |

No regression, so the tap stays wired as above (it is opt-in by plugin, not by a flag). Emit rate
dips (23-40/s in some 10 s windows) track the sink's buffer arrival rate on this headless box, not
the tap.

**Content checks.** `cargo test -- --ignored pcm_tap_reads_main_only` (needs a 4-ch null sink,
see the test's doc comment) runs the real graph: main = -0.25/+0.25, cue = loud 0.9, master
volume 0. Result: PCM shows exactly the main pair's values (pre-master-volume: not scaled, not
silent at volume 0), the cue level appears nowhere, <100 frames in 1.5 s, and closing the gate
stops emission. The margins above match between arms, so `position()`'s latency correction is
undisturbed (the tap is a side branch of the tee and adds nothing to the path to the sink).
Rust unit tests cover channel selection (front/rear/mono/none), downmix, quantise, window, base64.

**NOT verified.** Live listening / any real device (only a null sink); the 2-channel default-device
path and a real Starlight (only the 4-ch null-sink layout); a visible waveform on screen (WebGL
pixels cannot be checked headlessly here; the texture path is unit-tested and the `audio-pcm`
->`pcm`->texture chain ran without errors, but nobody looked at a picture); the IPC cost at the
control window's frame budget (only Rust-side emit time was measured, not `[raf]`/`[poll-stats]`
with the tap on); a second main device on another node (one owns the tap); hours-long behavior;
the MacBook Pro. Tap teardown is intentionally absent (valve only).

### Phase 5b (optional): move band analysis to the output node

A `spectrum` element on the node makes `'mix'` reflect EQ kills and the real mix, instead of
the gain-weighted pre-EQ approximation. Only if phase 3's approximation feels wrong live.

### Phase 6: Milkdrop via Butterchurn

1. Spike the three sandboxed-iframe checks in "Milkdrop renderer" item 4 first, and write
   the results here. (The audio-feed and readback questions were answered by reading the
   source on 2026-09-25.)

   **Spike result (2026-09-26, `mele`, real cuemark debug binary via tauri-driver + Xvfb with
   `CUEMARK_DISABLE_DMABUF=1`, butterchurn 2.6.7 + butterchurn-presets 2.4.7 Minimal pack;
   `scripts/probes/milkdrop_sandbox_iframe_probe.py`, re-runnable in ~1 min, exits 0 on pass):**

   | # | Check | Verdict |
   |---|---|---|
   | 1 | WebGL2 works inside `<iframe sandbox="allow-scripts">` | **PASS.** `getContext('webgl2')` gives `WebGL 2.0`; `createVisualizer(null, canvas, opts)` succeeds; a preset (`Flexi, fishbrain, Geiss + Martin - tokamak witchery`) rendered 400+ frames with no error; `readPixels` *inside* the iframe shows 4096/4096 sampled pixels lit (a black canvas cannot pass). `new Function` (preset equations) works. The preset JSON object reached the iframe via `postMessage` structured clone and `loadPreset` accepted it. |
   | 2 | iframe has no `window.__TAURI__` / `__TAURI_INTERNALS__` | **PASS.** Top frame: both `object` (control arm, so the check can fail). Sandboxed iframe: both `undefined`, no IPC fn to call, `window.parent.document` throws `SecurityError`, `self.origin === "null"`. **Stronger than the sandbox:** a *same-origin, unsandboxed* control child frame also has neither. Tauri's init script is not injected into child frames on this build, so the sandbox is defence in depth for IPC and is what actually blocks parent DOM access. Keep it. |
   | 3 | Per-frame `postMessage` of 3 x 1024 B costs no measurable frame time | **PASS.** Call cost p95 <= 1 ms (p50 rounds to 0; timers here are 1 ms-quantised). Host rAF delta p50: baselines 14/17/17 ms, 3 KB-per-frame arms 17/17 ms (inside the run's own 14 -> 17 ms baseline drift). Control arm (32 MB structured clone per frame) moves the call to p95 9-10 ms, so the instrument can see a cost. Butterchurn render inside the iframe p50 ~5 ms. |

   Also observed: with the iframe stacked over a canvas via CSS, `elementFromPoint` returns the
   iframe and computed `opacity` is `0.5`, so the layering and whole-layer opacity from item 3
   apply. **The pixels of the composite were not looked at** (WebDriver screenshots hang here,
   and WebGL readback is not a valid check of what is *displayed*); look at the window live.
   `mix-blend-mode` is still untested.

   **Consequences for the design:**
   - Design in "Milkdrop renderer" item 4 stands unchanged; go ahead with `MilkdropInstance`.
   - Send presets as JSON via `postMessage` (no need to serve them as files); PCM as three
     transferred `Uint8Array(1024)` per frame is safe.
   - **Not covered, verify in phase 6 proper:** (a) the probe page was `http://localhost:1420`
     embedding `http://127.0.0.1:1420`; production's output window is `tauri://localhost`
     embedding an `http://127.0.0.1:<media-server-port>` frame, a mixed-scheme case not tested
     and one that `media_server.rs` must also serve the right `Content-Type` for; (b) numbers
     are software GL under Xvfb (~22 fps at 640x360), so they bound *IPC cost*, not GPU cost;
     re-check render time against the ~8 ms frame budget on the projector's hardware; (c) the
     MacBook Pro (`crocus`) was not run, so check 1's pixel assertion would `SKIP` there;
     (d) that audio PCM visibly *drives* the preset was not asserted (the frames rendered and
     `recv` counted, nothing more).
2. `MilkdropInstance`: a sandboxed iframe stacked above the compositor canvas in
   `output.html`, running `createVisualizer(null, canvas)` and fed from `pcm` via
   `postMessage`.
3. List `milkdrop/*.json` presets in the picker (with a "Milkdrop" group). Preset blend time is
   a parameter.
4. Auto-cycle (screensaver behaviour): an optional "next preset every N bars/seconds", using
   the dominant deck's beat grid when it has one.

**Done when:** a preset from a user-supplied pack runs on the projector, reacts to the music,
and auto-cycle changes presets on a beat.

### Phase 6 → Result (2026-09-26, branch `viz-phase6-milkdrop`, mele, headless)

**Built.** `lib/renderer/milkdrop/frameShell.ts` (the sandbox document + message protocol),
`lib/renderer/milkdrop/instance.ts` (`MilkdropInstance`), `lib/viz/vizCycle.ts` (auto-cycle),
`output.ts` (`loadMilkdrop`/`teardownMilkdrop`), `viz_plugins.rs` (`milkdrop/*.json` discovery,
`viz_read_plugin`, hot-reload ids), `vizPlugins.ts`/`vizPcm.ts`/`VisualizationPanel.svelte`/
`App.svelte` wiring. Dependency: **`butterchurn@2.6.7` (exact)**.

- **Licences (checked 2026-09-26, `package.json` + shipped LICENSE files).** `butterchurn` MIT
  (its two bundled runtime deps, `@babel/runtime` and `ecma-proposal-math-extensions`, MIT):
  compatible with Apache-2.0, added. `butterchurn-presets@2.4.7`: the *package* is MIT, but the
  presets inside are many authors' work with no per-preset licence, so it is **not** a
  dependency and nothing from it is vendored; **presets are user-supplied only**
  (`<plugins>/milkdrop/*.json`). The probe fetches the Minimal pack with `npm pack` into a temp
  dir, exactly as the spike did. Open question 5 stays open for anything cuemark might ever ship.
- **Cost when unused: nothing.** `output.ts` reaches Milkdrop through `import()` of `instance.ts`,
  which itself lazy-`?raw`-imports `butterchurn.min.js` (193 KB, 40 KB gzip) as a separate
  chunk on the first preset. Verified: after selecting an ISF plugin, no `<iframe>` exists and
  neither chunk was requested (probe `isf/*`). Leaving Milkdrop `destroy()`s the frame.
- **Iframe source strategy: `srcdoc`, decided.** The production case the spike could not cover
  is a `tauri://localhost` page embedding a frame. With `srcdoc` there is no frame URL at all:
  no `http://127.0.0.1:<port>` cross-scheme embed, no `media_server.rs` route, no
  `Content-Type`, no CORS. The shell is a ~3 KB string; Butterchurn's text is `postMessage`d in
  and run as an inline `<script>` (so no `</script>` escaping problem either). A sandboxed frame
  has an opaque origin and could not fetch a same-origin file anyway. `media_server.rs` is
  **unchanged**. (This supersedes "served from the media server" in "Milkdrop renderer" item 4.)
- **Protocol.** Preset JSON *text* travels in `VizPluginPayload.source` (`format: 'milkdrop'`)
  and to the frame by `postMessage`; the frame `JSON.parse`s it, so a malformed file is a
  frame-side error, not a control-window one. PCM: the three 1024-byte blocks are copied out of
  the frame message's `pcm` and transferred (3 KB/frame, spike-verified free). Frame -> parent:
  `presetOk` / `error` / `stats` (every 5 s: `[viz] plugin=… format=milkdrop frames=… pcm_recv=…
  frame_ms p50=… p95=…`, `SLOW(>8ms budget)` appended past 8 ms median; **log only, not yet
  flagged in the picker**). Opacity is CSS `opacity` on the iframe; at 0 the frame also stops
  rendering. The frame stays invisible until the first preset loads (no black rectangle over
  the decks). Buffer is fixed 1280x720 (`MILKDROP_BUFFER`), CSS-stretched, not 1920x1080: a
  guess at the budget on weak GPUs, unmeasured there.
- **Ids.** `milkdrop/<file>.json`. ISF ids end in `.fs` and the ISF scan skips the `milkdrop/`
  folder, so the two cannot collide (unit-tested). `viz_read_plugin` accepts only exactly
  `milkdrop/<file>.json` (no nesting, no traversal; 4 MB cap; must be JSON with a `baseVals`
  object). A bad file is listed with `error` set, not dropped. Picker: a **Milkdrop `<select>`**
  (not buttons: a pack is hundreds of presets), separate from the ISF "Plugins" row.
  ⚠️ Hot reload now scans `milkdrop/` too: a pack of N presets is N `stat` calls per 2 s poll.
- **Params (in `Visualization.params`, persisted with the selection).** `blendTime` (s, default
  2; the first preset of a fresh frame always loads with 0), `cycleMode` (0 off / 1 seconds /
  2 bars), `cycleSeconds` (default 30; also the no-grid fallback for bars), `cycleBars`
  (default 8), `cycleShuffle`.
- **Auto-cycle** runs in `App.svelte`'s rAF tick (`tickAutoCycle`): the dominant deck's
  `getPhase()`; a wrap of the beat phase counts a beat, 4 beats = a bar, and the switch fires
  **on the wrap tick**, i.e. on a beat. No grid (no dominant deck, bpm 0, or deck paused, whose
  phase is frozen) falls back to `cycleSeconds`. ⚠️ "Bar" = 4 beats counted from when the cycle
  (re)started: `deck.downbeat` is a beat-level anchor, nothing knows where beat 1 of a bar is.
  A switch is an ordinary selection change (same resolve -> `viz` message path), a manual pick
  restarts the interval, and errored presets are skipped. It advances through the picker's list
  order (or random).
- **PCM gate.** `pluginWantsPcm` is true for every Milkdrop preset (Butterchurn runs its own
  FFT), so the phase-5a tap is built lazily on the first Milkdrop selection and, as before, is
  never torn down (valve only).

**Verification (mele, Xvfb `:97`, `GDK_BACKEND=x11`, `WEBKIT_DISABLE_DMABUF_RENDERER=1`,
isolated XDG dirs, WebKitGTK 2.52).** `cargo test --lib viz_plugins` 20 pass (4 new: listing,
bad-file flagging, read + traversal guard, hot-reload ids); `npm run check` 0 errors; `npm test`
282 pass (new: `vizCycle.test.ts`, Milkdrop cases in `vizPcm.test.ts`); `vite build` emits the two
lazy chunks. **`scripts/probes/milkdrop_output_window_probe.py`** loads the real `output.html`
in a WebKitGTK view and drives it with the same BroadcastChannel messages `outputBus.ts` sends.
Two arms, both PASS: `dev` (Vite over http) and **`scheme`: the built `dist/` served through a
registered `tauri://` scheme, embedding the `srcdoc` frame, i.e. the production mixed-scheme
case minus Tauri's own protocol handler.** 25 checks each, 8 real presets from the Minimal pack:

| Check | Result |
|---|---|
| ISF path untouched with an ISF plugin selected | `<iframe>` count 0; neither Milkdrop chunk requested; `vizOk`; screen non-black (plasma, mean luma 148) |
| Milkdrop renders | frame `sandbox` attribute is exactly `allow-scripts`; `vizOk`; `xwd` of the X screen (not WebGL readback) shows a real preset (looked at it: yellow/orange geometry on black); frames advancing, render p50 6-8 ms / p95 9-14 ms **under llvmpipe** |
| PCM reaches the frame | frame's own `recv` counter 179 -> 261 in 1.5 s; the loud-vs-silent picture difference was printed but **not asserted** (presets animate on their own, so "PCM drives the picture" is unproven here) |
| Opacity | computed CSS opacity 0.5 applied; opacity 0 -> screen back to black (lit fraction 0.0) |
| Bad presets | invalid JSON, a syntax error in the equations, and a preset with no `shapes`/`waves` each produce a `vizError` (`stage: compile`, with the engine's message), which is what the panel and `cuemark.log` show; a bad preset after a good one leaves the good one rendering; a bad *first* preset shows nothing and reports the error |
| ISF <-> Milkdrop churn | 60 and 120 round trips (120 / 240 switches), all `vizOk`, frame count back to 0. WebKitWebProcess RSS **before -> after: 357 -> 372 MB (+15) at 60, 356 -> 374 MB (+17) at 120** (mid-run peaks 440-550 MB with a live frame, sawtooth, not a ramp); ISF-only control arm 553 -> 556 MB (+2) over 120. The dev arm read +69 MB at 60 (Vite module state included; not chased) |

**NOT verified.**
- **The real production build.** The `tauri` scheme here is registered by the probe, not by
  wry, and `cargo tauri build` was not run (no launcher build/deploy). Whether wry's `tauri://`
  handler treats a `srcdoc` sandboxed frame the same is untested; expected to, since `srcdoc`
  involves no navigation, but only a production build settles it.
- **Live listening / a real audio-reactive look.** No audio device, no real deck, no Tauri:
  the control-window half (`vizPcm` gate -> `viz_set_listening` -> `audio-pcm` -> `pcm` field)
  is unit-tested and phase-5a-soaked but was not run together with the frame. **Nobody heard or
  watched a preset react to music.**
- **The auto-cycle in the running app.** `stepCycle`/`nextPresetId`/`tickAutoCycle` are unit-
  tested (bars fire exactly on the wrap tick; no-grid, paused and bpm-0 fall back to seconds;
  a manual pick restarts the interval), but the `App.svelte` call site was only type-checked,
  and the "changes on a beat" claim is by construction, not by ear or by watching the grid.
- **GPU frame budget on the projector, and the MacBook Pro.** The 6-8 ms is software GL on
  the N150 under Xvfb. The `crocus` machine was not run. The 1280x720 buffer is a guess.
- **`viz_list_plugins`/`viz_read_plugin` end to end through Tauri IPC** (only the pure Rust
  functions are tested), the panel UI rendering (only type-checked), preset-pack scale (a
  1000-preset folder: list latency, hot-reload polling cost), and multi-hour behaviour of the
  frame (a stalled or lost GL context is reported as a `vizError` but never auto-recovered;
  the `cuemark:vizQuarantine` idea in "Hazards" still does not exist for either format).
- **Preset compatibility.** Only 8 of the Minimal pack's presets ran; a preset whose GLSL
  `warp`/`comp` fails to compile inside Butterchurn was not tried, and Butterchurn may fall
  back silently rather than throw, which would still show as a picture with no error.

**Risks.** Presets are arbitrary JS run in the sandbox: it blocks parent DOM and Tauri IPC
(spike-verified), not CPU burn or an infinite loop in `frame_eqs`, which freezes the *output
window's* thread (the freeze-watchdog would reload it, and the `hello` resend would load the
same preset again: the reload-loop hazard has no guard for Milkdrop). Peak memory with a live
frame is ~+100-190 MB over ISF.

### Phase 7: metadata-driven selection (joins `track-visual-override.md`)

- Fetch mood/genre tags from Digger when a track loads (the endpoint exists in Digger; see
  `digger/docs/design/mood-analysis.md` and load the `digger` skill first). Note they are
  **not deployed** to the live instance as of that doc; check before relying on them.
- Rules: `{ when: { genre?: string; mood?: string; bpmRange?: [n, n] }, plugin: id, params? }`,
  evaluated on dominant-deck change. A per-track override from `track-visual-override.md`
  always wins over a rule.
- Numeric Digger fields (mood scores, energy, if they exist) become new `CUEMARK_BIND` names.
- **Idea (2026-09-26, user): lyrics and the CLAP-derived song description as visualization
  inputs.** Unverified what Digger actually stores — check the `digger` skill, the lyrics
  importer and `music-lab`'s `mood-analyze` output before designing. GLSL can't read text, so
  three routes, cheapest first: (a) **numeric** — CLAP mood/energy scores as `CUEMARK_BIND`
  floats, lyrics reduced to numbers (`hasLyrics`, current-line progress if lines are
  timestamped); (b) **rules layer** above — description keywords/tags pick a plugin (already
  this phase); (c) **text as texture** — the host rasterises the current lyric line, title or
  description onto a 2D canvas and binds it to an `image` input carrying
  `"CUEMARK_BIND": "lyricLine"` (host-side, no arbitrary JS in plugins; needs a new
  `CUEMARK_BIND` image kind and a timestamped-lyrics source). Note the doc's rule: bindings
  that look right but are random are worse than none, so gate (c) on lyrics having timestamps.

### Follow-up result 2026-09-26

- **IMPORTED without assets**: `vizHealth.ts` `importedWarning()` checks the header's
  `IMPORTED` against the assets `viz_read_plugin` returned (folder plugins only). A bare `.fs`
  or a folder missing its image now shows an amber warning in the panel and a
  `[viz] warning: …` line in `cuemark.log` when the plugin loads. It still renders (black);
  the point is that it says why.
- **Missing plugin file**: a failed read of a *disk* plugin renders the default built-in
  (`DEFAULT_VIZ_ID`, Plasma) and shows a panel note; `vizFallback` store. **`Session.visualization`
  is deliberately not rewritten**, so a file that is only briefly gone (editor save-by-rename,
  unmounted drive) is picked up again: Rescan re-runs the read, or reselect. There is no
  periodic rescan, by choice (mid-set disk polling). Trade-off: the persisted id is never
  garbage-collected; picking anything else, or None, replaces it.

## Out of scope (explore separately)

- **Arbitrary JS / three.js plugins**: requires sandboxing (see Decisions).
- **Controllable / generative scenes**: visualizations with state, scene graphs, or deeper
  interaction than ISF parameters. The user wants to explore these separately.
- **Per-deck visualizations**: `track-visual-override.md`. This design keeps the renderer
  instance-based so that doc can reuse it.
- **Album art**: Digger stores none. A cover-art source would be a Digger change first.
- **Text overlays** (track title on screen): a host feature, not a plugin one.

## Open questions

1. ~~`interactive-shader-format` package~~ **Answered 2026-09-25**: ISC/MIT, unmaintained
   since 2020, parser can't handle `audio`/`audioFFT` → vendor and patch it (see "ISF
   renderer"). Its ES 1.00 output has no extensions, so it should compile unmodified in WebGL2,
   **but that's still unverified in the real output window**: phase 1, step 2.
2. ~~Butterchurn `audioLevels` and stacked canvas~~ **Answered 2026-09-25**: both work as
   planned (no AudioContext, 3× `Uint8Array(1024)`, own WebGL2 context, no readback in
   `render()`). New finding: presets execute JS, so Butterchurn goes in a sandboxed iframe.
   The iframe checks are the phase-6 spike. Opaque canvas, so opacity is the only blend.
3. ~~PCM tap before or after master volume~~ **Decided 2026-09-25: before**, main channel pair
   only (see phase 5a).
4. ~~Should the viz pause when every deck is paused?~~ **Decided 2026-09-25 (user): keep
   animating whenever the output window is open, whether or not any deck is playing.** Audio
   bindings decay to 0, so the picture settles instead of freezing. **When the output window is
   closed, pause everything viz-related**: no viz-driven dirty frames in `App.svelte`, no
   binding/param computation, and the phase-5a PCM tap stops emitting `audio-pcm`. Gate all of
   it on the same `alive`-beacon liveness that `postFrame()` already uses (3 s of silence = gone;
   see CLAUDE.md "Rendering pipeline"). Don't add a second liveness signal. For the Rust tap,
   the simplest version is a `viz_set_listening(bool)` command driven by that liveness, and the
   appsink callback returns early when it's false.
5. Preset-pack licensing for anything cuemark might ever ship or link to (see "Preset
   formats"). Not blocking: packs are user-supplied. `butterchurn` itself (MIT) is a
   dependency since phase 6; `butterchurn-presets` (MIT package, unlicensed presets) is not.
