# Queue prefetch and local media cache management

**Status (2026-08-30): RESOLVED — closed with a negative result; phase 2/3 will not be built** (see
below for why). Phase 1 + 1b built and live-verified (`[media_cache]`/`[audio_load]`/
`[queue-load]` lines all firing correctly, both bug fixes and the waveform-cache lane in place).
**The phase-1 gate has been read, and it says stop.** Real-set log data (7 cold loads +
1 clean cold/warm reload A/B of the same file, 2026-08-30) shows `preroll` at 70–94% of
`total` on every cold load, `cache` (the network/local-copy leg this feature would optimize)
at only 6–30%. The one reload comparison available (Krust track, cold 3326.9ms → warm
1535.3ms) looks superficially like the "network dominates" prediction, but the arithmetic
doesn't support that: `cache` collapsed from 681.7ms→0.6ms (saving 681ms), yet `total` dropped
by 1791.6ms — the other ~1110ms came from `preroll` *itself* getting faster on the warm re-read
(2645.2ms→1534.7ms), which media_cache's hit/miss state does not control (most likely OS
page-cache warmth on the now-resident local file, not anything this feature's Rust worker would
change). `getCuemarkPayload` is negligible everywhere (7–28ms) — rules out the payload-batching
branch too. **Conclusion: this is prediction #2 from §1 below, not #1.** Phase 2 (the prefetch
worker, eviction, Settings UI) is **not being built** on this doc's current scope — building it
would buy back only the `cache` leg, a few hundred ms out of multi-second totals, not the
complaint that motivated this doc. The real lever is `preroll` — `uridecodebin` setup — which
this doc explicitly named as the redirect target and never designed for. See the raw numbers
and full reasoning in `skills/perf-log-reading/SKILL.md`'s `[media_cache]`/`[audio_load]`
section. If preroll-path work starts, it deserves its own design doc, not a phase 2 rewrite of
this one — the "warm this list of paths" prefetch primitive built here still stands and is
correct as far as it goes; it's just answering a question that turned out not to be the
dominant cost. **That doc now exists: `docs/design/preroll-latency.md`** (drafted 2026-08-30) —
it splits the `preroll=` bucket itself into teardown/PCM-decode/build/GStreamer-preroll, since
reading `pipeline.rs`'s `load()` showed that number already conflates a synchronous full-file
scratch PCM decode with actual GStreamer negotiation, and nobody had separated the two. The
other half of the original todo.md complaint (button-to-audio gap on an already-loaded deck) has
its own exploration doc too: `docs/design/button-to-audio-latency.md`. Original design intent
below, unedited except for this status block and §10.

**Status (2026-08-29, original):** design only, nothing built. Phase 1 (measurement) is the gate on everything else.
**Date:** 2026-08-29 (§4, the waveform-cache prefetch lane, added same day — Digger's own
waveform-cache work is in active development in a parallel session as of this writing)
**Origin:** todo.md, "Load-time / button-to-audio latency during live mixing" — first
multi-listener session; track load into cuemark felt slow, and there was a
perceptible gap between pressing a button and hearing the effect. Neither has been measured.
Proposal from the same conversation: pre-cache the whole queue to local disk ahead of time,
per DJ, with a max-cache-size setting and a usage display — extended to also cover Digger's
precomputed waveform data as a second, much lighter prefetch lane (§4).
**Read first:** `src-tauri/src/media_cache.rs` (the whole mechanism the media-file lane builds
on), `src/components/WaveformCanvas.svelte` + `src/lib/digger/api.ts`'s `getWaveformCache()`
(what the waveform lane builds on), `docs/design/offline-crate.md` in the digger repo
("Rejected alternative: streaming as the primary load path", and the 2026-08-01 update that
added the fetch-once fallback).

---

## 1. Do not build this before measuring. Build the measurement first.

The todo entry is explicit that nobody has checked which side the latency is on, and this
design will not pretend otherwise. Prefetching warms bytes onto local disk. That pays off
**only if reading the bytes is the dominant term** in "press LOAD → track is ready". If the
dominant term is GStreamer preroll, the full-file PCM decode, `audio_analyze_file`'s waveform
pass, or WebCodecs demux, then a perfectly warm cache changes nothing and the feature is
elaborate theatre.

This repo already has the rule for this situation, from `CLAUDE.md` and the `audio-debugging`
skill: **an instrument that cannot vary with the fault carries no information about it** — when
every instrument reads healthy and the user still reports the fault, the first move is to ask
which instrument *would* read differently if the hypothesis were true, and if none exists,
build that instrument before building anything else. There is no such instrument here today.
`ensure_cached()` logs `[media_cache] cached …` only on an actual copy and is completely silent
on a hit, so the log cannot currently distinguish "8s of SMB read" from "8s of preroll" — the
two hypotheses are indistinguishable in every signal the app emits.

Note also that the complaint is **two** complaints, and prefetch can only address one of them.
"Perceptible gap between pressing a button and hearing the effect" is output latency /
IPC / pipeline-response, not file residency — a warm cache cannot make a play or EQ button
respond faster. That half belongs to `[poll-stats]`/`[deliver-tel]` (see the `perf-log-reading`
skill) and should not be folded into this work or credited to it.

### What to add, concretely

Three timing lines, all cheap, all in the house style (per-event, not threshold-gated). Loads
happen a few times per minute at most, so unconditional logging costs nothing.

1. **`ensure_cached()`, one line on every call, including hits.** `Instant::now()` at entry;
   emit on every return path with the branch taken and the byte count:

   ```
   [media_cache] hit   path=… ms=0.4
   [media_cache] copy  path=… bytes=536870912 ms=6180
   [media_cache] fetch path=… bytes=536870912 ms=9020 url=…
   ```

   The `hit` line is the important one and the one that does not exist today. It is what makes
   a warm load distinguishable from a cold one in a log dump.

2. **`audio_load()`, one line per load, splitting the phases.** The blocking closure already
   has natural boundaries: `ensure_cached` → mutex acquire → `pipeline.load()` (preroll).

   ```
   [audio_load] deck-0 total=8420 cache=6180 lock=3 preroll=2210
   ```

3. **Frontend, `loadQueueItemToDeck()`.** The very first thing that function does is
   `await getCuemarkPayload(item.track_id)` — a Digger HTTP round trip that runs *before* any
   Rust code is entered, and which does an on-disk exists-check walk over candidate files
   server-side. It is inside the user's perception of "load time" and is currently untimed.
   Log it, plus the interval from `updateDeck()` to the `audio_load` promise resolving.

Add nothing else in phase 1. Then run one set and read the log.

### The falsifiable prediction

If the network read dominates, then **the second load of the same track in a session must be
dramatically faster than the first** — the first is a `copy`/`fetch` line of multiple seconds,
the second is a `hit` line of sub-millisecond, and `total` should collapse by roughly the same
amount. That is a free A/B available on the very first night, requiring no new machinery beyond
the log lines above. Predictions:

- **`cache` is most of `total` on the first load, and `total` drops hard on the reload** →
  the hypothesis holds, prefetch is the right fix, proceed to phase 2.
- **`preroll` (or the frontend's waveform/demux legs) is most of `total`, and reload is barely
  faster** → prefetch cannot fix the complaint. Stop. The effort belongs in the preroll path
  (`uridecodebin` setup, the `AnalysisCache`, Digger's `waveform_cache` reuse via
  `getWaveformCache`, which already exists and already skips a decode) instead.
- **`getCuemarkPayload` is a large fraction** → the fix is a batched/prewarmed payload, not
  file prefetch. Cheap and worth knowing either way.

A useful adjunct measurement, one command, no code: time a plain `cp` of a ~500MB file from
`/media/memory/…` to local disk, cold, and compare to the same file re-read warm. That
establishes the ceiling on what prefetch can possibly buy — if the SMB link delivers 110 MB/s
and the reported "slow" load is 8 seconds on a 200MB track, most of those 8 seconds are not
the network.

**Phase 1 is worth shipping even if phase 2 is then cancelled.** The instrument stays useful
forever, and it is the only way this question ever gets settled instead of re-argued.

---

## 2. Relationship to `offline-crate.md` (digger repo)

**Complementary, not a replacement, and not a resurrection.** They share a mechanism and share
almost nothing else.

| | offline-crate | queue prefetch |
|---|---|---|
| Problem | zero network, arbitrary catalog subset, edits made away must merge back | slow network, *connected*, next few tracks must load instantly |
| Needs a DB copy | yes, the whole point | no |
| Needs metadata sync-back | yes (`change_log`, `sync_back.py`) | **no** — cuemark is not editing Digger's catalog offline; it is talking to a live Digger the whole time |
| Needs browse/search offline | yes | no |
| Selection of files | explicit, human-curated crate | implicit, whatever is in the queue right now |
| Mechanism | `pack_crate.py` rsync + canonical mount point | `MediaCache::ensure_cached()` |

The recommendation is: **do not touch `DIGGER_MODE=travel`, `change_log`, or `sync_back.py` as
part of this work.** That machinery exists to make edits survive a round trip with no network.
Nothing in the load-latency complaint requires it, and pulling it in would multiply the scope of
a feature whose payoff has not even been confirmed yet (§1).

But this is not orthogonal work either, and that matters for how it should be built. The pieces
this design adds — a background warming worker keyed on a list of paths, on-disk size
accounting, a cap, a pinned set that eviction must respect — are precisely the client half of
offline-crate's phase 1 ("nearly free: sparse-mirror script … offline read-only"). If
offline-crate is ever picked back up, "pack this crate" on the cuemark side becomes
`media_cache_prefetch(<crate file list>)` with the entries marked pinned, and the eviction
policy already knows not to touch pinned entries. So:

- **Build the prefetch primitive as "warm this ordered list of paths", not as "warm the queue".**
  The queue is one caller. A crate would be another. Keep the Rust API in those terms.
- **Introduce `pinned` as a first-class concept now** (§7), even though phase 2 only ever pins
  deck-loaded files. It is the seam that makes a crate expressible later.

One thing offline-crate settled that this design inherits rather than re-litigates: **streaming
is not the load path.** The 2026-08-01 update to that doc records the conclusion — waveform
analysis needs the whole file anyway, `grids.json` identity is path-keyed, and a Wi-Fi hiccup
mid-set becoming an audio dropout is unacceptable. Prefetch is the same conclusion pushed one
step earlier in time: if the file has to be local anyway, make it local *before* the DJ asks
rather than while they wait.

---

## 3. What "each configured DJ" can actually mean

There is no server-side registry of DJs. There is:

- `queue_items.owner` in Digger — free text, `NULL` = unclaimed, matched `COLLATE NOCASE`
  (`routers/queue.py`, every statement).
- `cuemark:diggerDj` — the current selection, one string, `""` = unclaimed
  (`src/lib/digger/djSelector.ts`).
- `cuemark:diggerDjHistory` — a client-side MRU of up to 5 names, per install.

No `SELECT DISTINCT owner` is exposed anywhere.

### Why the obvious new endpoint is the wrong default

`GET /queue/owners` is a two-line endpoint and superficially the right answer. It is not,
because of a decision already made deliberately on the Digger side. `guest-djs.md`, "Decided
(2026-08-23)", item 1: *"A guest's queue persists indefinitely and is never auto-pruned …
Nothing cleans up owners who stop DJing."* So `SELECT DISTINCT owner FROM queue_items` returns
**everyone who has ever DJ'd here, forever**, each with a stale multi-track queue attached.
Prefetching "all owners" would, six months in, mean warming a dozen abandoned queues from past
parties — tens of GB of files nobody is going to play, competing for the same NAS bandwidth as
tonight's actual set. The endpoint is cheap; what it returns is not a list of *tonight's* DJs.

### Recommendation

**Phase 2: the currently selected DJ's queue only. No new Digger endpoint.**

`getQueue(currentDjOrNull($currentDj))` — the exact call `DiggerQueue.svelte` already makes.
This is the queue whose next entry is the one about to be loaded, by hand or by Auto DJ, and it
is where essentially all of the value is. It requires no cross-repo change, so this feature does
not block on the digger repo's own process.

**Phase 4 (only if the handoff case is actually felt): the local MRU, head-only.** When
prefetching more than one owner is wanted, drive it from `getDjHistory()` — up to 5 names,
already bounded, already scoped to *the people who have typed their name at these decks*, which
is a far better proxy for "who is DJing tonight" than a server-wide distinct-owner list, and
costs 5 existing `GET /queue?owner=` calls. Take only the **first 3 unplayed entries** of each
non-current owner's queue: the value of another DJ's queue is entirely concentrated at the
handoff moment, and only the head matters then. The current DJ's queue is warmed in full first;
other owners' heads are strictly lower priority and never displace it.

**Cross-repo note.** `GET /queue/owners` is a *digger* change and must go through that repo's own
todo/design process, not this doc. If it is ever added, it should return owners ordered by
`MAX(added_at)` with a recency cut (e.g. active in the last 7 days) rather than a bare
`SELECT DISTINCT`, for the staleness reason above — otherwise cuemark would need to apply that
filter client-side anyway and the endpoint saves nothing. Recommendation: **don't add it yet.**
The MRU covers the real case without a protocol change.

### The payload problem

`GET /queue` returns queue-entry metadata only — `track_id`, `title`, `artist`, `bpm`, … — and
**not** `filePath` or `fileId`. Those come from `GET /tracks/{id}/cuemark`, one call per track,
which today happens lazily inside `loadQueueItemToDeck`. So prefetching a 30-entry queue needs
30 additional Digger round trips before a single byte can be copied.

Rules:

- **Digger HTTP stays in `src/lib/digger/`.** Do not teach `media_cache.rs` to call
  `/tracks/{id}/cuemark`; the boundary in the `digger-integration` skill is that the Rust side
  knows about a path and an opaque fallback URL, nothing more. The frontend resolves payloads.
- **Resolve lazily, in prefetch order, not as an up-front burst.** The frontend prefetch
  controller walks the ordered list one entry at a time, `await`ing each `getCuemarkPayload`,
  and calls `media_cache_prefetch(entriesSoFar)` after each resolution. Because that command
  replaces the pending list wholesale (§6), calling it repeatedly with a growing list is
  naturally idempotent, lets the Rust worker start copying entry 1 while entry 7 is still being
  resolved, and means a superseded list costs at most one wasted round trip.
- **Memoize `filePath`/`fileId` per `track_id` for the session, and use that memo *only* for
  prefetch.** `loadQueueItemToDeck` keeps making its own fresh call: bpm, hot cues, `mixOut`
  and gain can be edited in Digger between prefetch and load and must not be served stale. The
  file path is what is stable enough to memoize.
- `filePath: null` (Digger's exists-check found nothing on disk) → skip silently. Not an error,
  not a toast.

---

## 4. Piggybacking the waveform cache

Digger already computes and stores exactly the datapoint needed to skip cuemark's local
waveform decode — `waveform_cache` (peaks 30/s + envelope 210/s + duration), served by
`GET /tracks/{id}/waveform` and consumed by `WaveformCanvas.svelte`'s `getWaveformCache()`.
This is worth prefetching into the local queue cache for the same reason as the media file:
it's a network round trip cuemark currently pays *at load time*, on the critical path, in a
`$effect` that races `audio_load` for the same track (the digger-integration skill documents
this exact race, and a live 2026-08-01 hit where the waveform fetch lost it). Unlike the media
file, though, it should not go through `media_cache.rs`/the Rust worker at all — different
consumer, different scale, different failure mode, and folding it in would cost more than it
saves.

### Why this is a separate, much simpler lane

- **Nothing in Rust ever reads this data.** It exists purely to feed
  `WaveformCanvas.svelte`'s canvas draw and `detectBeatGrid()`'s comb fit, both browser-side.
  Routing it through Tauri IPC and a Rust-side cache dir would mean serializing a Float32Array
  pair across the IPC boundary for no reason — the digger-integration skill's rule that "Digger
  HTTP stays in `src/lib/digger/`" already puts the natural cache boundary in the same place.
- **It's tiny.** 30/s + 210/s at 4 bytes/sample is ~173KB for a 3-minute track, ~350KB for 6
  minutes. A 50-track queue is 10-17MB total — two to three orders of magnitude below the media
  cache's multi-GB scale. None of §7's cap/eviction/free-space-floor machinery is worth building
  for this; it doesn't need it.
- **It doesn't compete for bandwidth the way a media file does.** §5's single-background-copy
  rule exists because one large file saturates the one NAS link long enough to matter. A few
  hundred KB does not — fetching several of these in the background while a deck is loading is
  not a contention risk worth guarding against. This lane can just fire off requests as the
  queue resolves, no gating needed.

### Storage: IndexedDB, not `media_cache.rs`

A new small module, `src/lib/digger/waveformCache.ts`, backed by one IndexedDB object store
(`track_id` → `{ peaks: ArrayBuffer, envelope: ArrayBuffer, durationS, updatedAt, cachedAt }`).
`getWaveformCache()` in `api.ts` stays a pure network call, unmodified; this new module wraps
it: check IndexedDB first, serve from there on a hit, otherwise call `api.ts`'s function, store
the result (fire-and-forget), and return it. `WaveformCanvas.svelte` switches its import to
this wrapper; the prefetch controller (§5) calls the same wrapper, in the same queue-position
order, right after resolving each track's `getCuemarkPayload` — the two calls can run
concurrently per track, since they hit different endpoints and neither blocks the other.

Every IndexedDB call wrapped in try/catch with a silent fall-through to the network path, same
convention this codebase already applies to every `localStorage` access (`persistentWritable`,
`setDiggerBaseUrl`, etc.) — a private-browsing quota block or a blocked IndexedDB origin must
degrade to "no local cache," never to a thrown error in the load path.

### The staleness problem, and why it needs a small Digger-side change

Caching this forever is unsafe, and the risk is live right now, not hypothetical: beat-grid
analysis on the Digger side is under active development in a parallel session as of this
writing — a re-analysis changing `bpm`/`beat_anchor_ms`/the peaks themselves is exactly the
kind of event this cache needs to detect and invalidate on, not silently serve past.
`waveform_cache` already has an `updated_at` column (`db.py`) that the
`/tracks/{id}/waveform` response doesn't currently expose — only `X-Duration-Seconds` rides
along today.

**Recommend adding `X-Updated-At` to that response** (a few lines: include `updated_at` in the
existing `SELECT`, add the header) — this is a *digger*-repo change, small enough to fold into
whatever waveform-cache work is already in flight there. With it, `waveformCache.ts` treats a
cached entry as valid only while its stored `updatedAt` matches; a mismatch triggers a re-fetch
and overwrite, using the same trust model `media_cache.rs` already uses for the media file (its
cache key embeds file size for exactly this reason — detect a changed source, don't trust a key
on identity alone).

Without that header, the honest fallback is a short TTL (e.g. 24h) on every cached entry, which
bounds the staleness window without eliminating it — worth calling out as a real tradeoff if the
header isn't added before this ships, not something to silently accept.

**One existing check needs to travel with the cache, not just the fetch.**
`WaveformCanvas.svelte` already refuses to trust a result whose duration lands within 1s of
`DIGGER_ANALYSIS_CAP_S` (600s) — that's librosa's 10-minute analysis cap, not a real waveform,
and today it falls through to a local decode instead. A cached entry must carry the same
rejection: don't cache a capped result as if it were valid forever, since Digger might later
re-analyze the same track without the cap and produce a real one — the same `updatedAt` check
above only closes this hole if a genuine re-analysis actually bumps `updated_at`; confirm that
it does before relying on it for this case specifically (see "Open decisions" below).

### What this buys, independent of §1's gate

This lane doesn't need to wait on the media-file prefetch's measure-first gate. The two
mechanisms address different cost buckets: §1 asks whether the SMB read is the bottleneck; this
asks whether the *fallback full local decode* (`analyzeFile()`, a real Rust-side PCM decode of
the whole file — `audio-debugging` territory, not `media_cache`'s) is ever the reason a load
feels slow. If `getWaveformCache()` is losing its race against `audio_load`, or 404ing more
often than expected (both documented, live-hit failure modes in the digger-integration skill),
prefetching the same data ahead of time removes that cost regardless of what §1's measurement
finds about the network. It's cheap enough, and safe enough with the staleness fix above, to
build without gating it on that result — see the Phasing section (§10).

---

## 5. Triggers, ordering, and the contention problem

The waveform-cache lane (§4) reuses these same triggers and the queue-position/unplayed
ordering below unmodified — it has no separate trigger logic of its own, it just piggybacks on
whatever list this section produces.

### Triggers

| Event | Action |
|---|---|
| `queue_changed` WS message | recompute list, debounced 750ms |
| `currentDj` store change | recompute immediately |
| App start, after the first successful queue fetch | recompute |
| `setDiggerBaseUrl()` | recompute — which Digger is authoritative just changed |
| WS reconnect | recompute — events during the outage were missed |
| Timer / polling | **no** |

⚠️ **The prefetch controller must not live in `DiggerQueue.svelte`.** `subscribeQueueChanges` is
today called from exactly one place — `DiggerQueue.svelte` — and that component is mounted
behind `{#if $showDiggerQueue}`. A prefetcher hung off it would silently stop the moment a DJ
closes the sidebar, which is normal mid-set behaviour. `autoDj.ts` already documents this exact
trap and works around it by fetching the queue directly. Put the controller in its own module
(`src/lib/digger/queuePrefetch.ts`) with its own `subscribeQueueChanges` subscription, started
once from `App.svelte`, and leave `DiggerQueue.svelte`'s subscription alone.

The 750ms debounce matters: adding ten tracks to a queue in Digger's UI fires ten
`queue_changed` events, and each recompute costs a `GET /queue` plus payload resolutions.

`subscribeQueueChanges` has no reconnect callback today; adding an optional `onReconnect` (fired
from the `connect()` retry path) is a four-line change and closes the missed-events window for
both callers.

### Ordering

**Queue position order, filtered to entries that are neither played nor skipped**
(`playedTracks.ts`'s `isPlayed`/`isSkipped`). This is not merely "the obvious order" — it is
*exactly* the order `autoDj.ts`'s `pickNextTrack()` will consume, per the `digger-integration`
skill's rule ("the next *unplayed* entry after its position in `GET /queue`"). Prefetching in
any other order would warm files Auto DJ is not going to reach.

The played/skipped filter is load-bearing, not an optimisation. Queue entries are **never
auto-deleted** — both `guest-djs.md` Decided #1 and the cuemark-side convention that the queue
should read as a set list rather than shrink as a work stack. Without the filter, by the end of
a four-hour night the prefetch list is the entire night's history plus the remaining three
tracks, and the worker spends its bandwidth re-warming things that already played. Played
entries are already cached (they played from the cache), so dropping them from the list costs
nothing and they are the *first* thing the evictor should be willing to release.

Per-owner priority, when phase 4 lands: current DJ's full unplayed list, then other owners'
first-3-unplayed each in MRU recency order. Never interleave — the current DJ's tail is more
likely to be played than another DJ's head.

### Contention: the single largest risk in this feature

Everything reads over **one SMB mount from one NAS**. Two concurrent full-file copies do not
finish sooner than two sequential ones; they finish *later, both*. A 1.4 GB video (there are two
in the cache right now) is ~13 s at gigabit wire speed and considerably worse on Wi-Fi. So a
naive "kick off prefetch of the whole queue in parallel" implementation makes foreground load
latency **worse**, and does so precisely at the moment it matters most — the queue is edited
right before and during a set, which is exactly when a DJ is also loading tracks.

Mitigations, in order of importance:

1. **Exactly one background copy at a time.** Non-negotiable. There is no throughput to win from
   parallelism against a single network mount; there is only latency to lose.

2. **Foreground demand always wins, at file granularity.** A `foreground: AtomicUsize` on
   `MediaCache`, incremented around every `ensure_cached()` call made on behalf of a real load
   (`audio_load`, `audio_analyze_file`, `video_demux_load` — a thin
   `ensure_cached_foreground()` wrapper, so the call sites read honestly). The worker checks it
   before starting each file and blocks on a condvar while non-zero, plus a 2 s grace period
   after it drops to zero.

3. **Foreground demand wins *during* a copy, too — chunked and pausable.** File-granularity
   gating alone leaves a hole: if a 1.4 GB prefetch is 3 s into `fs::copy` when the DJ hits
   LOAD, the foreground read contends with it for the next 10 s. That is the failure this whole
   feature exists to prevent, reintroduced by its own implementation. Fix: **in the prefetch
   path only**, replace `fs::copy` with an 8 MB-chunk read/write loop that checks the pause flag
   between chunks. At ~110 MB/s, 8 MB is ~70 ms of unavoidable overlap — well under perception.
   The foreground path keeps `fs::copy` (potentially `copy_file_range`, and it has no reason to
   ever yield).

4. **Pause must resume, not restart.** With loads every ~3 minutes and a 13 s copy, restart-from-
   zero can leave a large file permanently unfinished. Resume is nearly free here and, crucially,
   is *already safe under the existing cache-key design*: the `.part` filename embeds the source
   size (`{hash}-{size}.{ext}.part`), so a source file that changed size gets a different `.part`
   path and cannot be resumed into. The only hole — a changed source at byte-identical size — is
   the exact hole `ensure_cached()`'s cache key already documents and accepts. So: on resume,
   `metadata(src).len()` must match the size in the `.part` name; seek the source to the
   `.part`'s current length and append.

5. **Do not bother with I/O priority.** `ionice`/`IOPRIO_SET` affects the local block-layer
   queue, which is not the bottleneck — the network link and the SMB client are. It is also
   Linux-only and would not survive a future Mac/Windows build. Skip it.

6. **Do not gate prefetch on "a deck is playing".** A set is continuous playback; that gate
   would disable the feature entirely. The gate is on *load demand*, not on playback.

**Deadlock, must be handled explicitly.** If the DJ loads the very file the worker is currently
mid-copy on: the foreground caller finds `CacheEntry::InProgress` and waits on the condvar
(correct — this is the existing coalescing behaviour and it is exactly what we want), while the
worker sees `foreground > 0` and pauses waiting for foreground to finish. Both block forever.
Fix: when a foreground caller lands on an `InProgress` entry, it sets a `promoted: bool` on the
worker's current job (or a `promoted_path: Option<String>` on the cache) before waiting; the
worker's pause check is `foreground > 0 && !promoted`. A promoted file runs to completion at
full speed, which is the right answer anyway — it *is* the foreground load now.

**Acceptance check for this section** (the one that actually matters): start a prefetch of a
1.4 GB file, then play a deck, and confirm `[deliver-tel]`'s `min` and `drop` fields stay clean
throughout (`perf-log-reading` skill — read `min`, not the mean). A background copy that costs
an audio dropout is worse than the latency it was built to remove; `docs/design/audio-dropout-
mid-playback.md` is the standing evidence that this class of fault is real here.

---

## 6. Rust-side architecture

`MediaCache` grows; nothing else moves. The existing `resolved: Mutex<HashMap<String,
CacheEntry>>` + `Condvar` stays exactly as it is and does the coalescing work for free — a
prefetch and a real load of the same path already meet on the same `InProgress` entry, which is
the single most valuable property of the current design and the reason this is a small feature
rather than a large one.

```
pub struct MediaCache {
    dir: PathBuf,
    resolved: Mutex<HashMap<String, CacheEntry>>,   // unchanged
    cond: Condvar,                                   // unchanged

    // new
    pending: Mutex<Vec<PrefetchEntry>>,   // the ordered list; replaced wholesale
    pending_cv: Condvar,                  // wakes the worker on a new list
    foreground: AtomicUsize,              // live foreground ensure_cached() calls
    fg_cv: Condvar,                       // wakes the worker when foreground drains
    current: Mutex<Option<CurrentJob>>,   // { path, promoted, cancel }
    max_bytes: AtomicU64,                 // 0 = unlimited (§7)
    usage: Mutex<UsageIndex>,             // total bytes + per-file last-use
}

pub struct PrefetchEntry { pub path: String, pub fallback_url: Option<String> }
```

One dedicated OS thread, spawned from `lib.rs`'s `setup()` next to the existing
`media_server::start(...)` line, not `spawn_blocking` per call. `spawn_blocking` has no
queueing, no ordering, no cancellation and no priority — every one of which this feature needs.

Worker loop:

```
loop {
    wait until pending is non-empty
    wait while foreground > 0 (+2s grace), unless promoted
    take the head entry (leave it in the list until done, so a
        supersede that still contains it doesn't restart it)
    if cap would be exceeded → log once, drop the rest of the list, sleep
    ensure_cached_background(path, fallback_url)   // chunked, pausable, cancellable
    remove from pending; record usage
}
```

`ensure_cached_background()` shares all of `ensure_cached()`'s structure — the `InProgress`
insert, the `.part`-then-rename, the size-in-key, the remote fallback, the `Content-Length`
verification — and differs only in using the chunked copy loop and consulting the pause/cancel
flags between chunks. Factor the common body rather than forking it; the truncated-fetch
incident of 2026-08-28 is exactly the kind of thing that gets fixed in one copy of a duplicated
function and not the other.

**Supersede semantics.** `media_cache_prefetch(entries)` replaces `pending` wholesale under the
mutex and notifies. Strict adherence to a list that is already outdated has no value — only
*what is next* matters — so there is no merge logic, no diffing, no per-entry cancellation
protocol. One rule: if the in-flight file is no longer present anywhere in the new list, set its
cancel flag; the worker stops at the next chunk boundary and **leaves the `.part` in place**, so
if it returns to the list later it resumes rather than restarts.

**New Tauri commands** (registered in `lib.rs`'s `invoke_handler!`):

| Command | Shape | Called from |
|---|---|---|
| `media_cache_prefetch` | `(entries: Vec<PrefetchEntry>)` → `()` | `queuePrefetch.ts`, on every trigger in §5 |
| `media_cache_stats` | `()` → `{ bytes, files, max_bytes, free_bytes, pending, in_flight: Option<String> }` | the Settings storage section |
| `media_cache_set_max_bytes` | `(bytes: u64)` → `()` | at startup and on setting change |
| `media_cache_clear` | `()` → `{ removed, bytes_freed, skipped_pinned }` | the Clear button |

`media_cache_prefetch` is fire-and-forget and returns immediately; it must never block the IPC
thread (see `audio_load`'s doc comment on the freeze-watchdog incident that made every
potentially-blocking command async).

**Pinning is derived in Rust, not sent from the frontend.** `DeckAudioPipeline` already carries
`pub(super) file_path: Option<String>` (pipeline.rs:2147), and `audio_load` passes it the
*cached* path. So the authoritative "files currently loaded on a deck" set is
`mgr.pipelines.values().filter_map(|p| p.file_path.clone())`, needing only a small getter on
`AudioManager`. That is strictly better than a frontend-maintained pin list, which can drift
whenever a code path forgets to update it. The evictor should be a free function taking
`pinned: &HashSet<String>` explicitly, and the command in `lib.rs` (which has both `AudioState`
and `Arc<MediaCache>` in scope) assembles it — so `media_cache.rs` gains no dependency on the
audio module.

---

## 7. Size accounting, the cap, eviction, and Settings

### Accounting

- **On the stats command, rescan.** One `read_dir` + `metadata` walk of the cache dir, throttled
  to at most once per 5 s. Today that is 53 files; even 5,000 is microseconds on local disk, and
  the Settings panel is not a hot path. This deliberately eliminates the entire class of
  "incremental counter drifted from reality" bugs. The in-memory total is a hint for the
  evictor, not the source of truth.
- **Exclude `.part` and `.download` from the *usable* file count, but count their bytes toward
  disk usage.** They occupy space and must be visible in the total, but they are not cache hits.
- **Delete orphaned `.part`/`.download` files at startup.** Nothing is in flight at process
  start by definition, so any that exist are debris from a kill or a failed copy.
- **This accounting is media-file-only.** The waveform-cache lane (§4) is IndexedDB-backed,
  two to three orders of magnitude smaller, and deliberately outside this cap/eviction
  machinery — see §4 for why it doesn't need it. The Storage tab (below) shows its usage as a
  separate, much smaller number, not folded into the media-file total.

### Two existing bugs this section surfaces

Both are worth fixing in phase 1 regardless of whether phase 2 ever ships.

1. **A failed local copy leaks its `.part` forever.** In `ensure_cached()`'s local-stat branch,
   `fs::copy(src, &tmp_path).map_err(…)?` returns without removing `tmp_path`. The remote branch
   *does* clean up on a truncated fetch; the local branch does not clean up on any failure. The
   leaked file is invisible (no lookup path matches `.mp4.part`) and counts against disk usage
   forever. Add the `remove_file` on the error path.

2. **`ensure_cached()`'s `Ready` branch does not re-check `is_file()`.** `lookup()` does
   (`Path::new(p).is_file().then(…)`), `ensure_cached()` does not — it returns `Ok(p.clone())`
   straight from the map. Today nothing ever deletes from the cache dir, so the gap is
   unreachable. **Introducing eviction makes it reachable**, and the consequence is handing
   GStreamer a path that no longer exists mid-set. Two defences, take both: the evictor removes
   the `resolved` entry under the same lock as the file removal, *and* the `Ready` branch gains
   the same `is_file()` re-check `lookup()` already has, falling through to a re-copy on a miss.

### The cap

- **Unit: GB, decimal**, stored as bytes in Rust. GB is what the user will type and what disks
  are labelled with.
- **`0` means unlimited.** Chosen over `null`: it keeps the command signature `u64` instead of
  `Option<u64>`, keeps the Svelte input out of an empty-string/null tri-state, and "a 0 GB media
  cache" is not a configuration anyone could mean, so the sentinel cannot collide with intent.
- **Default: `0`, unlimited** — matching the ask directly.
- **But a free-space floor is always enforced, cap or no cap: never let the cache drive free
  space on its filesystem below 10 GB.** This is a safety rail, not a user setting, and it is
  the piece the "no real limit unless space becomes a concern" framing is missing. The cache is
  already 6.2 GB across 53 files (average ~120 MB, largest 1.46 GB) with a *manually* driven
  growth rate; a background prefetcher walking multi-owner queues changes that growth rate by an
  order of magnitude. A full root partition on a live-performance machine is a far worse failure
  than a stalled prefetch, and it fails in ways that have nothing to do with cuemark. The floor
  is checked before starting each background copy, against the *source file's size*, and never
  applies to a foreground load.

### Eviction

**Policy: least-recently-used, by last *use*, not last *write*.** Write time is copy time and
says nothing about what a DJ keeps reaching for.

Sourcing last-use, in order of authority:

1. **A `usage.json` sidecar in the cache dir** — cached filename → last-use epoch, updated
   in-memory on every `Ready` hit in `lookup`/`lookup_wait`/`ensure_cached`, flushed debounced
   (every ~30 s, and on exit). It is a hint, not a correctness structure: losing it costs a worse
   eviction decision, never a bug.
2. **`atime`, for files cached before the sidecar existed.** Verified on this machine: root is
   `relatime`, and a cache file's atime reads meaningfully after its mtime, so reads *are* being
   recorded at roughly day granularity. Good enough to bootstrap. Not trustworthy in general
   (`noatime` mounts; different semantics on other platforms), which is why it is the fallback
   and not the mechanism.
3. **`mtime`**, last resort.

**Never evict:** anything in the pinned set (§6), anything `InProgress`, anything in the current
prefetch list. Note that on Linux, unlinking a file GStreamer already has open is survivable —
the inode lives until the handle closes — but that is not true for a `<video>` element
re-requesting through `media_server.rs`, and not true at all on Windows. Do not rely on it.

**When eviction runs — this is the important call, and the answer is "never during a set."**

- Evict at **app start**, before any deck is loaded. This is where essentially all reclamation
  should happen: nothing is pinned, nothing is playing, and a wrong decision costs one re-copy
  at the next load rather than a dead deck.
- Evict **opportunistically when idle** — no deck playing, no foreground load for ≥60 s. Rare
  mid-set; that is the point.
- **Never inline in `ensure_cached()`.** A foreground load must never be gated on freeing space.
- **When the cap would be exceeded mid-set, the prefetcher simply stops and logs.** It does not
  evict to make room. The foreground path ignores the cap entirely: a track the DJ actually asked
  for is always cached, cap or no cap.

Justification: this is live performance software, and the two failure modes are not symmetric.
Temporarily sitting 20% over a self-imposed size target is invisible to everyone. Evicting a
file two minutes before a DJ reaches for it turns an instant load into a cold network read at
the worst possible moment — the exact fault this feature exists to eliminate, caused by the
feature itself. Overshoot is bounded in practice anyway: mid-set, only foreground loads add to
the cache, which is a handful of GB per night at most.

This rule also disposes of the thrash case. A queue containing 40 GB of tracks against a 20 GB
cap fills to the cap **in queue order** and then stops. The head of the queue — what is actually
about to play — is warm; the tail is not. That is precisely the right degradation, and because
the prefetcher never evicts, there is no evict-then-immediately-refetch loop to fall into.

### Settings UI

`SettingsPanel.svelte` is already a tabbed panel (Audio / Controls / MIDI / Record today). So
the question is only which tab, and the answer is **a fifth tab, "Storage"**, in a new
`StorageSettings.svelte`. Reasons: it is neither audio nor controls; a cache-usage readout with
a Clear button in the middle of `AudioSettings.svelte`'s device list would be noise on a screen
someone opens mid-set to fix an output; and Storage is the natural home for anything else
disk-shaped later (recordings, `grids.json`, the analysis cache).

Contents:

- **Usage**: `6.2 GB across 53 files` + `166 GB free on this disk`, from `media_cache_stats`,
  plus a second, much smaller line for the waveform lane: `Waveforms: 18 MB across 61 tracks`,
  from a small `waveform_cache_stats()` helper in `waveformCache.ts` (an IndexedDB count/size
  scan — no Rust command needed, since nothing outside the browser ever reads this store).
  Refresh on mount and after Clear, not on a timer.
- **Prefetch on/off**, `cuemark:prefetchQueue`, default on once phase 2 ships. A kill switch
  matters here — if prefetch ever *is* the thing making a night worse, the DJ needs to turn it
  off without a rebuild, the same role other feature kill-switches play elsewhere in this app.
- **Max cache size (GB)**, `cuemark:mediaCacheMaxGb`, default `0`, labelled "0 = unlimited",
  pushed to Rust via `media_cache_set_max_bytes` on change and at startup.
- **Prefetch status**, one line: `warming 3 of 12 — Artist — Title`, from
  `media_cache_stats`'s `pending`/`in_flight`. Cheap, and it is the difference between "is this
  even doing anything" and a black box.
- **Clear cache** — `ask()` confirmation (same `@tauri-apps/plugin-dialog` pattern
  `loadQueueItemToDeck` uses for the deck-is-playing guard), then `media_cache_clear` **and**
  clearing the IndexedDB waveform store (both stores, one button — the waveform store has no
  pin concept and nothing to protect, so it just clears; only the media-file half needs the pin
  report below), then report honestly: `Cleared 5.9 GB media + 18 MB waveforms. 2 files loaded
  on decks were kept.`

**Yes, Clear has the same pin safety as auto-eviction, and it is not optional.** "Clear cache"
is a button someone presses while tidying up, plausibly with a track cued on deck B. It must
never be the thing that kills a live deck. Skipping pinned files and saying so is both safer and
more informative than a silent full wipe.

---

## 8. Failure modes — what is silent when this breaks

| Failure | Behaviour required |
|---|---|
| **NAS unreachable during background prefetch** | `fs::metadata` fails → remote fallback (30 s ureq timeout) → error → `resolved` entry removed (retry allowed later), exactly as today. `log::warn!` once per path per list generation, move to the next entry. **No toast** — the DJ can do nothing about it mid-set, and a foreground load will surface its own error at the moment it actually matters. |
| **NAS unreachable, repeatedly** | After 3 consecutive failures, back the whole worker off for 30 s. Otherwise an unreachable NAS produces N × 30 s of pointless timeouts and log noise. |
| **Disk full (ENOSPC) mid-prefetch** | The `.part`-then-atomic-rename pattern already guarantees no truncated file is ever trusted — that half is solved. What is new: delete the `.part` on error (see the existing leak, §7), `log::error!` once, and **stop the prefetch worker for the session**. Never panic, never propagate. The foreground path is untouched and still degrades correctly — `audio_load`'s `unwrap_or_else` already falls back to reading the original path on any cache failure. With the free-space floor in place ENOSPC should be unreachable; treat it as the backstop, not the primary defence. |
| **Queue far larger than the cap** | Prefetch stops at the cap in queue order. No eviction, no thrash. See §7. |
| **Evicted file still in `resolved` as `Ready`** | Would hand GStreamer a nonexistent path mid-set. Fixed by the two defences in §7 — this is the one *new* correctness hazard eviction introduces and it must not be skipped. |
| **Deadlock: foreground waits on `InProgress` while the worker waits for foreground** | Real and reachable. Fixed by the `promoted` flag (§5/§6). |
| **Track with `filePath: null`** | Skip silently. Digger's exists-check returning null is a normal answer, not a fault. |
| **Duplicate content under two paths** | Already happening: two 1.46GB files with different hash prefixes sit in the cache today. The key is (path, size), so the same media reachable at two paths caches twice. Not worth fixing — content-hashing a 1.4 GB file costs more than the duplicate storage — but budget ~1.2× naive size when sizing the cap. |
| **Two cuemark processes sharing one app data dir** | Out of scope. `usage.json` and the size index assume a single writer. Note it and move on; it has never happened. |
| **Prefetch silently doing nothing** | The most likely *silent* failure of the whole feature, and the reason the Settings panel shows `pending`/`in_flight` rather than only a byte total. Also log one summary line per list generation: `[prefetch] list owner=… n=12 (3 already cached, 1 no local file)`. |
| **Waveform cache serving a stale, re-analyzed grid** | The §4 lane's own failure mode, not the media cache's — see §4's "staleness problem" for the fix (`X-Updated-At` header) and the fallback (short TTL) if that header isn't added first. |

---

## 9. Non-goals for this iteration

- **No offline browse/search/playlist CRUD.** That is `offline-crate.md`'s job if it is ever
  resumed. This feature assumes Digger is reachable for the whole set.
- **No metadata sync-back**, no `change_log`, no `DIGGER_MODE=travel`. Nothing here edits
  Digger's catalog while disconnected, so none of that machinery is needed.
- **No cross-machine cache sync.** The cache is a local, disposable, rebuildable artifact. It
  never becomes a thing that has to be kept consistent with anything.
- **No speculative prefetch.** Only what is literally in a queue. No "similar tracks", no
  play-history prediction, no warming `GET /queue/next`'s weighted-random suggestion — that
  endpoint *consumes* on some paths and speculating against a random suggestion would burn
  bandwidth on a track that will probably never be chosen.
- **No streaming path.** Settled in `offline-crate.md` and not reopened here.
- **No fix for the button-to-audio latency half of the todo entry.** Different subsystem,
  different investigation (§1).
- **No cap/eviction machinery for the waveform-cache lane.** Deliberately out of scope at its
  current scale (§4, §7) — revisit only if the Storage tab ever shows it growing to a size that
  matters, which at ~200-350KB/track is not expected.

---

## 10. Phasing

**Outcome (2026-08-30): 1 and 1b shipped, gate read, 2/3/4 not proceeding on this doc's scope.**
See the Status block at the top. Phase 1's Storage tab (read-only usage/free-space display) was
not built — it stopped being worth prioritizing once the gate came back negative, though it
remains cheap and low-risk if wanted later purely as a "how big is this thing" readout.

**1 — Nearly free, and worth doing whether or not the rest ever ships.**
Timing instrumentation: `[media_cache]` line on every call including hits, `[audio_load]` phase
split, `getCuemarkPayload` timing in `loadQueueItemToDeck`. Plus the two standalone bug fixes
the design surfaced — `.part` cleanup on a failed local copy, and the `is_file()` re-check in
`ensure_cached()`'s `Ready` branch. Plus `media_cache_stats` and a read-only Storage tab showing
usage and free space. Zero behaviour change, and it answers "how big is this thing" and "where
does the time actually go" in one set.

**Gate: read the logs from one real set before starting phase 2.** If `preroll` dominates and a
warm reload is barely faster than a cold one, stop here and redirect the effort. **This gate
does not apply to phase 1b below** — the waveform lane addresses a different cost bucket (§4)
and is cheap/safe enough to build regardless of what the gate finds.

**1b — The waveform-cache lane (§4), independent of the gate above.** `waveformCache.ts`
(IndexedDB wrapper around `api.ts`'s existing `getWaveformCache()`), wired into
`WaveformCanvas.svelte` in place of the direct import, plus the `DIGGER_ANALYSIS_CAP_S`
rejection travelling into the cached-entry check. **Cross-repo prerequisite**: ask for
`X-Updated-At` on Digger's `/tracks/{id}/waveform` response (`updated_at` already exists in
`waveform_cache`, just isn't exposed) — small enough to fold into the waveform-cache work
already underway there. Ship the 24h-TTL fallback first if that header lags behind this side's
implementation; swap to the header-based check once it lands. No Rust changes, no Settings
cap — just the usage line on the Storage tab.

**2 — The real feature.** The prefetch worker, `media_cache_prefetch`,
`src/lib/digger/queuePrefetch.ts` (own WS subscription, current DJ only, queue order,
unplayed-only, debounced), the foreground gate, and the chunked pausable/resumable copy with the
`promoted` deadlock fix. Ship with the on/off switch. Acceptance: a 1.4 GB prefetch running
while a deck plays leaves `[deliver-tel]`'s `min`/`drop` clean; a LOAD pressed mid-prefetch
shows `[media_cache] hit` or a `[audio_load]` `cache=` leg no worse than it would have been with
prefetch disabled.

**3 — Capacity management.** Max-size setting, the free-space floor, `usage.json`, the
startup/idle evictor with the pinned set, orphan `.part` cleanup, the Clear button. Not urgent —
until phase 2 runs unattended the cache grows exactly as it does today, and the honest trigger
for this phase is the Storage tab from phase 1 showing a number someone dislikes.

**4 — If it earns its keep.** Other owners' queue heads via the local DJ MRU; `GET /queue/owners`
in Digger (that repo's decision, with the staleness caveat from §3); resume-from-offset
refinements if the logs show restart churn; `pinned` reused to express an offline crate.

**Probably never.** Speculative prefetch. Content-addressed dedup. Any form of cache sharing
between machines.

---

## Open decisions before implementation starts

1. **The phase-1 gate is the real design choice here.** This doc recommends building the
   measurement first and treating phase 2 as conditional on it. Building the prefetcher
   regardless (it's plausibly worth having even if it's only worth 30% of the load time) is a
   reasonable alternative — it changes phase 1 and 2 from "gated" to "sequenced but both
   committed."
2. **`GET /queue/owners`** — recommended against, because `guest-djs.md`'s "queues are never
   auto-pruned" decision means a bare `SELECT DISTINCT owner` returns everyone who has ever
   DJ'd, not tonight's DJs. If wanted anyway, it's a digger-repo todo item with a recency filter,
   through that repo's own process.
3. **Cache size default**: `0` = unlimited (matching the ask) plus a non-configurable 10 GB
   free-space floor. The floor is an addition beyond what was asked for — confirm it, and
   confirm 10 GB vs. a percentage of the volume.
4. **May eviction ever run mid-set?** Recommended: no — only at app start and during genuine
   idle, with the prefetcher stopping rather than evicting when it hits the cap.
5. **Chunked pausable copy in the prefetch path** means prefetch and foreground no longer share
   one copy implementation (foreground keeps `fs::copy`). Deliberate divergence in a function
   with a live-incident history (the 2026-08-28 truncated fetch) — worth it for closing the
   13-second contention window on large files, but the place a future bug is most likely to hide.
6. **Two pre-existing bugs** fell out of this review, independent of the feature: the leaked
   `.part` on a failed local copy, and the missing `is_file()` re-check in `ensure_cached()`'s
   `Ready` branch (harmless today, becomes a live-deck hazard once eviction exists). Fix now as
   their own small commit, or fold into phase 1?
7. **Where the prefetch controller lives**: a new module with its own `subscribeQueueChanges`
   subscription rather than reusing `DiggerQueue.svelte`'s (which unmounts when the sidebar
   closes), meaning two WebSocket subscriptions to the same endpoint. Digger's `/queue/ws`
   should handle that fine; a shared-subscription refactor of `api.ts` is the alternative.
8. **`X-Updated-At` on `/tracks/{id}/waveform` (§4)** — a small digger-repo change (the column
   already exists, only the response header is missing), worth raising in whatever session is
   currently doing the waveform-cache work there, rather than waiting for this doc's own
   implementation to surface the need independently. Without it, phase 1b ships with a 24h TTL
   instead of exact invalidation — a real but bounded staleness window, not a blocker.
9. **Does a Digger re-analysis reliably bump `waveform_cache.updated_at`?** — including the
   specific case this design leans on: a track first cached at the librosa 600s cap, later
   re-analyzed in full. Worth confirming server-side before trusting `updated_at` as the sole
   staleness signal for that case (§4) — if a re-analysis is ever a raw `UPDATE` that doesn't
   touch the column, the check silently does nothing.
