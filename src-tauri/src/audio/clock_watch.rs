//! Output-node clock watch — the instrument `docs/design/sink-clock-stall.md` §6.3 asks for.
//!
//! Every symptom of that incident (decks silent, or audio delayed by minutes, after the
//! output graph idles) is a clock that stopped or stepped relative to real time, and until
//! this existed nothing in the log could say so: `[deliver-tel]`'s margin goes stale when
//! buffers stop, and the only evidence of the 2026-09-26 wedge was a gdb dump.
//!
//! Each output node gets a thread that, every `SAMPLE_SECS`, reads two clocks and compares
//! how far each *advanced* against how far the monotonic clock advanced over the same
//! interval:
//!
//! - **`pipeline`** — the clock the node's pipeline actually runs on (and, since the decks
//!   adopt the published clock, the one that paces every `appsink`).
//! - **`sink`** — the `pulsesink`'s own audio clock (`provide_clock()`), sampled even when
//!   the pipeline is pinned to `GstSystemClock`, so a pulse-clock step is still visible
//!   after the pin removes its consequences.
//!
//! An advance that differs from real time by more than `STEP_WARN_MS` is a step; an advance
//! near zero is a stall. Both WARN immediately; a summary line goes out every
//! `SUMMARY_EVERY` samples so a healthy run is also on record (a warning's absence proves
//! nothing if the thread died).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use gstreamer::glib;
use gstreamer::{self as gst, prelude::*};

/// Seconds between samples.
const SAMPLE_SECS: u64 = 5;
/// Samples between INFO summaries (5s × 6 = 30s).
const SUMMARY_EVERY: u32 = 6;
/// |clock advance − real advance| over one interval past which it is called a step. Healthy
/// clocks agree to well under a millisecond per interval; 100ms is far from both.
const STEP_WARN_MS: f64 = 100.0;
/// A clock that advanced less than this fraction of the real interval is stalled.
const STALL_FRACTION: f64 = 0.1;

/// What one comparison found.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Verdict {
    Ok,
    /// Advanced by roughly nothing while real time passed.
    Stalled,
    /// Advanced by a different amount than real time; positive = ran ahead.
    Stepped,
}

#[derive(Debug, Clone, Copy)]
pub struct Sample {
    /// Real (monotonic) milliseconds since the previous sample.
    pub real_ms: f64,
    /// How far the clock advanced over that interval, in milliseconds.
    pub clock_ms: f64,
    /// `clock_ms − real_ms`.
    pub error_ms: f64,
    /// Accumulated `clock − monotonic` offset since the baseline, in milliseconds. A healthy
    /// clock sits near 0; a stall drifts negative and a forward step drifts positive.
    pub drift_ms: f64,
    pub verdict: Verdict,
}

/// Compares one clock against the monotonic clock across successive readings. Pure, so the
/// classification is unit-tested without a device.
#[derive(Default)]
pub struct ClockSampler {
    /// `(clock_ns, mono_ns)` at the previous reading; `None` until baselined.
    last: Option<(u64, u64)>,
    /// `clock_ns − mono_ns` at the baseline, as i128 (both are u64-range).
    baseline_offset: i128,
}

impl ClockSampler {
    /// Forget history — used when the clock object changes identity, since a comparison
    /// across two different clocks means nothing.
    pub fn reset(&mut self) {
        self.last = None;
    }

    /// Feed one reading. The first after `reset()` only baselines and returns `None`.
    pub fn observe(&mut self, clock_ns: u64, mono_ns: u64) -> Option<Sample> {
        let Some((pc, pm)) = self.last else {
            self.last = Some((clock_ns, mono_ns));
            self.baseline_offset = clock_ns as i128 - mono_ns as i128;
            return None;
        };
        self.last = Some((clock_ns, mono_ns));
        let real_ms = mono_ns.saturating_sub(pm) as f64 / 1e6;
        let clock_ms = (clock_ns as i128 - pc as i128) as f64 / 1e6;
        let error_ms = clock_ms - real_ms;
        let drift_ms = ((clock_ns as i128 - mono_ns as i128) - self.baseline_offset) as f64 / 1e6;
        let verdict = if real_ms > 0.0 && clock_ms < real_ms * STALL_FRACTION {
            Verdict::Stalled
        } else if error_ms.abs() > STEP_WARN_MS {
            Verdict::Stepped
        } else {
            Verdict::Ok
        };
        Some(Sample { real_ms, clock_ms, error_ms, drift_ms, verdict })
    }
}

/// Buffer counters a node's sink-pad probe maintains, read by the watch thread.
#[derive(Default)]
pub struct NodeFlow {
    /// Buffers that carried audio (not flagged GAP).
    pub real: AtomicU64,
    /// GAP-flagged buffers — keepalive silence, or a mixer with no live input.
    pub gap: AtomicU64,
}

fn mono_ns() -> u64 {
    (glib::monotonic_time().max(0) as u64) * 1000
}

fn clock_id(c: &gst::Clock) -> usize {
    c.as_ptr() as usize
}

/// Spawn the watch thread for one node. It holds weak references only and exits when the
/// pipeline is dropped or reaches Null, so a rebuilt node does not leak a thread.
pub fn spawn(node: &str, pipeline: &gst::Pipeline, sink: &gst::Element, flow: Arc<NodeFlow>) {
    let node = node.to_string();
    let pipeline_w = pipeline.downgrade();
    let sink_w = sink.downgrade();
    let spawned = std::thread::Builder::new()
        .name(format!("clockwatch-{node}"))
        .spawn(move || {
            let mut pipe_s = ClockSampler::default();
            let mut sink_s = ClockSampler::default();
            let mut pipe_id = 0usize;
            let mut sink_id = 0usize;
            let (mut last_real, mut last_gap) = (0u64, 0u64);
            let mut tick = 0u32;
            loop {
                std::thread::sleep(Duration::from_secs(SAMPLE_SECS));
                let (Some(pipeline), Some(sink)) = (pipeline_w.upgrade(), sink_w.upgrade()) else {
                    return;
                };
                let (_, cur, _) = pipeline.state(gst::ClockTime::ZERO);
                if cur == gst::State::Null {
                    return;
                }
                tick += 1;
                let mono = mono_ns();
                let line = |label: &str, clock: Option<gst::Clock>, s: &mut ClockSampler, id: &mut usize| {
                    let Some(clock) = clock else {
                        s.reset();
                        *id = 0;
                        return format!("{label}=none");
                    };
                    if clock_id(&clock) != *id {
                        *id = clock_id(&clock);
                        s.reset();
                    }
                    let kind = clock.type_().name();
                    let Some(t) = clock.time() else { return format!("{label}={kind} no-time") };
                    match s.observe(t.nseconds(), mono) {
                        None => format!("{label}={kind} baseline"),
                        Some(smp) => {
                            if smp.verdict != Verdict::Ok {
                                log::warn!(
                                    "[audio/out/{node}] CLOCK {} — {label} clock ({kind}) advanced \
                                     {:.0}ms over {:.0}ms of real time (error {:+.0}ms, cumulative \
                                     drift {:+.1}s). {}See docs/design/sink-clock-stall.md.",
                                    if smp.verdict == Verdict::Stalled { "STALLED" } else { "STEPPED" },
                                    smp.clock_ms, smp.real_ms, smp.error_ms, smp.drift_ms / 1000.0,
                                    if label == "sink" {
                                        "This is the pulsesink's own clock; decks only feel it if it is also the published shared clock. "
                                    } else {
                                        "Decks' appsinks pace against this clock: expect silent or delayed audio. "
                                    },
                                );
                            }
                            format!("{label}={kind} drift {:+.0}ms", smp.drift_ms)
                        }
                    }
                };
                let p = line("pipeline", pipeline.clock(), &mut pipe_s, &mut pipe_id);
                let s = line("sink", sink.provide_clock(), &mut sink_s, &mut sink_id);
                let summary = format!("{p} | {s}");

                if tick % SUMMARY_EVERY == 0 {
                    let real = flow.real.load(Ordering::Relaxed);
                    let gap = flow.gap.load(Ordering::Relaxed);
                    let secs = (SAMPLE_SECS * SUMMARY_EVERY as u64) as f64;
                    log::info!(
                        "[audio/out/{node}] node-tel: real={:.0}/s gap={:.0}/s | {summary}",
                        (real - last_real) as f64 / secs,
                        (gap - last_gap) as f64 / secs,
                    );
                    last_real = real;
                    last_gap = gap;
                }
            }
        });
    if let Err(e) = spawned {
        log::warn!("[audio/out] could not start the clock watch thread: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    #[test]
    fn first_reading_only_baselines() {
        let mut s = ClockSampler::default();
        assert!(s.observe(10 * MS, 20 * MS).is_none());
    }

    #[test]
    fn a_clock_tracking_real_time_is_ok() {
        let mut s = ClockSampler::default();
        s.observe(1_000 * MS, 5_000 * MS);
        let smp = s.observe(6_000 * MS, 10_000 * MS).unwrap();
        assert_eq!(smp.verdict, Verdict::Ok);
        assert!(smp.error_ms.abs() < 0.001 && smp.drift_ms.abs() < 0.001);
    }

    #[test]
    fn a_frozen_clock_is_stalled_and_drifts_negative() {
        let mut s = ClockSampler::default();
        s.observe(1_000 * MS, 5_000 * MS);
        let smp = s.observe(1_000 * MS, 10_000 * MS).unwrap();
        assert_eq!(smp.verdict, Verdict::Stalled);
        assert!((smp.drift_ms + 5_000.0).abs() < 0.001);
    }

    #[test]
    fn a_clock_that_jumps_forward_is_a_step_with_positive_error() {
        // The 2026-09-25 shape: buffers stamped minutes ahead means the clock lagged, but the
        // mirror image (a clock running ahead) must classify the same way.
        let mut s = ClockSampler::default();
        s.observe(0, 0);
        let smp = s.observe(5_000 * MS + 300_000 * MS, 5_000 * MS).unwrap();
        assert_eq!(smp.verdict, Verdict::Stepped);
        assert!(smp.error_ms > 100_000.0);
    }

    #[test]
    fn a_clock_running_3_6x_fast_is_a_step() {
        // The 09-19 "bursts at 3.6× real time" shape.
        let mut s = ClockSampler::default();
        s.observe(0, 0);
        let smp = s.observe(18_000 * MS, 5_000 * MS).unwrap();
        assert_eq!(smp.verdict, Verdict::Stepped);
    }

    #[test]
    fn a_small_jitter_is_not_a_step() {
        let mut s = ClockSampler::default();
        s.observe(0, 0);
        let smp = s.observe(5_040 * MS, 5_000 * MS).unwrap();
        assert_eq!(smp.verdict, Verdict::Ok);
    }

    #[test]
    fn reset_rebaselines_so_a_new_clock_is_not_compared_to_the_old_one() {
        let mut s = ClockSampler::default();
        s.observe(0, 0);
        s.reset();
        assert!(s.observe(9_999_999 * MS, 5_000 * MS).is_none());
    }
}
