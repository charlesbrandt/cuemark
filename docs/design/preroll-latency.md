# Track-load latency: splitting the "preroll" bucket

**Status:** design only, nothing built. Direct continuation of `docs/design/
queue-prefetch-cache.md`'s phase-1 gate (2026-08-30): real-set `[audio_load]` data showed
`preroll` at 70–94% of total track-load time across 7 samples, with the network/media-cache leg
(`cache=`) only 6–30%. That doc's own recommendation was to redirect effort to the preroll path
rather than build a prefetch feature — this doc is that redirect, not a rewrite of the one that
came before it.

**Date:** 2026-08-30

**Origin:** `todo.md`, "Load-time / button-to-audio latency during live mixing" — the load-time
half. The user wants this to stay a *living* measurement, not a one-off: "continue to monitor
and log the time involved in loading new tracks so that we can start to analyze where the
biggest lag is coming from and tune accordingly." This doc's phase 1 is exactly that — more log
lines, no behavior change — with tuning explicitly deferred until the logs say which leg to tune.

**Read first:** `src-tauri/src/audio/pipeline.rs`'s `load()` (starts ~line 2863); `src-tauri/src/
audio/mod.rs`'s `audio_load` command (~line 173); `skills/perf-log-reading/SKILL.md`'s
`[media_cache]`/`[audio_load]` section; `docs/design/pcm-buffer-playback.md` (why the scratch
PCM decode exists at all).

---

## 1. The "preroll" bucket is not one thing — it's at least four, and they've never been split

`[audio_load]`'s `preroll=` field (`queue-prefetch-cache.md` phase 1) times the entire call to
`pipeline.load()` from *outside* it (`audio/mod.rs:246-248`: `preroll_start` before, `preroll_ms`
after). Reading `load()`'s own body (`pipeline.rs:2863` onward) shows that single number is
actually the sum of at least four very different costs, executed in this order:

1. **Teardown** of any existing pipeline for this deck — `set_state(Null)`, detaching output
   branches, joining the feeder thread (`pipeline.rs:2872-2886`). Expected cheap; never measured
   on its own.
2. **Conditionally, a synchronous full-file PCM decode.** `needs_pcm_decode` (`pipeline.rs:2866`)
   is true whenever this deck doesn't already hold PCM for this exact `file_path` — a brand new
   load, or any load where the deck's remembered `file_path` differs. When true,
   `pcm_buffer::decode_stereo_48k(file_path)` (`pipeline.rs:2889`) runs **to completion, on the
   calling thread, before a single element of the real playback graph is built.** This decode
   exists purely to feed the *scratch* feeder (`docs/design/pcm-buffer-playback.md`) — it has
   nothing to do with GStreamer's own preroll and nothing to do with the network/cache question
   `queue-prefetch-cache.md` addressed. It reads the *local* (already-cached) file, so it is
   unaffected by that doc's `cache=` leg entirely, and unaffected by whether the file came from
   the network a moment ago or has been on local disk for weeks.
3. **Graph construction** — dozens of `make_el()` calls (uridecodebin, queue, audioconvert,
   resample, capsfilter, pitch, optional spectrum, EQ + sweep filters, the scratch appsrc branch,
   valve, input-selector, tee, per-device branches — `pipeline.rs:2898` onward) plus linking.
   Expected near-zero; worth measuring once to actually rule it out instead of assuming it.
4. **Real GStreamer preroll** — `pipeline.set_state(Paused)` and the wait for it to actually
   reach `Paused` (`pipeline.rs:3299`). This is the only phase that is "GStreamer preroll" in the
   sense the word was used when `queue-prefetch-cache.md` first proposed redirecting effort here:
   `uridecodebin`'s internal typefind → demux → decoder-plugin negotiation, then buffering enough
   to reach `PAUSED`.

**This isn't a hypothetical confound — it's already baked into the data that exists.**
`pipeline.rs:2865`'s own comment says device-switch reloads (`set_devices()`/`set_cue_device()`)
call `load()` again on an already-loaded file, which means `needs_pcm_decode` is false for them.
The 7 samples logged in `queue-prefetch-cache.md`'s phase-1 gate almost certainly mix
PCM-decode-included loads (first play of a track) and PCM-decode-skipped loads (anything reloaded
for a device switch) under one `preroll=` number, and nobody has looked at which were which. It's
entirely possible the "preroll dominates" conclusion is real but for a completely different
reason than GStreamer negotiation being slow — the scratch PCM decode could be most of it.

## 2. What to add

Four `Instant::now()` splits **inside** `load()` itself (not wrapping it from `audio_load`, the
way the current `preroll=` field does), replacing one opaque number with a breakdown one level
down — the same move `queue-prefetch-cache.md` made splitting `total` into `cache`/`lock`/`preroll`
in the first place:

```
[pipeline_load] deck-0 total=… teardown=… pcm_decode=…      build=… gst_preroll=…
[pipeline_load] deck-1 total=… teardown=…  pcm_decode=skipped build=… gst_preroll=…
```

- `teardown` — step 1 above.
- `pcm_decode` — wall time in `decode_stereo_48k()`, or the literal string `skipped` when
  `needs_pcm_decode` is false, so a log grep separates the two populations immediately instead of
  inferring it from file size or guessing.
- `build` — step 3, graph construction and linking.
- `gst_preroll` — step 4, the actual `set_state(Paused)` call and wait — the only leg that is
  "real GStreamer preroll" in the sense the term has been used so far.

Keep `[audio_load]`'s existing `preroll=` field as the parent sum, unchanged, so every log
excerpt already captured from the 2026-08-30 real set (and anything saved from it) stays
comparable — `[pipeline_load]` is a breakdown one level down, logged from inside `load()` on the
same line-per-call cadence, not a replacement.

**Don't stop at these four in one pass.** If a future real set's logs show `gst_preroll` is still
the dominant leg once `pcm_decode` is separated out, the natural next cut is *inside*
`gst_preroll` itself: `uridecodebin`'s `pad-added`/`no-more-pads`/`source-setup` signals, each
timestamped relative to `gst_preroll`'s own start, would localize typefind time vs.
demuxer-plugin negotiation vs. decoder-plugin negotiation vs. actual pre-buffering. Don't build
that yet — it's the phase-2 cut, gated on phase 1's numbers actually pointing there (see
Phasing).

## 3. Falsifiable predictions

Same discipline `queue-prefetch-cache.md` used for its own gate — state what each outcome would
mean before reading the log, so the log settles the question instead of confirming a guess.

- **`pcm_decode` is most of `preroll` on loads where it ran, and `skipped` loads have small
  `preroll`** → the scratch PCM decode is the dominant cost, and it's fixable *without touching
  GStreamer at all* — move it off the load-blocking path (background thread run in parallel with
  graph construction/preroll, deferred until a scratch gesture is actually attempted, or reused
  more aggressively across a reload than the current same-`file_path`-only check at
  `pipeline.rs:2866`). This would also mean `queue-prefetch-cache.md`'s "preroll dominates"
  finding, which never separated the two, overstated GStreamer's own contribution — worth a
  follow-up note on that doc if this is what the logs show, since its Status block currently
  names `uridecodebin` setup as the redirect target and this would mean that's only partly right.
- **`gst_preroll` is most of `preroll` even on `skipped` loads** (the cleanest test population,
  since it has zero PCM-decode cost to confound it) → the cost really is in `uridecodebin`/demux/
  decoder negotiation, and the original redirect was correctly aimed. Proceed to the
  pad-signal-level breakdown in §2's last paragraph.
- **`build` is ever non-trivial** → something in graph construction itself is unexpectedly slow
  (plugin loading, `make_eq`/`make_sweep_filters` element creation cost) — a surprise worth its
  own look, not a tuning knob to reach for.
- **`teardown` is ever non-trivial** on a load that replaces an existing pipeline (as opposed to
  a deck's first load) → worth knowing separately, since a DJ swapping tracks mid-set hits this
  leg every time and a first-load-only investigation would never see it.

## 4. Non-goals for this pass

- **No `uridecodebin` property tuning** (`use-buffering`, `download`, `buffer-duration`,
  `connection-speed`) until the sub-phase logs specifically say `gst_preroll` — not
  `pcm_decode` — is the dominant cost. Tuning blind here risks exactly the "elaborate theatre"
  `queue-prefetch-cache.md` warned against for its own feature, just one layer deeper.
- **No change to when or where PCM decode runs yet**, even though §1 makes it a plausible
  culprit. Moving it to a background thread raises a real question this doc doesn't answer —
  what happens if a scratch gesture is attempted before that background decode finishes? — and
  deserves its own scoped follow-up once §3's predictions confirm it's worth doing, not a
  reflexive fix bolted onto an instrumentation pass.
- **Doesn't touch `output_queue`'s buffering, the shared output graph, or anything downstream of
  a track actually being loaded** — that's `docs/design/button-to-audio-latency.md`'s territory
  (the sibling exploration into the *other* half of the original complaint, a press on an
  already-loaded deck), not this doc's.
- **Doesn't re-litigate `queue-prefetch-cache.md`'s own conclusion about the network/cache leg**
  — `cache=` staying a minor term is not in question here; this doc is entirely about what's
  inside the much larger `preroll=` term.

## 5. Phasing

**1 — Sub-phase split inside `load()`.** The four-way `[pipeline_load]` breakdown above,
`pcm_decode` boolean-gated to `skipped`/real-timing, zero behavior change. This is the "keep
monitoring and logging" ask directly — cheap, standing instrumentation, not a one-off
measurement. Read a real set's logs (ideally spanning both fresh loads and device-switch
reloads, so both `pcm_decode` populations are represented) before deciding anything past this.

**2 — Only if `gst_preroll` turns out to be the dominant leg.** Break `gst_preroll` itself down
via `uridecodebin`'s `pad-added`/`no-more-pads`/`source-setup` signal timestamps, to localize
typefind vs. demux vs. decoder-negotiation cost before touching any `uridecodebin` property.

**3 — Only if `pcm_decode` turns out to be the dominant leg.** Redesign when/where the scratch
PCM decode happens — background thread started alongside GStreamer graph construction, deferred
until a scratch gesture is actually attempted, or a more aggressive reuse policy across reloads.
Real design work with its own tradeoffs (what a scratch attempted before decode-completion should
do), scoped separately once phase 1 confirms it's worth doing.

**4 — Ongoing.** Once phase 1's line format is settled, treat it as a permanent standing
instrument (like `[poll-stats]`/`[deliver-tel]`) rather than a temporary measurement — the user's
own framing here is "continue to monitor," not "measure once." Add it to
`skills/perf-log-reading/SKILL.md`'s reference table once the format is final and has been read
from at least one more real set, the same way `[media_cache]`/`[audio_load]`/`[queue-load]` were
added there after `queue-prefetch-cache.md`'s phase 1.

## Open decisions before implementation starts

1. **Whether to keep `[audio_load]`'s top-level `preroll=` field as the sum of the four new
   sub-phases, or fold `[pipeline_load]` into `[audio_load]` as one wider line.** Recommend
   keeping them as two lines for now (parent + breakdown), so anything already read or saved from
   `queue-prefetch-cache.md`'s phase-1 data stays comparable without re-deriving it.
2. **Whether `pcm_decode`'s cost, once isolated, is worth moving off the critical path at all
   versus documenting it as an accepted cost of scratch-readiness-at-load.** That's a product
   call (is scratch being instantly available on every deck worth the load-time cost, for decks
   that may never be scratched this set) as much as an engineering one — not this doc's to
   settle, but worth surfacing explicitly once §3's numbers are in, rather than assuming the
   answer is "always move it."
3. **How many real-set samples are enough before phase 2 or 3 starts.** `queue-prefetch-cache.md`
   acted on 7 cold samples plus one reload pair; that was enough to see a consistent 70%+ pattern
   there. Whether the same sample size is enough to confidently attribute *within* `preroll` is
   an open call — if the `pcm_decode`/`gst_preroll` split comes back close rather than lopsided,
   more sessions' worth of logs should be collected before committing to phase 2 or 3.
