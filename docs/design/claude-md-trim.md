# Trim CLAUDE.md's accumulated investigation narrative

**Status: ✅ EXECUTED 2026-08-12 — 772 → 639 lines, `## Architecture` 422 → 300.** All three
blocks below were compacted as scoped, plus two adjacent ones of the same class (the
DMA-BUF-retirement measurement narrative, and the VA-API-demotion block, which became
redundant when `docs/environment.md` landed). Every cut fact was re-verified as greppable in
the doc its pointer names; `npm run check` and `cargo check` both clean.

⚠️ **The acceptance target below (~450 lines / `## Architecture` under ~200) was not reached
and should not be chased.** What remains in `## Architecture` is overwhelmingly the "Do not
touch" category this doc defines — short structural rules and load-bearing silent gotchas.
Cutting further removes facts, not retellings. The number was a survey estimate, not a count
of what was actually narrative.

The rest of this doc is kept as the record of what was cut and why.

---

Scoped and surveyed 2026-08-12, in the same session that compacted four bloated
memory files (see `feedback_memory_compaction_practice.md` in the project's memory store —
not part of this repo — for the method that pass established; this doc applies the same
method to a higher-stakes file).

## Why this exists

`CLAUDE.md` has grown the same way several project-memory files had: dated investigation
narrative gets appended and never compacted once the bug is fixed and the full writeup lands
in `docs/design/*.md`. As of 2026-08-12: **772 lines, 60.7KB, 39 date-stamped entries**
(`2026-0[5-8]-\d\d`). `## Architecture` alone is **422 lines — 55% of the file** — and within
it, `### Rendering pipeline` is ~362 lines, dominated by narrative blocks that each end with
some form of "full writeup in `docs/design/X.md`" — i.e. the detail is already duplicated,
not uniquely held here.

This is a different risk profile than the memory compaction: `CLAUDE.md` is loaded into
*every* session's context regardless of relevance (memory can in principle be recalled
selectively), it's checked into the repo, and the project's own stated goal is open source —
other people may read this file. A bad trim here misleads every future session, not just one
memory read. **Land this as a reviewable diff on its own branch, and show the user the diff
before committing** — don't fold it into an unrelated commit.

## Scope: the specific blocks to compact

Line numbers below are as of commit `a8def16` (2026-08-12) and will drift — use the quoted
heading/opening text to relocate each block, not the line number.

### 1. The slow-jog/cue-gating saga inside `### Rendering pipeline` — biggest win

**~lines 286–403 (118 lines)**, opening at `🟢 **"Slow-jog audio gates out" — FIXED
2026-08-11, live-confirmed.**` and running through the `⚠️ **One bounded exception to "never
by rate"...` block just before "Reverse scrub video is served from...".

This is not just narrative bloat — it is **substantially duplicated three times over**:
the full investigation lives in `docs/design/slow-jog-audio-inaudible.md` (§10 and its
subsections, which this block itself cites repeatedly), and a compacted version of the same
material already exists in project memory as `project_slow_jog_audio_pitched.md` (rewritten
2026-08-11, before this session). CLAUDE.md's copy is the least-compressed of the three.

**Keep**: the fix and its current default (`CUEMARK_SHARED_OUTPUT` on since 2026-08-11, one
`pulsesink` per device node, `audio/mixer.rs`'s `OutputGraph`), the three genuinely
load-bearing-and-silent gotchas (`is-live=true` on every `appsrc`, deck pipelines
`use_clock()`-ing the graph clock, `position()` subtracting the measured 171.3ms latency),
and the pointer to `docs/design/shared-output-pipeline.md` / `slow-jog-audio-inaudible.md`
§10.14.

**Cut** (all fully preserved in the linked docs — verify before cutting, see "Method" below):
the six-refuted-hypotheses list, the `scratch-envelope.py` CLI changelog, the
`instrument_level()` dBFS/zero% reading tutorial, the "prior RESOLVED verdict was wrong"
narrative, the generalized "instrument that cannot vary with the fault" essay (this exact
lesson already lives, better-written, in memory as
`feedback_blind_instruments_stop_theorising.md`), and the `HandTracker` coast-mechanism
paragraph (keep only the one-line rule "position, not velocity, is the control variable" —
the mechanism detail is in `docs/design/waveform-scrub.md`).

Target: ~15–20 lines.

### 2. The legacy `<video>` fallback saga inside `### Rendering pipeline`

**~lines 167–238 (72 lines)**, opening at `🔴 **The previously-untested path — the legacy
<video> fallback — was exercised live on 2026-08-05 and it is unusable.**` through `See
docs/design/legacy-video-fallback-cost.md and webcodecs-video-path.md "Phase 7"...`.

**Keep**: current state only — VP9 is fixed (moved to WebCodecs, `video_demux.rs` accepts
H.264+VP9), AV1 stays on the legacy `<video>` path and decodes **zero frames** there (not
just slow), `CUEMARK_DISABLE_DMABUF=1` made the per-call cost worse and should not be
reached for, the "VP9 decay" scare was a measurement artifact (steady-state oscillates,
needs a multi-minute window to measure) — one line each, not the supporting measurements.

**Cut**: the fps/ms-per-call tables, the decay-arm methodology (leak/thermal/CPU-starvation
refutation detail), the AV1 four-bitstream-framing enumeration — all in
`docs/design/legacy-video-fallback-cost.md` already.

Target: ~15 lines.

### 3. `## Open findings from the 2026-08-05 live set` (own top-level section)

**Lines 521–563 (42 lines).** This section is *also stale*, independent of the trim: its
`audio-dropout-mid-playback.md` bullet doesn't mention the 2026-08-11
`shared-output-pipeline` default flip that structurally removed H1's precondition (see that
doc's own "H1 and the shared output pipeline (2026-08-11)" section, and project memory
`project_audio_dropout_h1_instrumentation.md`, corrected in this same 2026-08-12 session).
Refresh the status, don't just compress the prose — read the three linked docs' current
Status lines directly rather than trusting this section's summary of them.

Target: ~10–15 lines, or fold into a single "check these docs' Status lines" pointer list.

## Method (same as the memory-compaction pass)

For each block: **root cause (one line) + current fix/status (one line) + any load-bearing
silent gotcha that would bite someone reading only this file + a pointer** (design doc path,
and a specific commit hash if one exists for the closing fix — `git log --oneline | grep
-i <topic>` finds it). Cut the supporting narrative: measurement tables, refuted-hypothesis
walkthroughs, methodology essays — all things whose loss doesn't remove a fact, only a
retelling of one.

**Before cutting any claim, verify the design doc it points to still actually contains that
claim.** Docs get trimmed too (see commit `80a30d0`, "Trim stale/derivable content from
CLAUDE.md, move perf-log guide to a skill") — don't assume a pointer from months ago still
resolves. A quick `grep` for the key term/number in the target doc is enough.

**Do not touch** anything that is a short, undated, structural rule or warning with no
narrative attached (e.g. the canvas-sizing rule, the `deck.downbeat` phase-anchor rule, the
compositor-canvas-must-not-be-`display:none` warning) — those are exactly the kind of fact
CLAUDE.md should hold directly, and compressing them further would lose information, not
duplication.

## Acceptance check

- `CLAUDE.md` shrinks meaningfully (rough target: `## Architecture` under ~200 lines, whole
  file under ~450 lines) without any fact disappearing — every cut fact should still be
  `grep`-able in the design doc its pointer names.
- `npm run check` / `cd src-tauri && cargo check` still pass (trimming a doc shouldn't touch
  code, but confirms nothing got corrupted).
- Read the resulting file straight through once — it should still read as complete
  architecture documentation, not a stub with dangling pointers.
- Show the diff to the user before committing; this is their call on a shared, checked-in
  file, not a unilateral cleanup.
