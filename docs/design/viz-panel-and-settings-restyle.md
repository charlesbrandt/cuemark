# Visualization panel overhaul and settings restyle (UI)

**Status (2026-09-27): Phase 1 (picker + layer column) built and headless-verified on
`mele`; phases 2–4 not started.** The mockups are a claude.ai design canvas:
https://claude.ai/artifact/F2eBGJ3geKm8q6ZyTLPxTk (private to the owner). Every decision
below comes from the user, or from a proposal the user saw and didn't object to. Nothing
here needs another design pass. Build from this doc.

**Phase 1 (2026-09-27)**: `VisualizationPanel.svelte` rewritten to the three-column
layout (Layer / Source / per-plugin Settings). `vizPicker.ts` reworked to two groups only
(`buildVizPickerItems`/`groupPickerItems`/`filterPickerItems`/`stepSelection`/
`thumbGradient`, unit-tested in `vizPicker.test.ts`), favorites persisted via a new
`vizFavorites.ts` (`cuemark:vizFavorites`, same local-copy `persistentWritable` pattern as
`displaySettings.ts`). Custom thumbnail popover (search, All/Milkdrop/Shaders/★Favorites
chips, ★ per row, prev/next) replaces the native `<select>`. `npm run check` and `npm
test` clean (230 files / 3713 tests). Verified end-to-end via `verify-ui` on a
`VITE_ENABLE_DEBUG_HOOK=1` debug build under Xvfb: picker open/search/filter/select,
Plasma selection round-tripped through the Layer ON AIR/OFF toggle (off caches the
pluginId component-locally and restores it on), quick opacity buttons, prev/next
stepping, and the ★ favorite write/filter all behaved correctly; `cuemark.log` showed 132
disk plugins + 5 built-ins = 137, 0 build errors, matching the picker's own count.
⚠️ **The ON AIR/OFF toggle is a component-local cache, not `Session.visualizationEnabled`**
(off is still `setVisualization(null)` under the hood) — the real persisted field is
phase 2's job; this is an interim UX that round-trips correctly within one session but
not across a reload. Not yet looked at by the user on the real projector.

## The ask (user, 2026-09-27)

- The visualization UI felt fragmented. The five built-ins "aren't very good compared to what
  is available through the other sources", so they don't get their own group.
- One consistent picker across every source.
- Global opacity is easy to reach and kept apart from per-plugin settings.
- A track with no video (or only a still image) switches the visualization on automatically,
  then switches it back off when the next track comes in. No video → 100% opacity.
- Then: restyle the other Settings tabs to the same look.

## Decisions

**Panel** (`src/components/VisualizationPanel.svelte`). Three columns plus a strip:
1. **Layer** (global, never per-plugin): an ON AIR/OFF toggle, a large opacity readout and
   slider, and 0/25/50/75/100 quick buttons. It shows an amber AUTO chip plus "your N% comes
   back next track" while auto is in control.
2. **Source**: a *custom* popover picker, because a native `<select>` can't show thumbnails. It
   has a thumbnail per row, search, All / Milkdrop / Shaders / ★ Favorites filters, ★ per row,
   and prev/next buttons beside it. There are two groups only: **Milkdrop** and **Shaders
   (ISF)**. Built-ins sit inside Shaders with a small "built-in" tag. "Reacts to" (the
   existing `vizAudioSource`) sits under the picker.
3. **Settings for the selected plugin only**: Milkdrop blend/auto-cycle (adding a new "cycle
   from Favorites / All" pool), or the ISF inputs from `describeInputs()`, plus Reset.
4. **Auto-visualize strip** (decided: it lives **in this panel**, not in Settings): an on/off
   switch, "Show: current selection / a default / random favorite", no video = 100% (fixed),
   still image = a slider (default 60%).

**Toolbar**: the "Visualization" button becomes a split control: a VIZ toggle, a mini opacity
slider with its %, and a ▾ that opens the panel. Three states: off (grey, opacity kept),
on (cyan), AUTO (amber).

**Deck header** (`DeckCard.svelte`): a `NO VIDEO` / `STILL IMAGE` badge at load, plus
`AUTO VIZ n%` on the deck that is currently driving auto.

**Auto-visualize behaviour** (rules, detection, precedence, and the global-vs-per-deck
reasoning) **lives in `track-visual-override.md` → "Automatic fallback"**, merged there
2026-09-27 because it's the same question: what a track with no video shows. This doc
owns only its UI: the panel's auto strip, the toolbar AUTO state, and the deck badges.

**Settings restyle** (`SettingsPanel.svelte`, `AudioSettings.svelte`,
`ControlsSettings.svelte`, `MidiMonitor.svelte`, `RecordPanel.svelte`):
- The tabs become **Audio · Controls · Auto DJ · MIDI · Record · Display**. Auto DJ and
  Display are split out of `ControlsSettings`.
- The visual language comes from the panel: small uppercase section labels, a large mono
  value beside each slider, and **one short help line** under each control instead of the
  current paragraph-long `hint-inline` text. Segmented buttons replace short `<select>`s
  (tempo range, jog mode, record format). Switches replace checkboxes for on/off features.
  Snapcast targets become cards. Unmapped MIDI rows are highlighted amber.
- The Auto DJ tab gets a "last minute of a track" strip showing preload, mix start and fade.
- **Pure restyle. Store names, ranges, defaults and behaviour don't change.** When you
  shorten a hint, keep its fact: move detail to a `title` tooltip rather than dropping it.
  Several hints encode real constraints (Snapcast delay semantics, preload > min lead).

Palette: the app's existing tokens (`src/app.css`), cyan `#7ec8e3` for viz, deck lavender
`#7c8cff` for settings, amber `--accent-queue` for AUTO, font Manrope. No new fonts.

## Build order (each phase ships and is verified on its own)

1. **Picker + layer column** (frontend only). Custom picker component, two groups,
   favorites persisted via `persistentWritable` (`cuemark:vizFavorites`), prev/next.
   Keep `vizPicker.ts`'s grouping pure and unit-tested (`vizPicker.test.ts`).
2. **Toolbar split control.** Needs a real on/off that keeps opacity. Today "off" =
   `visualization: null`, which loses the pluginId. Add something like a
   `Session.visualizationEnabled` field (types.ts plus a `bootRestore` migration).
3. **Settings restyle**, one tab per commit. Frontend only.
4. **Auto-visualize**: build it per `track-visual-override.md` "Automatic fallback" (a
   still-image probe first, then `autoViz.ts`), and wire it to the auto strip and badges
   designed here.

## Verification

- `npm run check`, `npm test` after every phase. `cargo check` for phase 4.
- UI: the `verify-ui` skill (tauri-driver + Xvfb; on `mele` it needs
  `CUEMARK_DISABLE_DMABUF=1` or rAF never fires). ⚠️ Headless instances share localStorage
  with the live app by origin. Don't leave test values in `cuemark:*` keys.
- Compare against the canvas boards. **The live app may be a stale build**: the 2026-09-27
  screenshot still showed the pre-`8e748bf` chip rows. Check the `[build]` provenance line in
  `cuemark.log` before judging a UI change (`skills/run-app/SKILL.md`).
- Auto-visualize needs a live check by the user with real audio-only and still-image tracks.
