---
name: digger-integration
description: Digger API integration in cuemark — endpoints, WebSocket queue updates, boundary rules between the two projects. Load when working on src/lib/digger/ or the DiggerQueue panel.
---

# Cuemark ↔ Digger Integration

Media library management lives in a **separate project** (`~/repos/digger`).
Cuemark does not embed a media browser — Digger owns that concern.

## What Digger provides

FastAPI REST at `http://localhost:8200` by default:

| Endpoint | Used for |
|---|---|
| `GET /queue/next` | Weighted-random track suggestion; Auto DJ's fallback source when the queue is empty (see "Auto DJ" below) |
| `GET /search?q=` | Quick track search from the cuemark toolbar |
| `GET /tracks/{id}/cuemark` | Deck-ready payload: `filePath`, `cuePoint`, `hotCues[]`, `gain` |
| `GET /tracks/{id}/waveform` | Cached decode (peaks 30/s + envelope 210/s, binary) — see "Beat-grid precision" below |
| `POST /tracks/{id}/markers` | Write cue/hot-cue positions back after editing in cuemark |
| `PATCH /tracks/{id}` | Generic scalar-field patch — `bpm` (SET BEAT) and `gain` (gain slider) both go through this, `{k: v}` body |
| `POST /plays/start`, `PATCH /plays/{id}/heartbeat`, `PATCH /plays/{id}/finish` | Session/play-history reporting — see below |
| `GET /queue/ws` | WebSocket — pushes `{"type": "queue_changed"}` after any queue mutation in Digger (add/remove/clear/consume/source-disable) |

The `/cuemark` payload maps directly to cuemark's `Deck` source interface:
```json
{ "filePath": "/media/charles/music/artist/track.mp4", "fileId": 16167, "cuePoint": 4.2,
  "hotCues": [32.0, 128.5], "bpm": 123.4, "bpmSource": "detected", "downbeat": 0.812,
  "beatGridAlgo": "comb-v1", "beatGridConfidence": 0.33, "gain": 1.5 }
```
`bpmSource`/`beatGridAlgo`/`beatGridConfidence` (added 2026-08-23) are what
`DiggerQueue.svelte`'s `trusted` check reads before calling `markGridSaved()` — see
"Beat-grid precision" below. `beatGridAlgo` is `null` for a legacy librosa-only value.
`gain` (added 2026-08-12) is a per-track pre-fader trim default (0–4): `loadToDeck()` resets the
deck to 1.0 unless Digger supplies a value, mirroring the bpm/downbeat pull; `DeckCard`'s gain
slider pushes changes back via `setTrackGain()` on the range input's `change` event (fires once on
release, not per drag tick like `oninput` does) when `deck.diggerTrackId` is set.
File preference in Digger: video > audio > any. Marker mapping: first `cue` → `cuePoint`, first 3
`hot_cue` → `hotCues[]`. `bpm`/`downbeat` round-trip the trusted beat grid (see cuemark's
`gridSource.ts` gotcha in the top-level `CLAUDE.md`).

**`fileId` — tiered local/remote media resolution (added 2026-08-01).** `filePath` and `fileId`
always refer to the same underlying `files` row (Digger's own video>audio>default resolution) and
are `null` together when nothing resolves. cuemark stores `fileId` as `Deck.diggerFileId` and
passes it as `audio_load`'s `fallback_url` param (`${diggerBaseUrl}/files/${fileId}`, built by
`getDiggerFileUrl()` in `src/lib/digger/api.ts`). Rust's `media_cache.rs` (`ensure_cached()`)
tries the local path first exactly as before — this is a fallback, not a replacement — and only
on a local stat failure does it fetch Digger's `GET /files/{id}` (Range-capable raw file stream,
`routers/tracks.py`'s `serve_file`) into the same local cache slot, so every downstream reader
(waveform analysis, the `<video>` element, the webcodecs path) still only ever reads a local file.
Motivating case: cuemark running on a machine that doesn't have the NAS mounted at all (distinct
from the offline-crate/travel scenario in the digger repo's `docs/design/offline-crate.md`, which
covers Digger itself lacking the file). **`getDiggerFileUrl()` needs an absolute base URL** — it
returns `undefined` for the dev-mode Vite proxy path (`/digger-api`), since that's relative and
only resolvable in the browser, not from the separate Rust process. Set an absolute URL (e.g.
`http://10.20.2.99:8200`) via the Home/Local toggle in `DiggerQueue.svelte` for this fallback to
work.

**Gotcha — every `MediaCache` consumer needs its own `fallback_url`, not just `audio_load`.**
`audio_analyze_file` (waveform) and `video_demux_load` (webcodecs path) each race `audio_load` for
the same file on a fresh track load — `WaveformCanvas.svelte`'s `$effect` fires off the same
`deck.source` change on Svelte's own scheduler, independent of `audio_load`'s call inside
`App.svelte`'s rAF-scheduled `syncVideoElements`. `MediaCache::lookup_wait()` only waits out a copy
that's *already* `InProgress` — if a caller reaches it before `audio_load`'s `ensure_cached()` has
inserted that marker, there's nothing to wait on and it returns `None` immediately, silently
falling back to the original (possibly unreachable) path. With a local NAS mount this race was
always there but invisible — a local `fs::copy` starts near-instantly, so the window was
microseconds. A ~6s Digger network fetch blows that window wide open: confirmed live 2026-08-01,
waveform analysis lost the race and rendered blank/silent while the fetch was still in flight.
Fixed by having `audio_analyze_file` and `video_demux_load` call `ensure_cached()` directly
(same as `audio_load`, both now take an `Option<String>` fallback URL param) instead of a passive
`lookup_wait()` — `ensure_cached()`'s `InProgress` branch already coordinates concurrent callers
safely, so whichever arrives first does the fetch and the other(s) wait on it. **Not fixed**:
`media_server.rs`'s legacy-`<video>`-element HTTP handler still uses bare `lookup_wait()` — it's a
plain HTTP server with no IPC-parameter path for a fallback URL, and only serves the
legacy-fallback backend (non-webcodecs decks), not the webcodecs-default path. Same latent race
there if a legacy-backend deck's first HTTP video request beats `audio_load`'s `ensure_cached()`.

**Gotcha — Digger omits unset `bpm`/`downbeat` instead of sending JSON `null`.** cuemark's
`CuemarkPayload` TS interface declares `bpm: number | null`, but that's just a type annotation —
if the FastAPI response body simply omits the key (e.g. a Pydantic model with
`exclude_none=True`), `payload.bpm` deserializes as JS `undefined`, not `null`. Every consumer in
cuemark (`DeckCard.svelte`, `gridSource.ts`, etc.) only ever guards `!== null` to match the `Deck`
type's `number | null` invariant — `undefined !== null` is `true`, so it slips straight through
every guard. Confirmed root cause of a live freeze (2026-07-06): `deck.bpm` ended up `undefined`,
and `DeckCard.svelte`'s `{deck.bpm.toFixed(1)}` threw, which aborted that Svelte effect-flush tick
before `App.svelte`'s `syncVideoElements` (and therefore `audioLoad`) or `WaveformCanvas`'s
`analyzeFile` ever ran — the deck showed its filename (state updated fine) but never got a video
frame, audio pipeline, or waveform, and the Rust log showed zero pipeline-construction lines
because the backend was never actually invoked. Fixed in `DiggerQueue.svelte`'s `loadToDeck` by
normalizing `payload.bpm ?? null` / `payload.downbeat ?? null` right at the API boundary, before
the value touches any `!== null` guard. **Any new consumer of Digger JSON should normalize
optional fields the same way at the point they enter cuemark** — don't trust the TS interface to
guarantee the runtime shape.

## Session/play history reporting (added 2026-08-12)

**Before inventing a new endpoint for anything session/history-shaped, check
`~/repos/digger/docs/design/play-tracking.md` first** — Digger's `plays` table
(`context='cuemark'`) was already specced for exactly this ("Cuemark: standardize on the same
log" section) and just sat unused by cuemark for weeks. Building a parallel "Sessions" concept
would have been a second wheel. `history.ts`'s existing per-deck load/play/pause state machine
(it already tracks `deckId`, `diggerTrackId`, `startedAt`, `playedMs` locally) now also reports
into it: `playStart(trackId, deckId)` on load, `playHeartbeat()` on pause and every 30s while
playing, `playFinish()` on track-change/unload/deck-removal — all fire-and-forget
(`.catch(console.error)`), same convention as `pushMarker`. A `diggerTrackId === null` load
(local file, not from Digger) reports nothing.

⚠️ **`mix_transitions.source='play_history'` is not something cuemark should ever POST directly.**
That table's router docstring (`routers/mix_transitions.py` in the digger repo) explicitly
reserves `'play_history'` for a transition-mining job that reads the `plays` log server-side —
"out of scope for this router," i.e. separate future work, not a live client assertion. What
cuemark owns is making sure `plays` rows are accurate (real start times, real durations) so that
job has good raw material later — not deriving transitions itself.

## DJ selector / guest attribution (added 2026-08-23, case-insensitive 2026-08-24)

`src/lib/digger/djSelector.ts` — free-text "who's on the decks" (no accounts, no managed
list; see `docs/design/guest-djs.md` in the digger repo). `currentDj` feeds two things:
`playStart()`'s `listener` field (read at **load** time, captured for that play's whole
lifetime — a mid-track handoff must not retroactively reassign an in-progress play) and
`queueStore.ts`/`DiggerQueue.svelte`'s queue scoping (read reactively at **call** time).
Empty string → `null` (`currentDjOrNull()`) means unclaimed, matching Digger's
`queue_items.owner`/`plays.listener` NULL convention.

Digger matches these names **case-insensitively** (`COLLATE NOCASE` on every
`owner`/`listener` comparison, added 2026-08-24 so "Tessa" typed as "tessa" doesn't fork
into a second guest) — `djSelector.ts`'s own recent-values MRU (`pushDjHistory`) mirrors
that: dedup is case-insensitive too, so the toolbar's quick-pick list doesn't show the
same DJ twice under different casing. If you add another Digger-attribution field that
reuses this free-text-name pattern, match this case-insensitivity on both sides rather
than assuming exact-string matching.

## Digger-side schema changes (added 2026-08-12)

Adding a column to Digger's schema for cuemark to read/write (like `tracks.gain`) needs **two**
edits in the digger repo, not one — `CREATE TABLE IF NOT EXISTS` in `db.py` only affects a
brand-new database:
1. Add the column to the relevant `CREATE TABLE` in `db.py` (for fresh installs).
2. Add a new idempotent `step_add_..._column` function in `migrate.py`, registered as the next
   numbered step in `run()` (grep the file for `step_add_track_beat_anchor_column` for the
   pattern to copy). This is what actually reaches the **live** `digger.db`.

The live db is only patched by *running* the migration: `docker compose exec api python
migrate.py --dry-run` first (prints what it would do; matched against `_columns()`, safe to
run repeatedly), then without `--dry-run` to apply. The `api` service isn't always up —
`docker compose ps` to check, `docker compose up -d api` to start it (host port **8200**, maps
to the container's 8000; `docker compose logs api` to confirm it's serving before hitting it).

## Beat-grid precision + waveform cache (added 2026-08-23)

`bpm.ts`'s comb-fit algorithm is now ported to Digger (`importers/beatgrid.py`) so
Digger's own `bpm`/`beat_anchor_ms` get the same precision cuemark computes locally,
and Digger also caches the decoded peaks/envelope (`waveform_cache` table, served via
`GET /tracks/{id}/waveform`) so cuemark can skip its own Rust decode for a
Digger-loaded track. Full detail, including the exact trust rule and the binary
wire format: `docs/design/beatmatching.md` "Root cause #2" (cuemark side) and
`~/repos/digger/docs/design/beat-grid-precision.md` (Digger side, the source of
truth for the algorithm/schema detail). **If `bpm.ts`'s algorithm ever changes,
`importers/beatgrid.py` needs a matching re-port** — it's a separate implementation
in a separate language, not a shared module, and the two have already drifted once
(the port fixed nothing, it just needed to exist).

⚠️ **Local dev Digger (this machine, port 8200 — what the Vite dev proxy's
`/digger-api` target points at) is a different database from the live production
instance (192.168.2.99), and this is already documented convention** — see the
`digger` skill's "Important conventions" section ("192.168.2.99 is the only
production instance") before assuming a local test proves anything about the real
library. Concretely hit while building this feature: the local dev DB has the same
track *catalog* as production (same row count) but had **zero** tracks with `bpm`
set — analysis had simply never been run against its locally-mounted media, so
don't assume a track visible in the local Digger UI/queue has real bpm/waveform
data just because production does. Verify a schema/algorithm change locally
(pytest, `analyze_audio.py --track-id <id> --force`, curl), then still treat it as
undeployed until pushed and rolled out to .99 per that skill's sequence — local
`docker compose exec api python migrate.py` only ever touches the local copy.

## Auto DJ (added 2026-08-23)

`src/lib/digger/autoDj.ts` — a single toggle (the `Auto` button in `DiggerQueue.svelte`'s
search row, replacing the old unused `Rnd`/`Nxt` add-to-queue buttons) that auto-loads and
plays the next track whenever a deck reaches EOS (`deck-eos`, wired in `App.svelte`).
Persisted as `cuemark:autoDj` in localStorage.

Source order (`pickNextTrack()` in `autoDj.ts`), **changed 2026-08-24 — no longer deletes
queue entries**: **(1)** if the deck being replaced has a `diggerTrackId` that's itself a
queue entry, the next *unplayed* entry after its position in `GET /queue` (queue order is
the human-curated one, so Auto DJ should walk through it in order rather than restart from
the front every time); **(2)** no anchor (first track of the set, or a manually/search-
loaded track that was never queued) — the first unplayed entry, queue order; **(3)**
`GET /queue/next` (weighted-random) once nothing unplayed remains, so Auto DJ never just
stops. "Unplayed" is `playedTracks.ts`'s session-local tracking (`isPlayed()` — a track is
audible on the main output, not just cued, for 15s+ accumulated; see that file). Entries
stay in the queue permanently now — a DJ wants it to read as a set list matching Digger's
own web UI, not shrink as a work stack; the queue panel's played checkmark (same
`playedTracks.ts`) is what shows progress instead.

⚠️ **`handleDeckEos()`/`checkAutoPreloadTrigger()` fetch the queue directly rather than
reading the `diggerQueue` store** — that store is only kept live while `DiggerQueue.svelte`
is mounted (`{#if $showDiggerQueue}` in `App.svelte`), and a DJ closing the sidebar mid-set
to reclaim screen space is normal. Reading the store instead would make Auto DJ silently
stop advancing the moment the panel is hidden. If you ever refactor this to read the store
for efficiency, keep it working with the panel closed.

Not built: transition-mining for auto-DJ training (deliberately out of scope — see
"Session/play history reporting" above, `mix_transitions.source='play_history'` is a
server-side Digger job over the `plays` log, not something this toggle should compute).

**Phase 1 of the real auto-mixing version is built + live-verified** (2026-08-24,
`src/lib/digger/autoMix.ts`, gated on the same `Auto` toggle): while a
`crossfaderMapping`-named deck plays, once it's within `autoMixThresholdSec` (Settings →
Audio → Auto Mix, default 15s) of its end **and** the other mapped deck is already loaded
with a known duration, it starts that deck playing and ramps `setCrossfader()` toward it
over `crossfadeDurationMs` (default 6s), then pauses the outgoing deck. No tempo/phase sync.
A manual crossfader touch (on-screen or MIDI) aborts the ramp immediately, handing control
back at wherever it stopped; a `wasAutoMixTriggered()` per-file flag stops `handleDeckEos()`
above from also cold-reloading a deck this path already handled — bounds even the degenerate
case of a threshold larger than the track (both decks looking "near-end" at once) to one
extra reciprocal bounce, not a sustained oscillation; unreachable at normal
threshold/track-length ratios. Live-verified headless via `tauri-driver` against a real
GStreamer pipeline: incoming deck auto-starts within ~0.3s, crossfader ramps continuously
over the configured duration, outgoing deck pauses at the exact instant the ramp completes.

**Phase 2 (auto-preload) is built + unit-tested, NOT yet live-verified** (2026-08-24,
same file): `checkAutoPreloadTrigger()`, wired from `positionPoll.ts` right alongside the
phase-1 trigger, fires at an earlier `autoPreloadThresholdSec` (Settings → Controls → Auto
Preload, default 45s) and auto-loads (never plays) the next track onto the mapped deck
that's genuinely empty (`source === null`) — reusing the same `pickNextTrack()` sourcing
as `handleDeckEos` (see "Auto DJ" above), anchored on the *outgoing* deck's current track so
a multi-lap set keeps advancing through the queue in order. Never overwrites a deck the DJ
(or an earlier preload) already put a track on, and re-checks after the fetch resolves in
case the DJ loaded something manually while it was in flight. Only `autoMix.test.ts`'s
mocked-API unit tests have exercised this path — it has not been run against a real
Digger backend or a real deck.

**Phase 3 (optional tempo/phase sync) is built + unit-tested, NOT yet live-verified**
(2026-08-24, same file): `autoMixSyncEnabled` toggle (Settings → Controls → Auto Mix →
"Beatmatch before mixing", default off). When on and both decks have a detected/set `bpm`,
the phase-1 trigger rate-locks the incoming deck (`syncLocked: true`, rate = main-beat-ref /
incoming.bpm) and, after a 200ms settle, calls `nudgePhaseToMaster()` to align phase before
starting play + the crossfade ramp — the exact two-step sequence (and the same 200ms delay)
DeckCard.svelte's manual **Lock** button already uses; reused rather than reinvented. Missing
bpm on either deck silently falls through to the native-tempo cut, same as with the toggle
off. ⚠️ **A deferred step ahead of an interruptible ramp needs its own interruption check,
not just the ramp's** — the manual-crossfader-touch abort (`manualTouch` counter) is captured
before the 200ms `setTimeout` and re-checked inside it, or a DJ grabbing the fader during the
settle window would still get overridden a moment later when the deferred callback fired and
started playing anyway. ⚠️ **A live test found no audible beat change** — root cause: at the
moment `nudgePhaseToMaster()` runs the incoming deck is still paused, so it takes the
"paused: seek immediately" branch (`phaseNudge.ts`), and that seek's `audio_seek` IPC is
fire-and-forget — `updateDeck(incomingId, {playing:true})` used to fire right after with no
settle, so playback could start before the seek landed. Fixed with a second 200ms settle
window (same shape as the rate one above) between the nudge and setting `playing: true`; also
added `debugLog()` calls through the whole sync branch (`[auto-dj] sync: …`), since none of
this path logged anything to `cuemark.log` before — every state change was a pure Svelte-store
write. Both fixed 2026-08-24, still not live-reverified.

**Phase 4 (per-track outro marker), built + unit-tested 2026-08-24 — no digger-repo change
needed.** Digger's `analyze_audio.py` already derives a `mix_out` marker automatically during
BPM analysis and already returns it from `/tracks/{id}/cuemark` as `mixOut` (see
`_derive_mix_points` in the digger repo) — cuemark just never consumed it. Now pulled into
`Deck.outroPoint` (`queueStore.ts`'s `loadQueueItemToDeck`, same omitted-vs-null
normalization as bpm/downbeat above) and used by both triggers via `nearEndReference()` in
`autoMix.ts` in place of `source.duration` whenever a track has one — the existing
threshold settings still measure their lead time from whichever reference applies. Falls
back to duration exactly as before when unset (no analysis run yet, or a non-Digger load).
⚠️ **No manual "set outro" control was added** — Digger's `track_cuemark()` picks the
*first* marker of a type by `position_ms`, not most-recent like it does for `downbeat`, so a
manually-pushed second `mix_out` marker isn't guaranteed to win over an auto-derived one.
Fix that in the digger repo (most-recent-wins, matching `downbeat`) before adding a manual
override control.

⚠️ **The crossfade ramp's completion branch must clear the outgoing deck's `source`, not
just `playing`** (fixed 2026-08-24, `autoMix.ts`'s `startCrossfadeRamp`) — leaving a
just-finished track's `source` in place made it look permanently "already loaded" to both
this trigger and the mix trigger, so a deck that had just faded out never got a new track
on the next cycle. `source: null` also drives `App.svelte`'s `syncVideoElements()` to tear
the backend/audio pipeline down, same as a deck being removed.

Full design and live-verification status for all four phases: `docs/design/auto-dj-transitions.md`.

⚠️ **"The transition was abrupt" is not automatically a `crossfadeDurationMs` problem —
check `cuemark.log` for `[auto-dj]` lines before touching that setting** (fixed
2026-08-25). Until that date the base (non-sync) crossfade path — the one that actually
runs, since `autoMixSyncEnabled` defaults off — had **zero** `debugLog()` calls anywhere:
not the trigger firing, not the ramp starting/aborting/completing. A silent log there is
expected on an unpatched build, not evidence Auto DJ never ran. Now instrumented (`[auto-dj]
trigger:`, `ramp start:`/`ramp aborted:`/`ramp complete:`, `[auto-dj] preload:`) — read the
`from=`/`target=` values on `ramp start` first: if they're equal, the "ramp" was a
zero-length no-op regardless of `crossfadeDurationMs`, which is exactly what the
`crossfaderValue` bug below produces.

⚠️ **`session.crossfaderValue` restored from a prior session on an ordinary app restart can
silently desync from what the decks actually play at, producing a hard one-frame cut instead
of a fade** (root-caused + fixed 2026-08-25, `bootRestore.ts`). On a non-recovery boot decks
reset to fresh defaults (audible), but the old fix path restored `crossfaderValue` as inert
session state — so a value left at, say, `1.0` from a previous set sat unapplied until the
*next* `setCrossfader()` call (a manual touch, or Auto DJ's own ramp) finally pushed the
curve onto the decks, snapping volumes in one frame instead of gradually. The next fix
(eagerly applying the restored value at boot) was worse — it silently muted whichever deck
loaded next, with no on-screen cause, because an unmotorized fader's *physical* position
can drift from any persisted value just by being touched by hand while the app is closed.
**Current behavior: `crossfaderValue` is not restored or applied at all on an ordinary
restart** — it stays at the default (`0.5`, both decks live) until a real signal (physical
touch or Auto DJ) moves it. If a future session wants "remember my on-screen crossfader
position across restarts" back, it needs a way to distinguish "last touched on-screen" from
"last touched by a hardware fader that may have moved since" — don't just restore the field
again without solving that.

## Queue played-tracking (added 2026-08-24)

`src/lib/digger/playedTracks.ts` — a session-local ✓ shown left of the track label in
`DiggerQueue.svelte`'s queue rows and search-result rows, marking a `track_id` "played"
once a deck has been both `playing` **and** audible on the main output
(`deck.volume > 0.05`, accumulated 15s+) — not just loaded. Clicking a lit checkmark
clears that one track (`clearPlayed`); a "Clear played (N)" button in the panel's own
gear/settings dropdown clears the whole set (`clearAllPlayed`). Persisted to
`localStorage['cuemark:playedTrackIds']`.

**Deliberately separate from `history.ts`'s `plays` API reporting above, not a
repurposing of it.** `history.ts` marks a track "started" the instant it's *loaded*
onto a deck, which already fires for a track cued in headphones and never faded in —
correct for its own purpose (Digger's `plays` log wants every attempt, "record raw,
interpret at read" per `play-tracking.md`), wrong for a live-set "have I already
played this tonight" glance. **Gating on `deck.volume`** (the one field both the
crossfader `setCrossfader()` and the per-deck fader in `DeckCard.svelte` write to) is
the best available proxy for "actually in the main mix" — there's no lower-level
GStreamer output-tee instrumentation to observe this more precisely. If a future
feature needs the same "really audible" signal, reuse this heuristic rather than
re-deriving it or reaching for the Rust side.

⚠️ **Testing a `session.subscribe()`-driven module like this (or `history.ts`) under
`vi.useFakeTimers()`**: a module-level `setInterval(...)` fallback (both files have
one, for a deck left sitting past a threshold with no other store change to re-trigger
the subscriber) registers against **real** timers the moment the module is first
imported — which happens before any test's `beforeEach` calls `vi.useFakeTimers()`.
Advancing the fake clock afterward does not fire it. Don't chase this by trying to
install fake timers earlier (ESM import evaluation order makes that unreachable from
a static import); instead drive the subscriber directly with a harmless no-op
`updateDeck(deckId, {})` after advancing time — the subscriber recomputes on *every*
store tick regardless of whether anything actually changed, so this reliably
re-triggers the threshold check without depending on the interval at all. See
`playedTracks.test.ts`'s `tick()` helper for the pattern.

## Queue panel live updates

`DiggerQueue.svelte` opens once via `subscribeQueueChanges()` (`src/lib/digger/api.ts`) on mount
and refetches the queue on every `queue_changed` event — no polling. Reconnects with a fixed 3s
backoff if the socket drops (e.g. Digger restarts). Resubscribes if the user changes the Digger
base URL in settings. In dev, the `/digger-api` Vite proxy needs `ws: true` (set in
`vite.config.ts`) for the WebSocket upgrade to pass through alongside the existing REST proxying.

**Queue panel is shown by default**: `showDiggerQueue` in `App.svelte` defaults to `true` — the
queue is a primary workflow surface, not an opt-in panel. The main window width was bumped from
1280 to 1600 (`src-tauri/tauri.conf.json`) so decks aren't squeezed by the now-default-visible
sidebar.

## What cuemark owns

- Current play queue — ordered list of upcoming loads; may be populated from Digger or manually
- Session playback history [done, 2026-07-26; Digger reporting added 2026-08-12] —
  `src/lib/state/history.ts` + `HistoryPanel.svelte`; derived from the `session` store rather than
  instrumenting every play/pause call site. Title/artist come from `setPendingTrackMeta()` (called
  by `loadToDeck()` before the new source lands) since `Deck` itself has no title/artist fields;
  local-file loads fall back to the filename. Same store now also reports into Digger's `plays`
  API — see "Session/play history reporting" above.
- Runtime cue/hot-cue state; persisting them across sessions = push back to Digger markers API.
  `pushMarker(trackId, positionMs, type)` is called for `'cue'` (DeckCard SET button), `'hot_cue'`
  (DeckCard hot cue buttons), and `'downbeat'` (SET BEAT) — all best-effort/fire-and-forget, all
  gated on `deck.diggerTrackId !== null`.

## Boundary rules

- Cuemark calls Digger; Digger never calls cuemark
- Graceful degradation: if Digger is unreachable, drag-and-drop and manual load still work
- No embedded file browser in cuemark
