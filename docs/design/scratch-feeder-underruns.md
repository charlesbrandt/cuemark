# Scratch feeder starves the sink during a vinyl-mode gesture

Status: **open, not investigated.** Found incidentally 2026-08-03 while measuring
control-window frame budget (`control-window-frame-budget.md`); logged here rather than
chased, because it is a different subsystem from the investigation that surfaced it.

## Symptom

User report: "something strange happened with the jog once I stopped playing the track."

The deck was paused, then jogged in vinyl mode. During the gesture the GStreamer output
queue underran continuously:

```
23:20:34.740 [scratch/deck-0] feeder start frame=2158607 rate=0.020 hold_ms=40
23:20:34.959 [audio/deck-0] output_queue underrun (total=1)   — the pipeline is not producing
                            audio fast enough to keep the sink fed; expect audible choppiness
23:20:39.960 [audio/deck-0] output_queue underrun (total=336)
23:20:40.354 [frontend] [scratch/deck-0] idle timer fired 1ms late (main thread gate)
23:20:40.365 [scratch/deck-0] feeder stop frame=2135019
23:20:40.365 [scratch] feeder thread joined in 10.3ms
23:20:40.503 [scratch/deck-0] teardown timing: total=148.0ms warmup_seek=1.3ms resync_seek=6.0ms
```

**335 underruns in 5.0 seconds — ~67/sec — for the whole duration of the gesture**, then
only 28 more over the following 20 seconds. The underruns are concentrated in the gesture
and stop when it does.

## What is *not* the cause

Ruled out by measurements taken in the same window, so these do not need re-deriving:

- **Not main-thread latency.** The control window was healthy throughout: the
  `deck-0/scratch` position-poll bucket read `total p50=39ms` at ~25fps, and the scratch
  idle timer fired **1ms late**. Whatever starves the sink is downstream of the frontend.
- **Not IPC or mutex contention.** Poll legs in that window: `toRust p50=2ms`,
  `inRust p50=0ms`, `lock p50=0ms`, `query p50=0ms`.
- **Not `stop_scratch` teardown.** It held the pipeline detached for 148ms, inside its
  documented 130–400ms budget (`with_pipeline_detached`, `pcm-buffer-playback.md`), and it
  ran *after* the underruns rather than during them.
- **Not the transport-retry storm** fixed the same day — that log window shows 5 detached
  calls in 90 seconds, not the old 15–25/sec.

## Leads

The feeder was running at `rate=0.020` — exactly vinyl's `minRate` floor
(`SCRATCH_MODE_PARAMS.vinyl` in `src/lib/midi/handler.ts`), i.e. the wheel was barely
moving. Note the cursor went *backwards* over the gesture (2158607 → 2135019, about 0.49s
of audio), so this was reverse motion, which is expected and supported.

The obvious question first: **at a rate that low, is the feeder still producing a full
48kHz of output frames, or is it producing `rate ×` real-time?** It must be the former —
the feeder walks the PCM buffer at `rate` input frames per *output* frame, so output rate
is constant and only the read cursor slows. If the implementation instead ties chunk
production to the read cursor, a near-zero rate produces near-zero output and starves the
sink by construction, which would match this signature exactly. That is the first thing to
check in `spawn_scratch_feeder` (`src-tauri/src/audio/pipeline.rs`).

Second candidate: `hold_ms=40` for vinyl means the feeder decays to silence/hold almost
immediately between ticks. If "hold" is implemented as *not pushing buffers* rather than
*pushing silence*, every micro-gap between wheel ticks underruns the queue. The 67/sec rate
is suspiciously close to a per-tick or per-chunk cadence (chunks are 15ms → ~67/sec — this
is very likely one underrun per chunk, i.e. the feeder never keeps up for the whole
gesture).

That last arithmetic coincidence is the strongest lead in this document: **~67/sec is
1/15ms, the feeder's own chunk period.**

## Deliberately not concluded

The log also shows `main sink 0: buffer flow resumed after a 1.3s / 8.1s / 13.3s gap`
around this window. Those spans line up exactly with periods when the deck was paused, so
they are most likely benign and are *not* evidence of a fault. They were briefly reported
as "the device starved for 8–13s" during the live session; that reading was wrong. Don't
build a theory on them without first confirming what a paused deck is expected to send.

## Reproducing

Pause a deck, set scratch mode to vinyl (`audioSettings.ts`), and jog slowly — slowly
enough to sit near the `minRate` floor. Watch for `output_queue underrun` in
`~/.local/share/com.cuemark.app/logs/cuemark.log`. A fast gesture may not reproduce it if
the cause is rate-dependent, which is itself a useful signal: **compare a slow gesture
against a fast one and against shuttle mode** (`minRate` 0.15, `holdMs` 100_000) before
concluding anything.

## Related

- `docs/design/pcm-buffer-playback.md` — the feeder's design, the scratch-freeze history,
  and the teardown/resync path
- `docs/design/jog-scratch-audio.md` — mode tuning
- `skills/audio-debugging` — GStreamer bus errors and pipeline recovery
