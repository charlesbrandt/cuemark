# Mix zones: four-point vocabulary, and deriving the points algorithmically

**Status: design + handoff, nothing built (2026-09-20).** Two linked pieces of work, in the
order they should be done. Written as a cold-start brief for a new session — read this first,
then only the two docs it names.

**Prior reading, in this order and no further:**
1. [`auto-dj-transitions.md`](auto-dj-transitions.md) — "Phase 7", "Phase 7b", and the numbered
   open decisions. That is what exists today.
2. [`auto-dj-zone-review-2026-09-19.md`](auto-dj-zone-review-2026-09-19.md) — §3 (what a
   four-point model costs) and §5 (the phased plan). Its phase C is what §1 below revises.

Skills: `digger-integration` ("Marker vocabulary and mix points" — schema costs, the writer
inventory, the manual-wins rule), `tuning-knobs` §8, `digger` (local-vs-prod DB, deploy
sequence — **load it before touching Digger**, per `[[feedback_load_digger_skill_first]]`).

---

## Where this came from

Auto DJ's transitions are marker-driven. Phase 7 made the blend run *over* the outgoing
track's outro zone; phase 7b made the incoming deck *start* at its mix-in marker. Both landed
on a library where **the markers carry almost no information**: Digger derives
`mix_in = beat_times[0]` (the first tracked beat, typically < 1 s — i.e. "the beginning of the
song") and `mix_out = last beat − 16 bars`. The outro side is a real boundary; the intro side
is not. So every intro-driven behaviour cuemark now has is **inert until a human hand-places a
marker**, which is both a testing problem and a usability one.

Two things fix that, and they are independent:

- **§1 — say which end each marker is.** A one-point-per-zone model forced `introPoint` to be
  read as both a length and a start. Fixing the vocabulary is cheap and unblocks correct
  blend-length math.
- **§2 — derive a mix-in point worth having.** "Doesn't have to be right every time, just
  better than the beginning of the song." This is the one that makes the feature work on the
  whole library without manual work.

Do §1 first: §2's output has to be *stored* somewhere, and storing it under the ambiguous
vocabulary bakes the ambiguity into every newly derived row.

---

## §1 — Four-point mix-zone vocabulary

### The decision

Use **four symmetrical marker types**:

| Zone | start | end |
|---|---|---|
| mix-in (fade-in) | `mix_in_start` | `mix_in_end` |
| mix-out (fade-out) | `mix_out_start` | `mix_out_end` |

This supersedes the review §3 proposal (`mix_in` + `intro_end` / `mix_out` + `outro_end`).
Reasons, in order of weight:

1. **A marker that bounds a region must say which end it is.** That is the exact defect this
   whole thread has been chasing, twice: finding A was the fade placed on the wrong side of
   `mix_out`; phase 7b's open item is `introPoint` reading as both a length and a start. A bare
   `mix_in` invites both readings *and both are defensible*, which is what makes the resulting
   bugs silent. `mix_in_start` cannot be read as a length.
2. **Symmetry.** `mix_in` + `intro_end` names one end after the transition and the other after
   the song section, so a reader must already know they are two ends of one zone. Four `mix_*`
   names are self-describing in any order.
3. **`mix_*` is the honest namespace.** An "intro" is a property of the *song*; a "mix-in zone"
   is a property of the *mix*. They usually coincide and sometimes must not — a DJ may want to
   come in late over a long intro. These markers are consumed by the transition engine, so
   they should be named for the transition.

### What it costs — and the one claim to be careful with

Adding types is free (`markers.type` is free text, no CHECK constraint — see the
`digger-integration` skill). **Renaming `mix_in`/`mix_out` is not**: it is a data migration
over existing rows, including hand-placed ones. Still no `db.py` schema change, but a real
numbered `migrate.py` step:

```sql
UPDATE markers SET type = 'mix_in_start'  WHERE type = 'mix_in';
UPDATE markers SET type = 'mix_out_start' WHERE type = 'mix_out';
```

**Backward compatibility is free, though, because the wire payload is a separate contract from
the storage vocabulary.** `_build_cuemark_payload()` keeps emitting `mixIn`/`mixOut` (now from
`mix_in_start`/`mix_out_start`) and adds `mixInEnd`/`mixOutEnd`, so an un-updated cuemark build
keeps working unchanged. That removes the only real argument for keeping the old names.

### Build order

1. **Digger**: the migrate step above; `_derive_mix_points()` writes the four types;
   `_build_cuemark_payload()` gains `mixInEnd`/`mixOutEnd`; `backfill_mix_points.py` extended.
   Derivation defaults that preserve today's behaviour: `mix_out_end = duration`,
   `mix_in_end = mix_in_start + 16 bars` clamped to `duration/3` (a structurally correct zone,
   not a real intro boundary — that is §2).
2. **cuemark**: `Deck.introEnd`/`outroEnd`; `TransitionZones`; `zonesOf`; the `queueStore`
   mapping; `computeTransitionDurationMs` taking **two real lengths**
   (`min(outroEnd − outroStart, introEnd − introStart)`) instead of distances to implicit
   boundaries. **This is what resolves phase 7b's double-duty problem**: the start is a start,
   the length is a length, and a hand-placed mix-in stops inflating the blend.
3. **UI**: `MarkerPanel` gets a second ⦿ per zone (keep the label·time·⦿·✕ grammar);
   `WaveformCanvas.drawZone` draws both edges, both zones unpinned.
4. **Trust gates**: fold the `duration/3` floor/ceiling and `MIN_ZONE_SEC` into one exported
   `effectiveZones(deck)` that both `transitionPlan` and `MarkerPanel` read (review A4), and
   **split the point rule from the zone rule** — a hand-placed `mix_in_start` at 0.5 s is a
   perfectly good start position on a track with a hard first downbeat, and today
   `introZoneSec` rejects it because 0.5 s is not a usable *zone*. That split only makes sense
   once the two values exist separately, which is why it waits for this phase.

---

## §2 — Deriving a mix-in point better than "the beginning of the song"

### The goal, stated so it can be checked

Replace `mix_in = beat_times[0]` with something that lands at **"where the track has actually
started"** — after the bare-intro bars, at a bar boundary. It does not have to be right every
time. It has to be **right more often than 0.0 s, and wrong in a survivable direction.**

**Survivable direction matters more than accuracy.** Too early costs a few seconds of quiet
intro under a fade — exactly today's behaviour, so a wrong-early answer is never worse than the
status quo. Too late skips the head of a track the DJ queued, which is a real musical error.
So: **bias early, bar-quantise, and bound how far forward it may move.**

⚠️ Vocabulary check before starting: the user's phrasing for this was "the set beat point".
That is *not* the `downbeat` marker the DeckCard **SET BEAT** button writes — the beat-grid
anchor is already derived algorithmically by the comb fit (`bpm.ts` / `importers/beatgrid.py`)
and is not "the beginning of the song". This section is about **`mix_in_start`**. Confirm that
reading in the first minute of the session.

### The efficiency lever: it can run on cached envelopes, with no audio decode

This is the part worth designing around. Digger already stores, per track, a **210 Hz RMS
envelope** in `waveform_cache` (its own ATTACHed db file), and `detect_beat_grid()` already
consumes *exactly that* rather than raw audio. So an envelope-only derivation:

- is **backfillable over the whole library without re-decoding anything** — the expensive step
  in `analyze_audio.py` is the `librosa.load`, not the analysis;
- runs in-process in the always-on `api` container (CPU-only, no GPU handoff);
- can be **iterated on cheaply**: re-run over cached envelopes, re-score, adjust, repeat.

**First thing to measure, before designing anything**: what fraction of the library actually
has a `waveform_cache` row, on the **production** instance (192.168.2.99 — the local dev db is
a different database with the same catalog and almost no analysis, see the
`digger-integration` skill). If coverage is low, an envelope-only approach loses its advantage
and the decision changes. One query; do not skip it.

### Candidate signals, cheapest first

| # | Signal | Needs | Notes |
|---|---|---|---|
| A | **First sustained full-energy bar.** Per-bar mean RMS from the cached envelope + the existing grid; first bar `B` where `mean(B..B+3) ≥ θ · median(body bars)`; emit `B`'s downbeat. | envelope + grid (both cached) | The obvious first cut. Naturally bar-quantised, robust to one loud hit, one tunable (θ). |
| B | **Energy *step*, not level** — largest positive jump in smoothed per-bar RMS within the first third. | same | Catches "the drop" on tracks whose intro is loud but thin. Complements A; disagreement between A and B is itself a useful confidence signal. |
| C | **Low-band onset** — "the bass comes in" is the best single proxy for "the track has started" in 4/4 dance music. | ⚠️ a **multi-band** envelope; today's cache is broadband | Probably the highest-value signal here, and it is a cache-format change (3-band low/mid/high). Costs a re-decode pass over the library once, then it is cached forever and would likely improve the beat grid too. Worth pricing. |
| D | **Structural segmentation** (librosa recurrence matrix / `segment.agglomerative` over MFCC or chroma); take the first boundary ≥ ~8 bars in. | raw audio | **Nearly free *during* analysis** — `analyze_audio.py` already computes chroma for key detection — but not backfillable without a decode. Good candidate for "new tracks get the better answer, old tracks get A". |
| E | **Vocal onset** from the Demucs stems pipeline. | GPU, separate pipeline, likely sparse coverage | The gold standard for "end of intro" on vocal tracks, useless on instrumentals. Check actual stem coverage before considering it. |

Recommended shape: **A as the baseline, B as a cross-check, C priced properly, D added for
newly-analysed tracks if it beats A.** Ship A first; it is a day of work and it is already
better than 0.0 s.

### How to know whether it worked

The trap here is shipping a derivation nobody can score. Build the ground truth first, and note
that **doing so also produces exactly what phase 7b needs for live verification**:

1. Hand-place `mix_in_start` on ~20 tracks across genres, in cuemark's MarkerPanel (they land in
   Digger as `source='manual'`, and `_upsert_mix_marker` will never overwrite them).
2. Score each candidate against those: median absolute error in **bars**, and the share of
   tracks where the answer is **late** (the error that actually hurts).
3. Baseline to beat: `beat_times[0]`. It is a low bar. Report both numbers.
4. Then live-test the transitions on those same 20 tracks — which is the phase 7/7b
   verification that is still outstanding.

### Safety rules for whatever gets built

- Stay `source='detected'`, so a hand placement always wins (`_upsert_mix_marker` already
  enforces this — the "re-analysis clobbers manual markers" warning in cuemark is **stale**).
- Bar-quantise the output to the existing grid; never emit a raw sample offset.
- Bound it: never move `mix_in_start` past `duration/3` (cuemark's consumers reject that
  anyway), and prefer the earlier of two candidates when they disagree.
- Emit a confidence, or at least log the candidates and the chosen one. A derivation whose
  disagreements are invisible cannot be improved.
- Leave `mix_out` alone. It works.

---

## Still outstanding, unrelated to both sections

**Nothing in Auto DJ phases 5–7b has been live-verified.** Not the per-pair duration, not the
tempo drift-back, not the self-resetting Preview, not the fade-over-the-outro-zone placement,
not the mix-in seek. The instrumentation from the idle-clock-drift work is also unverified.
Rebuilding the launcher (`npm run tauri build -- --no-bundle`) kills live audio, so it is the
user's call when — see `[[feedback_live_set_no_rebuild]]`.
