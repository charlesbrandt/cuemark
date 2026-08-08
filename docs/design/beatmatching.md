# Beatmatching: grid anchors, downbeats, and sync quality (design)

Status: **Root cause #1 found and fixed 2026-08-08 (awaiting live confirmation).
Everything else in this doc is analysis + proposed work, not implemented.**

Written up after a session investigating a standing report: *"I've been having difficulty
getting beat matching to work."* The user's own theory — "if the downbeat is not set
correctly, the bars won't line up with the beats and the sync will sound off" — was
correct, and pointed straight at a real defect. This doc records what was found, why it
happened, and what the remaining work looks like, so the follow-ups don't get made
piecemeal inside unrelated commits.

---

## Vocabulary: two different things are called "downbeat"

Keeping these apart is load-bearing for everything below. `Deck.downbeat` is a single
`number | null` that has been quietly serving both roles.

**Beat-level phase anchor.** "A beat lies at `anchor + k·(60/bpm)`." Which beat is
irrelevant. This is what every existing consumer actually uses, and all of them work
mod one beat:

| Consumer | Location | Uses |
|---|---|---|
| `getPhase()` | `src/lib/renderer/seekBus.ts:156` | `((t − downbeat)/period) mod 1` |
| `quantizeToGrid()` | `src/lib/renderer/seekBus.ts:168` | nearest beat, `Math.round` |
| `nudgePhaseToMaster()` | `src/lib/audio/phaseNudge.ts:70` | shortest-arc delta in `[−0.5, 0.5]` beat |
| SNAP toolbar toggle | `Session.snapToBeat` → `quantizeToGrid` | beat quantization of seeks/hot cues/loop points |

**Bar-level downbeat.** "Beat 1 of the bar." Nothing detects this today — not cuemark,
not Digger. Its only current effect is cosmetic: `drawBeatGrid()`
(`src/components/WaveformCanvas.svelte:411`) accents every 4th gridline off an anchor
that carries no bar meaning, so the accents are a 1-in-4 guess.

`detectBeatGrid()`'s own header comment (`src/lib/audio/bpm.ts:22-24`) already says this
explicitly: *"The result is a beat-LEVEL grid: gridOffset marks a beat, not bar-beat-1."*

The user's reported symptom is caused by the **beat-level** anchor being wrong. Bar-level
detection is a separate, additive feature (see "Bar-level downbeat detection" below) and
would not have fixed the symptom on its own.

---

## Root cause #1 (FIXED 2026-08-08): the measured grid phase was discarded

### What was wrong

`detectBeatGrid()` returns `{ bpm, gridOffset, confidence }` (`src/lib/audio/bpm.ts:34`).
`gridOffset` is the comb/Fourier fit's **measured** grid phase, recovered for free from
`arg S` at the fitted beat frequency (`bpm.ts:188-192`). It is accurate: `bpm.test.ts:83`
and `:95` assert it lands within **20–25ms** of ground truth.

`WaveformCanvas` passes it up through `onAnalyzed` (`WaveformCanvas.svelte:74`).

`App.svelte`'s handler then destructured only `{ bpm }` and wrote **`downbeat: 0`**.

```svelte
// before (2026-07-25 .. 2026-08-08)
<WaveformCanvas {deck} onAnalyzed={({ bpm }) => {
  if (deck.source?.type === 'video' && !hasSavedGrid(deck.id, deck.source.filePath)) {
    updateDeck(deck.id, { bpm, downbeat: 0 });
  }
}} />
```

### Why this broke sync structurally, not just approximately

`getPhase()` measures each deck's phase **relative to that deck's own anchor**. With every
auto-fit deck anchored at its own `t = 0`, each deck's reported phase is offset from truth
by `−gridOffset/period` — a *different*, effectively random fraction of a beat per track,
since it depends only on how much silence or lead-in the file happens to start with.

Consequences, all of which match the reported symptom:

- Two decks whose beats are genuinely half a beat apart can report **identical** phase.
  `nudgePhaseToMaster` then hits its `Math.abs(delta) < 0.02` no-op guard
  (`phaseNudge.ts:88`) and does nothing, while NUDGE's `φ` readout in `DeckCard` shows
  them perfectly locked.
- Conversely, two decks that *are* aligned can report a large delta, so NUDGE happily
  rate-spikes them **out** of alignment.
- Sync (`DeckCard.svelte:475`) sets the correct *rate* — that part was always fine, it's
  pure `masterBpm / deck.bpm` arithmetic — and then calls `nudgePhaseToMaster` 200ms
  later to fix phase. The rate landed; the phase alignment was noise.
- SNAP quantized seeks and hot cues to gridlines that were off-beat by a constant
  fraction, on every track that doesn't begin exactly on a beat.

The net effect is that **beat-level sync could not work**, in a way that looked like it
was working — the UI reported alignment it did not have. That is why this presented as
"sync sounds off" rather than "sync does nothing."

### How it got there

Introduced in `acc4167` (2026-07-25, *"Fix Main Beat to honor tempo/pitch shift; default
SET BEAT grid to track start"*). The commit message says:

> Auto-fit's downbeat anchor now defaults to track start (0) instead of the comb-filter's
> arbitrary beat phase, extrapolating the grid from there.

The reasoning was that the fitted phase is "arbitrary." It is arbitrary in *bar identity*
— `gridOffset` names some beat, not necessarily beat 1 — but it is **not** arbitrary in
*phase*, which is the only property any consumer reads. `t = 0` is the genuinely arbitrary
choice: it is wrong by a uniformly-distributed fraction of a beat on every track.

The lesson worth carrying: "this value is arbitrary" needs to be qualified with *arbitrary
in which dimension*. The two dimensions here (phase vs. bar identity) have different
consumers, and the fix traded away the one that mattered to keep the one nothing used.

### The fix

`src/App.svelte` now passes the measured value through, with the reasoning recorded inline
so it isn't re-reverted:

```svelte
<WaveformCanvas {deck} onAnalyzed={({ bpm, gridOffset }) => {
  if (deck.source?.type === 'video' && !hasSavedGrid(deck.id, deck.source.filePath)) {
    updateDeck(deck.id, { bpm, downbeat: gridOffset });
  }
}} />
```

`gridOffset` is `null` when the comb fit fails and the integer `detectBpm()` fallback is
used; writing that `null` still clears any stale downbeat carried over from the previous
track on that deck, which was the one genuinely useful property of the old `0` default.

`npm run check` clean (238 files, 0 errors). **Not yet confirmed live** — this needs an
ear test with two decks before anything else in this doc is worth attempting, because
every remaining item assumes a trustworthy beat anchor.

The one-line change landed in **`d710c68` ("Add a global, proportional UI font-size
setting")** — an unrelated commit from a concurrent session that swept up the dirty
working tree. Recorded here because `git log` on `App.svelte` will not suggest that commit
has anything to do with beat matching, and because it is a live demonstration of the
failure mode this doc exists to prevent: a subtle grid decision disappearing into a commit
about something else. `acc4167`, which introduced the defect, is the same pattern.

---

## Root cause #2 (NOT FIXED): Digger's coarse grid outranks cuemark's better one

`DiggerQueue.svelte:143` calls `markGridSaved()` for any Digger track that carries both
`bpm` and `downbeat`, which marks the grid **trusted** in `gridSource.ts` and suppresses
cuemark's own comb fit entirely for that track.

But what Digger supplies is not a better grid:

- **BPM** comes from `librosa.beat.beat_track` **rounded to 0.1**
  (`digger/importers/analyze_audio.py:150`, `round(float(...), 1)`).
- **Downbeat** comes from `beat_anchor_ms = beat_times[0]`
  (`analyze_audio.py:162`) — the first librosa-tracked beat, frame-quantized, no
  sub-sample refinement. `digger/routers/tracks.py:300-307` resolves a user-placed
  `downbeat` marker first and falls back to this.

Compare cuemark's own fit: comb refinement scans at `df = 1/(8·span)` with parabolic
interpolation below that, result rounded to 0.01 BPM (`bpm.ts:195`), phase recovered from
`arg S` with the 20–25ms accuracy the tests assert.

### Drift math

The 0.1 BPM rounding alone puts a floor of ±0.05 BPM on Digger's tempo. At 128 BPM that is
a relative rate error of `0.05/128 = 3.9e-4`:

| Elapsed | Drift | As fraction of a 128 BPM beat (0.469s) |
|---|---|---|
| 60 s | 23 ms | 0.05 beat |
| 120 s | 47 ms | 0.10 beat |
| 300 s | 117 ms | 0.25 beat |

47ms is already an audible flam on percussive material. And this is the *floor* — it is
the rounding error only, not librosa's actual tempo-estimation error, which is typically
larger. cuemark's own 0.01 BPM figure gives ~23ms over a full 300s track, ~5× better than
Digger's rounding floor before accounting for estimator accuracy at all.

So a track loaded from the Digger queue currently gets a **worse** grid than the same file
dragged in from disk, with nothing in the UI to indicate it.

### Proposed fix: make trust provenance-aware

Digger already tracks provenance — `tracks.bpm_source` is one of `detected` / `manual` /
`imported`, and markers carry `source` with the same convention
(`analyze_audio.py:67-96`). cuemark's `getCuemarkPayload` currently flattens that away.

The rule should be:

- `bpm_source` in (`manual`, `imported`), or a user-placed `downbeat` marker → **trusted**,
  suppress the local fit (a human's answer wins, as SET BEAT already does).
- `bpm_source = 'detected'` with no manual marker → **hint, not truth**. Use it to seed the
  UI immediately (so the deck shows a BPM before analysis finishes) but let the local comb
  fit overwrite it when it lands.

This needs `getCuemarkPayload` to return the source fields, and `DiggerQueue.svelte:129`'s
`hasGrid` to become a three-state decision rather than a boolean. `gridSource.ts`'s
`markGridSaved` is already keyed by `(deckId, filePath)` and doesn't need to change shape.

Open question: if Digger's downbeat comes from a manual marker but its BPM is only
`detected`, is that pair trustworthy? A downbeat is only meaningful against the BPM it was
set against — which is the reasoning behind the existing all-or-nothing `hasGrid` pair
check (`DiggerQueue.svelte:127-129`). Probably: trust the manual anchor, re-fit the BPM,
and snap the anchor to the nearest beat of the new grid.

---

## Bar-level downbeat detection

This is what the original question asked about, and it is worth doing — just understand it
as additive rather than as the fix for the reported symptom.

### Why Digger's analyze step is the right home

`digger/importers/analyze_audio.py` already decodes the audio, already holds `beat_frames`
and a chroma matrix, and is deliberately CPU-only and in-process in the always-on `api`
container (no GPU handoff, unlike the Demucs/whisper-asr pipeline). Adding bar-phase
scoring there is close to free, and the result persists in the library so cuemark never
re-derives it. Digger already has the storage: a `downbeat` marker type and
`tracks.beat_anchor_ms`, plumbed through to cuemark via `routers/tracks.py:300-316`.

### Three options

**A. Heuristic over the existing librosa beats.** No new dependencies, ~20 lines. There are
only 4 candidate bar phases in 4/4; score each by low-band onset energy at the beats it
selects, plus chroma-change magnitude (harmonic change concentrates on downbeats). Pick the
best. For 4/4 dance music — which is the entire target corpus here — this should land
75–85%. **Recommended starting point**, because it is cheap enough that being wrong costs
almost nothing.

**B. `beat_this`** (2024, PyTorch, joint beat + downbeat, current state of the art).
Genuinely accurate. Costs torch in a container kept deliberately free of it; would have to
move to the GPU handoff path alongside Demucs, which is a real architectural change to
Digger's analyze step, not a dependency bump.

**C. `madmom`** (`RNNDownBeatProcessor` + `DBNDownBeatTrackingProcessor`). The classic
answer and still accurate, but pinned to old numpy/Cython and painful to install in 2026.
Skip unless A proves inadequate and B is unacceptable.

### The thing to keep in mind before investing much here

For mixing dance music, a **consistent** bar phase matters more than a **true** one. If both
decks agree on where bars start, cueing the incoming track from a bar boundary produces a
clean mix even if the detector picked beat 3 as beat 1. This caps how much accuracy is
actually worth buying — and argues for A.

A related gap: Digger's `mix_in` is `beat_times[0]` (`analyze_audio.py:106`), i.e. the
first tracked beat, which is not a phrase boundary and generally not even a bar boundary.
Its docstring is honest about this ("no dedicated bar/downbeat detector yet"). Whatever
lands here should feed `_derive_mix_points` too.

---

## Other sync-quality work, roughly by value

### 1. Phase lock, not just rate lock

`syncLocked` (`Deck.syncLocked`, applied by `applyLockedRates` in
`src/lib/state/session.ts:98-110`) continuously re-locks `playbackRate` to `Session.bpm`.
It never touches phase. Correct rate does not mean staying in phase: the grid model is
constant-tempo, real tracks are not, and any residual BPM error integrates.

Proposed shape: a slow PLL. Sample phase error ~1/s, apply a small correction (±0.5%, i.e.
an order of magnitude below NUDGE) for a few seconds, repeat. Inaudible, and it holds lock
across a long blend instead of decaying out of it.

Note the contrast with NUDGE's existing ±15% (`NUDGE_MAGNITUDE`, `phaseNudge.ts:6`). That
magnitude is correct for a manual "fix it now" stab and wrong for continuous correction —
the two want different constants and probably different code paths, though
`scheduleRevert`'s rAF-based revert (deliberately not `setTimeout`, too coarse at ~16ms
jitter) is reusable.

### 2. Quantized play / "start on the next downbeat"

Press play on the incoming deck; it launches on the master's next bar. The single biggest
ergonomic win for live mixing, and cheap once the grid is trustworthy — `quantizeToGrid()`
and a master phase reference (`Session.masterDeckId`) both already exist. Bar-level launch
wants bar detection; beat-level launch does not and could ship first.

### 3. Phrase-level (16/32-bar) alignment

Dance tracks change structure on phrase boundaries, and mixing into the wrong phrase sounds
wrong even when every beat lines up. Depends on bar detection landing first.

### 4. Surface grid confidence

`refineGrid` computes a normalized alignment confidence (`bpm.ts:185`) and rejects fits
below `GRID_CONFIDENCE_FLOOR = 0.15` (`bpm.ts:28`). Everything above that floor is
presented to the user identically. A track that fit at 0.2 should be visibly flagged rather
than silently ruining a mix. `BeatGrid.confidence` is already returned from
`detectBeatGrid`; it just isn't threaded through `onAnalyzed` or stored on `Deck`.

### 5. Half/double-time correction

`detectBeatGrid` resolves octave ambiguity by refining `[coarse/2, coarse, coarse·2]` and
preferring the slower candidate on a near-tie (`bpm.ts:225-233`, with the reasoning: a
beat-spaced click track aligns perfectly to its own double-tempo grid, making 2×
confidence spuriously equal). When this picks wrong, the user wants a one-click ×2 / ÷2 on
the deck — not a re-analysis, and not a manual tap. Cheap; needs to also halve/double the
anchor's meaning consistently and re-save if the grid was trusted.

---

## Main Beat: reference selection semantics

Absorbed from `docs/design/main-beat-toggle.md` (2026-07-21) when that doc was folded into
this one on 2026-08-08; its four open questions were re-verified against current code at
the same time, and **two of them are now resolved**. Background: the button was renamed
from "Master" to "Main Beat" on 2026-07-21 to avoid clashing with the unrelated Master
Volume slider in the toolbar. `setMasterBpm`/`masterBpm` internal naming was deliberately
left alone; only user-facing labels and tooltips changed.

### Current behavior

Substantially different from what the 2026-07-21 doc described — `Session.masterDeckId`,
`refreshMasterBpm`, `reconcileMaster`, and `applyLockedRates` all landed after it was
written.

- **Main Beat** (`DeckCard.svelte:468`) calls `setMasterDeck(deck.id)`
  (`session.ts:123`), which sets `masterDeckId` *and* `Session.bpm = deck.bpm ×
  deck.playbackRate`. Active state is an identity check, `masterDeckId === deck.id`.
- `refreshMasterBpm` (`session.ts:73`) re-derives `Session.bpm` from the master deck on
  **every** `updateDeck`, so the reference tracks the master's live tempo including pitch
  bends and re-analysis.
- `reconcileMaster` (`session.ts:84`) auto-promotes: whenever *exactly one* deck is
  playing, it becomes the reference. Zero or two-or-more playing decks leave the current
  reference untouched (sticky). Runs only when `playing` or `bpm` is in the patch.
- **Tap tempo** (`setMasterBpm`, `session.ts:195`) is an independent manual reference — it
  sets `Session.bpm` and explicitly clears `masterDeckId` to null, so no deck owns it.
- The only clear path remains the toolbar `✕` (`App.svelte:1626`), which calls
  `setMasterBpm(null)`.

### Q1 — Click-to-clear toggle: STILL OPEN

Clicking Main Beat on the already-active deck re-promotes the same deck (harmless no-op in
effect). There is still no per-deck way to clear the reference; the toolbar `✕` is
spatially and conceptually distant from the per-deck button that sets it.

Two things have changed since the question was posed:

- The plumbing now exists — `setMasterDeck(null)` (`session.ts:125`) already handles the
  clear case, including re-running `applyLockedRates`. Wiring the button to it is a
  one-line UI change.
- The sub-question *"what happens to decks already Sync'd to it"* now has a concrete
  answer: `applyLockedRates` returns early when `s.bpm === null` (`session.ts:101`), so
  `syncLocked` decks **freeze at their last-locked rate** rather than reverting or
  unlocking. Whether that silent freeze is the right behavior — versus visibly dropping
  the lock — is the part still worth deciding.

**New wrinkle not in the original doc**: `reconcileMaster`'s auto-promotion will
immediately re-promote a solo playing deck on the next `updateDeck` carrying `playing` or
`bpm`. So a click-to-clear during single-deck playback would appear to do nothing, or to
flicker. Any toggle design has to decide whether an explicit clear suppresses
auto-promotion (a sticky "no reference" state) or whether clearing is simply meaningless
while one deck plays solo.

### Q2 — Reassignment cascade: LARGELY RESOLVED by Lock

The original complaint was that moving Main Beat from deck A to deck B left decks synced
to A drifting at their old rate. `syncLocked` + `applyLockedRates` (`session.ts:98-110`)
now handle exactly this: locked decks recompute `Session.bpm / deck.bpm` on every path
that can move the reference, including master reassignment.

What remains is a deliberate design boundary rather than a bug: one-shot **Sync**
(`DeckCard.svelte:475`) explicitly sets `syncLocked: false`, so those decks still do not
follow a reassignment. That is what "one-shot" means, and **Lock** is the answer for users
who want the cascade. The only open question is discoverability — nothing signals that
Sync is a snapshot and Lock is a subscription.

Note that `applyLockedRates` corrects **rate only**, never phase. See "Phase lock, not just
rate lock" above; a locked deck can hold a perfect tempo match and still walk out of phase.

### Q3 — Active-state float equality: RESOLVED

The original doc flagged `masterBpm === deck.bpm` exact float equality as fragile against
fractional, re-fittable BPMs. `Session.masterDeckId` replaced it: the active check is
`masterDeckId === deck.id` (`DeckCard.svelte:468`) and `findReferenceDeck`
(`phaseNudge.ts:48`) resolves by deck id. No float comparison remains on either path.

### Q4 — Auto-refit interaction: RESOLVED

The concern was that a track reload re-fits `deck.bpm` while `Session.bpm` stays frozen at
whatever was captured when the button was clicked. `refreshMasterBpm` (`session.ts:73`)
now re-derives `Session.bpm` from the master deck on every `updateDeck`, so a re-fit
propagates automatically. The commit that introduced it names the original motivating case
— bending the master deck's pitch fader after the fact used to go stale silently.

---

## Suggested order

1. **Live-confirm root cause #1's fix.** Everything below assumes a trustworthy anchor;
   if it doesn't hold up by ear, nothing else is worth starting.
2. **Digger trust rule** (root cause #2). Small, self-contained, and it is actively
   degrading the best-analyzed tracks in the library right now.
3. **Quantized play**, beat-level first.
4. **Phase lock (PLL).**
5. **Bar detection in Digger** (option A), then phrase alignment.

Confidence surfacing and ×2/÷2 are small enough to fold into whichever pass touches
`onAnalyzed` and `DeckCard`'s BPM row respectively.

---

## Verification notes

There is no automated gate for sync quality, and building one is harder than it looks:
`bpm.test.ts` covers the *fit* (synthetic envelopes, known ground truth) but nothing covers
the *application* of the fit to two live decks. Root cause #1 lived for two weeks precisely
because the unit tests kept passing — they test `detectBeatGrid`, and the bug was in the
caller that discarded its output.

A regression test worth adding: assert that a deck's `downbeat` after auto-fit equals the
`gridOffset` the analyzer returned. That is a trivial assertion that would have caught this
exact defect, and it belongs wherever the `onAnalyzed` wiring can be exercised.

For live checks, the existing `φ` readout in `DeckCard` (shown when `getPhase()` is
non-null) is the fastest signal — with two decks at matched tempo and aligned by ear, the
two `φ` values should agree. Before the fix they systematically did not.

---

## Related

- `docs/design/main-beat-toggle.md` — **deleted 2026-08-08**, folded into "Main Beat:
  reference selection semantics" above. Two of its four open questions were already
  resolved by code that landed after it was written; keeping it alongside this doc would
  have left two overlapping descriptions of the same button, one of them wrong.
- `docs/design/av-sync-architecture.md` — position tracking, seek races, rate-then-seek
  ordering. Relevant because Sync's phase alignment is deliberately deferred 200ms behind
  the rate write (`DeckCard.svelte:481`) to let WebKit's pipeline rebuild settle.
- `src/lib/audio/gridSource.ts` — the per-deck `(deckId → trusted filePath)` map that gates
  saved-grid vs. auto-fit precedence.
- CLAUDE.md, "Waveform analysis uses `audio_analyze_file`" — the analysis path feeding all
  of this.
