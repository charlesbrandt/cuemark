# Design docs — status index

This directory is a set of **live investigation and design docs**, written in the moment.
Most read like an open crisis, because they were one when the first paragraph was written —
that's deliberate; the hard-won debugging narrative (refuted hypotheses, what was measured,
what to never re-try) is the point, and it's usually still true even after the bug is fixed.
But it means opening one cold can make a long-closed issue feel like the current priority.

**This file is the map.** Check here first. A doc's own `Status:` line near its top is the
detailed, authoritative word on where that specific investigation stands — but it can drift
stale (some had, before 2026-09-05 — see `output-noise-and-track-reload-silence.md` for the
worst case). This index is refreshed independently and cross-checked against each doc's own
text, so trust this table over a vague memory of a doc's title.

**Nothing here gets deleted or archived out.** A closed doc keeps its full narrative — that's
what makes the next similar bug fast to diagnose instead of starting from zero. "Resolved"
just means: don't expect to find open work in it.

**Overall state, as of 2026-09-05 (user's own assessment, in daily use):** the app feels
stable. **Auto DJ is the one actively-developing area** — see `auto-dj-transitions.md` in the
🟡 table below. Nearly everything else in this directory is a closed or reference doc; if
you're getting oriented, that's the one file in the 🔴/🟡 tables actually worth reading start
to finish right now.

## Legend

| | |
|---|---|
| 🟢 RESOLVED | Closed. Root cause understood (or a deliberate decision made), fix shipped and verified, or investigation deliberately ended. Read only for reference/history. |
| 🟡 PARTIALLY RESOLVED | Main finding fixed/shipped, but the doc itself names at least one remaining open item. |
| 🔴 OPEN | Genuinely active or unstarted work. |
| ⚪ SUPERSEDED | Not fixed — replaced by a different approach, tracked in another doc. |
| 📘 REFERENCE | Not a bug tracker. Living architecture/design doc, style guide, or permanent catalogue — "read before touching X." Never closes. |

## 🔴 Open — actually worth your attention

| Doc | What's open |
|---|---|
| [`audio-dropout-mid-playback.md`](audio-dropout-mid-playback.md) | D1 (10.8s mid-track silence): never reproduced on demand. ⚠️ The doc explicitly warns against closing this on "haven't heard it in a while" grounds — nothing in the pipeline can detect brief clipping, only >1s hard silence or starvation, so "no reports" and "fixed" are nearly independent claims here. |
| [`button-to-audio-latency.md`](button-to-audio-latency.md) | Exploration only, nothing built. Open decisions listed at the tail. |
| [`cross-platform-windows-mac.md`](cross-platform-windows-mac.md) | Not started. Guidance-only doc for a future port. |
| [`preroll-latency.md`](preroll-latency.md) | Design only, nothing built — direct follow-on from `queue-prefetch-cache.md`'s phase-1 gate. |
| [`scratch-feeder-underruns.md`](scratch-feeder-underruns.md) | Open, not yet investigated. |
| [`track-visual-override.md`](track-visual-override.md) | Design only (2026-09-20), nothing built. Per-deck viz / alternate video per track, stored in Digger. |

## 🟡 Partially resolved — core work is done, something specific remains

| Doc | Fixed | Still open |
|---|---|---|
| [`auto-dj-transitions.md`](auto-dj-transitions.md) | Phases 1–4 live-verified. Phase 8 (2026-09-20) landed the two-ended zone model, which resolved `introPoint`'s length-vs-start double duty and split the point rule from the zone rule | Phases 5–8 built + unit-tested, **none live-verified** (7 = fade over the outro zone, self-resetting Preview; 7b = incoming deck starts at its mix-in marker; 8 = four points, two zones, `effectiveZones()`). Phase 8's migration + backfill run 2026-09-20 (library-wide); manual-first marker resolution shipped. Marker-path review: [`auto-dj-zone-review-2026-09-19.md`](auto-dj-zone-review-2026-09-19.md); vocabulary + the unstarted §2 derivation: [`mix-zones.md`](mix-zones.md) |
| [`beatmatching.md`](beatmatching.md) | Root cause #1 fixed | Everything past that is proposed work, not implemented |
| [`tempo-maps.md`](tempo-maps.md) | Analysis only (2026-09-20) — Baianá ramps ~107→122 BPM over ~30–68s, then locks at 122.000; options recorded | Nothing built, deliberately parked; main-body grid is correct today |
| [`codec-frame-cache.md`](codec-frame-cache.md) | Live-verified 2026-08-13 | A short list of explicitly non-blocking open items (§7b) |
| [`ddj-flx4-feature-gaps.md`](ddj-flx4-feature-gaps.md) | Tier 1+2 implemented + bench-verified | Tier 3 — real features, own design pass still needed. Living catalogue, not a closeable doc. |
| [`freeze-watchdog.md`](freeze-watchdog.md) | Phases 1–3 closed 2026-07-25 | Phase 4 (mechanism-B self-heal): implemented, live-repro gate never reproduced enough to trust |
| [`legacy-video-fallback-cost.md`](legacy-video-fallback-cost.md) | Codec-linked cost, draw-frequency fix, VP9 moved to WebCodecs | AV1 renders zero frames on the legacy `<video>` path — no fix known |
| [`mix-zones.md`](mix-zones.md) | §1 (four-point marker vocabulary — `mix_in_start`/`mix_in_end`/`mix_out_start`/`mix_out_end`) built on both sides: cuemark's `effectiveZones()` point/zone trust-rule split, Digger's `migrate.py` step 54 + `importers/backfill_mix_points.py`; cuemark 202/202 and Digger 436/436 tests green. Migration + library-wide backfill run 2026-09-20; duration gap closed. | §2 (deriving a real mix-in point from the cached envelope instead of `beat_times[0]`) not started. |
| [`network-audio-output.md`](network-audio-output.md) | Live-verified end to end, audible | One unconfirmed live report (post-idle hang) and an accepted-for-now edge case (group routing after server restart) |
| [`output-noise-and-track-reload-silence.md`](output-noise-and-track-reload-silence.md) | Bugs A–D (output noise, silent reload, choppy audio, cue-enabled silence) all resolved | Bug E (UI freeze) — superseded into `freeze-watchdog.md` / `webcodecs-video-path.md`, not tracked here anymore |
| [`queue-prefetch-cache.md`](queue-prefetch-cache.md) | — | *(listed here as reference; see 🟢 below — closed with a negative result, not left open)* |
| [`rate-position-drift.md`](rate-position-drift.md) | Two bugs found and fixed | One confirmed-still-open mechanism (slow steady-state drift), root cause not pinned down |
| [`visualization-plugins.md`](visualization-plugins.md) | Phase 1 (2026-09-25): ISF loader, 5 built-ins ported to ISF, plugin folder + Rescan, build errors in panel and log. Headless-verified on `mele`, user-verified live | Phases 2–7 (next: parameters + hot reload). Audio reactivity never confirmed live (phase 3 step 0). Filter-type ISF shaders render black until image inputs load |
| [`waveform-scrub.md`](waveform-scrub.md) | Core scrub + position-mode scratch DONE, live-verified end to end | Latest addendum (platter inertia / jerk damping) not yet verified live — "the default is a guess at someone else's taste" |
| [`webcodecs-video-path.md`](webcodecs-video-path.md) | Phases 1–7 all ran; VP9 shipped on WebCodecs | AV1 explicitly refused — `isConfigSupported` lies, every real decode fails |

## 🟢 Resolved — closed, kept for reference

| Doc | Closed | One-line summary |
|---|---|---|
| [`claude-md-trim.md`](claude-md-trim.md) | 2026-08-12 | CLAUDE.md trimmed 772→639 lines per plan; target below that judged unreachable without cutting real facts |
| [`control-window-frame-budget.md`](control-window-frame-budget.md) | 2026-08-04 | Frame-rate regression fixed (rate-limited transport readout writes); waveform canvas exonerated as a suspect |
| [`deck-eq-and-filter.md`](deck-eq-and-filter.md) | 2026-08-17 | EQ + sweep filters built and live-verified, user-confirmed audibly |
| [`queue-prefetch-cache.md`](queue-prefetch-cache.md) | 2026-08-30 | Phase 1 built; measured preroll dominates load time, not cache — phase 2/3 deliberately not built |
| [`scratch-audio-downstream-delivery.md`](scratch-audio-downstream-delivery.md) | 2026-08-08 | Ringbuffer resync-backwards bug root-caused, fixed, verified live |
| [`scratch-play-race.md`](scratch-play-race.md) | 2026-08-13 | Play-during-scratch transport/clock race root-caused from logs alone, fixed, live-confirmed same day |
| [`slow-jog-audio-inaudible.md`](slow-jog-audio-inaudible.md) | 2026-08-11 | Two `pulsesink`s on one PipeWire node gated cue audio during scratch; fixed via shared-output-pipeline |
| [`webcodecs-video-not-rendering.md`](webcodecs-video-not-rendering.md) | 2026-08-02 | WebCodecs black-screen bug fixed, user re-tested live and confirmed |

## ⚪ Superseded — not fixed, replaced

| Doc | Replaced by |
|---|---|
| [`jog-scratch-audio.md`](jog-scratch-audio.md) | `waveform-scrub.md` / `pcm-buffer-playback.md` for vinyl mode (velocity-derived rate couldn't work from burst-delivered MIDI ticks). Shuttle mode still uses this doc's approach — not fully retired. |

## 📘 Living reference — architecture/design docs, not bug trackers

These stay open forever by design — read them *before* touching the area they cover,
regardless of how settled the underlying feature is.

| Doc | Covers |
|---|---|
| [`av-sync-architecture.md`](av-sync-architecture.md) | Position-tracking drift math, seek races, MIDI rAF-throttling — self-declared reference doc |
| [`branding.md`](branding.md) | Icon/style guide. One flagged open item: accent color unification (UI `#e04040` vs icon `#ff2e6e`) |
| [`native-output-pipeline.md`](native-output-pipeline.md) | Shelved escalation path — deliberately documented, not chosen, not deleted |
| [`pcm-buffer-playback.md`](pcm-buffer-playback.md) | Scratch feeder design/gotchas — the feature is done, this doc is the ongoing "read before touching" reference |
| [`pipewiresink-play-hang.md`](pipewiresink-play-hang.md) | Root cause found 2026-08-02 (upstream GStreamer bug) — mitigation (never multi-instance `pipewiresink`) is permanent guidance |
| [`shared-output-pipeline.md`](shared-output-pipeline.md) | Default since 2026-08-11, all gates passed — but still the doc to read before touching the output graph. **Open (2026-09-19): idle output graph accumulates a clock offset; see "Clock reference drifting while idle"** |
| [`silent-failure-inventory.md`](silent-failure-inventory.md) | Catalogue of ~25 known silent-success failure modes. Nothing here is scheduled work — it's a checklist |
| [`controller-mapping.md`](controller-mapping.md) | Profile system + FLX4 profile bench-verified, but this stays the living doc for adding/re-calibrating any controller |

---

Full per-doc detail and the hard-won investigation narrative live in each file — this table
is intentionally shallow. `CLAUDE.md`'s "Architecture" section carries the *why* behind the
load-bearing facts these docs established; this file carries *current status*, the same split
`docs/environment.md` uses for per-machine hardware facts.
