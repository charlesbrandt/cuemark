# Auto DJ: automated transitions

Status: 🟡 **Phase 1 DONE + live-verified 2026-08-24. Phase 2 (auto-preload) built +
unit-tested 2026-08-24, fixed one live bug 2026-08-24, still NOT re-verified live. Phase 3
(optional tempo/phase sync) built + unit-tested 2026-08-24; a first live test found no
audible beat change, root-caused to a fire-and-forget seek racing playback start plus zero
log coverage on the whole path — both fixed same day (see "Live-session bug found + fixed"
below), still NOT re-verified live. Phase 4 (per-track outro marker) built + unit-tested
2026-08-24 — turned out to need zero Digger schema/endpoint changes, see "Phase 4" below —
NOT yet live-verified.** — see "Proposed phased plan" below.

**2026-08-25: live test reported an abrupt transition, log had zero `[auto-dj]` lines to
explain it.** Root cause: the base (non-sync) crossfade path — the one that actually runs
by default, since `autoMixSyncEnabled` is off — had **no `debugLog()` calls at all**, in
either `checkAutoMixTrigger`'s trigger decision or `startCrossfadeRamp` (start/abort/
complete). Only phase 3's beatmatch-sync branch got instrumented when it was built. So a
transition firing, running to completion, or being aborted by a manual fader touch were all
silent — indistinguishable from Auto DJ never triggering at all. Fixed by adding `debugLog()`
calls mirroring the sync path's existing pattern: trigger fired (remaining/threshold/target),
ramp start (duration/from-value), ramp abort (with reason: manual touch or a deck vanishing),
ramp complete, and the preload trigger's fetch/load/skip outcomes. `crossfadeDurationMs` was
already Settings-configurable (Settings → Controls → Auto Mix, default 6.0s) before this — the
abruptness report is more likely explained by that 6s default itself, or a threshold/duration
mismatch, than by the feature being non-configurable; the new log lines are what will actually
tell us which on the next test. **The running launcher binary at the time of the report
(`~/.local/bin/cuemark`, built from `6551e35`) matched committed `autoMix.ts` exactly — the
logging gap was real code behavior, not staleness.**

**Root-caused on the re-test, same day, with the new logging.** The rebuilt launcher's log
showed the preload and trigger firing exactly on schedule, and the ramp itself: `ramp start:
deck-deck-0 -> deck-deck-1, target=1, from=1.000, duration=6000ms` — **`from=1.000` is already
equal to `target=1`, a zero-length interpolation.** Root cause was in `bootRestore.ts`'s
ordinary-restart path (`restoreSessionOnBoot()`'s non-recovery branch), not `autoMix.ts`:
that branch restores `crossfaderValue` from the previous session's `session-recovery.json`
straight into session state, but never calls `setCrossfader()` to actually apply the curve to
the (freshly-defaulted) decks' `volume`/`opacity`. So after a plain app restart,
`session.crossfaderValue` and the decks' actual audible volume silently disagree until the
*next* `setCrossfader()` call — a manual touch, or Auto DJ's own near-end ramp — applies the
curve for the first time since boot. In the reported test, `crossfaderValue` had been
restored to `1.0` from a prior session; deck-0 played at its own fresh-default volume (fully
audible, decoupled from the fader) for the whole track, and the ramp's `startValue` read that
same stale `1.0` — so its first frame, not its last, was the first time the curve was ever
applied: deck-0 cut to near-silence and deck-1 jumped to full volume in one frame, not over
the configured 6s. **Not a crossfade-duration problem at all** — the ramp had nowhere to
move. **Fix**: `bootRestore.ts` now calls `setCrossfader(restored.crossfaderValue)` right
after restoring the other globals in the non-recovery branch, reconciling deck
volume/opacity with the restored fader position immediately at boot, before any track loads.
`npm run check`/`npm test` clean (147/147).

**That fix was itself wrong, live-hit on the very next restart, 2026-08-25.** Eagerly
applying the restored `crossfaderValue` avoided the deferred-jump symptom but is worse: on
the next ordinary restart the DJ loaded one deck and pressed play, and got **no audio at
all** — `VOLUME`/`OPACITY` both `0.00` in the UI, with nothing the DJ had done to cause it.
The DJ's own hardware crossfader was sitting physically at full-left the whole time; the
restored value that got applied was `1.0` (full-right) from whatever the software had last
electronically read. **Root cause of both failed fixes**: an unmotorized fader's physical
position can drift from any persisted value — `session-recovery.json`'s `crossfaderValue`
or `midi_state.json`'s last-seen MIDI state alike — simply by being touched by hand while
the app is closed; neither can be trusted to reflect where the hardware currently sits.
Restoring either one and forcing it onto freshly-loaded (and therefore audible-by-default)
decks makes a silent, plausible-looking software value override what's actually true. Per
the DJ's own stated expectation, the actual fix is **don't restore or apply `crossfaderValue`
at all on an ordinary restart** — leave it at the module's own default (`0.5`, both decks
live) exactly like decks reset to their own fresh defaults, and let the first real signal —
a physical fader touch, or Auto DJ itself — establish it from there. `crossfaderMapping`/
`crossfaderTargets`/`audioCurve`/`visualCurve` are still restored (harmless preference
fields with no muting side effect on their own). `npm run check`/`npm test` clean (147/147).
**Not yet re-verified live** — needs a third restart + test: single deck loaded, `SETTLE`
shows both decks audible with no fader touched, then a real Auto DJ crossfade to confirm the
original abrupt-transition report is actually resolved end to end.

**Phase 3, same day:** `autoMixSyncEnabled` (Settings → Controls → Auto Mix → "Beatmatch before
mixing", default **off**) gates a beatmatch step inserted into `checkAutoMixTrigger`
(`autoMix.ts`) right before the crossfade would otherwise start. When on, and only when both
decks have a detected/set `bpm` and a main-beat reference exists (`session.bpm`, normally the
outgoing deck via the existing solo-playing auto-promotion in `session.ts`): rate-locks the
incoming deck (`syncLocked: true`, `playbackRate = session.bpm / incoming.bpm`) and, after a
200ms settle, calls `nudgePhaseToMaster()` to align its phase, *then* sets it playing and
starts the crossfade ramp — deliberately the same two-step sequence (and the same 200ms delay)
DeckCard.svelte's manual **Lock** button already uses, reusing existing machinery rather than
inventing new sync code (gap 5's whole premise). The 200ms settle exists for the same reason
it exists there: writing `playbackRate` rebuilds the legacy `<video>` pipeline, and seeking
into that rebuild lands stale (CLAUDE.md "Rate-then-seek ordering") — nudging phase
immediately would risk landing at a pre-rebuild position. A manual crossfader touch during
that settle window aborts the whole deferred step (checked via the same `manualTouch` counter
the ramp's own interruption handling uses), so the "DJ wins immediately" rule holds through
the sync step too, not just the ramp. Missing bpm on either deck (or no bpm reference at all)
silently falls through to the phase-1/2 native-tempo cut — no separate code path, just an
`if`. `autoMix.test.ts` covers: rate-lock + deferred nudge + deferred play/ramp start when a
bpm reference exists; the native-tempo fallback when the incoming deck has no bpm; and the
manual-touch-during-settle abort. `npm test`/`npm run check` clean. **Not yet live-verified**
— unit-tested only, same caveat as phase 2.

**Live-session bug found + fixed 2026-08-24 (same day as phase 2's build):** a DJ manually
loaded a track onto one of the two mapped decks; Auto DJ correctly crossfaded to it, but the
*next* cycle never loaded a new track onto the deck that had just faded out. Root cause: the
ramp driver's `t >= 1` completion branch (`startCrossfadeRamp` in `autoMix.ts`) only set
`playing: false` on the outgoing deck, leaving its now-fully-played `source` in place.
`checkAutoPreloadTrigger`'s "already loaded (by anyone) — don't clobber" guard
(`incoming.source !== null`) and `checkAutoMixTrigger`'s incoming-readiness check
(`source.duration > 0`) both treat any non-null source as a valid loaded track, with no way to
distinguish "freshly loaded" from "already played out" — so a deck that had just finished its
turn looked permanently occupied and was silently skipped by every later preload/crossfade
cycle. Not specific to a manual load — it would have reproduced identically with a
fully-automated pair of tracks; the manual load in the report just happened to be what was on
the deck when it was noticed. **Fix**: the completion branch now also sets `source: null`,
which additionally drives `App.svelte`'s `syncVideoElements()` to tear down that deck's video
backend + audio pipeline, same as a deck being removed — so the freed deck looks genuinely
idle to both trigger functions. Regression test added in `autoMix.test.ts` ("frees the
outgoing deck for a fresh preload after it fades out, even if it was manually loaded").
`npm test`/`npm run check` clean. **Not yet re-verified in a live session** — the original
report was live, the fix is unit-tested only so far.

**Live-session bug found + fixed 2026-08-24 (Phase 3's own first live test):** the DJ reported
no audible beat change on the incoming deck despite Beatmatch-before-mixing being on. Two
compounding problems, both fixed:
- **No log trail at all.** Every state change on the phase-3 path (`updateDeck`,
  `nudgePhaseToMaster`) is a pure frontend Svelte-store write with zero output to
  `cuemark.log` — only the two pre-existing `console.error` failure paths logged anything,
  and neither fired. `debugLog()` (the existing `frontend_log` IPC bridge other modules like
  `midi/handler.ts` and `scrubStats.ts` already use to get JS-side timing onto the Rust log
  timeline) was never wired into this path, so there was no way to tell "sync fired and did
  nothing audible" from "sync never fired (no bpm reference)" from the log — both looked
  identical: nothing. Added `debugLog()` calls at every branch (rate-lock, each settle-window
  abort, the bpm-missing skip, the seek fired, play started) so a re-test's log actually shows
  which of those happened.
- **The real race**: at the moment `nudgePhaseToMaster(incomingId)` is called, the incoming
  deck is still paused (`playing: true` is set on the very next line), so it takes the
  function's "paused: seek to the in-phase position immediately" branch rather than the
  playing rate-spike branch DeckCard's manual Lock/NUDGE buttons exercise (those are only ever
  pressed on an already-playing deck). That seek's `audio_seek` IPC call is fire-and-forget
  (`seekBus.ts`'s `seekDeck()` — `.catch(console.error)`, not awaited) and does not land in
  GStreamer synchronously. The old code called `updateDeck(incomingId, { playing: true })` on
  the very next line with no settle at all, so playback could start from the pre-nudge position
  before the seek landed — silence where a beat change should have been audible, with nothing
  in any log to say so. **Fix**: a second 200ms settle window (mirroring the existing
  rate-change settle immediately above it) now sits between the phase nudge and setting
  `playing: true`, with the same `manualTouch`/deck-vanished abort checks. New regression test
  in `autoMix.test.ts` ("abandons the sync+crossfade if the DJ touches the fader during the
  post-nudge seek settle"); the existing happy-path test now asserts `playing` stays `false`
  through the first settle and only flips after the second. `npm test`/`npm run check` clean
  (142/142). **Not yet re-verified live** — this is a reasoned fix for a real race identified
  by code inspection (the seek IPC is genuinely fire-and-forget), not a live-confirmed root
  cause; the next live test should watch for `[auto-dj] sync:` lines in `cuemark.log` to
  confirm the sequence actually happens and that the beat is now audibly locking.

**Sourcing changed 2026-08-24, same live-session feedback:** queue entries are no longer
deleted (`DELETE /queue/{id}`) as Auto DJ consumes them. The DJ wants the queue to stay put
and read as a set list — matching what Digger's own web UI shows on another screen — not
shrink as a work stack. `autoDj.ts`'s `pickAndConsumeNext()` (now `pickNextTrack()`) instead
leans on `playedTracks.ts`'s already-built session-local "played" tracking (a track counts
once it's been audible on the main output, not just cued, for 15s+) to walk the queue in
order: anchor on the deck-being-replaced's `diggerTrackId` position in the queue and take the
next *unplayed* entry after it; no anchor (first track of the set, or a manually/search-
loaded track never queued) falls back to the first unplayed entry; nothing unplayed left
falls back to `GET /queue/next` same as before. Both `handleDeckEos` and
`checkAutoPreloadTrigger` were updated to pass their outgoing deck's `diggerTrackId` as the
anchor. `pickNextTrack`'s own doc comment in `autoDj.ts` has the full three-step rule. New
regression coverage in both test files; `npm test`/`npm run check` clean. **Not live-verified.**

Written 2026-08-24 as a scoping handoff; phase 1 was implemented and verified the same
day in `src/lib/digger/autoMix.ts`. The `Auto` toggle in `DiggerQueue.svelte` now gates
*both* this near-end crossfade path and the older cold-reload EOS fallback (`autoDj.ts`,
"What already exists" below), which stays in place as a safety net for tracks the
lookahead never caught. `npm run check`/`npm test` clean (125/125, incl.
`autoMix.test.ts`'s 20 tests — 8 new ones cover phase 2's gating: never clobbering a
loaded deck, threshold gating, queue-first/`queueNext()`-fallback sourcing, no re-fetch
while still inside the threshold, and a DJ manually loading the deck while the fetch is
in flight). **Live-verified headless** (`tauri-driver` + Xvfb, isolated build, real
GStreamer pipeline, two decks loaded with the same 49s cached test clip) for **phase 1
only**: deck-1 started on its own 0.26s after deck-0 began playing (threshold set above
the clip's duration to trigger immediately), `crossfaderValue` ramped continuously 0→1
over ~2.2s against a configured 2000ms duration, and deck-0 was paused at the exact
instant the ramp hit 1, staying stable for 7.7s of further polling while deck-1 kept
advancing normally. One real edge case surfaced and is bounded, not a bug: with an
unrealistically large threshold relative to track length (as used to force a fast test),
the *incoming* deck can itself already be "near its end" under the same threshold,
producing one legitimate reciprocal trigger back toward the original deck once its ramp
completes — `wasAutoMixTriggered`'s per-file latch correctly caps this at one extra
bounce, never a sustained oscillation. Normal thresholds (15s default vs. multi-minute
tracks) can't reach this condition. **Phase 2 has only unit-test coverage (mocked
Digger API/`loadQueueItemToDeck`) — it has not been driven against a real running
Digger backend or a real deck in a live/headless session.** Phase 3 (tempo/phase sync) is
built + unit-tested, not live-verified — see the phase-3 note above.

**Phase 4 (per-track outro marker), built + unit-tested 2026-08-24, same day the user asked
for it right after Phase 3's own first live test.** Gap 1's original framing assumed this
would need a Digger schema migration and a new endpoint (`Deck.outroPoint` + `POST
/tracks/{id}/markers` support) — checking `~/repos/digger/routers/tracks.py` first found
that work already done, just unconsumed: Digger's `analyze_audio.py` already derives a
`mix_out` marker automatically during BPM analysis (16 bars before the last detected beat,
falling back to ~30s before the end — see `_derive_mix_points`, and
`docs/design/playlist-management.md` "Mix points" in the digger repo for the reasoning),
manually-overridable there via the existing generic markers API, and `GET
/tracks/{id}/cuemark` already returns it as `mixOut` — cuemark just never read the field.
**No digger-repo change was made or needed.** `Deck.outroPoint` (`types.ts`) is populated
from `payload.mixOut ?? null` in `queueStore.ts`'s `loadQueueItemToDeck()` (same
omitted-vs-null normalization the bpm/downbeat pull already needs — see the
digger-integration skill). `nearEndReference()` in `autoMix.ts` is the one seam both
triggers go through: `Math.min(outroPoint, duration)` when set (clamped defensively —
Digger already clamps server-side, but a stale value here must never land past EOS), else
`duration` exactly as before. The existing `autoMixThresholdSec`/`autoPreloadThresholdSec`
settings still measure their lead time from whichever reference applies, so a track with no
analysis run yet (or a local, non-Digger load) behaves identically to before this field
existed. `autoMix.test.ts` covers: triggering off the marker instead of duration, *not*
triggering early just because the marker is still far off, clamping an out-of-range marker,
the preload trigger also using the marker, and the duration-fallback case. `npm
test`/`npm run check` clean (147/147). **Not yet live-verified** — and specifically not
verified against a track where Digger's BPM analysis has actually run, since (per the
digger-integration skill) the local dev Digger database may have zero tracks with `bpm` set
depending on when analysis was last run there, which means zero tracks with a derived
`mixOut` either.

⚠️ **Deliberately not built alongside this**: a manual "SET OUTRO" UI control in cuemark
that would `pushMarker(trackId, ms, 'mix_out')`. Digger's `track_cuemark()` picks the
*first* marker of a type by `position_ms`, not "most recent" the way it does for
`downbeat` — so if a track already has an auto-derived `mix_out` row and a DJ manually adds
a second one, whichever sits at the lower position wins, not necessarily the manual one.
That's a pre-existing ambiguity in Digger's own endpoint, not something this session
introduced, and it should be fixed there (most-recent-wins, matching `downbeat`) before a
manual override control is trustworthy — separate work, in the digger repo, and out of
scope for this pass (a different session was actively working in that repo's shared
checkout while this one ran).

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
2. 🟡 **BUILT + unit-tested 2026-08-24, not yet live-verified — Auto-preload.**
   `checkAutoPreloadTrigger()` in `autoMix.ts` (wired from `positionPoll.ts` alongside
   `checkAutoMixTrigger`) fires at an earlier `autoPreloadThresholdSec` (Settings → Controls
   → Auto Preload, default 45s vs. Auto Mix's 15s) than the crossfade-start threshold,
   and only onto the mapped deck that's genuinely empty (`source === null` — never
   overwrites a DJ's manual load or an earlier preload). Reuses `autoDj.ts`'s existing
   sourcing, extracted into `pickAndConsumeNext()` so `handleDeckEos` and the preload
   trigger share one implementation instead of drifting. Readiness signal is
   `source.duration > 0` — the same one the crossfade trigger already gates the incoming
   deck on, not a fixed timeout (gap 3) — so no new readiness primitive was needed; a
   preload threshold set too close to the crossfade threshold for a given track's demux
   time just means the crossfade trigger waits, same as it always has when nothing is
   loaded yet. **Not yet exercised against a real running Digger backend or a real deck**
   — only `autoMix.test.ts`'s mocked-API unit tests have run this path.
3. 🟡 **BUILT + unit-tested 2026-08-24, not yet live-verified — Optional tempo/phase sync.**
   `autoMixSyncEnabled` toggle, reusing existing `syncLocked`/`nudgePhaseToMaster` machinery —
   gap 5. See the phase-3 note above.
4. 🟡 **BUILT + unit-tested 2026-08-24, not yet live-verified — Per-track outro marker.**
   Turned out to need **no** cross-repo schema/endpoint cost at all — see "Phase 4" note
   below. `nearEndReference()` in `autoMix.ts` swaps in `Deck.outroPoint` for
   `source.duration` as what "near-end" is measured from, in both the crossfade and
   preload triggers, when a track has one.

## Explicitly out of scope

Transition-mining from play history to *train* an auto-DJ model — Digger's
`mix_transitions.source='play_history'` is reserved for a separate server-side job over
the `plays` log (see the digger-integration skill's "Session/play history reporting"
section); this doc is about executing transitions live, not learning from past ones.

## Open questions for whoever picks this up

- ✅ Fixed crossfade duration (a Settings number), not BPM/genre-aware — `crossfadeDurationMs`,
  Settings → Controls → Auto Mix, default 6s. Answered as part of phase 1.
- ✅ **Hand-back-control-at-current-position**, not cancel-in-place, when the DJ grabs the
  fader mid-auto-fade: `autoMix.ts`'s ramp aborts the instant `notifyManualCrossfaderTouch()`
  fires (from `Crossfader.svelte`'s `oninput` or the MIDI handler's `queueCrossfader`) and
  does not resume — the crossfader just sits wherever it was, under manual control from
  that point on, mirroring the existing `syncLocked` "manual input wins immediately"
  convention. Chosen because a from-scratch re-take (cancel-in-place, wait, resume) has no
  precedent anywhere else in the codebase and adds a second state machine for a case (the
  DJ actively touching the fader) that should just mean "the DJ has it now."
- ✅ **Real per-track outro marker, built 2026-08-24** — see "Phase 4" note below. It
  reuses a field (`mixOut`) Digger was already computing during BPM analysis and already
  returning from `/tracks/{id}/cuemark`, unconsumed by cuemark until now — no schema
  change, no migration, no new endpoint, and (deliberately) no digger-repo edit at all.
- Confirm the two-deck-only scope (gap 2) is acceptable, or whether N-deck auto-mixing is
  actually needed before starting. Phase 1 ships with the two-deck scope as recommended.
