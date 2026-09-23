# Tempo maps: tracks whose tempo changes on purpose

**Status (2026-09-20): ANALYSIS ONLY — nothing built, and deliberately not being pursued yet.**
The schema (`Deck.bpm` + `downbeat`, Digger `bpm` + `beat_anchor_ms`) assumes one constant
tempo. This doc records the first known counter-example, what was measured, and the options,
so the next session doesn't have to redo the analysis.

## The specimen: Bakermat — Baianá (Official Video) [iaGjz4dtr3o]

Measured offline (numpy port of `bpm.ts`'s onset + comb fit, plus librosa) on the cached
mp4, 200.2s. **Not cuemark's own `audio_analyze_file` output, and Digger's stored row was
not inspected** — the DB lookup by title/path found nothing.

| Section | Tempo | Evidence |
|---|---|---|
| ~0–30s | **unmeasurable** | body percussion + vocal, almost no kick; every method returned scatter (101–140 BPM). Needs a listen / manual tap for ground truth |
| ~30–68s | **accelerando, ~107 → ~122 BPM** (≈0.45 BPM/s, near-linear) | windowed comb on the 150 Hz–6 kHz band: 107.3 (34s), 110.6 (44s), 112.4 (48s), 116.0 (52s), 119.3 (60s), 121.0 (64s), 122.7 (68s) |
| ~60s → end | **constant 122.000 BPM** | kick-band (30–150 Hz) phase flat to ±0.01 beats for ~140s, including the 100–136s breakdown |

So it is a ramp then a lock, not a steady acceleration. The global fit cuemark produces
(122.02, matches the deck) is right for the last ~140s; extrapolated back into the ramp it is
~2.65 beats out of phase. Its confidence was 0.159 against `GRID_CONFIDENCE_FLOOR` 0.15 — it
passes only barely, because the ramp smears the comb sum.

Caveats: the ramp shape comes from 8s windows, so endpoints are blurred by a few seconds; a
mid-band comb is noisier than a kick-band one, and the kick is absent for the first ~40s.

## What breaks on a variable-tempo region

- `quantizeToGrid` / SNAP put cues and loop points off the beat.
- Sync / Lock / NUDGE report a phase alignment that does not exist.
- Mix zones that land in the ramp (this track's stored `In start 0:20` / `In end 0:31`) are
  meaningless if derived from beats — relevant to `mix-zones.md` §2.

**In practice the main body is what gets mixed, and it is locked**, so the harm today is
confined to the intro. That is why this is parked.

## Options

1. **Grid-valid-from marker.** One marker: "the constant grid holds from here" (~60s here).
   Before it, sync/snap/nudge are disabled or flagged unreliable. Small; stops the false
   claim; does not help beatmatch the ramp. Detection is the same problem as option 2's.
2. **Piecewise tempo map.** Ordered `{t, bpm}` anchors, linear interpolation. `deck.bpm`
   stays the steady-state tempo; all mod-one-beat math goes through
   `beatAt(t)` / `timeAt(beat)` / `tempoAt(t)`. A constant track is a one-segment map, so
   existing data is unchanged. Fits this track (one ramp + one flat). Sync would need to
   follow `tempoAt(t)` or refuse to lock inside a ramp.
3. **Explicit beat-time list** (Rekordbox/Traktor-style variable grid). Handles anything,
   including a live drummer; heavy to store/edit and needs a beat tracker good enough to
   produce it. Overkill for this library.

**Suggested order if ever pursued: 1, then 2.** Option 1's data falls out of option 2's
detection anyway.

## Open decisions

- **Where it lives.** Digger already has `bpm`, `beat_anchor_ms`, `beat_grid_confidence` and
  a `markers` table (`position_ms`, `type`); a map is new marker types or a new column, and
  is cross-repo (needs a numbered `migrate.py` step — see `mix-zones.md` for the pattern).
- **What Sync does inside a ramp** — follow `tempoAt(t)`, or refuse.
- **Detection**: kick-band comb where the kick exists, mid-band otherwise; a windowed comb
  whose per-window confidence gates "grid-valid-from". The probe scripts are not kept in
  the repo; the method above is enough to redo them (~20 lines each).
