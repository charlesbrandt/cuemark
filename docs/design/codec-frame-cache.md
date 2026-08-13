# Codec frame cache — from a fixed ring to a directional working set

**Status**: 🟢 **live-verified 2026-08-13**, user-confirmed in both scrub directions with
mid-gesture direction changes, audio clean throughout. Steps 1, 3 (the eviction/gate test
half) and 5 of §5's order of work are done — the retained ring (2026-08-09), the cache
instrument, and **scrub GOP fill**, which supersedes and generalises the "tier 2" sketch
below. Steps 2 (the empty-deck guard), the `FrameRing` owned type, and step 4 (keyframe
thumbnail cache) are not.

**It took two live runs, and run 1 found three defects that every unit test passed through.**
Run 1: reverse worked and reached 13.7s against the ring's 1.28s, audio clean — then the user
reported the picture sticking whenever they changed direction, *in both orders*. Run 2 after
the corrections: user-confirmed working, and the decode bill fell **28× per second of
travel**.

| | run 1 | run 2 |
|---|---|---|
| fills requested / completed | 179 / 179 | 15 / 15 |
| AUs decoded | 6425 | 720 |
| decode | 9013ms | 1007ms |
| travel covered | 13.7s | 43.9s |
| **decode per second of travel** | **658ms** | **23ms** |

The three defects — reverse-only, a request loop, and a latched in-flight guard — are in §7a
with the reasoning, because each is a repeatable mistake rather than a typo. The instrument's
own two failures are there too.

`localStorage['cuemark:codecReverseBackfill'] = '0'` turns the fill off with no rebuild.

**Read first**: `webcodecs-video-path.md` (why the codec path exists at all),
`waveform-scrub.md` "Reverse scrub video" (the measurements that motivate this, and the
reverted attempt that must not be retried).

---

## 1. What this is really about

`CodecPlayer` holds decoded `VideoFrame`s. Until 2026-08-09 it held exactly two, which made
*any* backward motion require a seek, and a seek here costs a `decoder.reset()` plus a walk
from the nearest keyframe — **~125 frames of 1080p software decode on average, 250 worst
case** (measured: keyframe intervals of 8.34s and 10.0s in the real library, so GOPs of
~250 frames; there is no VA-API on this machine, so all of it is CPU). `dropBeforeUs` then
throws away everything before the target. The average seek spends ~125 frames of decode to
deliver one usable frame.

That cost is why the obvious fix — seek more eagerly during a reverse scrub — was built,
unit-tested, and **reverted the same day as a live audio regression**. Sustained software
decode starves the main thread and the GStreamer audio threads, the scrub servo stops
receiving targets, and `HandTracker` coasts out into `arrived ⇒ silence`.

So the design constraint is fixed and non-negotiable:

> **Serving an already-decoded frame is free. Producing one out of order is ruinously
> expensive. Every improvement here is about widening what "already decoded" covers.**

## 2. Why the current code is brittle

The frame ring works, but the surrounding machinery has properties that made a one-line
sizing constant produce a silent, invisible, hard-to-attribute failure — which is exactly
what happened.

### 2.1 Sizing was chosen against a sample of one (settled — see §5a)

The ring was first sized by a byte budget. The quantity a gesture actually consumes is
**seconds of content**, and frames-per-second varies independently of bytes-per-frame. A
48MB budget bought 16 frames at 1080p (0.64s) and 4 frames on the user's real 3840×2026
file (**0.16s**) — and it would have handed a 6fps file 2.7s and a 60fps file 0.27s. The
feature shipped, ran correctly, and read as "not working" live.

The fix for that was a duration target, which fixed 4K and cut every cheaper file — the
final answer is a larger byte budget alone (§5a), and the amended lesson is in §6.

### 2.2 There is no way to see the cache working — BUILT 2026-08-13

The only observability was one line at construction:

```
[codecPlayer:deck-0] frame ring: 17 frames (3840x2026, ~189.4MB, ~0.68s of reverse scrub)
```

Nothing reports, during or after a gesture, **whether requests were served from the ring or
fell off the end of it**. That is the single measurement that says whether the cache is
sized right, and its absence is why sizing was wrong for a full session. `getFrameForTime()`
already knows: it returns `best` (a real hit), or falls back to `this.frames[0]` (a miss —
the request was older than everything retained), or `null`.

**Built as specified**, in the shape of `scrubStats.ts`'s `[scrub-deliver]` reporter —
counters buffered in memory and emitted at gesture end, so nothing is logged on the path
being measured (`debugLog` is an `invoke()` on the bridge under test). `CodecPlayer` gets
the gesture-end signal from `seekBus.ts`'s `endScrub`/`cancelScrub` via
`settleAfterScrub()` / `noteScrubEnded()`:

```
[frame-cache/deck-0] 4.2s | stuck=0 (worst run 2) frozen=146 | req=248 hit=246 (99%) ring=91 fill=155 stale=2
                     | travelled 18.30s
[frame-cache/deck-0] fills req=2 done=2 frames=64 aus=498 decode=612ms held=61
```

How to read it — 🔴 **`stuck` first, and only then the rest**:

| Reading | Meaning |
|---|---|
| `stuck` > 0 | **the picture froze visibly** — a run of `FROZEN_STUCK_TICKS`+ requests on one frame. This is the symptom users report, and the only counter that sees it |
| `frozen` large, `stuck=0` | **normal.** rAF runs ~60fps against 25fps content, so ~58% of ticks redraw a frame that has not changed. Measured at 59% on a healthy 44s gesture. Do not read this as a fault |
| `stale` more than a handful | requests fell off the end of everything held |
| `fills req=` ≫ `done=` | replies are not coming back. Was the latch of live run 1 (§7a, defect 3) |
| `fills req=` in the hundreds | the request loop is back (§7a, defect 2) |
| `fills req=0` on a long gesture | the trigger never armed. Check `reasons:`, and that the deck was paused |
| `reasons: gop-too-long(N)` | the file's GOP exceeds `FILL_MAX_GOP_AUS`; the fill is deliberately unavailable on it |
| `decode=` climbing into seconds | the CPU bill. Read against `[raf]`/`[aux-loop]` busy% and `[scrub-deliver]` for the same window — the number that would show the reverted 2026-08-09 failure mode returning |

`hit` counts `ring` + `fill`. The split matters: `ring` hits are free, `fill` hits cost the
decode reported on the second line.

⚠️ **`hit` alone is not evidence of anything.** It read **100%** on live run 1 for a gesture
the user watched stick — `getFrameForTime` returning the same frame forever is a hit by its
definition. That is why `stuck` exists and is printed first. See §7a.

### 2.3 Frame lifetime is manual and the failure is silent in both directions

A `VideoFrame` pins a decoder buffer until `close()`. Two opposite bugs are both possible
and neither announces itself:

- **Leak** — an evicted frame not closed. Memory grows, and because `VideoDecoder` recycles
  from a bounded pool, decode eventually stalls outright. Symptom: *forward* playback stops
  updating, with `first decoded frame` followed by nothing. Nothing in the log says "pool
  exhausted".
- **Use-after-close** — a frame closed while a consumer still holds the reference. There are
  two consumers (`App.svelte`'s render loop and `DeckCard`'s preview), and neither takes a
  reference count.

Today correctness rests on eviction and `destroy()` being the only two close sites, and on
consumers using the returned frame synchronously. That is true now and is not enforced
anywhere.

**Robustness work**: make the ring a small owned type (`FrameRing`) with `acquire`/`release`
rather than a bare array, so lifetime is one testable unit rather than a convention spread
across `handleMessage`, `getFrameForTime` and `destroy`. Assert in dev builds that the ring
never exceeds capacity and that a closed frame is never returned.

### 2.4 The cache and the decode-ahead gate are coupled but do not know about each other

`codecWorker.ts` stops feeding when `au.ptsUs/1e6 - clockPos > aheadSeconds()`. Reverse
motion therefore stops the decoder on its own as `clockPos` retreats, which is *why* the
ring survives a backward gesture instead of being overwritten. That is load-bearing and
currently accidental — it is a property of two independently-written mechanisms that
happens to compose. Nothing tests it, and a future change to the gate would break the ring
with no failing test and no log line.

**Robustness work — done 2026-08-13**: `codecPlayer.test.ts`'s *"a backward clock does not
evict the ring"*, and a ⚠️ comment at the gate in `codecWorker.ts` naming the dependency in
both directions. The coupling is now load-bearing in a *second* way that the comment also
records: a quiet primary decoder is what leaves the core free for the backfill decoder, so
loosening the gate would put two decoders in contention during exactly the gesture that can
least afford it.

### 2.5 The frontend can call into a deck with no backend pipeline, and only finds out via a rejected promise

Not the frame cache, but the same brittleness and it cost a live session. Scrubbing a deck
with no loaded track calls `audio_scratch_to`, which fails `pipeline_mut` with `no audio
pipeline for deck 'deck-N'`. `seekBus.ts` catches it, degrades the whole gesture to the
throttled silent-seek path, and logs only via `console.warn` — which **is not forwarded to
the Rust log**, so the log shows a mysterious `err=1` and `skipped=383` with no cause.

**Robustness work**: (a) `beginScrub` should not start an audible gesture on a deck with no
source at all; (b) route that `console.warn` through `debugLog` so it lands in the log file
like everything else. Both are small; the second is what turns a 40-minute investigation
into a grep.

## 3. Where this goes: a directional working set

The user's framing, and the right one: **keep buffers for regions recently played, and
prefetch in the direction of travel.** The fixed ring is the degenerate case of that — a
window anchored to "wherever the decoder last was", with no notion of direction or of
regions worth keeping.

Three tiers, cheapest first. **All three exist as of 2026-08-13.**

| Travel, either direction | Source | Decode cost |
|---|---|---|
| within the ring (0.68–1.28s) | retained frames, exact | **zero** |
| forward, ring still around the gesture | the primary decoder's own decode-ahead gate opens and it feeds itself | normal playback cost |
| beyond that | **scrub GOP fill**: decode the GOP the gesture is *in* on a third decoder and retain an evenly-spaced subsample | ~250 frames per **GOP of coverage** |
| gesture end | one exact seek to settle the picture | ~125 frames, but once, and *outside* the gesture |

### Tier 2 as built: scrub GOP fill

The doc originally scoped tier 2 as *"seek to the nearest keyframe and show only that
keyframe"* — one frame per GOP boundary, at one frame of decode. What shipped is strictly
better for a cost that is amortised rather than avoided, and the reason is worth stating,
because it inverts the intuition the rest of this document is built on:

> Reaching **any** frame inside a GOP costs decoding that GOP from its keyframe. So the
> keyframe alone and the *whole GOP* cost the same. Once you are paying, decode all of it
> and keep as much as memory allows.

The keyframe-only design pays ~250 frames of decode (a full GOP walk is unavoidable to
produce even one frame at a GOP boundary once you cross it) for **one** picture. Backfill
pays the same and gets ~32. So the unit that matters is not frames-of-decode-per-frame-shown
but frames-of-decode-per-second-of-coverage:

| | decode | coverage bought | ratio |
|---|---|---|---|
| reverted 2026-08-09 design (exact seek per scrub step) | ~125 frames | 1 frame | ruinous |
| tier-2-as-scoped (keyframe only) | ~250 frames | 1 frame per ~10s | poor |
| **reverse backfill (built)** | ~250 frames | ~10s at ~3fps | ~25 frames of decode per second of coverage |

Mechanically:

- A **new worker message**, `{ type: 'fillGop', atUs, capacity }` — distinct from `seek`
  exactly as this section predicted, because `handleSeek()`'s `decoder.reset()` +
  `dropBeforeUs` + `pump()` walk is precisely what must not run: it would destroy the primary
  decoder's position and the ring with it.
- A **third `VideoDecoder`** in the worker, alongside the primary and the loop-prefetch one.
  The primary is never touched. This is what keeps the reverted design's failure mode
  structurally out of reach: nothing about a gesture can move the primary decoder.
- It decodes the GOP **containing** `atUs` (`codecGop.ts`), keeping the keyframe plus an
  evenly-spaced subsample out to `capacity` frames and closing the rest immediately.
- Retained in a **separate collection** from the ring on the main thread. Sharing one would
  be self-defeating — filled frames sit outside the ring's window by construction, so its
  oldest-first eviction would discard every one on arrival.
- Eviction is **against the direction of travel**, not furthest-from-the-clock. See §7a,
  defect 2: symmetric eviction discards the GOP the gesture is entering, because a gesture
  crossing a boundary is by definition still nearer the one it is leaving.
- Requested only when the deck is **paused**, travel has passed `FILL_TRIGGER_SECONDS`, and
  the **probe point** — the position projected forward by the lead, in whichever direction
  the gesture is moving — is not already covered by a held frame.
- **Paced, not just backpressured.** The feed loop sleeps `FILL_PACE_MS` whenever the decode
  queue is full, which caps how hard one fill drives a core *and* yields to the worker's
  message queue, so a seek or teardown arriving mid-GOP is acted on within a few ms rather
  than after ~250 frames. Both waits are **deadline-bounded** — see §7a, defect 3.

#### Why this is not direction-specific

This is the correction that live run 1 forced, and it is the part most likely to be
"simplified" back into a bug, so the reasoning is worth stating plainly:

> **The primary decoder covers exactly one direction — forward from wherever it is parked —
> and during a gesture it does not move at all.**

Its decode-ahead gate stops it the moment the clock stops advancing into it (§2.4). So:

- **Reverse** it cannot serve at any distance. Decode is forward-only.
- **Forward** it serves *while the ring is still around the gesture* — the gate opens and it
  feeds itself, which is why the trigger deliberately does nothing in that case rather than
  spending a GOP on every ordinary forward scrub.
- **Forward away from a parked ring** (i.e. after reversing) it can only reach the gesture by
  decoding every frame in between — ~200 frames per 8s of travel here — which a moving hand
  outruns. It is not permanently stuck, it is *catch-up-limited*, and live that is
  indistinguishable from stuck.

A reverse-only fill therefore leaves one of these three unserved, and which one depends
purely on where the primary happens to be parked. Live that presented as *"the first
direction I scrub in works and the other sticks"*, in both orders — an observation that fits
no reverse-vs-forward theory and immediately fits this one.

### Tier 3: the settle seek

`CodecPlayer.settleAfterScrub()`, called from `seekBus.ts`'s `endScrub`. **The fill makes
this mandatory rather than merely nice.** The primary decoder does not move during a gesture
(§2.4), so it is left wherever the gesture began. While a gesture could only travel the
ring's 1.28s, resuming playback froze the picture for an unnoticeable moment. With the fill a
gesture can travel tens of seconds, and pressing play would show nothing new until the clock
climbed all the way back: a worse bug than the one being fixed, and one that would have
presented as "the fill broke forward playback".

It no-ops when the gesture ended **inside** the ring — checked against both edges, not just
the low one, since forward travel parks the ring behind the gesture exactly as reverse parks
it ahead — and it keeps the filled frames, which are what covers the gap until the seek's own
first output arrives.

Beyond that, the working-set idea proper:

- **Keyframe thumbnail cache.** Decode every keyframe once at load (26 of them for a 254s
  file — cheap and off the hot path) and retain them for the whole track. A reverse scrub of
  *any* distance then always has something to show, and cue-point preview becomes free.
  Still unbuilt, and still probably the highest value-per-effort item here — it is what
  would cover a gesture that outruns backfill, and the `gop-too-long` files backfill
  declines outright.
- **Directional prefetch — built, in its cheap form.** `setClock()` sees the sign of travel
  and arms the backfill from it; the long lead once the gesture is inside backfilled
  territory is a prefetch of the next GOP. What is *not* built is prefetching the previous
  GOP speculatively before the current one runs out, which would double the decode bill for
  a gesture that may stop at any moment. The `[frame-cache]` `stale` count is what would say
  whether that is needed.
- **Hot-region pinning.** Loop in/out and hot cues are known positions a VJ returns to.
  Pinning their keyframes costs a handful of frames and removes the worst-feeling latency in
  the app.

⚠️ Caching a *whole* GOP as raw frames is not an option: 250 × 11.1MB ≈ 2.8GB per deck at
4K. Everything above is deliberately about keeping *few, well-chosen* frames rather than
many.

## 4. What must not be tried again

- **Lowering `BACKWARD_JUMP_SECONDS`**, or making the `setClock` anchor accumulate backward
  travel so it fires within a gesture. Built and reverted 2026-08-09; live audio regression.
  The cost is the seek, not the seek policy. ⚠️ Reverse backfill is **not** a rerun of this,
  and the distinction is the thing to hold on to if it is ever suspected of the same fault:
  that change moved the *primary* decoder, once per scrub step, to deliver one frame each
  time. Backfill never touches the primary decoder, runs once per ~10s of coverage, is
  paced, and is abandonable within one `await`. If backfill does turn out to starve audio,
  the lever is `BACKFILL_PACE_MS` / the trigger thresholds / the kill switch — not
  `BACKWARD_JUMP_SECONDS`, which still must not move.
- **Justifying seek avoidance by the WebKitGTK deadlock** (`pcm-buffer-playback.md`, "Ninth
  mechanism"). That deadlock is inside `MediaPlayerPrivateGStreamer`, reached from a legacy
  `<video>` element's `currentTime` write. `CodecPlayer.seek()` never touches it. The
  rationale was wrong *and* the conclusion was right — the real constraint is decode cost.
  Two independent things were being conflated; do not re-merge them.
- **Trusting unit tests as evidence here.** The reverted change's tests all passed. So did
  `scratch_to_smoke`, while the feature it covered was inaudible. Anything in this area is
  verified live, against *audio*, with slow smooth zoomed gestures.

## 5. Suggested order of work

1. ✅ **Cache hit-rate instrumentation** (§2.2) — built 2026-08-13.
2. ⬜ **`debugLog` for the silent-scrub fallback + the empty-deck guard** (§2.5). Small,
   independent, removes a whole class of unattributable live reports. Still the best
   remaining value-per-effort item, and untouched by this work.
3. 🟡 **`FrameRing` as an owned type with tested lifetime** (§2.3) — *not* built, and now
   more wanted than before: there are two collections with different eviction rules and one
   `lastServed` guard between them. The eviction-vs-gate test (§2.4) is done.
4. ⬜ **Keyframe thumbnail cache** (§3).
5. ✅ **Tier 2 reverse seek** (§3) — built 2026-08-13 as reverse backfill, which keeps the
   whole GOP's worth of subsampled frames rather than the keyframe alone, for the same
   decode. Tier 3's settle seek shipped with it, as a prerequisite rather than a nicety.
6. 🟡 Directional prefetch (cheap form built), hot-region pinning (not built).

## 5a. Sizing — SETTLED 2026-08-09 evening

**The duration target is gone. The ring is sized by a 192MB byte budget alone, capped at
`MAX_HELD_FRAMES = 32`.** Measured on the same machine, same track, four sizings:

| Content | Original byte budget (48MB) | 0.75s arm | 0.35s arm | **192MB budget (shipped)** |
|---|---|---|---|---|
| 3840×2026 @25 | 4 frames / 0.16s | 17 / 0.68s | 9 / 0.36s | **17 / 0.68s** |
| 1280×720 @25 (Tobago) | **32 / 1.28s** | 19 / 0.76s | **9 / 0.36s** | **32 / 1.28s** |

The shipped column is the best cell of every row: it matches the best 4K arm and restores
the best sub-4K one, with one constant instead of two. `RING_TARGET_SECONDS` and the `fps`
parameter of `heldFrameCapacity()` were removed outright rather than left at a permissive
value, so there is no dormant second control variable to rediscover.

Two consequences worth carrying forward:

- **Frame rate is ignored again, deliberately.** A 6fps file gets a very long window and a
  60fps file a short one from the same budget. That window costs no decode — only retained
  buffers — which is what made byte-only sizing defensible before and still does. If a
  high-frame-rate file ever scrubs short in practice, the fix is a duration **floor** on top
  of the ceiling, never a target that can shrink a window the ceiling would have allowed.
- **The ring is now wider than `BACKWARD_JUMP_SECONDS`** (1.28s of 1080p against a 0.5s
  jump threshold). Nothing needs changing — `setClock` only ever sees one poll's worth of
  movement, so a real gesture reaches the far end of the ring in many small steps — but a
  *single* leap wider than 0.5s still seeks by design, and a test that moves the clock in
  one jump will now trip that. `codecPlayer.test.ts` walks the gesture step-by-step for
  exactly this reason.

### How the duration target got it wrong

Worth keeping, because the mistake is repeatable and it was not a measurement error. The
byte budget let cheap frames earn a long window for free (capped at `MAX_HELD_FRAMES`), and
the duration target *removed* that — a 3.5× regression on sub-4K content, which is most of
the library. The 4K fix was real; the cap on cheap content was collateral damage, and it
went unnoticed because **the only file examined while designing the constant was the 4K
one**. Both duration arms were measured carefully and both measurements were correct; the
sample was one file. The generalisation in §6 was written from that same sample and is
weaker than it reads — see the amendment there.

**Any future change to this sizing is checked against at least one 4K and one sub-1080p
file before it ships**, which is one deck load each and readable straight off the
`[codecPlayer] frame ring:` line.

⚠️ **Do not conclude anything from Tobago.** `Jonas Rathsman - Tobago` is the one track the
user reports a consistent audio artifact on, independent of and predating all of this work
(`todo-20260808.md`; they suspect artifacts in the file itself). It is the worst possible
A/B track — two faults, one signal. Use it only once the frame-cache question is settled
elsewhere, and settle *it* by comparing the decoded signal against the recorded output, not
by ear.

**Open question the A/B was built to answer, still open**: whether presenting a frame costs
enough main thread to starve audio. The 4K measurement is solid — 54–77ms per preview draw
at 3840×2026, `busy 13–14%`, with `rafWait` tracking it — but whether that is what the user
hears is unproven, and the servo instruments say the servo never gated (`arrived 0%
snaps=0`, rms healthy). The cheapest clean test is a **1080p or 720p track that is not
Tobago**, on a ring sized the same way, comparing `[aux-loop] preview drew=… dur max=…`.

Note the machine struggles with 4K playback generally (user observation, consistent with
the per-draw cost above) — so a 4K-specific presentation ceiling is plausible on its own
terms and may not be a cuemark bug at all.

## 6. The general lesson

Originally stated as: *size a cache in the units the consumer spends, not the units the
resource is billed in* — the consumer spends seconds of content, the resource is billed in
bytes, so target seconds and keep bytes as a ceiling. **That was built and removed the same
day** (§5a). Half of it survives and the half that didn't is the more useful half:

- ✅ **Log the figure in the consumer's units.** This is the part that carried its weight,
  and it is what makes a wrong window visible in one deck load. `17 frames … ~0.68s of
  reverse scrub` says immediately what `189.4MB` never would.
- ❌ **Do not convert the *control variable* to the consumer's units when the resource
  budget is what makes the window free.** Bytes were not an accounting artefact here — they
  are what the ring actually costs. Targeting seconds meant *declining* window that cost
  nothing, on every file cheaper than the one the target was tuned against. A budget spends
  what it has; a target spends what it was told to, including on content it never saw.
- ⚠️ **The failure that produced both the bug and the wrong lesson was the sample, not the
  units.** One 4K file, measured well, twice. Any constant whose effect varies with content
  needs its effect enumerated across the *range* of content — here, one line of arithmetic
  per resolution, which is cheaper than either of the arms that were actually run.

The narrow rule that holds: **express the ceiling in the units the resource is billed in,
report the result in the units the consumer spends, and tabulate that result across the
content you actually have before choosing the number.**

See `skills/tuning-knobs/SKILL.md` for the operational version of this: which knob to reach
for, what its live symptom is, and how to check it without a rebuild.
## 7. Scrub GOP fill — constants and verification

### Constants

| Constant | Where | Value | What it controls |
|---|---|---|---|
| `FILL_RING_BYTES` | `codecPlayer.ts` | 192MB | Byte ceiling for retained fill frames. A **second** budget alongside `FRAME_RING_BYTES`. |
| `MAX_FILL_FRAMES` | `codecPlayer.ts` | 64 | Total retained across GOPs. Higher than the ring's 32 because **two GOPs must coexist** — see defect 2 below. Frames come from the fill decoder's own pool, not the primary's. |
| `fillPerGop()` | `codecPlayer.ts` | half the total | Frames requested per GOP, so a second GOP always has room. 32 across a 10s GOP ≈ 3.2fps. |
| `FILL_TRIGGER_SECONDS` | `codecPlayer.ts` | 0.35 | Travel before a fill is considered. Larger than mere jitter rejection on purpose: the probe lead is wider than the ring, so any *armed* reverse motion costs a GOP, and a flick shorter than this should cost nothing. |
| `FILL_PROBE_LEAD_SECONDS` | `codecPlayer.ts` | 1.5 | Head start for the decode. ⚠️ Cannot go much lower: a GOP decodes from its keyframe *forward*, so in reverse travel the frames nearest the gesture are produced **last**, and ~250 frames is over a second here. |
| `FILL_COVERAGE_GAP_SECONDS` | `codecPlayer.ts` | 0.6 | How far below the probe a held frame still counts as covering it. Also the tolerance for "is the primary decoder still following the gesture". |
| `FILL_KEEP_SECONDS` | `codecPlayer.ts` | 30 | Distance from the clock past which a filled GOP is dropped. |
| `FILL_REQUEST_TIMEOUT_MS` | `codecPlayer.ts` | 4000 | When an unanswered request may be retried. See defect 3 — this exists so no reply can disable the feature permanently. |
| `FILL_REFUSAL_COOLDOWN_MS` | `codecPlayer.ts` | 1500 | Self-clearing backoff after a refusal, instead of a latch. |
| `FILL_MAX_GOP_AUS` | `codecWorker.ts` | 600 | Refuse GOPs longer than this. Reported as `gop-too-long(N)`. |
| `FILL_PACE_MS` | `codecWorker.ts` | 4 | Sleep when the decode queue is full. The CPU throttle and the cancellation window. |
| `FILL_QUEUE_WAIT_MS` / `FILL_FLUSH_WAIT_MS` | `codecWorker.ts` | 1500 | Deadlines on the two waits that could otherwise hang a run — see defect 3. |

Live overrides, no rebuild (applied at the next deck load):

```js
localStorage['cuemark:codecReverseBackfill'] = '0'   // kill switch
localStorage['cuemark:codecBackfillRing']    = '24'  // total retained fill frames
```

(The keys keep their original names so a note written during live run 1 still works.)

## 7a. Live run 1 (2026-08-13) — three defects, and why each was invisible

Audio was clean throughout, under a decode load ~19× heavier than the corrected build
produces. That is the single most valuable result so far and it substantially de-risks §1's
central worry. Everything below is about *video*.

### Defect 1 — reverse-only, so one direction always froze

Covered in §3, "Why this is not direction-specific". The user's characterisation was the
thing that cracked it: *"seems like the first direction takes preference?"* — reported after
observing the freeze in **both** orders, which no forward-vs-reverse theory explains and
which the parked-primary-decoder model explains immediately.

### Defect 2 — the request loop: 179 fills in one 22s gesture

`aus=6425` ≈ **257 seconds of content decoded to cover 13.7 seconds of travel.** The file's
GOPs turned out to be ~36 AUs (~1.4s), not the ~10s the design was sized against, and two
constants then fought:

- 32 retained frames ÷ ~17 kept per GOP = only **~2 GOPs ≈ 2.8s** could be held at once.
- The prefetch lead wanted the coverage floor **3s** below the clock.

3 > 2.8, so the loop could not terminate: a GOP arrives → eviction runs → "furthest from the
clock" is the just-fetched earlier end → it is closed → the floor bounces back → the trigger
fires again, forever.

Two independent errors, both fixed:

- **The trigger asked the wrong question.** "Is the floor far enough below me" is a distance
  test, and distance can be un-satisfiable. "Is the probe point covered" is a *coverage* test
  — a GOP already fetched and still partly held answers it yes, so the trigger goes quiet by
  itself regardless of how leads and capacities compare. `filledGops` additionally records
  what the worker has decoded, so the same GOP is never requested twice while a frame of it
  survives.
- **Eviction was symmetric.** Furthest-from-the-clock discards the GOP the gesture is
  *entering*, because a gesture crossing a boundary is still nearer the one it is leaving.
  Frames on the travel side are now scored as 4× nearer, so the side being left goes first.

⚠️ **The generalisable rule**: any trigger of the form *"act while X is more than N away"*
can be starved by a mechanism that stops X getting that far. Prefer *"act while Y is
missing"*, where Y is something an action actually produces.

### Defect 3 — the in-flight guard latched and the feature died silently

179 fills, then **zero for the next 54 seconds**, with 100% hit rate reported the whole time.
`fillInFlight` was a plain boolean set on request and cleared only on the reply, and there
were at least two paths (an unbounded wait on a decode queue that had stopped draining, and
an unbounded `flush()`) where a reply could never come. One hang killed the feature for the
deck's lifetime.

Fixed on both sides: the worker's two waits are deadline-bounded and report `queue-stalled` /
`flush-timeout` instead of hanging, and the main thread's guard is a **timestamp** with
`FILL_REQUEST_TIMEOUT_MS` rather than a boolean. Refusals get a self-clearing cooldown
instead of the permanent `backfillRefusedAtUs` latch.

⚠️ **Never gate a repeating request on a boolean cleared only by a reply.** Both halves are
needed: the worker replying on every path is the fix, the timeout is what makes a *missed*
fix survivable. This is the shape catalogued in `docs/design/silent-failure-inventory.md`.

### The instrument was blind to all of it — and then wrong a second way

`[frame-cache]` reported `req=6416 hit=6416 (100%) stale=0` for a gesture the user watched
stick. `stale` means "older than everything held"; returning the *same* frame 300 ticks
running is a hit by that definition. **A hit-rate that reads perfect during a freeze is worse
than no instrument — it actively argues the feature is working.**

The first fix — a `frozen` counter, requests where the position moved but the frame did not —
was then **wrong in its own right**, and run 2 caught it: it reported `frozen=2418 (run 1)`,
i.e. 30% of requests repeated a frame but never twice consecutively, which is not a possible
distribution. `getFrameForTime` is called **twice per tick** — App.svelte's render loop and
DeckCard's preview, same `t` — and treating the duplicate as "not frozen" reset the run
counter on every other call, making a run of 2 structurally unrecordable.

⚠️ **An instrument with two callers has to count ticks, not calls.** Both are now fixed:

- The frozen check ignores a repeated position entirely rather than treating it as motion.
- `stuck` counts runs of `FROZEN_STUCK_TICKS` (8 ≈ 130ms) or longer and is printed **first**.
  Raw `frozen` is kept but demoted: ~58% of ticks legitimately repeat at 60fps-over-25fps, so
  a bare repeat count cries wolf on every healthy gesture — the opposite failure to the
  original, and just as useless.
- The fill line is emitted **unconditionally**, including all-zero, with refusal reasons and
  separate `req`/`done` counts. Suppressing it when nothing ran made "requested and refused"
  and "never requested at all" indistinguishable, and that difference was defect 3.

`codecPlayer.test.ts`'s "frame-cache instrument" block now tests the instrument itself,
including a case that fails if the two-caller bug returns. An instrument that cannot fail its
own test is not evidence.

## 7b. Verified, and what is still open

**Live run 2 (2026-08-13), user-confirmed**: both directions, direction changes mid-gesture,
audio clean, 43.9s of travel in one gesture. `fills req=15 done=15`, `decode=1007ms`,
`stale=38/8162` (0.5%). The headline numbers are in the Status table.

Still open, none of them blocking:

1. **Does `fillDecoder.reset()` between GOPs invalidate frames already transferred to the
   main thread?** Per spec no; on this WebKitGTK it remains an assumption that simply has not
   misbehaved yet. Would show as a previously-filled GOP going blank when the next fill
   starts. If it ever does, use a fresh `VideoDecoder` per fill.
2. **Only tested on ~1.9s-GOP 720p content.** The design was reasoned about ~10s GOPs and the
   4K case is untested end to end; per §5a, any sizing change here is checked against both a
   4K and a sub-1080p file.
3. **Two-deck cueing is untested** — run 2 was a single deck. Audio was clean under a much
   heavier load, so this is expected to hold, but the case where fill CPU can reach *live*
   audio has not actually been run.
4. AV1 is unaffected — still on the legacy `<video>` path, so it has no `CodecPlayer`.
