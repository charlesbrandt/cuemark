# Auto DJ: automated transitions

Status: 🟢 **Phase 1 DONE + live-verified 2026-08-24** (lookahead + crossfade ramp, fixed
threshold, no auto-preload — see "Proposed phased plan" below). Written 2026-08-24 as a
scoping handoff; phase 1 was implemented and verified the same day in
`src/lib/digger/autoMix.ts`. The `Auto` toggle in `DiggerQueue.svelte` now gates *both*
this near-end crossfade path and the older cold-reload EOS fallback (`autoDj.ts`, "What
already exists" below), which stays in place as a safety net for tracks the lookahead
never caught. `npm run check`/`npm test` clean (117/117, incl. `autoMix.test.ts`'s 12
tests). **Live-verified headless** (`tauri-driver` + Xvfb, isolated build, real GStreamer
pipeline, two decks loaded with the same 49s cached test clip): deck-1 started on its own
0.26s after deck-0 began playing (threshold set above the clip's duration to trigger
immediately), `crossfaderValue` ramped continuously 0→1 over ~2.2s against a configured
2000ms duration, and deck-0 was paused at the exact instant the ramp hit 1, staying
stable for 7.7s of further polling while deck-1 kept advancing normally. One real edge
case surfaced and is bounded, not a bug: with an unrealistically large threshold relative
to track length (as used to force a fast test), the *incoming* deck can itself already be
"near its end" under the same threshold, producing one legitimate reciprocal trigger back
toward the original deck once its ramp completes — `wasAutoMixTriggered`'s per-file latch
correctly caps this at one extra bounce, never a sustained oscillation. Normal thresholds
(15s default vs. multi-minute tracks) can't reach this condition. Phases 2-4
(auto-preload, tempo/phase sync, a real per-track outro marker) are **not built** — see
"Proposed phased plan".

## Problem

`autoDj.ts`'s `handleDeckEos()` reacts to a deck's full EOS (GStreamer's `deck-eos` event,
i.e. the track has *already finished*) and reloads the **same deck**, cold, with the next
track. That's it: no lookahead, no fade, no second deck involved, no tempo matching. It
satisfies the todo.md item's literal wording ("auto-load `GET /queue/next` when a deck's
clip ends") but produces a hard stop-then-start gap, not anything a DJ would recognize as
a mix. The user asked for the real thing: auto-switch decks and crossfade as the playing
track *approaches* its end (or a pre-designated fade-out point) — genuinely new scope,
not an extension of what's there.

## What already exists (reuse, don't reinvent)

- **`autoDjEnabled` store + `handleDeckEos()`** (`src/lib/digger/autoDj.ts`) — the
  enable/disable toggle and the "pick the next track" sourcing logic (queue-first,
  `GET /queue/next` fallback, DJ-scoped) are already right and should be reused, just
  retargeted to fire earlier and load onto a different deck. See the `digger-integration`
  skill's "Auto DJ" section for the sourcing rationale.
- **`setCrossfader(value)`** (`src/lib/state/session.ts`) — one synchronous call that
  applies `audioCurve`/`visualCurve` to `crossfaderMapping.left`/`.right`'s `volume`/
  `opacity`. This is the only blending primitive that exists; there is **no animation or
  ramp mechanism today** — a real auto-crossfade has to drive this repeatedly over time
  itself (rAF loop or `setInterval`), it doesn't get one for free.
- **`getDeckTime(deckId)`** (`src/lib/renderer/seekBus.ts`) + **`deck.source.duration`**
  (`src/lib/state/types.ts`, filled in once metadata/demux resolves — `App.svelte:530` for
  the webcodecs path, `legacyVideo.ts:142` for the legacy path) — enough to compute
  seconds-remaining. Nothing currently polls this against a threshold; `positionPoll.ts`
  already reads deck position every frame for the master clock, and is the natural place
  to add a remaining-time check rather than standing up a second polling loop.
- **`queueStore.loadQueueItemToDeck()`** — already deck-id-parameterized, so pointing it at
  a specific "idle" deck instead of "the deck that just ended" is a non-issue.
- **Tempo/phase sync**: `deck.syncLocked`, `nudgePhaseToMaster()` (`phaseNudge.ts`),
  `Session.masterDeckId`/`setMasterBpm()` (`session.ts`) — full beatmatching machinery
  already exists and could be invoked on the incoming deck before a crossfade starts. See
  `docs/design/beatmatching.md`.
- **`crossfaderMapping: {left, right}`** (`Session`) — the crossfader is hardwired to
  exactly two named decks today; see "Open question: N decks" below for why this matters.

## What's missing — five real design gaps, not implementation details

### 1. Near-end trigger
Nothing detects "about to end," only "already ended." Two possible triggers, not mutually
exclusive:
- **Fixed threshold**: N seconds of remaining time (computed from `getDeckTime` +
  `deck.source.duration`), works for any track with zero extra data. Good default/fallback.
- **Per-track fade-out/outro marker**: `Deck` has no such field today — only `cuePoint` and
  `hotCues: number[]` (up to 4). Adding one means either a new `Deck` field +
  `POST /tracks/{id}/markers` support on the Digger side (see the digger-integration
  skill's "Digger-side schema changes" — a two-repo migration, `db.py` + `migrate.py`, not
  a quick add), or repurposing an existing hot-cue slot by convention (e.g. "hot cue index
  3 = outro, if set"). **This needs a decision from whoever picks this up before touching
  schema** — don't default to inventing a new marker type without checking whether "N
  seconds before end" is actually good enough in practice first.

### 2. Which deck is the target
With exactly two decks this is trivial (`crossfaderMapping`'s *other* deck). CLAUDE.md's
"N-deck guarantee" table means cuemark is architected for any number of decks, but the
crossfader itself is not — it only ever drives the two decks named in
`crossfaderMapping`. **Recommended for phase 1: don't solve N-deck auto-mixing.** Scope
auto-crossfade to exactly the two decks already named in `crossfaderMapping`, same as the
crossfader itself; leave any other deck alone. Revisit only if the user actually runs
more than two decks live and wants Auto DJ to reach beyond the fader pair.

### 3. Preload timing
The incoming track has to be fully loaded/prerolled *before* the crossfade should start,
not at the moment it starts. The one precedent in the codebase for "load ahead, then wait,
then act" is `App.svelte`'s `sweepAutostartTrack` path — and it uses a **fixed 8-second
`setTimeout`**, explicitly a known-hacky stand-in for real readiness detection (the
comment there admits the sweep just eats a few seconds of `arm=off` if it presses play
too early). Don't copy that pattern uncritically; auto-mix should watch actual deck
readiness (e.g. position beginning to advance, or a backend-specific ready signal) rather
than guess a delay, since a too-short guess starts the crossfade into silence and a
too-long one wastes lookahead budget.

### 4. Crossfade automation + interruption
Needs a small driver that calls `setCrossfader()` repeatedly across a chosen duration
(likely Settings-configurable, not hardcoded) from the outgoing deck's side toward the
incoming deck's side. Must be cleanly cancellable: if the DJ touches the physical
crossfader (or the on-screen one) mid-auto-fade, that has to win immediately — same
principle already established for `syncLocked` ("cleared automatically by any manual rate
input on this deck," see `types.ts`). Open question is *how* it yields: abort in place
(freeze the mix wherever it was) vs. hand control back at the current position with no
further automation. Also needs to handle a deck being unloaded/removed mid-fade without
leaving a dangling animation loop.

### 5. Optional tempo/phase sync before mixing
Whether Auto DJ should beatmatch the incoming track (set `syncLocked`, run
`nudgePhaseToMaster`) before crossfading, or just cut between tracks at their native
tempos — different products (club-style beatmatched mix vs. radio-style track-to-track).
Should be a separate toggle from "Auto DJ is on at all," not bundled in.

## Interaction with the existing EOS fallback

Once a near-end trigger exists, `deck-eos` can still fire on the outgoing deck — expected
if the crossfade finishes right as the track ends, or as a safety net if the lookahead
never fired (unknown/zero duration, a corrupted file, etc.). **`handleDeckEos()`'s current
cold-reload behavior must not also fire once a crossfade to that deck's replacement has
already started or finished** — needs an in-flight-transition flag (per deck pair, or per
deck) that makes `handleDeckEos` a no-op when the near-end path already handled it, while
still catching the genuine case where lookahead never triggered.

## Proposed phased plan

1. 🟢 **DONE 2026-08-24 — Lookahead + crossfade ramp, fixed threshold only, no auto-preload.** Build the two
   genuinely new primitives — the near-end trigger (fixed N seconds, no per-track marker
   yet) and the crossfade-ramp driver with interruption handling — assuming the incoming
   deck is already loaded (manually, or by the DJ having queued it). This is the smallest
   slice that's actually a different feature from what exists.
2. **Auto-preload.** Retarget `autoDj.ts`'s existing sourcing (queue-first, `/queue/next`
   fallback) to fire at an earlier "start preloading" threshold than the crossfade-start
   threshold, targeting the deck `crossfaderMapping` isn't currently favoring. Needs the
   real-readiness fix from gap 3, not a fixed timeout.
3. **Optional tempo/phase sync**, toggleable, reusing existing `syncLocked`/
   `nudgePhaseToMaster` machinery — gap 5.
4. **Per-track fade-out/outro marker**, only if the fixed-threshold version proves
   insufficient in practice — this is the one phase with real cross-repo schema cost
   (gap 1), so it should be justified by lived experience with phases 1–3, not assumed
   up front.

## Explicitly out of scope

Transition-mining from play history to *train* an auto-DJ model — Digger's
`mix_transitions.source='play_history'` is reserved for a separate server-side job over
the `plays` log (see the digger-integration skill's "Session/play history reporting"
section); this doc is about executing transitions live, not learning from past ones.

## Open questions for whoever picks this up

- ✅ Fixed crossfade duration (a Settings number), not BPM/genre-aware — `crossfadeDurationMs`,
  Settings → Audio → Auto Mix, default 6s. Answered as part of phase 1.
- ✅ **Hand-back-control-at-current-position**, not cancel-in-place, when the DJ grabs the
  fader mid-auto-fade: `autoMix.ts`'s ramp aborts the instant `notifyManualCrossfaderTouch()`
  fires (from `Crossfader.svelte`'s `oninput` or the MIDI handler's `queueCrossfader`) and
  does not resume — the crossfader just sits wherever it was, under manual control from
  that point on, mirroring the existing `syncLocked` "manual input wins immediately"
  convention. Chosen because a from-scratch re-take (cancel-in-place, wait, resume) has no
  precedent anywhere else in the codebase and adds a second state machine for a case (the
  DJ actively touching the fader) that should just mean "the DJ has it now."
- Is a real per-track fade-out marker (Digger schema change) actually wanted, or is
  "N seconds before end" good enough long-term? Don't assume — ask before phase 4.
- Confirm the two-deck-only scope (gap 2) is acceptable, or whether N-deck auto-mixing is
  actually needed before starting. Phase 1 ships with the two-deck scope as recommended.
