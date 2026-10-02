---
name: visualizations
description: Adding external ISF shaders and Milkdrop/Butterchurn presets to cuemark's visualization layer — where they live, source packs and licensing, the drop-in + Rescan procedure, and how to headless-verify a batch before trusting it. Load when sourcing/downloading visualization content, troubleshooting a plugin that renders black or errors, or explaining the picker's Milkdrop/Shaders groups (built-ins tagged into Shaders, not their own group).
---

# Cuemark visualizations — sourcing and adding external content

Architecture, phases and status live in `docs/design/visualization-plugins.md` — read that
first for *why* things are built this way. This skill is the operational "how do I get more
visualizations into the app" doc.

## Where plugins live

Everything except the five vendored built-ins (`src/lib/renderer/builtin-isf/*.fs`, ids
`builtin:plasma` etc., shipped in the repo) is read from one folder, **outside the repo**,
per-machine:

```
~/.local/share/com.cuemark.app/visualizations/
├── SOURCES.md              ← per-machine provenance record you maintain by hand (not git)
├── some-shader.fs          ← bare ISF plugin (id: "some-shader.fs")
├── a-folder-plugin/        ← folder plugin with IMPORTED image assets (id: "a-folder-plugin")
│   ├── plugin.fs
│   └── texture.png
└── milkdrop/                ← Butterchurn/Milkdrop presets ONLY — never scanned for ISF
    └── some-preset.json     ← id: "milkdrop/some-preset.json"
```

The repo's `.gitignore` has a defensive guard (`/visualizations/`, `/plugins/milkdrop/`,
`*.milk`) in case content ever lands inside the checkout by mistake — it shouldn't, since
this path is entirely outside it, but community preset packs carry unclear per-file licenses
(see "Licensing" below), so nothing here may ever be committed or redistributed.

After adding or removing files, click **Rescan** in the Visualization panel (or restart the
app) — the folder isn't watched live.

## The picker

`VisualizationPanel.svelte` (rebuilt 2026-09-27/28, `docs/design/viz-panel-and-settings-restyle.md`
phases 1–3 — **not** a native `<select>` anymore) is three columns — **Layer** (global
ON AIR/OFF + opacity), **Source**, **Settings for the selected plugin** — plus a toolbar
split control (`App.svelte`'s `.viz-split`). The Source column is a custom popover picker
(`vizPicker.ts`'s `buildVizPickerItems`/`groupPickerItems`/`filterPickerItems`) with a
thumbnail per row, search, and **two groups only: Milkdrop and Shaders (ISF)** — the five
built-ins are folded into Shaders with a small "built-in" tag, not their own group (the user
considers them weak compared to sourced content). Filter chips: All / Milkdrop / Shaders /
★ Favorites (`vizFavorites.ts`, `cuemark:vizFavorites`). A "⚠" suffix on any row means it has
an error — hover for the message, or check the panel's error banner and `cuemark.log`
(`[viz] …` / `[output] visualization <id> failed (<stage>): …`). If a screenshot shows a
single grouped `<select>` or a row of plain button-chips instead of this popover, the running
app is a stale pre-`07215b7` build, not current code — check `cuemark.log`'s `[build]`
provenance line (`skills/run-app/SKILL.md`) before trusting a screenshot. Auto-visualize
(behaviour spec in `docs/design/track-visual-override.md` "Automatic fallback") is phase 4,
not yet built — the panel has no auto strip and the toolbar control has no AUTO state yet.

## Adding ISF plugins

**Format**: ISF (Interactive Shader Format) `.fs` files — a JSON header block (`INPUTS`,
`PASSES`, credit/description) followed by GLSL. Cuemark's loader supports (as of this
writing): single-pass **and** multipass (`PASSES`/`TARGET`, persistent/float buffers, phase
4), `image`-type inputs (phase 2), and `CUEMARK_BIND` audio/beat bindings. It compiles the
vendored ISF parser's GLSL ES 1.00 output — WebKitGTK/ANGLE here rejects GLSL ES 3.00-only
syntax (array constructors, `uvec2`, etc.), so a shader written against a GLSL ES 3.00 target
will fail to compile even though it's valid ISF elsewhere.

**A known source**: [Vidvox/ISF-Files](https://github.com/Vidvox/ISF-Files) (MIT, repo-level
`LICENSE`) — the canonical community ISF collection, hundreds of shaders with per-file
`CREDIT` fields. 30 were vetted into this machine's folder 2026-09-27; see that folder's
`SOURCES.md` for exactly which ones and why.

⚠️ **That first batch under-selected.** It was picked by an agent working from a stale
worktree that predated phases 2 and 4, so it filtered the 327-file repo down to single-pass,
no-image-input shaders only (40 candidates, 35 compiled, 30 shipped) — needlessly narrow
given multipass and `image` inputs both actually work on current main. Re-running the
selection against the full repo (allowing multipass and `image`-type shaders) is open
follow-up work, not yet done.

**Procedure to add more**:
1. Get shaders from a source with a clear permissive license (check the repo's own LICENSE,
   not just "found on GitHub" — many ISF/Shadertoy ports carry no license or an explicit
   non-commercial one).
2. Drop the `.fs` (or a folder, for one with `IMPORTED` image assets) into the visualizations
   folder.
3. Rescan, then pick it from the Source popover. A build failure shows in the panel with the stage
   (`parse`/`compile`/`link`) and the exact GLSL error, plus a `cuemark.log` line — never a
   silent black layer.
4. **Vetting a batch before shipping it**: there's no saved reusable probe for this yet (the
   2026-09-27 batch used a one-off headless check driving the real `output.html`'s
   `cuemark-output` `BroadcastChannel` protocol — the same technique
   `scripts/probes/milkdrop_output_window_probe.py` uses for Milkdrop, just posting a `viz`
   message per candidate and reading back `vizOk`/`vizError`). Writing an
   `isf_batch_compile_probe.py` companion to the Milkdrop one would make this repeatable —
   flagged in the design doc as a follow-up, not yet built.
5. Update the folder's own `SOURCES.md` with the source URL, license and what you kept/dropped
   and why — it's the only record once a shader's origin repo moves or disappears.

## Adding Milkdrop (Butterchurn) presets

**Format**: NOT raw `.milk` text. Cuemark's `validate_milkdrop_preset` (Rust,
`viz_plugins.rs`) requires a top-level JSON object with a `baseVals` object — the *converted*
Butterchurn preset shape (`baseVals`, `shapes`, `waves`, `init_eqs_str`/`frame_eqs_str`/
`pixel_eqs_str`, `warp`, `comp`).

**Two ways to get converted JSON**:
- **`butterchurn-presets`** (npm, MIT package) ships ~1750 pre-converted presets under
  `presets/converted/*.json`. Fetch with `npm pack butterchurn-presets` into a **throwaway
  directory outside the repo** — never `npm install` it into cuemark's own
  `package.json`/`node_modules`, and never commit its output. The runtime dependency is
  `butterchurn` itself (already in `package.json`); `butterchurn-presets` is a source of
  *content*, not a code dependency.
- **`milkdrop-preset-converter`** (npm, MIT) converts raw `.milk` files you already have
  (e.g. from an old Winamp install) into the same JSON shape.

**Licensing — read before shipping any preset anywhere but your own machine**: the
`butterchurn-presets` *package* is MIT, but the individual presets are by many different
original Milkdrop-era authors, credited only in filenames (e.g. "Geiss", "Flexi",
"Rovastar"), with **no per-preset license recorded anywhere**. This is exactly why cuemark's
own design decision is "presets stay user-supplied" — never bundled in the repo, never
redistributed. Only place them in your own `~/.local/share/com.cuemark.app/visualizations/milkdrop/`
for personal local use.

**Procedure**:
1. Fetch/convert presets as above, into a scratch directory.
2. Copy the `.json` files into `visualizations/milkdrop/`.
3. Rescan. A malformed file is listed with an error rather than silently dropped
   (`discover_milkdrop_presets` in `viz_plugins.rs`), and a preset larger than 4 MB is
   rejected outright (real presets are tens of KB).
4. **Verify a real sample renders**, not just that it parses — `validate_milkdrop_preset`
   only checks JSON shape, not whether Butterchurn's own equation execution (`new Function`
   JS per preset) succeeds at runtime. Run the actual end-to-end probe:
   ```sh
   CUEMARK_DISABLE_DMABUF=1 python3 scripts/probes/milkdrop_output_window_probe.py \
     --presets ~/.local/share/com.cuemark.app/visualizations/milkdrop --mode dev
   ```
   It drives the real `output.html`, loads the first two presets (alphabetically) from the
   directory, and asserts `vizOk`, real pixels via `xwd` (never WebGL readback — unusable on
   the MacBook Pro's `crocus` driver), PCM reaching the iframe, opacity, and that bad presets
   correctly surface `vizError`. It only samples 2 of however many are in the folder — for a
   large batch, either run it a few times against different subsets or accept the sample as a
   confidence check, not exhaustive coverage.
5. Update `SOURCES.md`.

## Auto-cycle and blend

Once a Milkdrop preset is selected, the panel shows **blend time** (crossfade seconds between
presets) and **auto-cycle** (`Off` / every N seconds / every N bars — bars use the dominant
deck's beat grid when it has one, falling back to seconds otherwise). These are per-session
UI state, not per-preset.

## Related

- `docs/design/visualization-plugins.md` — architecture, phase status, hazards, open
  follow-ups (dominant-deck routing for `inMixOut`/`liked`, the ISF batch-vet probe, live
  projector verification).
- `docs/design/viz-panel-and-settings-restyle.md` — the current panel/toolbar UI (phases
  1–3 shipped 2026-09-28), its build order, and the still-open phase 4 (auto-visualize).
- `docs/scripts-reference.md` — `milkdrop_sandbox_iframe_probe.py` (Phase 6 feasibility spike)
  and `milkdrop_output_window_probe.py` (the end-to-end probe used above).
- `skills/verify-ui/SKILL.md` — the tauri-driver + Xvfb headless setup these probes build on.
