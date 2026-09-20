# Auto DJ: automated transitions

Status: 🟡 **Phases 5 + 6 built + unit-tested 2026-08-30, NOT live-verified — see the
2026-08-30 entry and the four "Phase 5"/"Phase 6" sections. Phase 1 DONE + live-verified
2026-08-24. Phase 2 (auto-preload) built +
unit-tested 2026-08-24, fixed one live bug 2026-08-24, still NOT re-verified live. Phase 3
(optional tempo/phase sync) built + unit-tested 2026-08-24; a first live test found no
audible beat change, root-caused to a fire-and-forget seek racing playback start plus zero
log coverage on the whole path — both fixed same day (see "Live-session bug found + fixed"
below), still NOT re-verified live. Phase 4 (per-track outro marker) built + unit-tested
2026-08-24 — turned out to need zero Digger schema/endpoint changes, see "Phase 4" below —
NOT yet live-verified. 2026-08-26: "Manual/auto interaction" tier system (see that section)
and an `outroPoint` low-end sanity floor built + unit-tested, both root-caused from live logs,
NOT yet live-verified.** — see "Proposed phased plan" below.

**2026-08-30: phases 5 and 6 built + unit-tested (182/182), from three live asks and one
UI ask. NONE of it is live-verified.** Phase 5 is three changes to how a transition is
decided — its *duration* now comes from the two tracks' own mix markers rather than one
flat setting, **Skip** actually skips, and a beatmatched deck's rate **drifts back to
native** instead of compounding across a set. Phase 6 reclaims the deck card's slider
space for a **mix-point panel** (with in-app Digger marker writes) and adds a
**transition preview**, plus intro/outro zone shading on the waveform. See the four
"Phase 5"/"Phase 6" sections below.

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

**2026-08-26, two more live reports, both root-caused from `cuemark.log` alone (no
reproduction needed — the debugLog instrumentation from the entry above was enough):**

1. **A track got loaded onto two decks at once.** Full timeline: an automated crossfade
   completed normally, freeing deck-0 (`source: null`). The DJ then manually loaded and
   played an older track back onto deck-0, and pulled the crossfader to `0.0` to hear it —
   silencing deck-1, which kept playing its own (automatically-advanced) track unattended
   the whole time. `checkAutoMixTrigger` correctly refused to touch that pair (it bails
   whenever the incoming deck is already playing — "manual overlap in progress, leave it
   alone"), but nothing recorded that the transition had, in effect, already happened. When
   deck-0's manually-driven track reached its own real EOS ~4 minutes later, `handleDeckEos`
   saw an *unhandled* transition and picked "the next unplayed track" — which was still
   technically unplayed because `playedTracks.ts` gates on **audible** volume, not just
   `playing`, and deck-1's crossfader-driven volume had been `0` the entire time. Same file
   loaded onto both decks. Confirmed end-to-end from `[bus/deck-N] EOS`, `detached-pipeline
   IPC received`, `video_demux`, and `Crossfader` log lines — no missing case, no ambiguity.
2. **A track auto-mixed in and was replaced again within ~8 seconds.** "Baddy On The Floor"
   (measured `duration=222.889s`) crossfaded in per the phase-4 `outroPoint` reference, then
   `checkAutoPreloadTrigger` reported it had "12.5s remaining" **12ms after the ramp
   completed**. Digger's auto-derived marker ("16 bars before the last detected beat") was
   wrong for this specific file — a bad beat-grid fit put it at ~18s into a 223s track.
   `nearEndReference()`'s clamp only ever protected the high end (never past EOS); nothing
   protected the low end. Unrelated to a tempo-slider change the DJ had made two minutes
   earlier on the *other* deck — remaining-time is computed purely from the incoming deck's
   own duration/outroPoint/content-position.

**Both fixed the same day.** (1) is the "Manual/auto interaction" design below —
`notifyManualPlay()` now marks both decks in a manually-overlapped pair as handled, closing
the exact gap the incident hit; `queueStore.ts`'s `loadQueueItemToDeck()` gained an `origin:
'manual' | 'auto'` parameter so a manual load also marks whatever it displaced as "skipped"
(new `playedTracks.ts` state, distinct from "played") rather than leaving it dangling as
foreverunplayed. (2) is a one-line floor in `nearEndReference()`: an `outroPoint` inside the
first third of a track's duration is now treated as untrustworthy and ignored in favor of raw
duration, same as no marker at all — see "What's missing" §1/§3 below for where that
function lives. `npm test`/`npm run check` clean (161/161, up from 148). **Neither
live-verified yet** — both are log-forensics fixes for one-off incidents, not yet re-run
against a real set.

## Phase 5 — transition duration derived from the two tracks (2026-08-30)

🟡 **Built + unit-tested, not live-verified.** The ask: "the duration should come from the
two tracks, not one app-level number — a per-track fade-in zone and fade-out zone, so two
tracks that both support it get a long musically interesting blend and ones that don't get
a short one."

**No Digger change was needed, again.** Same shape as phase 4: `_derive_mix_points()`
(`~/repos/digger/importers/analyze_audio.py:109`) already writes **both** a `mix_in` and a
`mix_out` marker per track, and `_build_cuemark_payload()`
(`~/repos/digger/routers/tracks.py:313`) already returns both as `mixIn`/`mixOut` — cuemark
consumed only `mixOut`. `Deck.introPoint` (`types.ts:75`) now mirrors `Deck.outroPoint`,
populated from `payload.mixIn ?? null` in `queueStore.ts`'s `loadQueueItemToDeck()` with the
same omitted-vs-null normalization.

**What a "zone" is.** Two lengths, not two timestamps:
- outgoing **outro zone** = `duration − outroPoint` — how much track sits after the mix-out
  marker, i.e. the tail the DJ is happy to have another track playing over. Digger's
  auto-derived marker makes this 16 bars (~30s at 128bpm).
- incoming **intro zone** = `introPoint` — how much of its head is blendable before its
  body starts.

`computeTransitionDurationMs()` (`autoMix.ts:395`, pure and unit-tested directly) takes the
**minimum** of the two usable zones — a blend can only be as long as the more constrained
track supports — clamped to 2s…20s, and falls back to the flat `crossfadeDurationMs`
setting when neither side has usable marker data. Same fallback discipline as
`nearEndReference`: a track with no analysis run behaves exactly as it did before the field
existed.

⚠️ **The honest finding: Digger's `mix_in` is not an intro *length*.**
`_derive_mix_points()` sets `mix_in_s = float(beat_times[0])` — the **first tracked beat of
the track**, typically well under a second, with an explicit "no dedicated bar/downbeat
detector yet" comment. So for an auto-analysed track the intro side carries no information,
and `MIN_ZONE_SEC = 2` (`autoMix.ts:354`) is what keeps those sub-second values from
collapsing every transition to the 2s floor. It becomes real the moment a DJ places a
manual `mix_in` — which phase 6's marker panel now makes possible from inside cuemark — and
would become real for the whole library if Digger learned to derive a genuine intro
boundary (open decision below). Wiring the field through anyway is deliberate: it is the
correct consumption point, it costs nothing, and it is inert rather than wrong until the
data improves.

**The trigger point moved too, and had to.** With a per-pair duration, a fixed
`autoMixThresholdSec` can disagree with it — a 20s blend triggered 15s from the outro point
would be cut off by the track ending 5s early. `transitionPlan()` (`autoMix.ts:425`) makes
the lead `max(autoMixThresholdSec, durationMs/1000)`, so:
- **no marker data** → derived duration is the 6s default, below the 15s threshold → the
  trigger fires at exactly 15s and the ramp runs 6s. **Byte-identical to before phase 5.**
- **a long derived blend** (say 20s) → the trigger fires 20s out and the fade lands exactly
  on the outro reference.
- **a short derived blend** (say 5s) → the DJ's "start mixing 15s out" setting still wins as
  the trigger point; the fade just finishes early, as it always has.

`autoMixThresholdSec` is therefore now a **floor**, and `crossfadeDurationMs` a
**fallback** — the Settings copy (`ControlsSettings.svelte`) says so.

The preload trigger got the same treatment from the outgoing side only (it can't see the
incoming track — that's what it's for): `max(autoPreloadThresholdSec, plan.leadSec +
PRELOAD_LEAD_MARGIN_SEC)`, where the 15s margin guarantees a long marker-derived blend can
never start before the load has had time to finish. Over-estimating there only preloads
*earlier*, never later. With the 45s default and the 20s duration ceiling this is a no-op
today.

**Tests**: 8 direct unit tests on `computeTransitionDurationMs` (fallback, outro-only,
intro-only, min-of-both, the sub-second `mix_in`, an out-of-range `introPoint`, the
"Baddy On The Floor" untrusted `outroPoint`, both clamps) plus 3 on the trigger (triggers
earlier than the threshold for a long blend and runs for the derived duration; still waits
for the threshold when the blend is shorter; uses the flat fallback with no markers).

## Phase 5 — Skip now actually skips (2026-08-30)

🟡 **Built + unit-tested, not live-verified.** Live report, verbatim: *"Something went wrong
when I tried to skip a track. The next track loaded, but nothing happened. I expected it to
start the transition automatically."*

**Not a bug — a mismatch between what was built and what the control reads as.**
`skipUpcomingTrack()` (`autoMix.ts:175`) did exactly what it was designed to do in the
2026-08-26 tier-2 work: swap what's *preloaded* on the idle deck and let the playing deck's
own near-end threshold fire the transition later. Its tooltip even said so. But ⏭ on a
playing track means "get me off this track" on every other DJ tool, and a DJ mid-set does
not read a tooltip.

**Decision: keep both behaviors, separately labeled, and give ⏭ the one the DJ expects.**
- **⏭ Skip** → `skipCurrentTrack()` (`autoMix.ts:232`) — starts the transition *now*.
- **⤼ Change what's next** → the existing `skipUpcomingTrack()`, unchanged.

Collapsing them into one was considered. Against: the "swap the upcoming pick" behavior is
genuinely useful and already live-exercised (a DJ hearing what's cued and wanting a
different one, without disturbing the floor), it is the only control that can reach a deck
that isn't playing, and deleting it would silently change what an existing muscle-memory
press does. Two adjacent icon buttons with distinct tooltips is a smaller surprise than one
button that quietly changed meaning.

`skipCurrentTrack()` runs the **same** transition the near-end trigger would have — the
crossfade ramp was extracted into `beginTransition()` (`autoMix.ts:662`), shared by both,
rather than duplicated, so the beatmatch step, the settle windows and the phase-5 duration
all come along. Beyond that it:
- picks + loads a track first when the idle deck is empty, then waits on the *real*
  readiness signal (`source.duration > 0`, gap 3 — not a fixed delay), 15s bounded, with a
  toast on timeout;
- re-reads deck state after every await, and bails if a ramp started or a deck changed
  underneath it;
- marks the outgoing track **handled** (so its later EOS isn't treated as unhandled) and
  **skipped** (`playedTracks.ts` — it may not have been audible long enough for the 15s
  "played" rule, and it must not be re-offered);
- **degrades to `skipUpcomingTrack()`** when there is no single playing mapped deck to skip
  *from* — nothing playing yet, or a manual overlap where both are live. Pressing Skip
  should always do the most useful available thing; silently doing nothing is the failure
  mode this whole entry is about.
- no-ops (with a log line) while a crossfade is already in flight.

Every branch logs through `debugLog()` — `[auto-dj] skip-now: …`.

## Phase 5 — tempo drift-back after a beatmatched transition (2026-08-30)

🟡 **Built + unit-tested, not live-verified.** Live report: tempo "gets locked at some
strange tempos over time" instead of returning to normal.

**Root cause, traced through `session.ts`.** `checkAutoMixTrigger`'s sync branch locks the
incoming deck with `playbackRate = session.bpm / incoming.bpm`. When the fade completes and
that deck is the only one playing, `reconcileMaster()` (`session.ts:90`) promotes it to
`masterDeckId` and sets `session.bpm = deck.bpm * deck.playbackRate` — its
**already-adjusted** tempo. Nothing ever reset the rate: `syncLocked` is cleared only on the
*outgoing* deck as it's freed, never on the one that keeps playing. So transition N+1
locked deck C to deck B's adjusted rate, N+2 to C's, and so on — each reference derived
from the previous transition's output, **with no anchor to any track's real tempo**. Over a
set that walks in whichever direction the first few pairs pushed, without bound.

**Fix: an anchor, not a clamp.** After a synced fade completes, `startRateDriftBack()`
(`autoMix.ts:591`) eases the now-solo deck's `playbackRate` back to **1.0** over
`autoMixDriftBackSec` (`autoMix.ts:79`, default 20s, Settings → Controls → Auto Mix, shown
only when Beatmatch is on; **0 = off**, exactly the old behavior). `refreshMasterBpm()`
recomputes `session.bpm` from `deck.bpm * playbackRate` on every `updateDeck`, so the
reference walks back to the track's true bpm alongside it and the next transition starts
anchored.

**Why 1.0 and not "some configured rate".** The ask said "drift back to its configured
rate"; checking `types.ts` there is no per-deck configured-rate concept — `playbackRate`
*is* the deviation from native, and `deck.bpm` is measured at native. 1.0 is the only value
that makes `session.bpm` mean "this track's real tempo", which is the property the whole
compounding failure was missing.

Three things are load-bearing and were each found by reasoning through `session.ts`:
- **`syncLocked` is cleared at the START of the drift, not the end.** While it's set,
  `applyLockedRates()` (`session.ts:101`) re-pins the deck to `session.bpm / deck.bpm` on
  every session write, which would undo each easing step as it landed. Clearing it first is
  also what the flag means here: the deck is no longer following a master.
- **The ease writes in 0.005 rate steps, not every frame.** Both `syncRate()`
  (`audioSync.ts`) and the legacy `<video>` path ignore rate changes below 0.005, so a
  per-frame write would cost a Svelte store update (and a WebKit pipeline rebuild on the
  legacy path) to reach nothing. A 20s drift over a typical ±5% lock is ~12 writes total.
- **Cancellation is by divergence, not by a notify() at every call site.** Each tick
  compares the deck's `playbackRate` against what the drift itself last wrote; anything
  else — the DeckCard tempo slider (step 0.001), Sync, Lock, a MIDI fader, a jog nudge —
  differs and aborts the drift immediately, mirroring the `syncLocked` "manual input wins"
  convention. Unlike an explicit call it cannot be forgotten at a rate-writing site added
  later. `notifyManualRateInput()` (`autoMix.ts:583`) is wired into the two MIDI paths
  anyway (`midi/handler.ts`, the tempo fader and jog nudge) because those write audio
  immediately and the *store* only on the next rAF — divergence would catch them a frame
  later, and a frame later is one stale rate write on top of what the DJ just did.

The drift is deliberately **not** force-settled when the next transition arrives mid-ease.
Locking the incoming deck to a partially-drifted reference is musically *correct* — sync
means matching what is playing now — and `applyLockedRates` keeps the incoming deck
tracking the outgoing deck's own drift for the duration of the fade, so the two stay
matched. Compounding is still bounded, because every transition ends with its own
drift-back to native.

**Tests**: rate eases back to 1.0 with `syncLocked` cleared and `session.bpm` landing on the
incoming track's native bpm; `0` leaves the locked rate and the compounding reference exactly
as before; a manual rate write mid-ease cancels it and leaves the deck where the DJ put it,
with no dangling rAF loop; and a second transition locks against the settled 128bpm rather
than the 120 the first one left behind.

## Phase 6 — mix-point panel, zone visualization, transition preview (2026-08-30)

🟡 **Built + unit-tested, not live-verified.** The ask: reclaim the deck card's
Opacity/Volume/Rate slider space (keep the sliders as an option for a DJ with no
controller), put marker management there instead, and make it possible to preview an auto
transition without jumping to Digger mid-mix.

**1. The sliders became opt-in.** `Session.compactControls` already existed as the
hide/show switch — the default flipped to `true` (`session.ts`), the Settings checkbox
inverted to read **"Mixer sliders"** (`ControlsSettings.svelte`), and the mechanism is
otherwise untouched. ⚠️ `bootRestore.ts`'s restore is `restored.compactControls ?? true`:
a DJ who has already chosen keeps their choice, and only a snapshot predating the field
picks up the new default — the same "never let a default silently overrule a stored
choice" rule the 2026-08-25 `crossfaderValue` incident above established the hard way.
Hot cues are unaffected; they were never gated by this flag.

**2. `MarkerPanel.svelte`** (new) takes that space, always visible, one uniform row per
point — label · time · set-to-playhead (⦿) · clear (✕) — for Cue, **Intro**, **Outro** and
the Loop region, plus the zone *length* next to intro/outro because the length is what
`computeTransitionDurationMs` actually consumes. Set/clear writes the deck first and Digger
second: the deck must reflect the edit immediately (the waveform shading and the next
transition's duration both read the deck), and a local, non-Digger file simply skips the
write.

⚠️ **Intro/outro writes are delete-then-insert, and that is load-bearing.**
`setMixMarker()` (`api.ts:318`) deletes *every* existing marker of that type before POSTing
the new one. Digger's `_build_cuemark_payload()` resolves mix_in/mix_out as **"first marker
of the type by `position_ms`"** — not most-recent, and not manual-first, the way it does for
`downbeat` — so appending a manual marker later in the track than the auto-derived one
silently loses to it, forever, with no error. That ambiguity is exactly why phase 4
**declined** to ship a SET OUTRO button. Deleting first leaves one row, which makes "first
by position" unambiguous whatever cuemark writes, and needs no Digger change: `DELETE
/markers/{id}` and `GET /tracks/{id}` (which is where marker *ids* live — `/cuemark`
flattens them away) already exist. New thin wrappers `getTrackMarkers`/`deleteMarker`/
`setMixMarker`/`clearMixMarker` in `api.ts`, mirroring `pushMarker`'s shape.
🔴 **Still open**: re-running `analyze_audio.py` on that track re-derives a `detected`
marker alongside the manual one and the ambiguity returns. The real fix is in Digger
(rank `source='manual'` first, or upsert), and is an open decision below rather than
something worked around further from this side.

**3. Zone shading on the waveform.** `drawMarkers()` in `WaveformCanvas.svelte:502` now
draws the intro zone `[0, introPoint]` in blue and the outro zone `[outroPoint, end]` in
amber, under everything else, as a low-alpha wash plus one boundary line — deliberately
dimmer than the loop region's green fill and clear of the cue point's white, because zones
are present on every analysed track and must read as background information rather than as
an engaged mode. This is the piece that makes the rest legible: a DJ can *see* why a
transition will be long or short.

**4. `previewTransition()`** (`autoMix.ts:736`), the ▶ Preview button on each deck card:
parks the fader on the outgoing side, seeks the outgoing deck to exactly the point the
near-end trigger would have fired at (`reference − lead`) and the incoming deck to 0, then
after one 200ms seek settle runs **the real `beginTransition()`** — same beatmatch, same
ramp, same derived duration. Building a second ramp mechanism was rejected outright: the
two would drift apart and "the preview sounded fine" would stop meaning anything.

Three deliberate deviations, all so an audition is repeatable and consumes nothing: the
outgoing deck keeps its `source` at the end (unloading it would also make the idle deck
look empty to `checkAutoPreloadTrigger`, which would then eat the next queue entry for a
transition that never happened); no `handledOutgoing`/`markSkipped` bookkeeping; and it
works with Auto DJ **off**, because this is a workshopping tool, not automation. Seeking
the incoming deck to its `introPoint` instead of 0 was considered and declined — the live
path starts the incoming deck wherever it is parked, and a preview that differs from the
live path is worth less than no preview (making *both* start at `mixIn` is a real idea, and
an open decision below).

## Manual/auto interaction

**Problem this section answers**: what should a manual action (play/pause, load, crossfader
touch, tempo change, hot cue, …) do to Auto DJ while it's running? Incident 1 above is what
happens with no answer at all — Auto DJ silently mis-modeled a deck a human had taken over.

**Principle**: hand back control of exactly the thing touched, automatically, no negotiation
— the same convention `syncLocked` and `manualTouch` (this doc, "Hand-back-control-at-
current-position") already use. A blanket "turn Auto DJ off the moment a human does
anything" was considered and rejected: incident 1 wasn't caused by needing an off switch, it
was Auto DJ having no bookkeeping for a human quietly taking over one deck. Three tiers:

- **Tier 1 — pass through, Auto DJ never notices.** No code changes needed — these already
  don't touch anything Auto DJ reads: volume/gain faders, EQ, filters, tempo/pitch, seek/
  scrub/hot-cues within the currently-loaded track, headphone cue.
- **Tier 2 — local override ("park"), silent, Auto DJ stays on.** `notifyManualPlay(deckId)`
  (`autoMix.ts`) — called from every manual play-toggle site (`DeckCard.svelte`, the MIDI
  `deck_play_toggle` handler) right after a deck flips to playing — marks both decks in a
  mapped pair "handled" (`markHandledOutgoing`, the same bookkeeping `checkAutoMixTrigger`'s
  own ramp uses) the instant a manual play overlaps the other mapped deck already playing.
  `loadQueueItemToDeck(item, deckId, origin)` — the shared load path (DiggerQueue's click-to-
  load, the MIDI browse-encoder LOAD button) and the two non-Digger manual-load sites
  (`DeckCard.svelte`'s file picker, `App.svelte`'s drag-and-drop) all mark whatever they
  displace as **skipped** (`playedTracks.ts`'s `markSkipped`/`isSkipped`, a new state
  distinct from "played" — the track never actually sounded, but the DJ deliberately moved
  past it) so `pickNextTrack` doesn't loop back to it later. `skipUpcomingTrack()` is the
  explicit **Skip** control (DiggerQueue.svelte, next to the Auto toggle, visible only when
  Auto DJ is on) — advances whichever mapped deck isn't currently audible past its current
  pick (marking it skipped) and loads a fresh one with `origin: 'auto'`, without touching the
  toggle or the crossfader.
- **Tier 3 — disengage + alert.** Reserved for cases where Auto DJ's model of the mix is
  structurally broken, not just "a human did something": (a) a `crossfaderMapping` deck no
  longer exists in the session (`session.subscribe` guard in `autoMix.ts`) — e.g. removed via
  the toolbar's deck-remove button; (b) `handleDeckEos`'s advance genuinely fails (Digger
  unreachable, empty queue and no suggestion available) — every subsequent EOS would fail the
  same way, so leaving the toggle "on" but silently non-functional is worse than disengaging
  and saying so. Both call `autoDjEnabled.set(false)` and `showToast()` (`src/lib/ui/toast.ts`
  + `ToastHost.svelte`, new — no toast/status-bar primitive existed anywhere in the app before
  this). **Deliberately the only two triggers** — a usage-pattern-based one ("N manual
  takeovers in a row disengages") was considered and declined: a heuristic that turns the
  toggle off on its own judgement is more likely to surprise a DJ mid-set than help one.

**Not built**: any UI to review/clear the skipped-track set (the existing "Clear played"
button in DiggerQueue's settings row only clears `playedTrackIds`) — low priority since
`skippedTrackIds` only ever grows by a DJ's own deliberate action and a stale entry just means
one track doesn't get re-offered, not a hang or a crash.

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
still catching the genuine case where lookahead never triggered. Built as `handledOutgoing`/
`wasAutoMixTriggered` in `autoMix.ts`; extended 2026-08-26 to also cover a **manual** takeover
of one deck, not just the automated ramp — see "Manual/auto interaction" above.

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
5. 🟡 **BUILT + unit-tested 2026-08-30, not yet live-verified — Per-pair transition
   duration, a Skip that skips, and tempo drift-back.** Three separate live asks, one
   phase because all three change how a transition is decided. `Deck.introPoint` joins
   `outroPoint` (again with zero Digger changes), `computeTransitionDurationMs()` derives
   the fade length and the trigger lead from the pair's own zones with the flat settings as
   floor/fallback, `skipCurrentTrack()` forces the real transition now, and
   `startRateDriftBack()` returns a beatmatched deck to native tempo so the main-beat
   reference stops compounding across a set. See the three "Phase 5" sections above.
6. 🟡 **BUILT + unit-tested 2026-08-30, not yet live-verified — Mix-point panel, zone
   shading, transition preview.** The deck card's mixer sliders became opt-in
   (`compactControls` default flip) and `MarkerPanel.svelte` took the space; intro/outro
   edits write back to Digger delete-then-insert; the waveform shades both zones; ▶ Preview
   auditions the real transition on demand. See the "Phase 6" section above.

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

### Opened 2026-08-30 by phases 5 and 6 — decisions, not work items

Each of these is deliberately **not built**, per the convention phase 4's outro-marker
scoping set: flag the cross-repo or taste-dependent call rather than build ahead of it
blind.

1. 🔴 **A real intro boundary needs new Digger analysis.** `mix_in` is `beat_times[0]`,
   the first tracked beat — see the Phase 5 duration section. A genuine "end of the intro"
   (first vocal, energy onset, first full-arrangement bar) would make the incoming side of
   every transition duration meaningful for the whole library instead of only for manually
   marked tracks. That is a Digger-side analysis change (`_derive_mix_points`, plus a
   re-analysis pass over the library) and possibly a schema one if it wants its own marker
   type rather than redefining `mix_in`. **Needs a call from the library's owner**: is
   `mix_in` allowed to change meaning, or does this want a new `intro_end` marker type?
2. 🟡 **Explicit per-track "suggested fade time", distinct from a zone boundary.** The
   original ask mentioned a recommended fade-in/fade-out *time* as well as zones. Today the
   duration is inferred from zone lengths, which is a proxy: a track can have a 30s outro
   that only wants an 8s blend. A real hint is a new per-track field (Digger schema +
   migration + a UI to set it) and is only worth it if the inferred duration turns out to
   feel wrong live — **re-read the derived durations from a real set's `[auto-dj] trigger:
   … (duration from …)` log lines before deciding.**
3. 🟡 **Cross-track compatibility scoring (key/energy) as an input to the transition.**
   Explicitly out of scope here, and adjacent to the transition-mining work Digger reserves
   as a server-side job — noted only so it isn't re-derived as a new idea.
4. 🔴 **Digger's mix_in/mix_out resolution should be most-recent- or manual-first.** Phase 6
   works around "first marker by `position_ms` wins" by deleting before inserting, which is
   correct from cuemark's side but does not survive a re-run of `analyze_audio.py` (a fresh
   `detected` marker reappears alongside the manual one, and whichever sits earlier wins).
   The fix is one line of ordering in `_build_cuemark_payload()` — matching what it already
   does for `downbeat` — in the digger repo. Same call that phase 4 flagged and declined;
   phase 6 raises the stakes because there is now a UI that makes manual markers routine.
5. 🟡 **Should a transition start the incoming deck at its `mixIn` rather than at 0?**
   Today both the live path and the preview start it wherever it's parked (position 0 for a
   freshly loaded deck), so dead air at the head of a track is audible under the fade.
   Starting at `mixIn` would skip it — but it means adding a seek to the live path, which
   already has one documented fire-and-forget-seek race (see the 2026-08-24 phase-3 entry),
   so it wants its own settle-window design rather than a one-liner.
6. 🟡 **Zone editing is numeric/playhead-based, not draggable on the waveform.** The panel
   sets a point from the playhead; dragging the shaded zone edge directly would be better
   for workshopping, and `WaveformCanvas`'s pointer handlers already own a
   press-anchored drag gesture that the scrub bus consumes — adding a second gesture there
   is a real design question (what does grabbing an edge do to scrubbing?), not a
   free addition. **Read `docs/design/waveform-scrub.md` before attempting it.**
7. 🟡 **Preview leaves the crossfader wherever the fade ended.** It parks the fader on the
   outgoing side before each run, so pressing Preview twice works, but after one preview
   the fader sits at the far end until the DJ or the next transition moves it. Restoring
   the pre-preview position afterwards was considered and left out — an automated fader
   move *after* the DJ has heard the result is the kind of surprise the "hand back control
   at current position" rule exists to avoid — but it should be checked against how it
   actually feels live.


## Phase 7 — fade over the outro zone, preview restores itself (2026-09-19)

**0. Preview raced the live trigger (fixed, `d874990`).** Preview seeks the outgoing deck to
the trigger point and starts it playing, then waits 200 ms for the seek to settle before its
ramp exists; in that window `activeRamp` was still null, so with Auto DJ **on** the real
trigger fired too — two concurrent ramps, one "completing" in 168 ms, the outgoing deck freed
and the next queue track loaded onto it. `previewInFlight` (with a timeout fallback so it can
never stick) now holds the trigger, the auto-preload and Skip off from the moment a preview
starts until its tail ends. Regression test: "holds the live trigger off during the
seek-settle window". The full review of the marker path that prompted the items below is
kept in [`auto-dj-zone-review-2026-09-19.md`](auto-dj-zone-review-2026-09-19.md).

🟡 **Built + unit-tested, not live-verified.** Prompted by a review of the marker path
(see the numbered open decisions above for what it settled).

1. **The blend now starts AT `outroPoint`** when a usable outro marker exists
   (`transitionPlan().startsAtOutro`, lead 0; the live trigger fires when the playhead
   reaches the marker and there is room for the blend). Before this the ramp was timed to
   *finish* at the marker and the outgoing deck was then unloaded, so the region
   `[outroPoint, end]` — the tail the marker's length is *derived from* — was never heard.
   Tracks with no usable marker (and intro-only) keep the old end-anchored lead and the
   `autoMixThresholdSec` setting; with a marker the setting no longer moves the start.
2. **Preview restores itself** (`finishPreview`): 3s after the fade completes it pauses the
   incoming deck at 0, puts back its rate/`syncLocked`, and returns the crossfader to where
   the DJ left it (open decision #7, now decided *yes*). Skipped on any abort — a fader
   touch hands control back and nothing is moved for the DJ. Pressing Preview again during
   the tail keeps the original snapshot.
3. The marker panel prints the engine's own zone figures (`outroZoneSec`/`introZoneSec`),
   showing "ignored" for a marker the engine discards, instead of raw numbers.
4. A ramp whose start already equals its target logs a WARN (the 2026-08-25 zero-length
   trap, which the live trigger can still reach).
5. Loading a local file onto a deck now also clears `introPoint`/`outroPoint`, and the
   drag-drop path clears `diggerTrackId`/`diggerFileId` (it cleared neither, so ⦿ wrote
   markers to the previous track's Digger row).

⚠️ **Open decision #4 is stale**: re-running `analyze_audio.py` does NOT clobber a manual
marker — `_upsert_mix_marker` returns early when any non-`detected` marker of that type
exists and cuemark writes `source='manual'`. What still happens is that a *cleared* marker
is re-derived on the next analysis run.

Not done (from the review, needs a decision or Digger work): two-ended zones (`intro_end` /
`outro_end` marker types — no migration needed, `markers.type` is free text), seeking the
incoming deck to its intro point (#5), marker-write rollback (`setMixMarker` is
delete-then-insert with no transaction).

**What a transition does with the two tracks' markers today (verified 2026-09-19)** — the
incoming deck is never *positioned* by a marker: Preview seeks it to 0 and the live path
starts it wherever it is parked. `cuePoint` is unused by transitions. `introPoint` only
bounds the blend *length* (min of the outro zone and, if ≤ duration/3, the intro zone).
Making the incoming deck start at its `introPoint` is the next piece of work (decision #5
above, now wanted): it needs the same seek on the live path and in Preview, reusing the
existing 200 ms settle window, and a real intro boundary — Digger's auto `mix_in` is the
first tracked beat (usually <1 s), so it only carries information once a human has placed it.

