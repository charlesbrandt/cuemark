# Mix-zone model review — Auto DJ transitions (read-only, 2026-09-19)

Facts below are marked **[V]** verified in code this session, **[I]** inference.

---

## 1. The marker path end to end, and what's wrong with it

### The path [V]

**Derive (Digger).** `importers/analyze_audio.py::_derive_mix_points()` (line 109) writes two
markers per track during BPM analysis:
- `mix_in = beat_times[0]` — the *first tracked beat*. Usually < 1 s.
- `mix_out = beat_times[-1] − 16·4·(60/bpm)`, floored to `max(duration−30, mix_in)` and
  clamped to `duration`.

Both go through `_upsert_mix_marker()` (line 75), which writes `source='detected'`.
`importers/backfill_mix_points.py` does the same for tracks that already have a stored
`bpm`/`beat_anchor_ms` but no markers.

**Read.** `routers/tracks.py::_build_cuemark_payload()` (line 286) selects all markers
`ORDER BY position_ms` and takes the **first** `mix_in` and the **first** `mix_out` by
position → `mixIn` / `mixOut` in seconds. `GET /tracks/{id}/cuemark`.

**Load (cuemark).** `queueStore.ts::loadQueueItemToDeck()` lines 98–99:
`outroPoint: payload.mixOut ?? null`, `introPoint: payload.mixIn ?? null`.

**Set/clear (cuemark).** `MarkerPanel.svelte::setMix()` quantises the playhead
(`quantizeToGrid`), writes the deck field *first* (`updateDeck`), then, only if
`deck.diggerTrackId !== null`, calls `api.ts::setMixMarker()` = `clearMixMarker()` (GET
`/tracks/{id}`, DELETE every marker of that type) then `pushMarker()` (POST
`/tracks/{id}/markers`, `position_ms = round(sec*1000)`).

**Consume.** `autoMix.ts`: `nearEndReference()` (348), `computeTransitionDurationMs()` (416),
`transitionPlan()` (446), `zonesOf()` (457), plus `WaveformCanvas.svelte::drawMarkers()` (502)
for the shading.

### Bugs, races and inconsistencies found

**A. 🔴 The fade is placed on the wrong side of `outroPoint`.** [V] This is the biggest one
and it is semantic, not a crash.
- `computeTransitionDurationMs` derives the blend length from `duration − outroPoint` — the
  tail *after* the marker (autoMix.ts:421-422).
- `checkAutoMixTrigger` (831) computes `remaining = nearEndReference(...) − contentPos` and
  fires when `remaining <= plan.leadSec`; `transitionPlan` sets
  `leadSec = max(autoMixThresholdSec, ms/1000)` precisely so "the fade always finishes by the
  outgoing track's outro reference" (autoMix.ts:438-445, verbatim).
- Net effect: the ramp runs over `[outroPoint − len, outroPoint]` and completes **at**
  `outroPoint`, at which point `startCrossfadeRamp` sets `source: null` on the outgoing deck.
  The entire `[outroPoint, end]` region — the 16 bars Digger derived as "the tail the DJ is
  happy to have another track playing over" (autoMix.ts:359-361, verbatim) — is **never
  heard**.
- Digger's own spec disagrees with the implementation: `docs/design/playlist-management.md`
  "Mix points" says *"mix_out means where the next track starts coming in … the blend length
  is simply mix_out → end of track"* and *"start the next track at its mix_in"*.
- Root cause is a phase-4/phase-5 collision: phase 4 defined `outroPoint` as a replacement for
  *the literal end of the track* ("near-end reference"), phase 5 then derived a *length* from
  the tail beyond it. Both are defensible; together they are incoherent. **This alone can make
  every marker-driven transition feel wrong**, and it will read as "the markers do nothing
  useful" rather than as a placement bug.

**B. Optimistic local write with no rollback.** [V] `setMix()` calls `updateDeck` before the
network write and never reverts on failure; `withBusy` catches, logs, toasts, and stops. Deck
and Digger then disagree silently until the next load of that track. Same for `clearMix()`.

**C. Delete-then-insert is non-atomic, and the failure mode is data loss.** [V]
`clearMixMarker` does `GET /tracks/{id}` then a sequential `DELETE /markers/{id}` per row, then
`setMixMarker` POSTs. If the POST fails (or the app is killed between them), the track ends up
with **no** marker of that type at all — strictly worse than before the edit. If a DELETE
mid-loop fails, `clearMixMarker` throws and the POST never runs: same outcome, partially
deleted. There is no transaction and no `PATCH`-based alternative in use (Digger *has*
`PATCH /markers/{id}`, but `MarkerPatchIn` only accepts `label`/`color` — **not**
`position_ms`, so an in-place move is not currently possible server-side).

**D. 🟢 The "re-analysis clobbers a manual marker" warning is STALE — it does not happen.**
[V] This is documented as a live risk in three places (`api.ts:322-324`,
`MarkerPanel.svelte:14-18`, design doc open decision #4 and the Phase 6 "🔴 Still open" note),
and the code says otherwise:
- `routers/tracks.py::create_marker()` line 613: `source = body.source or "manual"` — every
  marker cuemark POSTs is `'manual'`.
- `_upsert_mix_marker()` lines 88-95: if **any** marker of that type has
  `source IS NULL OR source != 'detected'`, it `return`s and derives nothing.
- So re-running `analyze_audio.py` (or the backfill) over a track cuemark has edited is a
  **no-op for that marker type**. The doc's open decision #4 should be closed.
- Residual, and real: if the DJ *clears* a mix marker in cuemark, `clearMixMarker` deletes all
  rows, so the next analysis run has nothing to back off from and **re-derives a `detected`
  marker**. "Cleared" is not durable; "moved" is.

**E. Stale deck fields on a local-file load.** [V]
- `App.svelte:322` (drag-and-drop) sets only `source` + `playing`. It clears **neither**
  `diggerTrackId`/`diggerFileId` **nor** `introPoint`/`outroPoint`. The DeckCard file-picker
  path (`DeckCard.svelte:352`) has an explicit comment about exactly this hazard and clears
  the Digger ids — the drag-drop path was missed. Consequence: drag a local file onto a deck
  that held a Digger track and the Mix-points panel's ⦿ writes markers **to the wrong track
  in Digger**, silently.
- Neither local path clears `introPoint`/`outroPoint` (nor `cuePoint`/`hotCues`/`bpm`/
  `downbeat`). The previous track's zones are shaded over the new file's waveform and fed to
  `transitionPlan`. Partly masked by `nearEndReference`'s `min(outroPoint, duration)` clamp
  and the `duration/3` floor, but a stale outro on a longer new track fires the transition at
  a meaningless time.
- `startCrossfadeRamp`'s deck-free patch (autoMix.ts:544-546) clears `source`, `syncLocked`,
  `diggerTrackId`, `diggerFileId` — but not `introPoint`/`outroPoint`. Harmless for a Digger
  reload (which always overwrites both), part of the same gap for a local reload.

**F. No validation or cross-field clamping at write time.** [V] `setMix()` accepts any
playhead value. Nothing prevents `outroPoint < introPoint`, `outroPoint == 0`, or an intro
past the end. The *consumers* defend themselves (the `duration/3` floor for outro, the
`duration/3` ceiling for intro, `MIN_ZONE_SEC = 2`, `MIN/MAX_TRANSITION_MS`), but the UI never
says so — see G.

**G. The panel's zone numbers are not the numbers the engine uses.** [V]
`MarkerPanel.svelte:96-97` computes `introZone = deck.introPoint` and
`outroZone = duration − outroPoint` **raw** — no `MIN_ZONE_SEC`, no `duration/3` floor/ceiling,
no `MAX_TRANSITION_MS` cap. So the panel will confidently print "0.4s zone" for a value the
engine discards, "205.0s zone" for an outro the engine rejects as inside the first third, and
"30.0s zone" for a blend that will actually be capped at 20 s. The one number a DJ is told is
load-bearing is the one that can be wrong.

**H. Time display resolution.** [V] `fmt()` is `m:ss` — sub-second precision is invisible, so
Digger's typical `mix_in ≈ 0.43 s` shows as `0:00` and a beat-quantised nudge of a few hundred
ms is invisible in the panel. (The waveform shading does show it.)

**I. Units.** [V] Clean. Deck fields and the `/cuemark` payload are seconds; the markers table
is `position_ms` integer; conversion is `Math.round(sec*1000)` out and `/1000.0` back. No
drift found.

**J. Minor: no re-read after an external edit.** [V] Mix points are pulled once, at
`loadQueueItemToDeck`. Editing markers in Digger's web UI while the track is on a deck does
not reach cuemark until reload. Acceptable, but worth knowing when workshopping across both
UIs.

**K. Minor: `busy` guards the row, not the track.** [V] Two decks holding the *same* Digger
track (possible after a manual double-load) can run overlapping delete-then-insert sequences
against one track id. Narrow, but it is the one place the delete-then-insert non-atomicity
could interleave.

---

## 2. Can the DJ define and see two zones with start AND end today?

**No, and the gap is symmetrical in the UI and the model.** [V]

- **Panel**: four rows, one point each. `Intro` sets one number; `Outro` sets one number. There
  is no second field per zone, and the "zone" column is derived, not editable.
- **Waveform**: `drawZone(0, introPoint, …)` and `drawZone(outroPoint, trackEnd, …)`
  (WaveformCanvas.svelte:525-529). The far edge of each zone is **pinned** — intro always
  starts at 0, outro always ends at `duration`. Only one boundary line is drawn per zone
  because only one boundary exists.
- **Not draggable**: setting is playhead-only (⦿). Design-doc open decision #6 flags dragging
  as a real design question against the existing scrub gesture, not a free addition.
- **Guard rails invisible**: the `duration/3` floor/ceiling and `MIN_ZONE_SEC` are silent. A DJ
  who places an intro at 40 % of the track sees a shaded zone and a length and gets no
  transition change at all.

So the visual language is *already* zone-shaped — which is a real asset; the shading, the two
colours and the low-alpha wash all survive unchanged into a two-ended model. What is missing
is a second handle per zone, plus an honest readout of what the engine will actually do.

---

## 3. Can the current model represent `[a,b]` / `[c,d]`? What would it take?

**No.** [V] `Deck.introPoint` and `Deck.outroPoint` are `number | null` and both consumers
(`computeTransitionDurationMs`, `drawZone`) hard-code the missing end as `0` and `duration`.
`introPoint` is used *as a length* (autoMix.ts:429, `usableZone(incoming.introPoint)`), which
is only valid because the zone starts at 0.

### Minimal concrete proposal

**Digger schema: no migration needed.** [V] `markers.type` is `TEXT NOT NULL DEFAULT 'cue'`
with **no CHECK constraint** (`db.py:181-191`), and `MarkerIn.type` is a bare `str`
(`models.py:25-35`). New marker types are pure vocabulary — no `db.py` CREATE TABLE change and
no numbered `migrate.py` step. (This is the same discovery phase 4 made for `mix_out`.) The
only Digger edits are:
1. `_build_cuemark_payload()` — surface two more values.
2. `_derive_mix_points()` — derive them (and `_upsert_mix_marker` already protects manual
   edits, per finding D).
3. `importers/backfill_mix_points.py` — extend the target-set query and the apply loop.

**Marker types.** Add `intro_end` and `outro_end`, keeping `mix_in`/`mix_out` as the zone
*starts*. Concretely the four-point model becomes:

| Zone | start | end |
|---|---|---|
| fade-in | `mix_in` (existing) | `intro_end` (new) |
| fade-out | `mix_out` (existing) | `outro_end` (new) |

This is the least disruptive option: `mix_in` keeps its current meaning ("earliest point it is
safe to bring this track in"), `mix_out` keeps its ("where the next track starts coming in",
matching Digger's own spec), and nothing already stored changes meaning. It also answers open
decision #1 without redefining `mix_in`, which is the question the doc says needs the library
owner's call.

⚠️ **This needs a user decision** (see §5, D1): the alternative is a start+end *pair* stored as
one marker with a `length_ms`/`end_ms` column — that *would* need `db.py` + a numbered
`migrate.py` step, and buys atomicity of the pair (one row, one write, no
delete-then-insert-two-things). Given finding C, that atomicity is worth something. My
recommendation is still four marker types, because zero-migration is worth more and the
atomicity problem is better solved by making `PATCH /markers/{id}` accept `position_ms`.

**Payload shape** (`/cuemark`, additive, all `null`-able so old cuemark builds are unaffected):

```jsonc
{
  "mixIn": 0.43,        // unchanged — fade-in zone START
  "mixInEnd": 18.2,     // new — fade-in zone END   (marker type intro_end)
  "mixOut": 192.5,      // unchanged — fade-out zone START
  "mixOutEnd": 222.5,   // new — fade-out zone END  (marker type outro_end)
}
```

Resolution rule for the two new ones: **same as the others for now** (first by `position_ms`),
and fix the whole family together if open decision #4 is ever revisited — but note finding D
means that decision is much less urgent than the doc claims.

**Derivation defaults** so the feature is useful with zero manual work (Digger's stated rule in
`playlist-management.md`):
- `intro_end` = `mix_in + 16 bars` at the track's BPM, i.e. the mirror of the existing `mix_out`
  rule, clamped to `duration/3`. Not a real "end of the intro" — that is open decision #1's
  energy/vocal-onset analysis and is a separate, much larger job — but it is a *structurally
  correct* zone that a DJ can then drag, which is what the user is asking for.
- `outro_end` = `duration` (the current implicit value), so existing behaviour is the default.

**cuemark data model.** Replace the two scalars with two ranges; keep the old names as the
zone starts to minimise churn:

```ts
introPoint: number | null;   // fade-in zone START  (was: length from 0)
introEnd:   number | null;   // fade-in zone END    (new)
outroPoint: number | null;   // fade-out zone START (unchanged meaning)
outroEnd:   number | null;   // fade-out zone END   (new; null ⇒ duration)
```

`TransitionZones` gains the two fields. `zonesOf()` is a one-liner. `drawZone` calls become
`drawZone(introPoint ?? 0, introEnd ?? …)` / `drawZone(outroPoint, outroEnd ?? trackEnd)` with a
boundary line at **each** end.

**How `transitionPlan` should consume it** — and this is where finding A gets fixed:

- **Length** = `min(outroLen, introLen)` where `outroLen = outroEnd − outroPoint` and
  `introLen = introEnd − introPoint`, still clamped by `MIN_ZONE_SEC` / `MIN_TRANSITION_MS` /
  `MAX_TRANSITION_MS`. Same shape as today, but both sides are now real measured lengths rather
  than "distance from an implicit boundary".
- **Placement** = start the ramp **at `outroPoint`**, not finish at it. `nearEndReference`
  should become `outroPoint + ms/1000` (i.e. the fade's *end*), or — cleaner — the trigger
  should compare `contentPos >= outroPoint` directly and `leadSec` should disappear from the
  crossfade trigger, surviving only in the preload trigger where it is genuinely about load
  lead time. **This is a behaviour change and needs the user's sign-off** (§5, D2): every
  transition moves later by its own length.
- **Guard rails become explicit**: `duration/3` floor/ceiling and `MIN_ZONE_SEC` should be
  applied once, in a small exported `effectiveZones(deck)` helper that *both* `transitionPlan`
  and `MarkerPanel` read, so finding G cannot recur.

**Incoming-deck start position.** With real zones, `mixIn` finally means something as a *seek
target*: the live path and the preview should both `seekDeck(incomingId, introPoint, true)`
before `updateDeck({playing:true})`, so the blend covers `[introPoint, introEnd]` of the
incoming track against `[outroPoint, outroEnd]` of the outgoing. This is design-doc open
decision #5, and it becomes the *natural* behaviour once zones exist rather than an extra
feature. ⚠️ It adds a seek to the live path, which already has the documented
fire-and-forget-seek race (phase 3, 2026-08-24) — reuse the existing 200 ms settle window that
`beginTransition`'s sync branch and `previewTransition` both already use, and place the seek
*before* the rate write so the existing rate-then-seek ordering rule still holds.

**Preview.** Once the live path seeks the incoming deck to `introPoint`, preview should do the
same thing — which removes the current deliberate asymmetry (preview seeks to 0 specifically
because the live path doesn't seek at all; autoMix.ts:751-758). Preview's other two deviations
(keep `source`, no bookkeeping) stay. Preview should also seek the outgoing deck to
`outroPoint − ~3 s` rather than `reference − leadSec`, so the DJ hears the run-in *and* the
whole blend.

---

## 4. Is the zone model actually what blocks transition testing?

**Honest answer: it is #3, not #1.** The user's hypothesis is reasonable but the code says two
cheaper things are in the way first. Ranked, with evidence:

**1. 🔴 The fade never covers the outro zone (finding A).** [V] Even with perfect four-point
zones, if the ramp still *completes* at `outroPoint` the DJ is auditioning the wrong region of
the track and every parameter they tune will be tuned against the wrong thing. This is a ~20-line
fix in `nearEndReference`/`transitionPlan` and it unblocks meaningful listening immediately,
before any schema work. Evidence: autoMix.ts:348-351, 421-422, 438-448, 831-832; contradicted by
Digger's own `playlist-management.md` "Mix points".

**2. 🔴 Preview's preconditions and side effects make iteration expensive.** [V]
`previewTransition` (762-805) requires: both decks named in `crossfaderMapping`; a loaded track
with `duration > 0` on **both**; and it **moves the crossfader to the far end and leaves it
there** (open decision #7 — it parks at `target === 1 ? 0 : 1` before each run and never
restores). It also fully unloads nothing but does leave the incoming deck playing at the end.
So "try a transition, tweak a number, try again" works, but "try a transition, then go back to
listening to the outgoing deck normally" requires manual fader recovery every time. For a
workshopping loop this is the friction the user is actually feeling. Cheap fixes: restore the
fader on preview *end* behind a setting, and add a "stop/reset preview" control.

**3. 🟡 The zone model itself (single point + inferred length).** [V] Real, and the user's
diagnosis is correct as far as it goes — but note that **the outro side already works**:
Digger's auto `mix_out` is a genuine 16-bars-before-the-end boundary, so `duration − mixOut` is
a real ~30 s zone today, and `computeTransitionDurationMs` will report
`source: "outro"` for any analysed track. It is only the **intro** side that carries no
information (`beat_times[0]`, < 1 s, discarded by `MIN_ZONE_SEC`). So the immediate testing
blocker is narrower than "no zones": it is "the incoming side never constrains anything, and
the incoming deck starts at 0 so you hear its dead-air head under the fade".

**4. 🟡 Needing both decks loaded, with `duration > 0`.** [V] Required by preview
(772-777) and by `checkAutoMixTrigger` (828). `duration` is filled asynchronously by demux
(`App.svelte:476/544`, `legacyVideo.ts:142`), and a cold Digger fetch over the SMB mount is
seconds (`docs/design/preroll-latency.md`, memory `project_queue_prefetch_gate_result`). Real
friction, but it is inherent to auditioning a *transition*, and the 15 s `awaitDeckReady` poll
already handles it on the Skip path. Not a blocker, a cost.

**5. 🟡 Crossfader parked at the far end / not in `crossfaderTargets`.** [V] The 2026-08-25
incident (`from=1.000` equal to `target=1`, a zero-length interpolation) is the recorded
precedent. `previewTransition` now parks the fader first and is immune; **`checkAutoMixTrigger`
and `skipCurrentTrack` do not** — `beginTransition` → `startCrossfadeRamp` reads
`startValue = get(session).crossfaderValue` and ramps from wherever it is. A DJ who previews
once (leaving the fader at the far end) and then lets the live trigger fire gets an instant cut,
not a fade. Also, if `crossfaderTargets` has `opacity` but not `volume`
(`setCrossfader`, session.ts:164-184), the whole audio transition is silent-by-config with no
warning anywhere. Both are one-line detections worth a log line at minimum.

**6. 🟢 Duration derivation.** [V] Not a blocker. `source.duration` comes from demux and is
correct; `TransitionDuration.source` is already logged on every trigger
(`(duration from ${plan.source})`), which is exactly the instrument the design doc's open
decision #2 says to read before building a "suggested fade time" field.

**7. 🟢 The incoming-deck start point.** [V] Listed separately because the user named it: it
matters, but it is *downstream* of #3 — there is nothing worth seeking to until `mixIn` means
something.

**Bottom line**: fix #1 and #2 first (a day of work, no cross-repo change, no schema), then the
zone model. Fixing #1 alone may change the user's read of whether transitions "work" enough
that their zone requirements get sharper.

---

## 5. Phased build plan

Sizes are rough: **S** ≈ under an hour, **M** ≈ a few hours, **L** ≈ a day+, **XL** ≈ multi-day
cross-repo.

### Phase A — unblock listening (no schema, no Digger change)

| # | Item | Size |
|---|---|---|
| A1 | **Fix finding A**: make the ramp *start* at `outroPoint` instead of finishing there. Update `nearEndReference`/`transitionPlan` and the affected `autoMix.test.ts` cases. **⚠️ needs decision D2.** | M |
| A2 | Log (and optionally toast) when a transition starts with `startValue` already at `target`, or when `crossfaderTargets` lacks `volume`. Closes blocker #5's silent modes. | S |
| A3 | Preview: restore the pre-preview crossfader position on completion (behind a setting, default on), and give it a cancel. **⚠️ touches open decision #7 — needs a taste call.** | S–M |
| A4 | Single `effectiveZones()` helper shared by `transitionPlan` and `MarkerPanel`, so the panel shows the *engine's* numbers (finding G) and displays why a zone was rejected. | S |
| A5 | Clear `introPoint`/`outroPoint` (and the Digger ids, on the drag-drop path) on every local-file load — `App.svelte:322`, `DeckCard.svelte:352` (finding E). | S |
| A6 | `fmt()` to `m:ss.t` in the panel (finding H). | S |

### Phase B — write-path robustness (cuemark + one small Digger change)

| # | Item | Size |
|---|---|---|
| B1 | Extend Digger's `MarkerPatchIn` to accept `position_ms`, and make `setMixMarker` **patch in place** when exactly one marker of the type exists, falling back to delete-then-insert otherwise. Removes the data-loss window (finding C). No schema change. | M |
| B2 | Roll back the optimistic deck write when the Digger write fails, or mark the field visibly "unsaved" (finding B). | S |
| B3 | Close design-doc open decision #4 as **already handled**, and correct the three stale comments (`api.ts:322-324`, `MarkerPanel.svelte:14-18`, the Phase 6 "🔴 Still open" note) — finding D. Document the one residual: a *cleared* marker is re-derived on the next analysis run. | S |

### Phase C — the four-point zone model

| # | Item | Size |
|---|---|---|
| C1 | **Digger**: `intro_end` / `outro_end` marker types (vocabulary only, no migration), derived in `_derive_mix_points()`, surfaced as `mixInEnd`/`mixOutEnd` in `_build_cuemark_payload()`, extended in `backfill_mix_points.py`. Run the backfill over the library. **⚠️ needs decision D1.** | M–L |
| C2 | **cuemark**: `Deck.introEnd`/`outroEnd`, `TransitionZones`, `zonesOf`, `queueStore` mapping, `computeTransitionDurationMs` using two real lengths. Unit tests. | M |
| C3 | `MarkerPanel`: two rows per zone (start/end) or one row with two ⦿ buttons. Keep the uniform label·time·⦿·✕ grammar the panel's own header comment insists on. | M |
| C4 | `WaveformCanvas`: `drawZone` with both edges drawn, both zones unpinned. | S |
| C5 | ~~Seek the incoming deck to `introPoint` on both the live path and preview, reusing the existing 200 ms settle window (open decision #5).~~ ✅ **BUILT 2026-09-19 ahead of the rest of phase C** (D3 answered yes) — see "Phase 7b" in `auto-dj-transitions.md`. Gated on `introZoneSec`, so it is inert until a marker is hand-placed; that is also what makes `introPoint`'s length-vs-start double duty (C2's job to split) start to bite. | M |

### Phase D — optional, only if Phase A–C still feels wrong live

| # | Item | Size |
|---|---|---|
| D-a | Draggable zone edges on the waveform (open decision #6 — read `docs/design/waveform-scrub.md` first; the scrub gesture already owns the pointer). | L |
| D-b | Real "end of intro" analysis in Digger (energy/vocal onset) replacing the `mix_in + 16 bars` default (open decision #1's hard half). | XL |
| D-c | Explicit per-track "suggested fade time" distinct from zone length (open decision #2) — the doc is right that this should wait until the derived durations are read from a real set's logs. | M + schema |

### Decisions needed from the user

- **D1 — marker vocabulary.** Four marker types (`mix_in`/`intro_end`/`mix_out`/`outro_end`,
  zero migration) versus a start+end pair on one row (needs `db.py` + a numbered `migrate.py`
  step, but makes the pair atomic). Also: is `mix_in` allowed to keep meaning "first beat /
  earliest safe in-point", or should it be redefined? This is design-doc open decision #1's
  "needs a call from the library's owner".
- **D2 — fade placement.** Should the blend run *over* `[outroPoint, outroEnd]` (my
  recommendation, and what Digger's own spec says) rather than finishing at `outroPoint`?
  Every existing transition moves later by its own length.
- **D3 — incoming start.** ✅ **Answered yes; built 2026-09-19** (C5, "Phase 7b" in
  `auto-dj-transitions.md`). Residual question it exposed: the trust gate is `introZoneSec`,
  a *zone* rule applied to a *point*, so a hand-placed mix-in under `MIN_ZONE_SEC` is
  rejected as a start position. Splitting the two rules only makes sense alongside C1/C2.
- **D4 — preview fader restore.** Open decision #7, a taste call the doc explicitly defers to
  live feel.

### What I would do first, in one sentence

A1 + A2 + A4 + A5 (half a day, no cross-repo work), then run one real pair through Preview and
read the `[auto-dj] trigger: … (duration from …)` lines — that is the evidence the design doc
itself says to gather before spending Phase C.
