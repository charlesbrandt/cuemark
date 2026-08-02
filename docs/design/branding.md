# Cuemark brand icon & style guide

## Icon concept

Design authored in the Claude Design project ["Cuemark application icon
design"](https://claude.ai/design/p/11099be2-4638-4de0-bd07-22719cbbdc64)
(`Cuemark Icon.dc.html`), turn 1: three cue-dot concepts.

**Selected: 1c "Cue + Arc"** — a single offset dot (the projector cue mark cuemark.com
is named after) with an orbiting groove segment behind it, a quiet nod to turntable
motion around the mark.

Rejected alternatives, kept here for reference in case the direction is revisited:

| ID | Name | Description |
|---|---|---|
| 1a | Pure Cue | Single offset dot only, no secondary mark — maximum reduction. |
| 1b | Cue + Reticle | Dot balanced by a diagonal viewfinder tick — read as precision targeting rather than motion. |
| **1c** | **Cue + Arc** | Dot with a partial orbiting arc — chosen for tying together the "cue mark" and "turntable" halves of the concept without adding UI-style chrome (crosshairs/reticles) to what should be a simple mark. |

## Source of truth

`branding/cuemark-icon.svg` (512×512, `viewBox 0 0 512 512`) is the canonical source.
Edit it directly rather than the design-canvas HTML for small tweaks; re-import from
the Claude Design project if the concept changes materially.

```svg
<rect width="512" height="512" rx="110" fill="#0c0c0e"/>
<circle cx="336" cy="176" r="66" fill="#ff2e6e"/>
<path d="M 218 176 A 118 118 0 0 1 336 58"
      stroke="#ff2e6e" stroke-width="16" stroke-linecap="round"
      fill="none" opacity="0.55"/>
```

Regenerate the full platform icon set from it after any edit:

```bash
cd src-tauri && cargo tauri icon ../branding/cuemark-icon.svg
```

This overwrites `src-tauri/icons/*` (32×32, 64×64, 128×128, 128×128@2x, `icon.png`,
`icon.icns`, `icon.ico` — the set referenced by `bundle.icon` in `tauri.conf.json`).
`cargo tauri icon` also emits Android/iOS/Windows-Store assets by default
(`icons/android/`, `icons/ios/`, `Square*Logo.png`, `StoreLogo.png`); delete those
after regenerating — this app has no mobile or Store target and they're dead weight.

The **installed desktop launcher** reads its icon from the Linux icon theme, not
from `src-tauri/icons/` directly — see the `run-app` skill for the full launcher
setup. After regenerating:

```bash
cp src-tauri/icons/32x32.png  ~/.local/share/icons/hicolor/32x32/apps/cuemark.png
cp src-tauri/icons/128x128.png ~/.local/share/icons/hicolor/128x128/apps/cuemark.png
gtk-update-icon-cache -f -t ~/.local/share/icons/hicolor
```

## Geometry rules

- **Canvas**: 512×512, corner radius 110 (~21.5% of width) — a squircle, not a
  circle or a sharp square. Pre-baked into the source (not left to OS auto-masking),
  since Linux desktop environments generally render app icons as-is.
- **Cue dot**: radius 66, centered at (336, 176) — upper-right of center, echoing
  the off-center placement of an actual film-reel cue mark rather than a centered
  logo-mark.
- **Arc**: radius 118 traced from the dot's position, 16px stroke, round caps,
  55% opacity — a groove segment, not a full ring. Keep it a partial arc (roughly
  a quarter turn); a closed ring reads as a "record" cliché the concept is
  deliberately avoiding.
- Don't add a third element (text, additional marks). The whole point of 1c over
  1a/1b was staying reducible to a dot + one gesture.

## Color palette

| Role | Hex | Usage |
|---|---|---|
| Icon background | `#0c0c0e` | Near-black tile background — matches the app's dark UI register but is a distinct, slightly warmer black than the in-app surfaces. |
| Brand accent ("cue magenta") | `#ff2e6e` | The dot + arc. Reserved for the mark itself — a bright, saturated pink-red chosen to read clearly at 32px and stand apart from the muted grays of the working UI. |

**Open item**: the in-app UI (`src/app.css`) currently uses `#e04040` (a duller
red) as its primary accent — active decks, transport highlights, hot-cue markers,
slider accent-color. That predates this icon work and was not changed here (out of
scope for "add a launcher icon"). If/when the brand color is unified across the
icon and the UI, `#e04040` → `#ff2e6e` is the natural direction, but that's a
deliberate follow-up, not a byproduct of this change — treat `#e04040` as current
UI truth until someone decides to make that swap.

## Non-goals

- This guide covers the **app icon** only. It does not establish a typography
  system, a full UI color system, or marketing/website assets — those don't exist
  yet and shouldn't be inferred from three SVG concepts.
