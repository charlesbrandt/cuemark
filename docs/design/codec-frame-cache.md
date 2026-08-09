# Codec frame cache — from a fixed ring to a directional working set

**Status**: design, not built. The retained frame ring (`codecPlayer.ts`, 2026-08-09) is
step 1 and is in `waveform-scrub.md`; this doc is the generalisation and the robustness
work around it.

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

### 2.2 There is no way to see the cache working

The only observability is one line at construction:

```
[codecPlayer:deck-0] frame ring: 17 frames (3840x2026, ~189.4MB, ~0.68s of reverse scrub)
```

Nothing reports, during or after a gesture, **whether requests were served from the ring or
fell off the end of it**. That is the single measurement that says whether the cache is
sized right, and its absence is why sizing was wrong for a full session. `getFrameForTime()`
already knows: it returns `best` (a real hit), or falls back to `this.frames[0]` (a miss —
the request was older than everything retained), or `null`.

**This should be built before any further tuning.** A per-gesture counter in the shape of
`scrubStats.ts`'s existing `[scrub-deliver]` reporter — buffered in memory, emitted at
gesture end so it adds nothing to the path it measures:

```
[frame-cache/deck-0] gesture 2.1s | req=126 hit=118 (94%) stale=8 | ring 17 frames
                     | deepest reverse reach 0.61s of 0.68s retained
```

`deepest reverse reach` vs. `retained` is the actionable number: at 90%+ of the window the
ring is too small, well under it and the memory is wasted.

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

**Robustness work**: an explicit test that a backward clock does not evict the ring, and a
comment at the gate naming the dependency in both directions.

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

Three tiers, cheapest first. Only tier 1 exists.

| Reverse travel | Source | Decode cost |
|---|---|---|
| within the ring (~0.7s) | retained frames, exact | **zero** |
| beyond the ring | seek to the nearest keyframe and show *only* that keyframe — `dropBeforeUs = null`, decode the single key AU, no walk to the target | **1 frame** per GOP boundary crossed |
| gesture end | one exact seek to settle the picture | ~125 frames, but once, and *outside* the gesture |

Tier 2 is the key trick and is not built: visible, regular motion during a long reverse
sweep, quantized to GOP boundaries (every ~8–10s of content), for essentially nothing —
instead of exact-but-unaffordable. It needs a **new worker message distinct from `seek`**,
because `handleSeek()`'s `dropBeforeUs` + `pump()` walk is precisely what must not run.

Beyond that, the working-set idea proper:

- **Keyframe thumbnail cache.** Decode every keyframe once at load (26 of them for a 254s
  file — cheap and off the hot path) and retain them for the whole track. A reverse scrub of
  *any* distance then always has something to show, and cue-point preview becomes free.
  This is probably the highest value-per-effort item in this document.
- **Directional prefetch.** `setClock()` already sees the sign of travel. Sustained reverse
  motion could bias the ring to retain further back, or pre-warm the previous GOP's
  keyframe. Cheap to try, and the hit-rate instrument from §2.2 is what would say whether it
  earned anything.
- **Hot-region pinning.** Loop in/out and hot cues are known positions a VJ returns to.
  Pinning their keyframes costs a handful of frames and removes the worst-feeling latency in
  the app.

⚠️ Caching a *whole* GOP as raw frames is not an option: 250 × 11.1MB ≈ 2.8GB per deck at
4K. Everything above is deliberately about keeping *few, well-chosen* frames rather than
many.

## 4. What must not be tried again

- **Lowering `BACKWARD_JUMP_SECONDS`**, or making the `setClock` anchor accumulate backward
  travel so it fires within a gesture. Built and reverted 2026-08-09; live audio regression.
  The cost is the seek, not the seek policy.
- **Justifying seek avoidance by the WebKitGTK deadlock** (`pcm-buffer-playback.md`, "Ninth
  mechanism"). That deadlock is inside `MediaPlayerPrivateGStreamer`, reached from a legacy
  `<video>` element's `currentTime` write. `CodecPlayer.seek()` never touches it. The
  rationale was wrong *and* the conclusion was right — the real constraint is decode cost.
  Two independent things were being conflated; do not re-merge them.
- **Trusting unit tests as evidence here.** The reverted change's tests all passed. So did
  `scratch_to_smoke`, while the feature it covered was inaudible. Anything in this area is
  verified live, against *audio*, with slow smooth zoomed gestures.

## 5. Suggested order of work

1. **Cache hit-rate instrumentation** (§2.2). Nothing else should be tuned before this
   exists; it is what would have caught the 0.16s ring in minutes.
2. **`debugLog` for the silent-scrub fallback + the empty-deck guard** (§2.5). Small,
   independent, removes a whole class of unattributable live reports.
3. **`FrameRing` as an owned type with tested lifetime** (§2.3), plus the eviction-vs-gate
   test (§2.4).
4. **Keyframe thumbnail cache** (§3) — best value-per-effort of the caching work.
5. **Tier 2 keyframe-only reverse seek** (§3), which needs the new worker message.
6. Directional prefetch and hot-region pinning, guided by the instrument from step 1.

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
