/// Per-deck GStreamer audio pipeline.
///
/// Topology:
///   uridecodebin → queue(max-buffers=2) → audioconvert → audioresample
///     → capsfilter(48kHz) → pitch → [spectrum] → output_queue → tee
///         ├─ volume₀ → sink₀  ┐
///         ├─ volume₁ → sink₁  ┤  one branch per main output device (≥1; empty → system default)
///         └─ cue_valve → cue_volume → cue_queue → pulsesink(cue) | fakesink
///
/// The cue branch is always wired. `cue_valve` (drop-buffers=true when cue is off)
/// gates it without blocking the tee. A `fakesink` is used when no cue device is
/// selected so the pipeline loads successfully regardless of headphone availability.

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type EosCallback = Arc<dyn Fn() + Send + Sync>;

use gstreamer::{self as gst, glib, prelude::*};
use gstreamer_app::AppSrc;
use tauri::Emitter;
use super::analysis;
use super::pcm_buffer::{self, PcmBuffer};

/// Steady-state `output_queue` cap — see its field comment in `load()`. Shared
/// constant so `scratch()`'s transient widen/narrow (below) and the initial
/// setup in `load()` can't drift out of sync.
const OUTPUT_QUEUE_STEADY_CAP_NS: u64 = 100_000_000; // 100ms

/// `output_queue` cap held for the duration of a scratch gesture. Root-caused
/// via live `gdb` (docs/design/pcm-buffer-playback.md, "Seventh mechanism"):
/// the `Paused→Playing` transition in `scratch()` below is followed by a
/// window — hundreds of ms to a couple seconds — where `pipewiresink`'s pull
/// cadence lags while PipeWire re-establishes its RT cycle. At the steady
/// 100ms cap, `output_queue` (a stock `queue` between `input_selector` and
/// `tee`) hits its limit during that window and applies ordinary `GstQueue`
/// backpressure, blocking `appsrc`'s own push thread mid `gst_pad_push()` —
/// this is the "reverse scratch is silent" bug. Widening the cap for the
/// gesture's duration (narrowed back in stop_scratch_feeder(), not on a
/// timer — see its comment) absorbs the catch-up instead of blocking.
const SCRATCH_STARTUP_QUEUE_CAP_NS: u64 = 2_000_000_000; // 2s

/// Attach rate-limited flow logging to `output_queue` (the queue feeding tee → volume →
/// sink) — the last point in the graph shared by every output branch.
///
/// **Why this exists**: audio symptoms in this app ("it's choppy", "the second track is
/// silent") all present identically in the existing logs — the pipeline reaches
/// `Playing`, no bus `ERROR` is posted, and the applied volume is correct. That proves
/// the graph was *built* and *started*, not that samples are *moving*. `pulsesink`
/// reports underflows only at `GST_DEBUG` level, so nothing surfaces the difference.
/// A `queue`'s own `underrun`/`overrun` signals do, and they discriminate three cases
/// that need completely different fixes:
///
/// - **`underrun` while Playing** — `uridecodebin`/`audioconvert`/`pitch` (soundtouch is
///   the expensive one) can't produce a second of audio per second of wall clock, usually
///   because the GStreamer streaming thread is losing CPU to the WebKitWebProcess. The
///   problem is UPSTREAM; widening the sink buffer only delays it.
/// - **No `underrun`, but audio is still choppy** — samples move through this queue
///   steadily and the gap happens past it, i.e. in the sink's own ringbuffer. That points
///   at `sink_buffer_times()` being too small to ride out scheduling jitter.
///
/// Only `underrun` is watched, **not `overrun`**: with a synced sink, upstream decode
/// runs far faster than real time and backpressure holds this queue at or near its cap
/// for the entire duration of healthy playback, so `overrun` fires continuously when
/// nothing is wrong. An empty queue is the anomaly here; a full one is the steady state.
/// (For "did audio reach the device at all", see `instrument_sink_flow()` — a queue
/// signal cannot answer that, since a stalled sink leaves this queue *full*.)
///
/// Gated on `playing` (a `queue` legitimately signals `underrun` while empty during
/// preroll and at EOS) and rate-limited, since a real episode fires continuously.
///
/// `playing` is a plain `AtomicBool` written by the bus thread rather than a
/// `current_state()` query, deliberately: these signals are emitted **from the queue's
/// own streaming thread while it holds the queue lock**, and querying element state
/// there would take `GST_OBJECT_LOCK` underneath it. This project has already lost
/// multiple sessions to lock-ordering deadlocks in the audio path
/// (`docs/design/pipewiresink-play-hang.md`), so a diagnostic must not introduce a new
/// lock acquisition on a streaming thread. A relaxed atomic load costs nothing and
/// cannot deadlock; being one bus-message late on a state change is irrelevant here.
fn instrument_queue_flow(output_queue: &gst::Element, deck_id: &str, playing: &Arc<AtomicBool>) {
    const LOG_EVERY: Duration = Duration::from_secs(5);

    fn connect_counted(
        queue: &gst::Element,
        signal: &'static str,
        deck_id: String,
        playing: Arc<AtomicBool>,
        message: &'static str,
    ) {
        // (events seen, last time one was logged). The first event logs immediately so
        // the onset is timestamped precisely; the rest collapse into a running total.
        let state = Arc::new(Mutex::new((0u64, None::<Instant>)));
        let _ = queue.connect(signal, false, move |_args| {
            if !playing.load(Ordering::Relaxed) {
                return None; // preroll/paused/EOS — an empty or backed-up queue is expected
            }
            let mut st = state.lock().unwrap();
            st.0 += 1;
            if st.1.is_none_or(|last| last.elapsed() >= LOG_EVERY) {
                st.1 = Some(Instant::now());
                log::warn!(
                    "[audio/{deck_id}] output_queue {signal} (total={}) — {message} \
                     See instrument_queue_flow()'s doc comment for how to read this.",
                    st.0
                );
            }
            None
        });
    }

    connect_counted(
        output_queue,
        "underrun",
        deck_id.to_string(),
        playing.clone(),
        "the pipeline is not producing audio fast enough to keep the sink fed; expect \
         audible choppiness. Points UPSTREAM (decode/soundtouch/CPU contention), NOT at \
         the sink buffer.",
    );
}

/// Log the first buffer that actually reaches a main output sink, and any resumption
/// after a gap of more than a second.
///
/// **Why this exists**: reaching `Playing` with no bus `ERROR`, the right volume and the
/// right device proves the graph was *built and started*. It does not prove a single
/// sample ever reached the hardware. That distinction is the whole of Bug B in
/// `docs/design/output-noise-and-track-reload-silence.md` — load a second track onto a
/// deck and it plays silently, with a bus log identical, line for line, to the load that
/// worked. `instrument_queue_flow()` above cannot answer it either: a sink that has
/// stopped consuming leaves `output_queue` *full*, which is also what healthy playback
/// looks like.
///
/// So: a pad probe on the sink's own sink pad, which is the last measurable point before
/// the device. On a silent deck, the single line this emits (or doesn't) splits Bug B in
/// half — no line at all means nothing reached the sink and the fault is upstream in the
/// rebuilt graph; a line means audio *was* delivered and the fault is the sink/device
/// (hypothesis 1: PipeWire/ALSA not releasing the node before the rebuilt `pulsesink`
/// reopened it).
///
/// Deliberately event-driven rather than periodic — one line per load, plus one per
/// recovered stall — so this stays readable across a multi-hour set instead of becoming
/// the next thing that drowns the log.
///
/// **Gated on `playing`, exactly like `instrument_queue_flow()` above and for the same
/// reason** (added 2026-08-05, `docs/design/audio-dropout-mid-playback.md` D2). Ungated,
/// the gap check measured *any* span between two buffers at the sink — including the one
/// between the single preroll buffer and the first buffer after the user presses play.
/// In the 2026-08-05 live set that produced **six false "Ns gap" warnings for every real
/// one**, each stamped in the same millisecond as a `Paused → Playing` transition, and the
/// noise is what nearly buried the single genuine 10.8s dropout.
///
/// The gate is not just "was the deck playing when this buffer arrived" — that alone still
/// misreports a pause/resume, because the last buffer before the pause is recorded while
/// still Playing and the bus message announcing the pause can easily lose the race to the
/// first buffer after the resume. Instead **`last` is cleared whenever the deck is not
/// playing**, from both sides: by this probe when a buffer arrives with the flag false,
/// and by the bus thread's `StateChanged` handler on any transition out of `Playing`
/// (which is why this returns its state handle). A gap is therefore only ever measured
/// between two buffers that were *both* delivered inside one continuous `Playing` span —
/// which is exactly the condition that makes it evidence of a fault.
///
/// **`gates` is a conjunction: every flag must be true for a gap to be measurable.** Main
/// sinks pass just `at_playing`. The cue sink (added 2026-08-08) passes `at_playing` *and*
/// `cue_open`, because `cue_valve` drops every buffer while cue is off — so without the
/// second gate, each cue-off span is a perfect forgery of the very dropout this probe
/// exists to catch, and a user toggling cue would manufacture a "gap" every time. ⚠️ The
/// D2 lesson repeats exactly here and is easy to get wrong twice: **the gate alone is not
/// sufficient.** The last buffer before the valve closes is recorded with both flags true,
/// and no further buffer ever arrives to clear it (the valve drops them upstream of this
/// pad), so `set_cue_enabled()` must invalidate `last` itself — see its call into
/// `cue_sink_flow`. Both sides, same as the pause/resume case.
///
/// Each gate is read with a relaxed `AtomicBool` load and **must stay that way**: this
/// probe runs on the sink's streaming thread, and a `current_state()` query there would
/// take `GST_OBJECT_LOCK` under it. See `instrument_queue_flow()`'s doc comment for the
/// full argument and the deadlock history it comes from.
///
/// The warning reports the gap's *onset* as well as its duration. The correlation that
/// broke the 2026-08-05 investigation open — that the stall began within 200 ms of an
/// `output_queue underrun` — had to be back-computed by hand from the duration, and was
/// nearly missed.
fn instrument_sink_flow(
    sink: &gst::Element,
    deck_id: &str,
    label: &str,
    gates: Vec<Arc<AtomicBool>>,
) -> Option<SinkFlowState> {
    let Some(pad) = sink.static_pad("sink") else {
        log::warn!("[audio/{deck_id}] {label}: no sink pad to probe for flow diagnostics");
        return None;
    };
    let state: SinkFlowState = Arc::new(Mutex::new(SinkFlow::default()));
    let probe_state = state.clone();
    let deck_id = deck_id.to_string();
    let label = label.to_string();
    pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        let is_playing = gates.iter().all(|g| g.load(Ordering::Relaxed));
        let now = Instant::now();
        let mut st = probe_state.lock().unwrap();
        if !st.first_logged {
            // Kept ungated: "did a single sample ever reach the device" is the question
            // this probe exists to answer (Bug B), and it is asked of a deck that has just
            // prerolled. Gating it would delete the one line that splits that bug in half.
            st.first_logged = true;
            log::info!(
                "[audio/{deck_id}] {label}: first buffer reached the sink — audio is \
                 being delivered to the device"
            );
        } else if is_playing {
            if let Some(prev) = st.last {
                let gap = now.duration_since(prev);
                if gap > Duration::from_secs(1) {
                    log::warn!(
                        "[audio/{deck_id}] {label}: buffer flow resumed after a {:.1}s gap \
                         (began {}) — the device received no audio for that span, and the \
                         pipeline was Playing throughout. See instrument_sink_flow()'s doc \
                         comment.",
                        gap.as_secs_f64(),
                        wall_clock_utc(SystemTime::now().checked_sub(gap)),
                    );
                }
            }
        }
        st.last = if is_playing { Some(now) } else { None };
        gst::PadProbeReturn::Ok
    });
    Some(state)
}

/// Per-sink state for `instrument_sink_flow()`'s pad probe. `last` is deliberately
/// `None` for any moment from which a gap cannot legitimately be measured: before the
/// first buffer, and across every span the deck was not `Playing`.
#[derive(Default)]
struct SinkFlow {
    first_logged: bool,
    last: Option<Instant>,
}

/// Shared with the bus thread so a transition out of `Playing` can invalidate the last
/// buffer time — see `instrument_sink_flow()`.
type SinkFlowState = Arc<Mutex<SinkFlow>>;

/// Buffer delivery counters for `volume` → `pulsesink`, the one span between the scratch
/// feeder and the speakers that nothing else measures.
///
/// Added 2026-08-08 for `docs/design/scratch-audio-downstream-delivery.md`. That
/// investigation established the feeder is healthy (`[scratch-tel]` rms, F1) and that
/// `appsrc → input_selector` delivers everything (F2's pad probes), then ran the
/// device-routing A/B down to arm A4 — a single `pulsesink` on a single device, nothing
/// on the controller — where the audio still dies mid-gesture and stays dead until the
/// next gesture. That kills every routing hypothesis and leaves two candidates this
/// probe separates in one reading:
///
/// - **`count` stops advancing** ⇒ the stall is in `output_queue`/`tee`/`volume`; the
///   sink is starved and the question becomes what stopped upstream of it.
/// - **`count` keeps advancing while nothing is audible** ⇒ buffers are reaching the
///   device and not being rendered, which is H5 (zero sink margin): the feeder produces
///   exactly real time with `do-timestamp=true`, so buffers carry no head start, and a
///   gesture that re-rolls `base_time` on its `Paused → Playing` can leave every
///   subsequent buffer late for the rest of that span.
///
/// `margin_us` is what adjudicates the second case: a buffer's own running time minus
/// the element's current running time. Positive means it arrived ahead of the clock and
/// the sink can wait for it; negative means it is already late on arrival, and a
/// steadily-more-negative margin across a gesture *is* H5, measured rather than argued.
///
/// ⚠️ Deliberately **not** gated on `at_playing` like `instrument_sink_flow()`. That gate
/// is why the existing sink-flow warning cannot see this fault at all: it only reports a
/// gap when flow *resumes*, and a stall that persists to the end of the gesture is
/// followed by a transition out of `Playing` that invalidates the timestamp — so the
/// warning is structurally unreachable here. These are plain counters read by the feeder
/// telemetry once a second, which sidesteps that entirely.
struct DeliveryProbe {
    label: String,
    /// Buffers seen at this pad since the pipeline was built. Read as a per-second delta.
    count: AtomicU64,
    /// Most recent buffer's running time minus the element's current running time, in
    /// microseconds. `i64::MIN` = never set (no PTS, or no clock yet).
    margin_us: AtomicI64,
}

/// All delivery probes for one pipeline, shared with the scratch feeder so a gesture's
/// telemetry line can carry delivery counts alongside the rms that produced them —
/// correlating them by hand across two log lines is what made this fault hard to read.
type DeliveryProbes = Arc<Vec<Arc<DeliveryProbe>>>;

fn instrument_delivery(element: &gst::Element, pad_name: &str, label: &str) -> Option<Arc<DeliveryProbe>> {
    let pad = element.static_pad(pad_name)?;
    let probe = Arc::new(DeliveryProbe {
        label: label.to_string(),
        count: AtomicU64::new(0),
        margin_us: AtomicI64::new(i64::MIN),
    });
    let probe_ref = probe.clone();
    // Weak, so the probe closure can never keep the element alive across a rebuild.
    let elem_weak = element.downgrade();
    pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, info| {
        probe_ref.count.fetch_add(1, Ordering::Relaxed);
        if let Some(gst::PadProbeData::Buffer(buf)) = &info.data {
            if let (Some(pts), Some(elem)) = (buf.pts(), elem_weak.upgrade()) {
                if let Some(now) = elem.current_running_time() {
                    let margin_ns = pts.nseconds() as i64 - now.nseconds() as i64;
                    probe_ref.margin_us.store(margin_ns / 1000, Ordering::Relaxed);
                }
            }
        }
        gst::PadProbeReturn::Ok
    });
    Some(probe)
}

/// Report every `DeliveryProbe` on this pipeline once per 5s **while the deck is playing**,
/// as `[deliver-tel/<deck>]`.
///
/// Added 2026-08-08. Until now the counters existed but were read only by the scratch
/// feeder's own telemetry loop, which lives for the duration of a gesture — so during
/// ordinary playback, the exact scenario `docs/design/audio-dropout-mid-playback.md` is
/// about, nothing read them at all. That is why the 2026-08-05 live dropout could not be
/// adjudicated after the fact: the one instrument that answers "did buffers keep reaching
/// the device while the room went quiet" was structurally unreachable outside a scratch.
///
/// **Sampled every 1s, emitted every 5s.** The 5s cadence matches the rest of this
/// project's standing instrumentation and keeps a multi-hour set readable; the 1s
/// sampling is what preserves the resolution that matters, because the fault under
/// investigation is a second-scale stall that a 5s mean would average away into nothing.
/// Hence `min` per label — **that is the field to read**. A healthy branch reports a min
/// within a buffer or two of its mean; `min 0/s` means a full second delivered nothing,
/// which is the D1 signature and is invisible in the mean.
///
/// `margin` is `DeliveryProbe::margin_us` — buffer running time minus element running
/// time. Its *minimum* over the window is the H5 field (see `DeliveryProbe`): steadily
/// negative means buffers are arriving already late and the sink has no slack to absorb
/// anything, whether or not a gap ever gets long enough to trip `instrument_sink_flow()`.
///
/// Gated on `at_playing` so an idle deck logs nothing, and the per-second baseline is
/// reset while paused so the first line after a resume is not one giant delta.
///
/// Terminates when the pipeline is torn down: it holds a `Weak` to the probe vec, which
/// only `PipelineInner` (and any live scratch feeder) keeps alive, so a rebuild drops it
/// and the next tick exits rather than leaking a thread per `set_devices()`.
fn spawn_delivery_reporter(deck_id: &str, probes: &DeliveryProbes, playing: &Arc<AtomicBool>) {
    if probes.is_empty() {
        return;
    }
    let weak = Arc::downgrade(probes);
    let playing = playing.clone();
    let deck_id = deck_id.to_string();
    std::thread::spawn(move || {
        // Per-label: last cumulative count, and the accumulating window stats.
        let mut last_counts: Vec<u64> = Vec::new();
        let mut win_total: Vec<u64> = Vec::new();
        let mut win_min: Vec<f64> = Vec::new();
        let mut win_margin_min: Vec<i64> = Vec::new();
        let mut win_margin_last: Vec<i64> = Vec::new();
        let mut samples = 0u32;
        /// Ticks to baseline-only after a resume before measuring. See the skip below.
        const RESUME_SKIP_TICKS: u8 = 2;
        let mut resume_skip = RESUME_SKIP_TICKS;

        loop {
            std::thread::sleep(Duration::from_secs(1));
            let Some(probes) = weak.upgrade() else { return };

            if last_counts.len() != probes.len() {
                last_counts = probes.iter().map(|p| p.count.load(Ordering::Relaxed)).collect();
                win_total = vec![0; probes.len()];
                win_min = vec![f64::MAX; probes.len()];
                win_margin_min = vec![i64::MAX; probes.len()];
                win_margin_last = vec![i64::MIN; probes.len()];
                samples = 0;
            }

            let is_playing = playing.load(Ordering::Relaxed);
            if !is_playing {
                // Re-baseline without reporting: the counts kept moving during preroll and
                // will move again on resume, and a delta spanning the pause is not a rate.
                for (i, p) in probes.iter().enumerate() {
                    last_counts[i] = p.count.load(Ordering::Relaxed);
                    win_total[i] = 0;
                    win_min[i] = f64::MAX;
                    win_margin_min[i] = i64::MAX;
                    win_margin_last[i] = i64::MIN;
                }
                samples = 0;
                resume_skip = RESUME_SKIP_TICKS;
                continue;
            }
            if resume_skip > 0 {
                // Baseline only, twice. One skip is not enough, measured 2026-08-08: the
                // first tick's delta straddles the pause, and the *second* second is where
                // `pulsesink` reopening the device lands, which shows up as a legitimate
                // `min 0/s` that has nothing to do with the stall this reporter exists to
                // find. Reporting it would put a cry-wolf zero in the one field the design
                // doc tells people to read — the same mistake D2 had to undo for
                // `instrument_sink_flow()`.
                for (i, p) in probes.iter().enumerate() {
                    last_counts[i] = p.count.load(Ordering::Relaxed);
                }
                resume_skip -= 1;
                continue;
            }

            for (i, p) in probes.iter().enumerate() {
                let now = p.count.load(Ordering::Relaxed);
                let delta = now.saturating_sub(last_counts[i]);
                last_counts[i] = now;
                win_total[i] += delta;
                win_min[i] = win_min[i].min(delta as f64);
                let m = p.margin_us.load(Ordering::Relaxed);
                if m != i64::MIN {
                    win_margin_last[i] = m;
                    win_margin_min[i] = win_margin_min[i].min(m);
                }
            }
            samples += 1;
            if samples < 5 {
                continue;
            }

            let report = probes
                .iter()
                .enumerate()
                .map(|(i, p)| {
                    let mean = win_total[i] as f64 / samples as f64;
                    let min = if win_min[i] == f64::MAX { 0.0 } else { win_min[i] };
                    let margin = if win_margin_last[i] == i64::MIN {
                        "no ts".to_string()
                    } else {
                        format!(
                            "{:+.0}ms(min {:+.0}ms)",
                            win_margin_last[i] as f64 / 1000.0,
                            win_margin_min[i] as f64 / 1000.0,
                        )
                    };
                    format!("{}={mean:.0}/s(min {min:.0}) margin {margin}", p.label)
                })
                .collect::<Vec<_>>()
                .join(" | ");
            log::info!("[deliver-tel/{deck_id}] {report}");

            for i in 0..probes.len() {
                win_total[i] = 0;
                win_min[i] = f64::MAX;
                win_margin_min[i] = i64::MAX;
            }
            samples = 0;
        }
    });
}

/// Time-of-day in UTC, matching the log formatter in `lib.rs` so a timestamp printed
/// inside a message can be grepped against the line prefixes around it.
fn wall_clock_utc(t: Option<SystemTime>) -> String {
    let Some(d) = t.and_then(|t| t.duration_since(UNIX_EPOCH).ok()) else {
        return "unknown".into();
    };
    time::OffsetDateTime::from_unix_timestamp(d.as_secs() as i64)
        .ok()
        .and_then(|dt| {
            dt.format(&time::macros::format_description!(
                "[hour]:[minute]:[second]"
            ))
            .ok()
        })
        .map(|hms| format!("{hms}.{:03}", d.subsec_millis()))
        .unwrap_or_else(|| "unknown".into())
}

/// Sink ringbuffer sizing as `(buffer_time_us, latency_time_us)`. `buffer-time` is the
/// total playback buffer the sink keeps queued at the device; `latency-time` is how much
/// it writes per wakeup.
///
/// **Was 50ms/10ms until 2026-08-02; now 200ms/20ms (`pulsesink`'s own defaults), which
/// fixed live-reproduced choppiness and silence on a USB DJ controller.**
///
/// The old 50ms was vestigial. It was chosen in May 2026 (see journal.md) for a problem
/// that no longer exists: a rate change was a FLUSH seek back then, and the sink's
/// default 200ms of already-buffered old-rate audio drained *while* the new segment
/// started, producing an audible "doubled/detuned" artifact — so the buffer was cut to
/// shorten the overlap. Rate changes now go through the `pitch` element's `tempo`
/// property with no seek and no flush at all (see CLAUDE.md), so nothing requires a
/// small buffer anymore. The 50ms was nonetheless carried forward unexamined across the
/// 2026-08-02 `pipewiresink`→`pulsesink` switch, where it began binding far harder:
/// `pipewiresink` ignored these properties entirely (it extends `GstBaseSink`, not
/// `GstAudioBaseSink`) and took a `node.latency` quantum instead, whereas on `pulsesink`
/// this really is the PulseAudio/pipewire-pulse ringbuffer.
///
/// **How this was proven, because the symptom pointed everywhere else first.** Audio was
/// choppy and, with headphone cue enabled, the master output was silent outright. The
/// decisive observation came from a deck configured with *two* main sinks at once — an
/// onboard PCI codec and a USB DJ controller — fed by one `tee`. Identical decode,
/// identical soundtouch output, identical CPU: the PCI branch was clean and the USB
/// branch jittered. That rules out every upstream cause (CPU contention, decode,
/// soundtouch) by construction, since those cannot affect one branch and spare its
/// sibling. `instrument_queue_flow()` agreed — zero underruns all session. USB audio has
/// far more scheduling jitter than an onboard codec, so 50ms of ringbuffer written 10ms
/// at a time was simply too tight for it. At 200ms/20ms the user confirmed every device
/// clean, with zero underruns and zero sink-flow gaps across ~106s of playback, and all
/// three expected PipeWire streams present where previously only one existed.
///
/// Still overridable, now mainly to trade latency back for tighter cueing on hardware
/// that tolerates it:
/// ```text
/// CUEMARK_SINK_BUFFER_MS=100 CUEMARK_SINK_LATENCY_MS=20 cargo tauri dev
/// ```
/// This buffer is pure added output latency, so it is worth bisecting downward on a
/// given rig — but **do not lower the default again without re-testing on USB audio**,
/// which is where it broke.
/// How a sink corrects for its device clock running at a different real rate than the
/// pipeline clock. Returns `None` to leave GStreamer's default alone.
///
/// **Why this is a knob.** A GStreamer pipeline has exactly one clock. With more than one
/// output device selected, one `pulsesink` becomes the pipeline clock and every other
/// sink must slave to it — but each device free-runs on its own crystal, typically
/// 20–200 ppm apart, so they cannot stay aligned. `GstAudioBaseSink`'s default
/// `slave-method=skew` absorbs the difference by jumping the ringbuffer pointer —
/// dropping or inserting a block of samples — once it exceeds `drift-tolerance` (40ms
/// by default). Audibly that is a brief gap or click that does not interrupt playback,
/// recurring on a period of `drift_tolerance / relative_drift`: roughly every 3 minutes
/// at 200 ppm, every 13 at 50 ppm.
///
/// `resample` instead corrects continuously by resampling to match the master clock. It
/// costs a little CPU and detunes that device by the drift itself — 50 ppm is 0.0009 of
/// a semitone, inaudible — in exchange for never producing a discontinuity. For a VJ/DJ
/// tool driving several outputs at once that is usually the better trade, which is why
/// this is exposed rather than hardcoded.
///
/// **Only matters across distinct devices.** Two sinks on the *same* device share one
/// hardware clock and cannot drift, so a main+cue pair on one controller is unaffected.
///
/// ```text
/// CUEMARK_SINK_SLAVE_METHOD=resample cargo tauri dev
/// ```
/// Accepts `resample`, `skew` (GStreamer's default), `none`. Default is unchanged until
/// the drift mechanism is confirmed live — see docs/design/output-noise-and-track-reload-silence.md.
fn sink_slave_method() -> Option<i32> {
    let raw = std::env::var("CUEMARK_SINK_SLAVE_METHOD").ok()?;
    match raw.trim().to_ascii_lowercase().as_str() {
        "resample" => Some(0),
        "skew" => Some(1),
        "none" => Some(2),
        other => {
            log::warn!(
                "[audio] ignoring CUEMARK_SINK_SLAVE_METHOD={other:?} — expected \
                 resample|skew|none; leaving GStreamer's default (skew)"
            );
            None
        }
    }
}

fn sink_buffer_times() -> (i64, i64) {
    fn from_env(var: &str, default_us: i64) -> i64 {
        let Ok(raw) = std::env::var(var) else { return default_us };
        match raw.trim().parse::<i64>() {
            Ok(ms) if ms > 0 => {
                // WARN, not info: an active override means the running app is NOT using the
                // compiled-in default, and that divergence is invisible otherwise. On
                // 2026-08-02 a shell still exporting CUEMARK_SINK_BUFFER_MS=200 masked the
                // fact that a "fixed" default had only been changed in the doc comment and
                // not in the code — the regression reappeared on the next clean restart and
                // cost a debugging cycle. If this line is in the log, the default is not
                // what is being tested.
                log::warn!(
                    "[audio] {var}={ms}ms OVERRIDE ACTIVE — compiled-in default ({}ms) is NOT \
                     in effect; unset it to test the default",
                    default_us / 1_000
                );
                ms * 1_000
            }
            _ => {
                log::warn!(
                    "[audio] ignoring {var}={raw:?} — expected a positive whole number of \
                     milliseconds; using default {}us",
                    default_us
                );
                default_us
            }
        }
    }
    (
        // 200ms/20ms, NOT the old 50ms/10ms — see this fn's doc comment. The old value
        // was ~1.17 graph quanta and caused live-confirmed choppiness on USB audio.
        from_env("CUEMARK_SINK_BUFFER_MS", 200_000),
        from_env("CUEMARK_SINK_LATENCY_MS", 20_000),
    )
}

/// Sink timestamp-alignment tolerance to apply **for the duration of a scratch gesture
/// only**, as `(alignment_threshold_ns, discont_wait_ns)`. Restored to GStreamer's
/// defaults when the gesture ends.
///
/// **Why this exists — root-caused 2026-08-08, see
/// docs/design/scratch-audio-downstream-delivery.md F10.** The scratch feeder pushes
/// just-in-time with `do-timestamp=true`, so its buffers carry no head start and run
/// progressively later than the sink's ringbuffer write pointer as a gesture is driven
/// harder. `GstAudioBaseSink` absorbs that by aligning each buffer to the previous one —
/// and the output is **correct** while it does. But the correction is time-limited: once
/// misalignment exceeds `alignment-threshold` (40ms) continuously for `discont-wait`
/// (1s), the sink gives up, sets `align = 0`, and places the buffer at its raw
/// timestamp-derived offset — measured live at **253ms in the past**, behind the
/// ringbuffer's read pointer. Every buffer after that is written into segments already
/// played out, so the deck goes silent for the rest of the `Playing` span and only a new
/// gesture (fresh `base_time`) recovers it.
///
/// Widening both is therefore not a workaround for a stall — it keeps the sink doing the
/// thing that was already producing correct audio. Delivery was never interrupted:
/// `DeliveryProbe` measured an unbroken 67 buffers/s into the sink's own pad, and
/// `audiobasesink:6` shows `wrote 720 of 720` on every buffer, throughout the silence.
///
/// **Why it is scoped to the gesture and not set on the sink permanently.** Outside a
/// scratch these defaults are load-bearing: a real decoder gap during normal playback
/// *should* resync rather than be masked, or the audio plays contiguously late and drifts
/// away from video. During a gesture there is nothing to drift from — the normal branch is
/// valved off and `uridecodebin`'s state is locked (see `valve_normal_el`), so the deck's
/// only audio is the feeder's, and the feeder is self-paced to wall clock.
///
/// **Rejected alternative: a fixed timestamp lead on the pushed buffers.** To work it must
/// be ≥ the worst-case lateness (~250ms observed), and a quarter-second of latency between
/// hand and sound defeats the point of scratching. `ts-offset` on the sink costs the same
/// and additionally applies to normal playback through the same element.
///
/// ```text
/// # control arm — GStreamer's stock values, reproduces the fault on a hard gesture
/// CUEMARK_SCRATCH_ALIGN_MS=40 CUEMARK_SCRATCH_DISCONT_WAIT_MS=1000 cargo tauri dev
/// ```
fn scratch_sink_alignment() -> (u64, u64) {
    fn from_env(var: &str, default_ms: u64) -> u64 {
        let Ok(raw) = std::env::var(var) else { return default_ms * 1_000_000 };
        match raw.trim().parse::<u64>() {
            Ok(ms) if ms > 0 => {
                // WARN for the same reason sink_buffer_times() does: an override means the
                // running app is not testing the compiled-in default, and that divergence
                // is otherwise invisible in the log.
                log::warn!(
                    "[audio] {var}={ms}ms OVERRIDE ACTIVE — compiled-in default ({default_ms}ms) \
                     is NOT in effect; unset it to test the default"
                );
                ms * 1_000_000
            }
            _ => {
                log::warn!(
                    "[audio] ignoring {var}={raw:?} — expected a positive whole number of \
                     milliseconds; using default {default_ms}ms"
                );
                default_ms * 1_000_000
            }
        }
    }
    (
        // 2s/1h against GStreamer's 40ms/1s. The threshold is sized well clear of the
        // ~253ms of lateness a hard gesture actually accumulated, and the wait is sized so
        // it cannot expire inside any plausible gesture — together they mean the sink
        // masks for the whole gesture rather than masking and then giving up, which is
        // the specific failure F10 measured.
        from_env("CUEMARK_SCRATCH_ALIGN_MS", 2_000),
        from_env("CUEMARK_SCRATCH_DISCONT_WAIT_MS", 3_600_000),
    )
}

/// GStreamer's stock `(alignment-threshold, discont-wait)`, restored at gesture end.
/// Hardcoded rather than read back before overriding: `make_sink()` never sets these, so
/// the pre-gesture value is always the default, and reading it back would silently
/// persist a previous gesture's override if a restore were ever missed.
const SINK_ALIGN_DEFAULTS_NS: (u64, u64) = (40_000_000, 1_000_000_000);

/// Apply `(alignment-threshold, discont-wait)` to whichever main sinks actually have them.
///
/// ⚠️ **The property check is not defensive padding.** `make_sink()` falls back to
/// `autoaudiosink` when `pulsesink` is missing, and that is a `GstBin`, not a
/// `GstAudioBaseSink` — it has neither property, and `set_property` on a property a
/// GObject does not have **panics** rather than erroring. That fallback path would
/// otherwise turn a missing-plugin install into a crash on the first jog gesture.
fn set_sink_alignment(sinks: &[gst::Element], align_ns: u64, discont_wait_ns: u64) {
    for snk in sinks {
        if snk.find_property("alignment-threshold").is_none() {
            continue;
        }
        snk.set_property("alignment-threshold", align_ns);
        snk.set_property("discont-wait", discont_wait_ns);
    }
}

fn make_el(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory)
        .build()
        .map_err(|e| format!("GStreamer element '{factory}' not found: {e}"))
}

/// A `valve` with `drop=true` silently swallows the EOS event too, not just data
/// buffers — confirmed empirically (`gst-launch-1.0 audiotestsrc num-buffers=20 !
/// valve drop=true ! fakesink` hangs forever instead of exiting on EOS; the same
/// pipeline with `drop=false` exits immediately). `GstBin` only posts its
/// aggregate pipeline-level EOS message to the bus once *every* sink element has
/// posted its own — so any permanently-closed valve upstream of a sink (the
/// headphone `cue_valve`, closed by default on every deck until a user enables
/// cue; the scratch `valve_normal`, briefly closed mid-gesture) means that sink
/// never sees EOS and the whole pipeline's EOS message never arrives, even though
/// every other branch (e.g. the main audio output) reached real EOS cleanly.
///
/// This was the actual root cause of the "silent stall a fraction of a second
/// before every track's true end" finding in docs/design/webcodecs-video-path.md
/// — root-caused via a pad-probe trace of a natural-EOS repro
/// (`eos_stall_probe_trace` in this module's tests) that showed EOS reaching the
/// main branch's sink cleanly but stopping dead at `cue_valve`'s sink pad. The
/// original hypothesis blamed the `input_selector`/scratch topology; that topology
/// was actually unrelated — this valve-swallows-EOS behavior is a stock GStreamer
/// gotcha, present since the cue branch was first added, and simply never
/// exercised by a natural-EOS run before (all prior testing used loops/seeks that
/// never reach true end of file with the cue branch idling).
///
/// Fix: a downstream-event probe on the valve's sink pad that flips `drop` to
/// `false` the instant an EOS event is about to be handled, then lets it `Pass`
/// through the valve's own (already-correct, already-tested) forwarding logic —
/// rather than manually re-pushing the event ourselves. An earlier version of this
/// fix tried exactly that manual re-push (clone the event, push it onto the
/// valve's src pad, return `Drop`), which "worked" (EOS reached the sink) but
/// triggered a `gst_mini_object_unref: assertion 'mini_object != NULL' failed`
/// GStreamer-CRITICAL — confirmed via `gdb` (`G_DEBUG=fatal-criticals` turns the
/// critical into a trappable signal) to originate one frame away, inside `tee`'s
/// own `gst_pad_forward` fan-out: pushing a second, independently-owned event
/// clone from *within* a probe callback that's itself running *inside* that same
/// synchronous fan-out over multiple src pads corrupts whatever bookkeeping
/// `gst_pad_forward` does across the pads it hasn't visited yet. Flipping `drop`
/// and returning `Pass` needs no reentrant push — GStreamer's own single already-
/// correct code path does the forwarding. Permanently leaving `drop=false` after
/// EOS is harmless: EOS means no more buffers are coming on this pad, and
/// `load()` rebuilds a fresh valve (with `drop` set from live state) on every
/// track load, so nothing leaks across loads.
fn make_eos_passthrough_valve(valve: &gst::Element) {
    let valve_weak = valve.downgrade();
    let sink_pad = valve.static_pad("sink").expect("valve has a sink pad");
    sink_pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_, info| {
        let Some(event) = info.event() else { return gst::PadProbeReturn::Ok };
        if event.type_() == gst::EventType::Eos {
            if let Some(valve) = valve_weak.upgrade() {
                valve.set_property("drop", false);
            }
        }
        gst::PadProbeReturn::Ok
    });
}

/// Logs every CAPS event crossing `pad_name` on `element`, tagged `label`.
///
/// Added 2026-08-10 for the cue-branch silence in `slow-jog-audio-inaudible.md` §10, where
/// the headphone output measured **exact digital zero** for the whole of a scratch gesture
/// while the main output ran at −19 dBFS and the cue branch's own delivery probes counted
/// 68 buffers/s. Buffers arriving and containing silence points at negotiation, not flow,
/// and negotiation was the one thing in this pipeline that nothing observed: every existing
/// probe counts buffers, timestamps or levels, and a caps change is none of those.
///
/// Attach it around the element whose behaviour depends on the negotiated layout — here
/// `ch_conv`, whose hand-built N×2 `mix-matrix` is only meaningful against a known input
/// channel layout.
fn instrument_caps(element: &gst::Element, pad_name: &str, label: &str, deck_id: &str) {
    let Some(pad) = element.static_pad(pad_name) else { return };
    let label = label.to_string();
    let deck_id = deck_id.to_string();
    pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_, info| {
        let Some(event) = info.event() else { return gst::PadProbeReturn::Ok };
        if let gst::EventView::Caps(c) = event.view() {
            log::info!("[caps/{deck_id}] {label}: {}", c.caps());
        }
        gst::PadProbeReturn::Ok
    });
}

/// Per-channel RMS of the samples actually crossing `pad_name`, logged once a second.
///
/// **The cue branch has never had an instrument that looks at buffer *content*.** Its
/// delivery probes count buffers, `instrument_caps` reports negotiation, and the feeder's
/// own `rms` is measured at the `appsrc` — upstream of the tee, so it cannot see a loss on
/// one branch below the split. That left the exact question this bug turns on unobservable:
/// during a scratch gesture the headphone output measures **digital zero at the device**
/// while 68 buffers/s arrive at the cue sink with correct 4-channel caps
/// (`slow-jog-audio-inaudible.md` §10). Buffers that are present, correctly shaped, and full
/// of silence can only be distinguished from working audio by reading the samples.
///
/// Per-channel rather than overall, because the answer is expected to be channel-specific:
/// downstream of the mix-matrix, rows 0,1 are silent *by design* and rows 2,3 carry the
/// headphone feed, so an overall RMS would blur the one distinction that matters.
///
/// Assumes F32LE, which `caps_48k` now pins on both selector inputs.
fn instrument_level(element: &gst::Element, pad_name: &str, label: &str, deck_id: &str) {
    let Some(pad) = element.static_pad(pad_name) else { return };
    let label = label.to_string();
    let deck_id = deck_id.to_string();
    // (per-channel sum of squares, frames, window start)
    let state = Arc::new(Mutex::new((Vec::<f64>::new(), 0u64, Instant::now())));
    pad.add_probe(gst::PadProbeType::BUFFER, move |pad, info| {
        let Some(buf) = info.buffer() else { return gst::PadProbeReturn::Ok };
        let channels = pad
            .current_caps()
            .and_then(|c| c.structure(0).and_then(|s| s.get::<i32>("channels").ok()))
            .unwrap_or(2)
            .max(1) as usize;
        let Ok(map) = buf.map_readable() else { return gst::PadProbeReturn::Ok };
        let data = map.as_slice();
        let mut st = state.lock().unwrap();
        if st.0.len() != channels {
            st.0 = vec![0.0; channels];
        }
        let n = data.len() / 4;
        for i in 0..n {
            let v = f32::from_le_bytes([data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]])
                as f64;
            st.0[i % channels] += v * v;
        }
        st.1 += (n / channels) as u64;
        if st.2.elapsed() >= Duration::from_secs(1) {
            let frames = st.1.max(1) as f64;
            let per_ch: Vec<String> = st
                .0
                .iter()
                .map(|s| {
                    let rms = (s / frames).sqrt();
                    if rms > 0.0 { format!("{:.1}", 20.0 * rms.log10()) } else { "-inf".to_string() }
                })
                .collect();
            log::info!(
                "[level/{deck_id}] {label}: [{}] dBFS/ch frames={}",
                per_ch.join(" "),
                st.1
            );
            st.0 = vec![0.0; channels];
            st.1 = 0;
            st.2 = Instant::now();
        }
        gst::PadProbeReturn::Ok
    });
}

/// Encode a filesystem path as a file:// URI suitable for uridecodebin.
///
/// Each byte is examined individually so multi-byte UTF-8 sequences (e.g. 'ç' → 0xC3 0xA7)
/// are percent-encoded as %C3%A7 rather than pushed as `char` values (which produces mojibake).
pub(super) fn file_to_uri(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 7);
    out.push_str("file://");
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'.' | b'_' | b'~'
            | b'/' | b':' | b'@'
            | b'!' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b'+' | b',' | b';' | b'=' => {
                out.push(byte as char);
            }
            b => {
                out.push('%');
                out.push(char::from_digit((b >> 4) as u32, 16).unwrap().to_ascii_uppercase());
                out.push(char::from_digit((b & 0x0f) as u32, 16).unwrap().to_ascii_uppercase());
            }
        }
    }
    out
}

/// Map a PipeWire channel name to its GStreamer audio channel-mask bit position.
fn pw_channel_to_gst_bit(ch: &str) -> Option<u32> {
    match ch {
        "FL"            => Some(0),
        "FR"            => Some(1),
        "FC"            => Some(2),
        "LFE" | "LFE1"  => Some(3),
        "RL"            => Some(4),
        "RR"            => Some(5),
        "SL"            => Some(10),
        "SR"            => Some(11),
        _ => None,
    }
}

/// Pre-computed routing info for the cue channel-remap branch.
struct CueRemap {
    /// Number of output channels for the GStreamer capsfilter.
    out_channels: i32,
    /// GStreamer audio channel-mask bitmask for the capsfilter.
    channel_mask: u64,
    /// Mix-matrix rows: one [left_coeff, right_coeff] pair per output channel.
    /// audioconvert interprets rows as output channels and columns as input channels.
    matrix_rows: Vec<[f32; 2]>,
}

/// Build a CueRemap from the `target!full_layout` suffix of a device ID.
///
/// Strategy: instead of trying to re-label a 2-channel stereo stream (WirePlumber
/// ignores channel-position labels on stereo→multi-channel connections and always
/// routes to the first pair), we output an N-channel stream matching the sink's full
/// channel count. PipeWire then does a 1:1 port connection, and the silence/audio
/// values in each channel end up in the correct physical output.
///
/// Returns `Ok(None)` when the target is the default front pair (no remap needed —
/// safe to route straight to the node), and `Err` when `target`/`full_layout` can't
/// be parsed as channel-position tokens (e.g. a corrupted persisted device id). The
/// `Err` case matters: silently treating an unparseable non-default target as "no
/// remap needed" would send a plain stereo stream straight at the shared node, same
/// as a second sink using the *default* pair — a same-channel collision between two
/// `pipewiresink` clients on one node that, live on 2026-08-02, deadlocked PipeWire's
/// own node-negotiation thread system-wide (confirmed via gdb: the *daemon's* graph
/// thread hung in `pw_impl_node_set_state()`, blocking even unrelated `pw-cli`
/// queries, until the offending cuemark process was killed). The persisted device id
/// that triggered it was corrupted (stray `[`/`]`/space characters around the channel
/// lists — origin unconfirmed, possibly a stale value from manual devtools testing),
/// so this can recur any time a malformed id reaches this parser. Callers must fall
/// back to `fakesink` on `Err`, never to an unmapped real sink.
fn compute_cue_remap(target: &str, full_layout: &str) -> Result<Option<CueRemap>, String> {
    if target == "FL,FR" || full_layout.is_empty() {
        return Ok(None); // default front pair — no remap needed
    }

    let all_channels: Vec<&str> = full_layout.split(',').map(str::trim).collect();
    let n = all_channels.len();
    if n <= 2 {
        return Ok(None);
    }

    let target_chs: Vec<&str> = target.split(',').map(str::trim).collect();

    // Compute GStreamer channel-mask covering all channels in the full layout.
    let mut mask: u64 = 0;
    for &ch in &all_channels {
        let bit = pw_channel_to_gst_bit(ch)
            .ok_or_else(|| format!("unrecognized channel token {ch:?} in full_layout {full_layout:?}"))?;
        mask |= 1u64 << bit;
    }

    // For each target channel, find its buffer index within the full layout.
    // Index = number of set bits in mask that are strictly below this channel's bit.
    let target_indices: Vec<usize> = target_chs.iter()
        .map(|&ch| {
            let bit = pw_channel_to_gst_bit(ch)
                .ok_or_else(|| format!("unrecognized channel token {ch:?} in target {target:?}"))? as u64;
            if mask & (1 << bit) == 0 {
                return Err(format!("target channel {ch:?} not present in full_layout {full_layout:?}"));
            }
            Ok((0..bit).filter(|&b| mask & (1 << b) != 0).count())
        })
        .collect::<Result<Vec<_>, String>>()?;

    // Build N×2 mix-matrix: most rows are silence; target rows get left/right audio.
    let mut matrix_rows = vec![[0.0f32, 0.0f32]; n];
    for (pair_idx, &ch_idx) in target_indices.iter().enumerate() {
        if ch_idx < n && pair_idx < 2 {
            matrix_rows[ch_idx][pair_idx] = 1.0;
        }
    }

    log::info!(
        "[audio/cue] remap: target={target} full={full_layout} n_ch={n} mask={mask:#x} idx={target_indices:?}"
    );
    Ok(Some(CueRemap { out_channels: n as i32, channel_mask: mask, matrix_rows }))
}

/// Build one output sink targeting `device`.
///
/// **Uses `pulsesink`, deliberately not `pipewiresink`** (changed 2026-08-02). On a
/// PipeWire system `pulsesink` talks to `pipewire-pulse`, so this is still PipeWire —
/// just reached through the Pulse compat layer rather than the native GStreamer element.
///
/// The native `pipewiresink` cannot be used here: `libgstpipewire` (gst-plugin-pipewire
/// 1.6.2) has an AB-BA lock inversion that deadlocks whenever **two or more
/// `pipewiresink` elements in one process** go PAUSED→PLAYING with any delay between the
/// transitions. cuemark always has at least two (≥1 main output + the cue branch), and
/// more with multiple decks, so it fires on essentially every play. Measured 4/6 runs
/// with two sinks and 6/6 with three, versus 0/6 for `pulsesink` at both. When it fires
/// it strands the client node mid-state-change and hangs *every* PipeWire client on the
/// machine — not just cuemark — until the process is killed. Full analysis, gdb stacks
/// and the reproducer: `docs/design/pipewiresink-play-hang.md` and
/// `scripts/probes/pipewiresink_multisink_deadlock.py`. Do not switch back without
/// re-running that probe.
fn make_sink(device: &str, deck_id: &str) -> Result<gst::Element, String> {
    // Device string may encode a stereo-pair target: "node-name@CH1,CH2".
    // Strip the @suffix here — the actual channel remapping is done via GStreamer caps
    // inserted before this sink by the caller (the sink routes by caps channel positions,
    // not by stream-property metadata). The bare node name that survives this strip is
    // PipeWire's `node.name`, which is exactly what pulsesink's `device` property expects.
    let node_name = match device.find('@') {
        Some(at) => &device[..at],
        None => device,
    };

    // Not constants: overridable via CUEMARK_SINK_BUFFER_MS / CUEMARK_SINK_LATENCY_MS so
    // a choppy-audio repro can be bisected by ear without a rebuild per value. See
    // sink_buffer_times() for why the 50ms default is suspect in the first place.
    let (buffer_time_us, latency_time_us) = sink_buffer_times();

    if let Ok(sink) = gst::ElementFactory::make("pulsesink").build() {
        if !node_name.is_empty() {
            // NOTE: unlike pipewiresink's `target-object`, an unresolvable `device` here
            // does NOT error — pulsesink silently falls back to the system default sink.
            // A stale/corrupted persisted device id therefore shows up as "audio came out
            // of the wrong device", never as a failure. AudioSettings.svelte's on-mount
            // auto-heal (drops persisted ids absent from the live device list) is the
            // guard for that; this log line is how you confirm what was actually asked for.
            sink.set_property("device", node_name);
        }
        // pulsesink is a GstAudioBaseSink, so latency is set directly here rather than
        // through PipeWire stream-properties (pipewiresink extends GstBaseSink and has
        // neither of these properties — it needed `node.latency=1024/48000` instead).
        sink.set_property("buffer-time", buffer_time_us);
        sink.set_property("latency-time", latency_time_us);
        sink.set_property("client-name", "cuemark");
        if let Some(method) = sink_slave_method() {
            // Set via GValue on the enum property — see sink_slave_method()'s doc comment
            // for what this trades off and when it matters.
            sink.set_property_from_str("slave-method", match method {
                0 => "resample",
                2 => "none",
                _ => "skew",
            });
            log::info!("[audio/{}] sink: slave-method override -> {}", deck_id, method);
        }
        // Tag this stream with the branch that owns it, so `pw-dump` can say which
        // cuemark output each PipeWire node actually is.
        //
        // Uses a custom `cuemark.branch` key, NOT `media.name`: setting `media.name` here
        // appears to work but is silently overwritten once the track's tags arrive, so
        // every branch ends up displaying the same title (verified live 2026-08-02 — all
        // three streams still read as the track name after this was set). A private key
        // survives because nothing else writes it.
        //
        // This matters because the branches are otherwise indistinguishable in the graph:
        // pipewire-pulse maps even a plain stereo stream onto all of a 4-channel device's
        // ports, so a stereo main sink and a 4-channel remapped cue sink both present as
        // FL/FR/RL/RR (confirmed by scripts/probes/pulsesink_shared_device_silence.py).
        // During the 2026-08-02 "no audio output" investigation that ambiguity produced a
        // wrong conclusion — the single surviving stream was identified as the cue branch
        // purely from its port count, which cannot tell them apart. `deck_id` here already
        // encodes the branch ("deck-0/0" for main sink 0, "deck-0-cue" for cue).
        let stream_props = gst::Structure::builder("props")
            .field("cuemark.branch", deck_id)
            .build();
        sink.set_property("stream-properties", &stream_props);
        log::info!(
            "[audio/{}] sink: pulsesink device={:?} buffer-time={}us latency-time={}us",
            deck_id, node_name, buffer_time_us, latency_time_us
        );
        return Ok(sink);
    }

    log::warn!(
        "[audio/{}] pulsesink unavailable (apt install gstreamer1.0-plugins-good); \
         falling back to autoaudiosink",
        deck_id
    );

    let sink = gst::ElementFactory::make("autoaudiosink")
        .build()
        .map_err(|e| format!("autoaudiosink not found: {e}"))?;

    let deck_id_owned = deck_id.to_string();
    let _ = sink.connect("child-added", false, move |args| {
        let child = args
            .get(1)
            .and_then(|v| v.get::<glib::Object>().ok())
            .and_then(|o| o.downcast::<gst::Element>().ok());
        let Some(child) = child else { return None };
        child.set_property("buffer-time", buffer_time_us);
        child.set_property("latency-time", latency_time_us);
        let factory = child
            .factory()
            .map(|f| f.name().to_string())
            .unwrap_or_else(|| "?".to_string());
        let bt: i64 = child.property("buffer-time");
        let lt: i64 = child.property("latency-time");
        log::info!(
            "[audio/{}] sink: {} buffer-time={}us latency-time={}us",
            deck_id_owned, factory, bt, lt
        );
        None
    });
    Ok(sink)
}

struct PipelineInner {
    pipeline: gst::Pipeline,
    /// One volume element per main output device (gain × vol applied to all).
    volume_els: Vec<gst::Element>,
    /// Cue branch volume — gain × cue_gain, independent of the crossfader.
    cue_volume_el: gst::Element,
    /// Valve that gates the cue branch; drop-buffers=true when cue is off.
    cue_valve_el: gst::Element,
    /// soundtouch pitch element — `tempo` property controls playback speed without pitch shift.
    pitch_el: gst::Element,
    /// Held so we can call set_flushing(true) to stop the bus monitor thread on drop/reload.
    bus: gst::Bus,
    /// Set by the bus monitor thread when EOS arrives; cleared by play() on restart.
    at_eos: Arc<AtomicBool>,
    /// Set by the bus monitor thread when an ERROR message arrives.
    at_error: Arc<AtomicBool>,
    /// Scratch feeder source — see docs/design/pcm-buffer-playback.md. Always present
    /// in the topology (gated closed by default); scratch()/stop_scratch() are the only
    /// things that touch it.
    appsrc: AppSrc,
    /// Exclusive-switches between the normal (uridecodebin) branch and the scratch
    /// (appsrc) branch, downstream of `pitch`.
    input_selector: gst::Element,
    sel_normal_pad: gst::Pad,
    sel_scratch_pad: gst::Pad,
    /// Gates the normal branch off during scratch. Paired with locking
    /// `uridecodebin_el`'s state (see scratch()) — the valve alone isn't enough: with
    /// drop=true it discards instantly rather than blocking, so nothing backpressures
    /// uridecodebin and it races ahead decoding (and discarding) the rest of the file
    /// in a fraction of a second, reaching EOS almost immediately regardless of how
    /// short the scratch gesture is. Locking the source element's state is what
    /// actually freezes it; the valve just keeps stray buffers from reaching the
    /// (unselected) input-selector pad in the meantime.
    valve_normal_el: gst::Element,
    /// The uridecodebin element driving the normal branch. Its state is explicitly
    /// locked (frozen) while scratch is active — see the valve_normal_el comment.
    uridecodebin_el: gst::Element,
    /// Present only while a scratch gesture is in progress.
    scratch_feeder: Option<ScratchFeeder>,
    /// The shared queue between `input_selector` and `tee` — see the constants
    /// above `make_el` for why `scratch()` widens its cap for the gesture's
    /// duration.
    output_queue_el: gst::Element,
    /// The main output sinks, kept so a scratch gesture can widen their timestamp-alignment
    /// tolerance for its duration and restore it afterwards — see `scratch_sink_alignment()`.
    main_sink_els: Vec<gst::Element>,
    /// Buffer counters on the `volume`/`pulsesink` pads, handed to each scratch feeder so
    /// its per-second telemetry can report delivery next to rms. See `DeliveryProbe`.
    delivery_probes: DeliveryProbes,
    /// Mirrors `cue_valve`'s open/closed state for the cue sink's flow probe, which must
    /// not measure a gap across a span where the valve was dropping everything.
    cue_open: Arc<AtomicBool>,
    /// The cue output sink — a real `pulsesink` when a cue device is configured, else the
    /// `fakesink` fallback. Kept because `make_sink()` does not name the element (the
    /// branch id goes into a `cuemark.branch` stream property, not `name`), so there is
    /// otherwise no way to tell it apart from a main `pulsesink` in the built graph.
    /// Read only by `cue_sink_of()` in tests today; kept on the struct because
    /// reconstructing "which sink is the cue one" after the fact is not possible.
    #[cfg_attr(not(test), allow(dead_code))]
    cue_sink_el: gst::Element,
    /// The cue sink's flow-probe state, so `set_cue_enabled()` can invalidate its
    /// last-buffer time when the valve closes. `None` when cue is on the fakesink
    /// fallback (uninstrumented). See `instrument_sink_flow()`.
    cue_sink_flow: Option<SinkFlowState>,
}

pub struct DeckAudioPipeline {
    pub deck_id: String,
    inner: Option<PipelineInner>,
    pub(super) file_path: Option<String>,
    /// PipeWire sink names for the main outputs. Empty vec = single system-default output.
    pub(super) devices: Vec<String>,
    /// PipeWire sink name for the headphone cue output. Empty = use fakesink (no cue output).
    pub(super) cue_device: String,
    gain: f32,
    vol: f32,
    /// Master volume factor applied on top of gain×vol (0–1). Set by AudioManager.
    pub(super) master_volume: f32,
    /// Independent gain for the cue/headphone branch (0–4).
    cue_gain: f32,
    /// True when the headphone cue branch is open (valve passing buffers).
    cue_enabled: bool,
    /// Current tempo multiplier. Re-applied to the pitch element after each load.
    rate: f64,
    /// True when the user has pressed play (intent). Retained across device rebuilds.
    playing: bool,
    /// Called by the bus thread when EOS fires. Used to notify the frontend.
    eos_callback: Option<EosCallback>,
    /// AppHandle for emitting audio-fft Tauri events from the bus thread.
    app: Option<tauri::AppHandle>,
    /// Full-file PCM decode for scratch playback, cached per loaded file (see
    /// docs/design/pcm-buffer-playback.md). `None` if decode failed or hasn't
    /// happened yet — scratch() then declines rather than crashing playback.
    pcm_buffer: Option<Arc<PcmBuffer>>,
    /// Where the previous scratch gesture's cursor landed, in PCM buffer frames.
    ///
    /// `scratch()`/`scratch_to()` prefer this over `query_position()` when starting a
    /// fresh gesture. The reason is a real gesture-boundary jump: `stop_scratch_feeder()`
    /// ends every gesture with a 130ms drain sleep and two flush seeks, and until that
    /// ACCURATE resync seek actually lands, `query_position()` still reports where the
    /// normal branch was *before* the gesture. Cueing naturally produces short gestures
    /// separated by pauses longer than `SCRATCH_IDLE_MS`, so the next gesture routinely
    /// started from that stale position — the track appeared to jump backward between
    /// nudges. Reading back the cursor we ourselves wrote sidesteps the race entirely.
    ///
    /// Cleared by anything that legitimately moves the playhead by another route
    /// (`seek_output_domain`, `load`, `play`), so it can never go stale in the other
    /// direction.
    last_scratch_frame: Option<f64>,
}

impl DeckAudioPipeline {
    pub fn new(deck_id: &str) -> Self {
        Self {
            deck_id: deck_id.to_string(),
            inner: None,
            file_path: None,
            devices: Vec::new(),
            cue_device: String::new(),
            gain: 1.0,
            vol: 1.0,
            master_volume: 1.0,
            cue_gain: 1.0,
            cue_enabled: false,
            rate: 1.0,
            playing: false,
            eos_callback: None,
            app: None,
            pcm_buffer: None,
            last_scratch_frame: None,
        }
    }

    pub fn set_eos_callback(&mut self, f: impl Fn() + Send + Sync + 'static) {
        self.eos_callback = Some(Arc::new(f));
    }

    pub fn set_app(&mut self, app: tauri::AppHandle) {
        self.app = Some(app);
    }

    pub fn load(&mut self, file_path: &str) -> Result<Option<f64>, String> {
        // Skip the (potentially slow, full-file) PCM re-decode when reloading the same
        // file — set_devices()/set_cue_device() call load() again on every device switch.
        let needs_pcm_decode = self.pcm_buffer.is_none() || self.file_path.as_deref() != Some(file_path);
        self.file_path = Some(file_path.to_string());
        // Any remembered scratch landing frame belongs to the outgoing pipeline (and
        // possibly to a different file) — see `last_scratch_frame`.
        self.last_scratch_frame = None;

        if let Some(ref mut inner) = self.inner {
            Self::take_and_join_feeder(inner);
            // Belt-and-suspenders: if a scratch was in progress, uridecodebin's state
            // is locked (see scratch()) — unlock before tearing the pipeline down to
            // Null so the state change actually propagates to it.
            inner.uridecodebin_el.set_locked_state(false);
            inner.bus.set_flushing(true);
            let _ = inner.pipeline.set_state(gst::State::Null);
        }
        self.inner = None;

        if needs_pcm_decode {
            match pcm_buffer::decode_stereo_48k(file_path) {
                Ok(pcm) => self.pcm_buffer = Some(Arc::new(pcm)),
                Err(e) => {
                    log::warn!("[audio/{}] scratch PCM decode failed, scratch unavailable: {e}", self.deck_id);
                    self.pcm_buffer = None;
                }
            }
        }

        let pipeline = gst::Pipeline::new();
        let src      = make_el("uridecodebin")?;
        // queue decouples the uridecodebin decoder thread from audioconvert.
        // Without it, FLUSH seeks can hand audioconvert a buffer still referenced
        // by the decoder (ref_count > 1), triggering a gst_buffer_is_writable assertion crash.
        let queue      = make_el("queue")?;
        let convert    = make_el("audioconvert")?;
        let resample   = make_el("audioresample")?;
        // capsfilter forces 48000 Hz downstream so pipewiresink always negotiates at the
        // PipeWire graph's native rate. Without this, 44100 Hz source files cause PipeWire
        // to assign a non-power-of-two quantum (e.g. 3969) to the stream, producing xruns.
        let rate_caps    = make_el("capsfilter")?;
        let pitch        = make_el("pitch")?;
        // spectrum is a passthrough transform that emits FFT bus messages at ~30 fps
        // for audio-reactive shader uniforms. Optional: skip gracefully if the
        // gstreamer1.0-plugins-good package is absent.
        let spectrum_opt: Option<gst::Element> = make_el("spectrum").ok().map(|s| {
            s.set_property("bands", 32u32);
            s.set_property("interval", 33_333_333u64); // 33ms ≈ 30 fps
            s.set_property("threshold", -80i32);
            s.set_property("post-messages", true);
            s.set_property("multi-channel", false);
            if s.has_property("message-magnitude-list", None) {
                s.set_property("message-magnitude-list", true);
            }
            s
        });
        if spectrum_opt.is_none() {
            log::warn!(
                "[audio/{}] spectrum element not available — audio-fft events disabled. \
                 Install gstreamer1.0-plugins-good.",
                self.deck_id
            );
        } else {
            log::info!("[audio/{}] spectrum element ready (32 bands, ~30 fps)", self.deck_id);
        }
        // output_queue buffers pitch's variable-sized output chunks (soundtouch produces
        // non-uniform sizes at non-1.0 tempos). Without this, the PipeWire pull callback
        // can starve when soundtouch hasn't yet produced a full 1024-sample quantum.
        let output_queue = make_el("queue")?;

        // ── Scratch branch (docs/design/pcm-buffer-playback.md) ────────────────────
        // A dedicated PCM-buffer feeder branch, exclusive-switched against the normal
        // branch via input-selector downstream of pitch. Always present in the topology
        // (gated closed by default) so scratch can engage without a pipeline rebuild —
        // only scratch()/stop_scratch() touch the valve/selector state. Deliberately
        // bypasses pitch: scratch's pitch-bend-with-speed is the direct consequence of
        // how fast the feeder thread walks the PCM buffer, not a separate effect to
        // apply via soundtouch (which choked structurally on reversal — see
        // docs/design/jog-scratch-audio.md).
        let appsrc_el = make_el("appsrc")?;
        appsrc_el.set_property("format", gst::Format::Time);
        // Not marked is-live: the feeder thread already self-paces pushes to wall-clock
        // time, and a live source anywhere in the bin makes the whole pipeline report as
        // live (different clock/latency/preroll handling) — a change in behavior for
        // every load, not just scratch. do-timestamp alone gives correct running-time
        // PTS on each pushed buffer.
        appsrc_el.set_property("do-timestamp", true);
        let appsrc = appsrc_el.downcast_ref::<AppSrc>().unwrap().clone();
        // channel-mask is explicit here for the same reason it is on caps_48k below: without
        // it these are *unpositioned* stereo channels, and the cue branch's mix-matrix needs a
        // known layout to route into. Setting it at the source as well as at capsfilter2 means
        // no element between them has to invent one.
        let scratch_caps = gst::Caps::builder("audio/x-raw")
            .field("format", "F32LE")
            .field("layout", "interleaved")
            .field("channels", 2i32)
            .field("channel-mask", gst::Bitmask(0x3))
            .field("rate", pcm_buffer::SCRATCH_SAMPLE_RATE as i32)
            .build();
        appsrc.set_caps(Some(&scratch_caps));
        let convert2 = make_el("audioconvert")?;
        let resample2 = make_el("audioresample")?;
        let capsfilter2 = make_el("capsfilter")?;
        let valve_normal = make_el("valve")?;
        valve_normal.set_property("drop", false);
        make_eos_passthrough_valve(&valve_normal);
        let input_selector = make_el("input-selector")?;

        // Written by the bus thread's StateChanged handler below, read lock-free by the
        // output_queue underrun handler and by every main sink's flow probe, both of which
        // run on streaming threads — see instrument_queue_flow() for why this isn't a
        // current_state() query. Declared here rather than next to its queue hookup below
        // because the sink probes are attached as the sinks are built, just underneath.
        let at_playing = Arc::new(AtomicBool::new(false));
        let mut sink_flow_states: Vec<SinkFlowState> = Vec::new();

        // One (volume, sink) pair per main output device. Empty devices list = single default.
        let main_devs: Vec<String> = if self.devices.is_empty() {
            vec![String::new()]
        } else {
            self.devices.clone()
        };
        let mut volume_els: Vec<gst::Element> = Vec::with_capacity(main_devs.len());
        let mut main_sinks: Vec<gst::Element> = Vec::with_capacity(main_devs.len());
        let mut delivery_probes: Vec<Arc<DeliveryProbe>> = Vec::new();
        for (i, dev) in main_devs.iter().enumerate() {
            let vol = make_el("volume")?;
            let snk = make_sink(dev, &format!("{}/{}", self.deck_id, i))?;
            // Only the primary sink (i=0) participates in preroll — it controls the
            // pipeline's READY→PAUSED state transition. Secondary sinks use async=false
            // so they don't block preroll; they join at PLAYING time using the primary's clock.
            if i > 0 {
                snk.set_property("async", false);
            }
            sink_flow_states.extend(instrument_sink_flow(
                &snk,
                &self.deck_id,
                &format!("main sink {i}"),
                vec![at_playing.clone()],
            ));
            // Bracket the last stage: what leaves `volume` against what the sink accepts.
            // Both, not just the sink — a count that matches at `volume` and not at the
            // sink narrows the fault to one link, and a count that advances at both while
            // the room is silent moves the whole question past delivery. See DeliveryProbe.
            delivery_probes.extend(instrument_delivery(&vol, "src", &format!("vol{i}")));
            delivery_probes.extend(instrument_delivery(&snk, "sink", &format!("sink{i}")));
            volume_els.push(vol);
            main_sinks.push(snk);
        }

        // ── Cue branch ────────────────────────────────────────────────────────────
        // tee splits post-pitch audio into main and cue branches.
        let tee       = make_el("tee")?;
        // valve gates the cue branch; drop-buffers=true means it returns GST_FLOW_OK
        // immediately without passing any data, so the tee never blocks on this branch.
        let cue_valve  = make_el("valve")?;
        let cue_volume = make_el("volume")?;
        // Small queue so pipewiresink's pull callback always finds data when cue is active.
        let cue_queue  = make_el("queue")?;
        // Decide the cue routing *before* building any sink: a device id that requests
        // a non-default channel pair but fails to parse must never fall through to a
        // plain sink targeting the shared node (see compute_cue_remap's doc comment —
        // that exact failure mode deadlocked PipeWire system-wide on 2026-08-02).
        //
        // Device ID format: `node@target!full_layout` e.g. `alsa_out...@RL,RR!FL,FR,RL,RR`
        let cue_remap_outcome: Result<Option<CueRemap>, String> = if self.cue_device.is_empty() {
            Ok(None)
        } else if let Some(at) = self.cue_device.find('@') {
            let after = &self.cue_device[at + 1..];
            match after.find('!') {
                Some(bang) => compute_cue_remap(&after[..bang], &after[bang + 1..]),
                None => Err(format!("malformed device id (missing '!' after '@'): {:?}", self.cue_device)),
            }
        } else {
            Ok(None) // plain single-purpose device id — no remap needed
        };

        // Use a real sink only when a device is configured and (for multi-channel
        // targets) its channel remap parsed cleanly; fakesink otherwise so the
        // pipeline loads cleanly and never risks two sinks colliding on one node.
        let (cue_sink, cue_channel_remap): (gst::Element, Option<(gst::Element, gst::Element)>) =
            match &cue_remap_outcome {
                _ if self.cue_device.is_empty() => {
                    log::warn!("[audio/{}-cue] no device set — cue output routed to fakesink", self.deck_id);
                    let fs = make_el("fakesink")?;
                    fs.set_property("sync", false);
                    (fs, None)
                }
                Err(e) => {
                    log::error!(
                        "[audio/{}-cue] cue device id {:?} failed to parse ({e}) — routing to \
                         fakesink instead of risking a same-channel collision with another sink \
                         on the shared node (see compute_cue_remap's doc comment). Re-select the \
                         cue device in Settings to clear the stale/corrupted id.",
                        self.deck_id, self.cue_device
                    );
                    let fs = make_el("fakesink")?;
                    fs.set_property("sync", false);
                    (fs, None)
                }
                Ok(remap) => {
                    let sink = make_sink(&self.cue_device, &format!("{}-cue", self.deck_id))?;
                    let channel_remap = match remap {
                        Some(r) => {
                            let ch_conv = make_el("audioconvert")?;

                            // N×2 mix-matrix: routes the two input (stereo) channels into the
                            // correct output channel slots; all other output channels stay silent.
                            let matrix_arrays: Vec<gst::Array> = r.matrix_rows.iter()
                                .map(|row| gst::Array::new([row[0], row[1]]))
                                .collect();
                            ch_conv.set_property("mix-matrix", gst::Array::new(matrix_arrays));

                            let ch_caps = make_el("capsfilter")?;
                            ch_caps.set_property("caps", &gst::Caps::builder("audio/x-raw")
                                .field("channels", r.out_channels)
                                .field("channel-mask", gst::Bitmask(r.channel_mask))
                                .build());

                            // Bracket the mix-matrix: what it is asked to map, and what it
                            // produced. See instrument_caps() — a renegotiation here is the
                            // suspect for the cue branch going to digital zero the moment a
                            // scratch gesture switches input_selector.
                            instrument_caps(&ch_conv, "sink", "ch_conv.sink (mix-matrix in)", &self.deck_id);
                            instrument_caps(&ch_caps, "src", "ch_caps.src (to cue sink)", &self.deck_id);

                            Some((ch_conv, ch_caps))
                        }
                        None => None,
                    };
                    (sink, channel_remap)
                }
            };
        // The cue branch is a monitoring output. async=false means it never participates in
        // pipeline preroll, so the valve dropping all buffers (cue off) doesn't block the
        // pipeline from completing PAUSED — only the main sink controls preroll timing.
        cue_sink.set_property("async", false);

        // ── Cue-branch instrumentation ────────────────────────────────────────────
        // Added 2026-08-08 for docs/design/audio-dropout-mid-playback.md H1, which blames
        // contention between the main and cue `pulsesink`s on one USB node — and which
        // until now was the *only* branch in this pipeline carrying no probes at all. A
        // live occurrence therefore produced a log that could not speak to the hypothesis
        // it was supposed to test.
        //
        // Only instrumented when the cue sink is real. On the fakesink fallback the pad
        // still sees buffers, but `sync=false` means its clock margin is meaningless and
        // its delivery count measures nothing about any device — a reading that looks
        // like evidence and is not.
        let cue_is_real = !self.cue_device.is_empty() && cue_remap_outcome.is_ok();
        // Second gate for the cue sink's flow probe: `cue_valve` drops every buffer while
        // cue is off, so without this each cue-off span forges a dropout. Seeded from the
        // deck's retained intent because a device rebuild re-enters load() mid-set with
        // cue already open. See instrument_sink_flow()'s doc comment.
        let cue_open = Arc::new(AtomicBool::new(self.cue_enabled));
        let cue_sink_flow: Option<SinkFlowState> = if cue_is_real {
            let st = instrument_sink_flow(
                &cue_sink,
                &self.deck_id,
                "cue sink",
                vec![at_playing.clone(), cue_open.clone()],
            );
            // Also registered with the bus thread, so a transition out of Playing
            // invalidates it alongside the main sinks.
            sink_flow_states.extend(st.clone());
            // Bracket the cue branch's last stage the same way the main branch is
            // bracketed: `cue_volume`'s src against the sink's own pad. A count that
            // advances at `cuevol` and not at `cuesink` isolates the fault to that link;
            // both advancing while the headphones are silent moves it past delivery.
            delivery_probes.extend(instrument_delivery(&cue_volume, "src", "cuevol"));
            delivery_probes.extend(instrument_delivery(&cue_sink, "sink", "cuesink"));
            st
        } else {
            None
        };

        // ⚠️ **Fully specified on purpose, and it must stay that way.** This filter sits on
        // *both* of input_selector's inputs — `rate_caps` on the normal branch and
        // `capsfilter2` on the scratch branch — so anything it leaves open is negotiated
        // independently per branch, and switching the selector then changes the caps seen by
        // everything downstream: output_queue, tee, both main sinks, and the cue branch.
        //
        // Until 2026-08-10 this constrained **rate alone**. The scratch branch therefore took
        // its format/layout/channel-mask from `appsrc`'s caps (F32LE, 2ch, *no channel-mask* —
        // unpositioned channels), while the normal branch took its own from the decoder chain.
        // The measured consequence: on the cue branch, whose `ch_conv` carries a hand-built
        // N×2 `mix-matrix` that is only meaningful against a **known** input channel layout,
        // the headphone output went to **exact digital zero** for the whole of every scratch
        // gesture — literal zero samples, quieter than the device's own −54 dBFS monitor floor
        // — while the main output continued at −19 dBFS and the cue branch's delivery probes
        // still counted 68 buffers/s. Buffers arriving full of silence is a negotiation
        // failure, not a flow one. See docs/design/slow-jog-audio-inaudible.md §10.
        //
        // Pinning every field makes the two branches caps-identical, so the selector switch
        // is a no-op downstream and `mix-matrix` never renegotiates. `audioconvert` +
        // `audioresample` sit upstream of both filters, so both branches can always satisfy
        // this; the mask is plain front-left/front-right (0x3).
        let caps_48k = gst::Caps::builder("audio/x-raw")
            .field("rate", 48_000i32)
            .field("format", "F32LE")
            .field("layout", "interleaved")
            .field("channels", 2i32)
            .field("channel-mask", gst::Bitmask(0x3))
            .build();
        rate_caps.set_property("caps", &caps_48k);
        capsfilter2.set_property("caps", &caps_48k);

        src.set_property("uri", file_to_uri(file_path));
        // Prevent video decoders from being instantiated. autoplug-select returning SKIP
        // for a factory causes decodebin to try the next one; when all factories for a
        // stream type are exhausted it fires unknown-type (WARNING, not ERROR) and
        // abandons that stream cleanly. autoplug-continue returning false leaves the pad
        // exposed but unlinked, causing a not-linked ERROR that crashes the pipeline.
        // Values: 0=TRY, 1=EXPOSE, 2=SKIP.
        src.connect("autoplug-select", false, |values| {
            // Skip video decoder factories so vaav1dec (and friends) are never instantiated.
            // Check the factory klass rather than the stream caps: caps like "video/quicktime"
            // describe the container, not just video tracks, so a caps-based check would also
            // skip the MP4/MOV demuxer and prevent the file from being opened at all.
            let factory = values.get(3).and_then(|v| v.get::<gst::ElementFactory>().ok())?;
            let klass = factory.metadata("klass").unwrap_or_default();
            let is_video_decoder = klass.contains("Decoder") && klass.contains("Video");
            let result_int = if is_video_decoder { 2i32 } else { 0i32 }; // SKIP=2, TRY=0
            let enum_class = glib::Type::from_name("GstAutoplugSelectResult")
                .and_then(glib::EnumClass::with_type)?;
            enum_class.to_value(result_int)
        });
        log::info!(
            "[audio/{}] load(): applying gain={:.3} vol={:.3} master_volume={:.3} -> volume={:.3} to {} main sink(s)",
            self.deck_id, self.gain, self.vol, self.master_volume,
            self.gain * self.vol * self.master_volume, volume_els.len()
        );
        for vol in &volume_els {
            // Bug fix: this omitted master_volume (unlike apply_volume(), the canonical
            // helper set_gain/set_volume/set_master_volume_factor all go through) — a
            // rebuild here always used to reset each sink's volume back to gain*vol alone,
            // silently dropping whatever master-volume attenuation was in effect until the
            // next explicit master-volume change nudged apply_volume() again.
            vol.set_property("volume", (self.gain * self.vol * self.master_volume) as f64);
        }
        pitch.set_property("tempo", self.rate as f32);
        queue.set_property("max-size-buffers", 2u32);
        queue.set_property("max-size-bytes", 0u32);
        queue.set_property("max-size-time", 0u64);
        // Time-based output queue: absorb soundtouch's variable-sized output chunks
        // (~82ms WSOLA window) while keeping tempo-change latency audibly tight.
        // 100ms was sized against pipewiresink's 21ms quantum (~5× headroom); since the
        // 2026-08-02 switch to pulsesink the downstream buffer is `sink_buffer_times()`
        // instead, so this is now ~2× a 50ms sink buffer. 500ms caused up to 500ms of
        // old-rate audio to drain before a new tempo was audible, so don't just widen it
        // — instrument_queue_flow() below reports if this cap is actually the binding
        // constraint.
        output_queue.set_property("max-size-buffers", 0u32);
        output_queue.set_property("max-size-bytes", 0u32);
        output_queue.set_property("max-size-time", OUTPUT_QUEUE_STEADY_CAP_NS);
        instrument_queue_flow(&output_queue, &self.deck_id, &at_playing);

        cue_valve.set_property("drop", !self.cue_enabled);
        make_eos_passthrough_valve(&cue_valve);
        cue_volume.set_property("volume", (self.gain * self.cue_gain * self.master_volume) as f64);
        cue_queue.set_property("max-size-buffers", 2u32);
        cue_queue.set_property("max-size-bytes", 0u32);
        cue_queue.set_property("max-size-time", 0u64);

        pipeline
            .add_many([&src, &queue, &convert, &resample, &rate_caps, &pitch, &output_queue,
                       &tee, &cue_valve, &cue_volume, &cue_queue, &cue_sink,
                       &appsrc_el, &convert2, &resample2, &capsfilter2, &valve_normal, &input_selector])
            .map_err(|e| format!("[{}] pipeline add_many: {e}", self.deck_id))?;
        for (vol, snk) in volume_els.iter().zip(main_sinks.iter()) {
            pipeline.add(vol).map_err(|e| format!("[{}] pipeline add volume: {e}", self.deck_id))?;
            pipeline.add(snk).map_err(|e| format!("[{}] pipeline add sink: {e}", self.deck_id))?;
        }
        if let Some(ref s) = spectrum_opt {
            pipeline.add(s).map_err(|e| format!("[{}] pipeline add spectrum: {e}", self.deck_id))?;
        }
        if let Some((ref ch_conv, ref ch_caps)) = cue_channel_remap {
            pipeline.add(ch_conv).map_err(|e| format!("[{}] pipeline add cue ch_conv: {e}", self.deck_id))?;
            pipeline.add(ch_caps).map_err(|e| format!("[{}] pipeline add cue ch_caps: {e}", self.deck_id))?;
        }

        queue.link(&convert).map_err(|e| format!("queue→audioconvert: {e}"))?;
        convert.link(&resample).map_err(|e| format!("audioconvert→audioresample: {e}"))?;
        resample.link(&rate_caps).map_err(|e| format!("audioresample→capsfilter: {e}"))?;
        rate_caps.link(&pitch).map_err(|e| format!("capsfilter→pitch: {e}"))?;
        // pitch → [spectrum →] valve_normal → input_selector ⌐
        //                          appsrc → convert2 → resample2 → capsfilter2 ⌐ ├→ output_queue → tee
        if let Some(ref s) = spectrum_opt {
            pitch.link(s).map_err(|e| format!("pitch→spectrum: {e}"))?;
            s.link(&valve_normal).map_err(|e| format!("spectrum→valve_normal: {e}"))?;
        } else {
            pitch.link(&valve_normal).map_err(|e| format!("pitch→valve_normal: {e}"))?;
        }
        gst::Element::link_many([&appsrc_el, &convert2, &resample2, &capsfilter2])
            .map_err(|e| format!("appsrc→convert2→resample2→capsfilter2: {e}"))?;

        let sel_normal_pad = input_selector.request_pad_simple("sink_%u")
            .ok_or_else(|| format!("[{}] input-selector: no normal sink pad", self.deck_id))?;
        let valve_src_pad = valve_normal.static_pad("src")
            .ok_or_else(|| format!("[{}] valve_normal: no src pad", self.deck_id))?;
        valve_src_pad.link(&sel_normal_pad).map_err(|e| format!("valve_normal→input_selector: {e}"))?;

        let sel_scratch_pad = input_selector.request_pad_simple("sink_%u")
            .ok_or_else(|| format!("[{}] input-selector: no scratch sink pad", self.deck_id))?;
        let caps2_src_pad = capsfilter2.static_pad("src")
            .ok_or_else(|| format!("[{}] capsfilter2: no src pad", self.deck_id))?;
        caps2_src_pad.link(&sel_scratch_pad).map_err(|e| format!("capsfilter2→input_selector: {e}"))?;

        input_selector.set_property("active-pad", &sel_normal_pad);

        input_selector.link(&output_queue).map_err(|e| format!("input_selector→output_queue: {e}"))?;
        output_queue.link(&tee).map_err(|e| format!("output_queue→tee: {e}"))?;

        // tee → main branches (one per configured output device)
        for (vol, snk) in volume_els.iter().zip(main_sinks.iter()) {
            let tee_pad = tee.request_pad_simple("src_%u")
                .ok_or_else(|| format!("[{}] tee: could not request main src pad", self.deck_id))?;
            let vol_sink_pad = vol.static_pad("sink")
                .ok_or_else(|| format!("[{}] volume: no sink pad", self.deck_id))?;
            tee_pad.link(&vol_sink_pad).map_err(|e| format!("tee→volume: {e}"))?;
            vol.link(snk).map_err(|e| format!("volume→sink: {e}"))?;
        }

        // tee → cue branch
        let tee_cue_pad = tee.request_pad_simple("src_%u")
            .ok_or_else(|| format!("[{}] tee: could not request cue src pad", self.deck_id))?;
        let cue_valve_sink_pad = cue_valve.static_pad("sink")
            .ok_or_else(|| format!("[{}] cue_valve: no sink pad", self.deck_id))?;
        tee_cue_pad.link(&cue_valve_sink_pad)
            .map_err(|e| format!("tee→cue_valve: {e}"))?;
        cue_valve.link(&cue_volume).map_err(|e| format!("cue_valve→cue_volume: {e}"))?;
        // cue_volume → [ch_conv → ch_caps →] cue_queue → cue_sink
        if let Some((ref ch_conv, ref ch_caps)) = cue_channel_remap {
            cue_volume.link(ch_conv).map_err(|e| format!("cue_volume→ch_conv: {e}"))?;
            ch_conv.link(ch_caps).map_err(|e| format!("ch_conv→ch_caps: {e}"))?;
            ch_caps.link(&cue_queue).map_err(|e| format!("ch_caps→cue_queue: {e}"))?;
        } else {
            cue_volume.link(&cue_queue).map_err(|e| format!("cue_volume→cue_queue: {e}"))?;
        }
        cue_queue.link(&cue_sink).map_err(|e| format!("cue_queue→cue_sink: {e}"))?;

        // Content levels along the whole cue path, plus one main-branch reference to read
        // them against. See instrument_level(): the cue branch measures digital zero at the
        // device during a scratch while its buffer counters read full rate, and no existing
        // probe distinguishes "buffers full of music" from "buffers full of silence". Each
        // stage here answers one link of the question — valve (is the tee feeding it),
        // cue_volume (did the gain stage zero it), post-matrix (did the routing drop it) —
        // and `main vol0` says whether the tee is delivering audio at all that second.
        instrument_level(&cue_valve, "src", "cue after valve", &self.deck_id);
        instrument_level(&cue_volume, "src", "cue after volume", &self.deck_id);
        if let Some((_, ref ch_caps)) = cue_channel_remap {
            instrument_level(ch_caps, "src", "cue post-matrix (to sink)", &self.deck_id);
        }
        if let Some(v0) = volume_els.first() {
            instrument_level(v0, "src", "main vol0 (reference)", &self.deck_id);
        }

        let queue_weak = queue.downgrade();
        let deck_id = self.deck_id.clone();
        src.connect_pad_added(move |_, pad| {
            let Some(queue) = queue_weak.upgrade() else { return };
            let is_audio = pad
                .current_caps()
                .map(|c| {
                    c.structure(0)
                        .map(|s| s.name().starts_with("audio/"))
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if !is_audio { return; }
            let sink_pad = match queue.static_pad("sink") {
                Some(p) => p,
                None => return,
            };
            if sink_pad.is_linked() { return; }
            if let Err(e) = pad.link(&sink_pad) {
                log::error!("[audio/{deck_id}] pad link error: {e}");
            }
        });

        let bus = pipeline.bus().ok_or_else(|| format!("[{}] no bus", self.deck_id))?;

        let at_eos = Arc::new(AtomicBool::new(false));
        let at_eos_thread = at_eos.clone();
        let at_error = Arc::new(AtomicBool::new(false));
        let at_error_thread = at_error.clone();
        // Logs the first received spectrum message so we can confirm the signal path.
        let fft_logged = Arc::new(AtomicBool::new(false));
        let fft_logged_thread = fft_logged.clone();
        let at_playing_thread = at_playing.clone();
        let sink_flow_thread = sink_flow_states.clone();
        let bus_thread = bus.clone();
        let deck_id_log = self.deck_id.clone();
        let eos_cb = self.eos_callback.clone();
        let app_handle = self.app.clone();
        let pipeline_eos = pipeline.clone();

        std::thread::spawn(move || {
            for msg in bus_thread.iter_timed(None) {
                match msg.view() {
                    gst::MessageView::Eos(_) => {
                        log::info!("[bus/{}] EOS", deck_id_log);
                        at_eos_thread.store(true, Ordering::Relaxed);
                        // Pause the pipeline ourselves right here instead of relying on the
                        // frontend to react to the eos_callback below and call audio_pause().
                        // GStreamer does NOT stop a pipeline's clock on EOS — PLAYING state
                        // keeps running with nothing left to render, so query_position keeps
                        // climbing indefinitely at wall-clock speed forever if nothing pauses
                        // it. Previously this depended entirely on the frontend's 'deck-eos'
                        // Tauri-event handler calling audio_pause() — live-tested (2026-07-25)
                        // and found that round trip does not reliably land in time (or at all)
                        // in every scenario, leaving audio playing forever with a waveform
                        // position that never stops growing (silently unbounded past the
                        // track's real duration). Pausing directly here makes the pipeline
                        // self-correct regardless of frontend timing/behavior.
                        if let Err(e) = pipeline_eos.set_state(gst::State::Paused) {
                            log::warn!("[bus/{}] EOS: failed to pause pipeline: {}", deck_id_log, e);
                        }
                        if let Some(cb) = &eos_cb { cb(); }
                    }
                    gst::MessageView::Error(e) => {
                        log::error!("[bus/{}] ERROR: {} (debug: {:?})", deck_id_log, e.error(), e.debug());
                        at_error_thread.store(true, Ordering::Relaxed);
                    }
                    gst::MessageView::Warning(w) => {
                        log::warn!("[bus/{}] WARNING: {} (debug: {:?})", deck_id_log, w.error(), w.debug());
                    }
                    gst::MessageView::AsyncDone(_) => {
                        let pos_ms = msg.src()
                            .and_then(|e| e.downcast_ref::<gst::Pipeline>())
                            .and_then(|p| p.query_position::<gst::ClockTime>())
                            .map(|t| t.mseconds())
                            .unwrap_or(0);
                        log::info!("[bus/{}] async-done  pos={}ms", deck_id_log, pos_ms);
                    }
                    gst::MessageView::StateChanged(s) => {
                        let src = msg.src().map(|e| e.name().to_string()).unwrap_or_default();
                        if src.starts_with("pipeline") {
                            log::info!("[bus/{}] pipeline: {:?} → {:?} (pending {:?})",
                                deck_id_log, s.old(), s.current(), s.pending());
                            // Gates the output_queue underrun/overrun diagnostics so they
                            // don't fire on the legitimately-empty queue during preroll or
                            // after EOS — see instrument_queue_flow().
                            let now_playing = s.current() == gst::State::Playing;
                            at_playing_thread.store(now_playing, Ordering::Relaxed);
                            if !now_playing {
                                // Invalidate every sink's last-buffer time so the span
                                // across this pause/preroll/EOS can never be reported as a
                                // dropout. Doing it here as well as in the probe closes the
                                // race where the resume's first buffer beats this message's
                                // sibling on the way back to Playing — see
                                // instrument_sink_flow(). Safe from this thread: the probe
                                // holds no other lock under this one.
                                for st in &sink_flow_thread {
                                    st.lock().unwrap().last = None;
                                }
                            }
                        }
                    }
                    gst::MessageView::Element(_) => {
                        let Some(structure) = msg.structure() else { continue };
                        if structure.name() != "spectrum" { continue; }
                        let Some(ref app) = app_handle else { continue };

                        // magnitude is a GstValueList (gst::List) of gfloat values in dBFS.
                        // Note: GstValueList != GstValueArray — gst::Array would silently fail here.
                        let Ok(magnitude) = structure.get::<gst::List>("magnitude") else {
                            log::warn!("[bus/{}] spectrum: no magnitude field; structure={}", deck_id_log, structure);
                            continue
                        };
                        let bands: Vec<f32> = magnitude
                            .as_slice()
                            .iter()
                            .filter_map(|v| v.get::<f32>().ok())
                            .collect();

                        let n = bands.len();
                        if n < 4 { continue; }

                        // Map dBFS (-80..0) to linear 0..1
                        let to_linear = |db: f32| ((db + 80.0) / 80.0).clamp(0.0, 1.0);
                        // With 32 bands at 48 kHz, each band ≈ 750 Hz.
                        // Bass 0–1500 Hz: bands 0–1; Mid 1500–7500 Hz: bands 2–9; High: rest.
                        let bass_end = (n * 2 / 32).max(1);
                        let mid_end = (n * 10 / 32).max(bass_end + 1);
                        let avg = |slice: &[f32]| -> f32 {
                            if slice.is_empty() { return 0.0; }
                            slice.iter().copied().map(to_linear).sum::<f32>() / slice.len() as f32
                        };

                        let bass  = avg(&bands[..bass_end]);
                        let mid   = avg(&bands[bass_end..mid_end]);
                        let high  = avg(&bands[mid_end..]);

                        if !fft_logged_thread.swap(true, Ordering::Relaxed) {
                            log::info!(
                                "[bus/{}] first audio-fft: {} bands  bass={:.3} mid={:.3} high={:.3}",
                                deck_id_log, n, bass, mid, high
                            );
                        }

                        let _ = app.emit("audio-fft", analysis::AudioFftEvent {
                            deck_id: deck_id_log.clone(),
                            bass,
                            mid,
                            high,
                            bands: bands.iter().copied().map(to_linear).collect(),
                        });
                    }
                    _ => {}
                }
            }
            log::info!("[bus/{}] monitor thread exiting", deck_id_log);
        });

        pipeline
            .set_state(gst::State::Paused)
            .map_err(|e| format!("[{}] set_state(Paused) failed: {e}", self.deck_id))?;

        let (ret, _cur, _pending) = pipeline.state(Some(gst::ClockTime::from_seconds(5)));
        match ret {
            Err(_) => {
                bus.set_flushing(true);
                let _ = pipeline.set_state(gst::State::Null);
                return Err(format!("[{}] preroll failed", self.deck_id));
            }
            Ok(gst::StateChangeSuccess::Async) => {
                log::warn!("[audio/{}] preroll still pending after 5s timeout", self.deck_id);
            }
            _ => {}
        }

        let duration = pipeline
            .query_duration::<gst::ClockTime>()
            .map(|d| d.nseconds() as f64 / 1_000_000_000.0);
        if let Some(dur) = duration {
            log::info!("[audio/{}] duration={:.3}s", self.deck_id, dur);
        }

        let delivery_probes_shared: DeliveryProbes = Arc::new(delivery_probes);
        spawn_delivery_reporter(&self.deck_id, &delivery_probes_shared, &at_playing);

        self.inner = Some(PipelineInner {
            pipeline,
            volume_els,
            cue_volume_el: cue_volume,
            cue_valve_el: cue_valve,
            pitch_el: pitch,
            bus,
            at_eos,
            at_error,
            appsrc,
            input_selector,
            sel_normal_pad,
            sel_scratch_pad,
            valve_normal_el: valve_normal,
            uridecodebin_el: src.clone(),
            scratch_feeder: None,
            output_queue_el: output_queue,
            main_sink_els: main_sinks,
            delivery_probes: delivery_probes_shared,
            cue_open,
            cue_sink_el: cue_sink,
            cue_sink_flow,
        });
        Ok(duration)
    }

    /// Switch main outputs to a new set of PipeWire sinks.
    ///
    /// PipeWire's `pipewiresink` does not support runtime target changes, so the
    /// pipeline must be torn down and rebuilt. Playback position and play/pause
    /// state are restored after the rebuild.
    pub fn set_devices(&mut self, devices: &[String]) -> Result<(), String> {
        self.devices = devices.to_vec();
        let file_path = match self.file_path.clone() {
            Some(p) => p,
            None => return Ok(()),
        };

        // position() returns the seek/output-domain value (same domain query_position
        // lives in — see seek()'s doc comment). Restore via seek_output_domain, not
        // seek(), which would treat it as content time and wrongly divide by rate again.
        let position = self.position().unwrap_or(0.0);
        let was_playing = self
            .inner
            .as_ref()
            .map(|i| i.pipeline.current_state() == gst::State::Playing)
            .unwrap_or(false);

        self.load(&file_path)?;

        if position > 0.01 {
            let _ = self.seek_output_domain(position);
        }
        if was_playing {
            self.play()?;
        }

        Ok(())
    }

    /// Switch cue/headphone output to a different PipeWire sink.
    /// Requires a pipeline rebuild for the same reason as set_devices.
    pub fn set_cue_device(&mut self, device: &str) -> Result<(), String> {
        self.cue_device = device.to_string();
        let file_path = match self.file_path.clone() {
            Some(p) => p,
            None => return Ok(()),
        };

        // See set_devices()'s comment: position() is already in the seek/output domain.
        let position = self.position().unwrap_or(0.0);
        let was_playing = self
            .inner
            .as_ref()
            .map(|i| i.pipeline.current_state() == gst::State::Playing)
            .unwrap_or(false);

        self.load(&file_path)?;

        if position > 0.01 {
            let _ = self.seek_output_domain(position);
        }
        if was_playing {
            self.play()?;
        }

        Ok(())
    }

    pub fn play(&mut self) -> Result<(), String> {
        self.playing = true;
        // Normal playback owns the playhead from here — see `last_scratch_frame`.
        self.last_scratch_frame = None;
        // Any post-scratch resync already happened synchronously in
        // stop_scratch_feeder() (it has to: switching input-selector's pad leaves the
        // sink needing a fresh preroll buffer on the newly-active branch, which only a
        // seek forces — deferring that to here would leave every intervening pause()
        // stuck ASYNC). Nothing left to do here for that case.
        let inner = self.inner.as_ref().ok_or_else(|| "no pipeline loaded".to_string())?;
        if inner.at_eos.swap(false, Ordering::Relaxed) {
            let _ = inner.pipeline.seek_simple(
                gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                gst::ClockTime::ZERO,
            );
        }
        inner.at_error.store(false, Ordering::Relaxed);
        inner
            .pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn pause(&mut self) -> Result<(), String> {
        self.stop_scratch_feeder();
        self.playing = false;
        let inner = self.inner.as_ref().ok_or_else(|| "no pipeline loaded".to_string())?;
        inner
            .pipeline
            .set_state(gst::State::Paused)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Seek to a position in **content time** (the file's own timeline — what the
    /// waveform, cue points, hot cues, and loop bounds all use).
    ///
    /// `pitch` (soundtouch) scales seek positions by the `tempo` ratio when it forwards
    /// them upstream to the decoder: a `seek_simple(V)` on this pipeline lands the actual
    /// decoded content at `V * tempo`, not at `V` — confirmed empirically with an
    /// `identity` probe inserted upstream of `pitch` (see docs/design/rate-position-drift.md,
    /// "seek-domain scaling bug"). This matches `query_position`/`query_duration`, which
    /// also live in this same tempo-scaled "seek domain": a 288.5s file at tempo 0.852
    /// reports `query_duration` = 338.6s (288.5 / 0.852). So to land content at the
    /// caller's requested `secs`, the seek must be issued at `secs / self.rate`.
    /// Bypassed at rate 1.0 (no-op division) and by `seek_output_domain` for internal
    /// callers that already have a value in the scaled domain (e.g. `position()`'s
    /// return value, when restoring position across a device-switch pipeline rebuild).
    pub fn seek(&mut self, secs: f64) -> Result<(), String> {
        self.seek_output_domain(secs / self.rate)
    }

    /// Seek to a raw position in the pipeline's own seek/position domain — i.e. exactly
    /// what `query_position`/`position()` return, already tempo-scaled. Used internally
    /// where the caller already holds a value in that domain rather than content time
    /// (see `seek`'s doc comment for why the two differ at any rate != 1.0).
    fn seek_output_domain(&mut self, secs: f64) -> Result<(), String> {
        // The playhead just moved by a route that has nothing to do with the scratch
        // cursor, so the remembered landing frame is now wrong — see `last_scratch_frame`.
        self.last_scratch_frame = None;
        let inner = self.inner.as_ref().ok_or_else(|| "no pipeline loaded".to_string())?;
        // An explicit seek means the user chose a new position — don't restart from 0 on next play().
        inner.at_eos.store(false, Ordering::Relaxed);
        let pos = gst::ClockTime::from_nseconds((secs * 1_000_000_000.0) as u64);
        inner
            .pipeline
            .seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT, pos)
            .map_err(|e| e.to_string())
    }

    /// Set the playback tempo (speed without pitch change). Applied instantly via the
    /// soundtouch pitch element's `tempo` property — no seek or pipeline flush needed.
    pub fn set_rate(&mut self, rate: f64) -> Result<(), String> {
        self.rate = rate.clamp(0.1, 4.0);
        if let Some(inner) = &self.inner {
            inner.pitch_el.set_property("tempo", self.rate as f32);
        }
        Ok(())
    }

    /// Pre-fader trim (0–4). Values above 1.0 boost quiet tracks. Effective audio = gain × volume.
    pub fn set_gain(&mut self, gain: f32) -> Result<(), String> {
        self.gain = gain.clamp(0.0, 4.0);
        self.apply_volume();
        Ok(())
    }

    /// Post-fader level (0–1), driven by crossfader / volume fader.
    pub fn set_volume(&mut self, volume: f32) -> Result<(), String> {
        self.vol = volume.clamp(0.0, 1.0);
        self.apply_volume();
        Ok(())
    }

    /// Independent gain for the cue/headphone output (0–4).
    pub fn set_cue_gain(&mut self, gain: f32) -> Result<(), String> {
        self.cue_gain = gain.clamp(0.0, 4.0);
        if let Some(inner) = &self.inner {
            inner.cue_volume_el.set_property("volume", (self.gain * self.cue_gain) as f64);
        }
        Ok(())
    }

    fn apply_volume(&self) {
        if let Some(inner) = &self.inner {
            for vol in &inner.volume_els {
                vol.set_property("volume", (self.gain * self.vol * self.master_volume) as f64);
            }
            inner.cue_volume_el.set_property("volume", (self.gain * self.cue_gain * self.master_volume) as f64);
        }
    }

    pub fn set_master_volume_factor(&mut self, factor: f32) {
        self.master_volume = factor.clamp(0.0, 1.0);
        self.apply_volume();
    }

    /// EQ bands in dB. No-op until equalizer-3bands element is added.
    pub fn set_eq(&self, _low_db: f32, _mid_db: f32, _high_db: f32) -> Result<(), String> {
        Ok(())
    }

    /// Open or close the headphone cue branch via the valve gate.
    ///
    /// Also maintains the cue sink's flow-probe gate. Order matters on the way *down*:
    /// clear `cue_open` first, then invalidate the probe's last-buffer time, so a buffer
    /// already in flight cannot re-stamp it after the clear — with the flag false the
    /// probe writes `None` itself. Doing only one of the two is the D2 trap: the gate
    /// alone leaves a stale timestamp from just before the valve closed, and the next
    /// cue-on reports the whole cue-off span as a dropout. See `instrument_sink_flow()`.
    pub fn set_cue_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.cue_enabled = enabled;
        if let Some(inner) = &self.inner {
            inner.cue_open.store(enabled, Ordering::Relaxed);
            if let Some(st) = &inner.cue_sink_flow {
                st.lock().unwrap().last = None;
            }
            inner.cue_valve_el.set_property("drop", !enabled);
            log::info!("[audio/{}] cue {}", self.deck_id, if enabled { "ON" } else { "OFF" });
        }
        Ok(())
    }

    /// Variable-rate scratch playback while paused, via the PCM-buffer feeder branch
    /// (see docs/design/pcm-buffer-playback.md) rather than a GStreamer segment-rate
    /// seek — reverse-direction segment seeks are rejected/misbehave at the demuxer
    /// level on this pipeline (wavparse/qtdemux; see docs/design/jog-scratch-audio.md),
    /// so this bypasses demuxers entirely: the file is pre-decoded to raw stereo PCM at
    /// load time (`pcm_buffer`) and a feeder thread walks it forward or backward at
    /// `rate`, pushing into an `appsrc` branch that exclusive-switches against the
    /// normal branch via `input_selector`, downstream of `pitch` — pitch bend from
    /// speed is inherent to walking the buffer at a non-1.0 step, so soundtouch is
    /// bypassed rather than reused (see the topology comment in `load()`).
    ///
    /// Cheap to call repeatedly: the first call in a scratch gesture starts the feeder
    /// thread and flips the input-selector/valve; every subsequent call while the
    /// gesture continues just updates the shared rate the feeder thread reads on its
    /// next chunk — no seek, no pipeline state change.
    /// `hold_ms`: how long the feeder keeps free-running at the last `rate` after this
    /// call before decaying toward silence/hold if no further `scratch()` call
    /// refreshes it — see the field comment on `ScratchFeeder::hold_ms`.
    pub fn scratch(&mut self, rate: f64, hold_ms: u64) -> Result<(), String> {
        // NaN target = velocity mode (see ScratchFeeder::target_frames_bits). Written
        // unconditionally so a gesture that started in position mode can be handed over
        // to velocity mode without restarting the feeder.
        self.begin_or_update_scratch(rate, f64::NAN, hold_ms)
    }

    /// Position-mode scratch: drive the feeder toward an absolute content position
    /// instead of at a rate. Same audible result as `scratch()` — the feeder still walks
    /// the PCM buffer and pitch still bends with speed — but the caller supplies *where
    /// to be* rather than *how fast to go*, so it cannot drift and repeated updates are
    /// safe to coalesce down to the most recent one.
    ///
    /// This is the mode for anything driven by direct manipulation: a waveform drag
    /// (which has an absolute position by construction) and vinyl-mode jog (which gets
    /// one by accumulating encoder ticks). See `target_frames_bits` for why velocity is
    /// the wrong control variable for those inputs.
    ///
    /// `target_secs` is **content time**, the same domain as the waveform, cue points and
    /// the PCM buffer itself — not the tempo-scaled seek domain `seek()` takes.
    pub fn scratch_to(&mut self, target_secs: f64, hold_ms: u64) -> Result<(), String> {
        let rate = self.pcm_buffer.as_ref().map(|p| p.rate as f64).unwrap_or(48_000.0);
        self.begin_or_update_scratch(0.0, target_secs.max(0.0) * rate, hold_ms)
    }

    /// Shared body of `scratch()`/`scratch_to()`: starts the feeder and switches the
    /// topology on the first call of a gesture, and is a cheap atomic store on every
    /// call after that.
    fn begin_or_update_scratch(
        &mut self,
        rate: f64,
        target_frames: f64,
        hold_ms: u64,
    ) -> Result<(), String> {
        let pcm = self.pcm_buffer.clone().ok_or_else(|| {
            format!("[{}] no PCM buffer decoded — scratch unavailable for this file", self.deck_id)
        })?;
        let last_scratch_frame = self.last_scratch_frame;
        let inner = self.inner.as_mut().ok_or_else(|| "no pipeline loaded".to_string())?;
        inner.at_eos.store(false, Ordering::Relaxed);

        if let Some(feeder) = &inner.scratch_feeder {
            feeder.rate_bits.store(rate.to_bits(), Ordering::Relaxed);
            feeder.target_frames_bits.store(target_frames.to_bits(), Ordering::Relaxed);
            // Gap since the previous update, measured here rather than in the feeder
            // thread: this is the arrival time of the input event itself, whereas the
            // feeder only ever sees the *latest* value at 15ms chunk boundaries and so
            // cannot distinguish "no update" from "several coalesced into one".
            {
                let mut last = feeder.last_update.lock().unwrap();
                let now = Instant::now();
                feeder
                    .target_gaps_ms
                    .lock()
                    .unwrap()
                    .record(now.duration_since(*last).as_millis().min(u32::MAX as u128) as u32);
                *last = now;
            }
            return Ok(());
        }

        // Prefer where the last gesture's cursor actually landed over asking GStreamer:
        // the previous stop_scratch_feeder()'s resync seek may still be in flight, in
        // which case query_position() reports the pre-gesture position and the new
        // gesture starts with a visible jump. See `last_scratch_frame`.
        //
        // query_position() is in the seek/output domain (see seek()'s doc comment) —
        // scale by self.rate (the tempo currently in effect) to recover true content
        // time before indexing into the PCM buffer, which is authored at real content
        // time (scratch bypasses `pitch` entirely — see the module doc comment on
        // this branch). Without this, starting a scratch gesture after playing at a
        // non-1.0 rate begins the feeder from the wrong point in the file, off by the
        // same tempo ratio as the seek-domain bug in seek() (see
        // docs/design/rate-position-drift.md).
        //
        // ⚠️ **Position mode ignores both and starts at the caller's own target.** The
        // caller anchored the gesture on `getDeckTime()`, which is the clock the waveform
        // is drawn from — so it is the position the user is looking at and grabbing. Any
        // disagreement with GStreamer's idea of the playhead becomes a jump on the first
        // chunk, and if it exceeds SCRATCH_TARGET_SNAP_SECS the servo *snaps* and reports
        // `arrived`, opening every gesture on silence. Measured live 2026-08-08: a jog
        // gesture whose accumulator moved 5.126s left the cursor 7.484s further on,
        // because query_position() said frame 0 while the frontend anchor said 2.358s.
        // In position mode there is nothing to recover — the caller states where to be.
        let start_frame = if !target_frames.is_nan() {
            target_frames
        } else {
            match last_scratch_frame {
                Some(frame) => frame,
                None => {
                    let start_secs = inner
                        .pipeline
                        .query_position::<gst::ClockTime>()
                        .map(|t| (t.nseconds() as f64 / 1_000_000_000.0).max(0.0))
                        .unwrap_or(0.0)
                        * self.rate;
                    start_secs * pcm.rate as f64
                }
            }
        };

        inner.input_selector.set_property("active-pad", &inner.sel_scratch_pad);
        inner.valve_normal_el.set_property("drop", true);
        // Freeze the normal branch's source: without this, valve_normal's drop=true
        // discards instantly rather than blocking, so nothing backpressures
        // uridecodebin and it decodes (and discards) the rest of the file in a
        // fraction of a second — see the field comment on valve_normal_el.
        inner.uridecodebin_el.set_locked_state(true);

        // Widen output_queue's cap before the Paused→Playing transition below —
        // see SCRATCH_STARTUP_QUEUE_CAP_NS's doc comment for why. Stays widened
        // for the whole gesture (not narrowed on a timer): an earlier version
        // narrowed back after a fixed grace period, but narrowing a live
        // GstQueue while it's still holding a backlog above the *new* (lower)
        // cap makes it immediately re-apply backpressure — turning the
        // intermittent stall into a deterministic one landing right at the
        // timer's deadline (confirmed empirically: every repro run stalled for
        // ~1.2-1.4s starting almost exactly at the old 1500ms grace mark).
        // stop_scratch_feeder() narrows it back once the gesture actually ends
        // and the normal branch needs tight latency again.
        inner.output_queue_el.set_property("max-size-time", SCRATCH_STARTUP_QUEUE_CAP_NS);

        // Widen the sinks' timestamp-alignment tolerance for the gesture, before the
        // Paused→Playing transition below — see scratch_sink_alignment() for the full
        // mechanism. Must be set before PLAYING: the sink reads these on its streaming
        // thread from the first buffer, and the failure it prevents begins accumulating
        // immediately (the gesture that first exposed it opened 93ms late).
        let (align_ns, discont_wait_ns) = scratch_sink_alignment();
        set_sink_alignment(&inner.main_sink_els, align_ns, discont_wait_ns);
        log::info!(
            "[audio/{}] scratch: sink alignment-threshold={}ms discont-wait={}ms (defaults {}ms/{}ms)",
            self.deck_id,
            align_ns / 1_000_000,
            discont_wait_ns / 1_000_000,
            SINK_ALIGN_DEFAULTS_NS.0 / 1_000_000,
            SINK_ALIGN_DEFAULTS_NS.1 / 1_000_000,
        );

        inner
            .pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("scratch play failed: {e}"))?;

        inner.scratch_feeder = Some(spawn_scratch_feeder(
            self.deck_id.clone(),
            inner.appsrc.clone(),
            pcm,
            start_frame,
            rate,
            target_frames,
            hold_ms,
            inner.delivery_probes.clone(),
        ));
        Ok(())
    }

    /// Stops scratch playback and returns to Paused. Resyncs the normal branch to
    /// wherever the scratch cursor landed (see stop_scratch_feeder) — the normal
    /// (uridecodebin) branch never advances during scratch, so its own position is
    /// stale until this runs.
    pub fn stop_scratch(&mut self) -> Result<(), String> {
        self.stop_scratch_feeder();
        self.pause()
    }

    /// Joins the feeder thread (if any) and switches the topology back to the normal
    /// branch. Shared by stop_scratch() and pause() (defensive: a direct audio_pause
    /// call while scratch is active must not leave it running against a paused
    /// pipeline) and by load()'s teardown (via the associated-fn form below).
    fn stop_scratch_feeder(&mut self) {
        let Some(inner) = self.inner.as_mut() else { return };
        let t_entry = Instant::now();
        let Some(final_frame) = Self::take_and_join_feeder(inner) else { return };
        // Remember where the gesture ended before doing anything else — the resync below
        // takes ~300ms of sleep and seeks, and a gesture starting inside that window must
        // not fall back to query_position()'s stale answer. See `last_scratch_frame`.
        self.last_scratch_frame = Some(final_frame);

        // Narrow output_queue back to the steady cap — the normal branch is
        // about to become active again and wants tight tempo-change latency,
        // not the widened scratch-startup allowance (see scratch()'s comment
        // on why this narrows here, at gesture end, rather than on a timer).
        inner.output_queue_el.set_property("max-size-time", OUTPUT_QUEUE_STEADY_CAP_NS);

        // Restore stock alignment tolerance — the normal branch is about to feed these
        // sinks again, and there a real timestamp discontinuity should resync rather than
        // be masked into contiguous-but-late audio. See scratch_sink_alignment().
        //
        // Deliberately before the early `return` below: that path (no PCM buffer) skips
        // only the resync seek, and leaving the sinks widened because a buffer was absent
        // would be a silent, sticky change to normal playback.
        set_sink_alignment(
            &inner.main_sink_els,
            SINK_ALIGN_DEFAULTS_NS.0,
            SINK_ALIGN_DEFAULTS_NS.1,
        );

        let Some(pcm) = &self.pcm_buffer else { return };
        let pos = (final_frame / pcm.rate as f64).max(0.0);
        let target = gst::ClockTime::from_nseconds((pos * 1_000_000_000.0) as u64);

        // Let the feeder's already-pushed fade-out tail actually drain through
        // output_queue (up to 100ms of buffering — see its field comment) before the
        // flush below discards whatever's still queued. Blocks the calling thread (a
        // Tauri command handler, not the audio thread) briefly; harmless here since a
        // discrete stop_scratch() call isn't as latency-sensitive as per-tick rate
        // updates.
        std::thread::sleep(Duration::from_millis(130));

        // Flush *while still on the scratch pad*, before switching input-selector back.
        // Empirically required (found via a real hang, not by inspection): without this
        // first flush, switching straight to the normal branch and then seeking leaves
        // the main sink stuck ASYNC forever — `pipeline.state()` reports it pinned at
        // cur=Playing target=Paused indefinitely, no matter how long you wait. This
        // flush resets the sink's preroll bookkeeping cleanly so the second seek below
        // (on the newly-active normal branch) actually completes. The exact target time
        // doesn't matter here — the appsrc branch has no real seekable position — only
        // the FLUSH_START/STOP cycle it triggers through the shared downstream chain.
        let t_seek1 = Instant::now();
        let _ = inner.pipeline.seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT, target);
        let seek1_ms = t_seek1.elapsed().as_secs_f64() * 1000.0;

        inner.input_selector.set_property("active-pad", &inner.sel_normal_pad);
        inner.valve_normal_el.set_property("drop", false);
        // Unlock so the normal branch's state tracks the pipeline again — the seek
        // below needs uridecodebin to actually respond to it.
        inner.uridecodebin_el.set_locked_state(false);

        // The real resync: forces uridecodebin to produce a buffer at the scratch
        // cursor's landing position and the sink to preroll against it, now that the
        // normal branch is the active one — it never advanced during scratch
        // (valve_normal closed the whole time), so its position is stale otherwise.
        //
        // ACCURATE, not KEY_UNIT: KEY_UNIT snaps to the nearest keyframe, which can be
        // up to a full GOP away from `target` (observed ~0.5s off on an mp4 source —
        // the next scratch's start_secs then reads that snapped position, so gestures
        // appeared to resume from a keyframe-quantized spot instead of where the wheel
        // actually left off). ACCURATE costs a bit more (decode from the prior keyframe
        // up to target) but this is a discrete once-per-gesture seek, not a hot path.
        //
        // This seek travels through `pitch` (the normal branch is now active — see the
        // input_selector switch above), which scales seek positions by `tempo`/`rate`
        // (docs/design/rate-position-drift.md, "seek-domain scaling bug"). `pos`/`target`
        // is real content time (the PCM buffer's own cursor, which bypasses pitch during
        // scratch), so it must be divided by self.rate before being handed to a seek that
        // crosses pitch — otherwise, at any non-1.0 rate, the normal branch resumes from
        // the wrong content position after every scratch gesture.
        let target_output_domain = gst::ClockTime::from_nseconds(
            ((pos / self.rate) * 1_000_000_000.0) as u64
        );
        let t_seek2 = Instant::now();
        let _ = inner.pipeline.seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE, target_output_domain);
        let seek2_ms = t_seek2.elapsed().as_secs_f64() * 1000.0;

        // Per-phase timing — added after a live session reported the app "choking up"
        // during vinyl-mode scratching well after the mutex-detach fix (which only
        // bounds how long *other* decks wait, not this deck's own teardown). Any of
        // these phases running far longer than its comment above claims narrows down
        // where a future stall actually is, instead of guessing between "JS timer
        // delayed," "feeder thread stuck in push_buffer," or "seek is slow."
        log::info!(
            "[scratch/{}] teardown timing: total={:.1}ms  warmup_seek={:.1}ms  resync_seek={:.1}ms",
            self.deck_id,
            t_entry.elapsed().as_secs_f64() * 1000.0,
            seek1_ms,
            seek2_ms,
        );
    }

    /// Signals the feeder thread to fade out and stop, joins it, and returns the frame
    /// it last reached. Plain associated fn (not `&mut self`) so `load()`'s teardown —
    /// which only has a live `&mut PipelineInner` for the pipeline being replaced, not
    /// a full `&mut self` — can call it too.
    fn take_and_join_feeder(inner: &mut PipelineInner) -> Option<f64> {
        let feeder = inner.scratch_feeder.take()?;
        feeder.stop_requested.store(true, Ordering::Relaxed);
        if let Some(h) = feeder.handle {
            let t0 = Instant::now();
            let _ = h.join();
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            // The feeder loop wakes every SCRATCH_CHUNK_MS (15ms) to check
            // stop_requested, so join() should return in low tens of ms. A much
            // larger value means the thread was stuck somewhere in its loop body
            // (most likely appsrc.push_buffer() blocking on downstream backpressure)
            // and unable to even reach the stop_requested check.
            if ms > 100.0 {
                log::warn!(
                    "[scratch] feeder thread join took {ms:.1}ms (expected ~15ms) — \
                     thread was likely stuck, not just slow to notice stop_requested"
                );
            } else {
                log::info!("[scratch] feeder thread joined in {ms:.1}ms");
            }
        }
        Some(f64::from_bits(feeder.cursor_frames_bits.load(Ordering::Relaxed)))
    }

    /// True when the user has pressed play (survives device rebuilds; see the `playing`
    /// field doc comment). Used by session_store.rs to report live state for a deck
    /// whose webview died — the pipeline is the ground truth, not the (possibly stale)
    /// JS-side snapshot.
    pub fn is_playing(&self) -> bool {
        self.playing
    }

    /// Current tempo multiplier (see `set_rate`).
    pub fn rate(&self) -> f64 {
        self.rate
    }

    /// Current playback position in seconds. None if no pipeline is loaded.
    pub fn position(&self) -> Option<f64> {
        let inner = self.inner.as_ref()?;

        // While a scratch feeder is active, the pipeline's running position reflects
        // the appsrc branch's wall-clock output time (do-timestamp=true stamps buffers
        // by when they were pushed, not by what part of the track they contain) —
        // completely unrelated to where in the file the feeder is actually reading
        // from. The feeder's own cursor (already tracked for the stop_scratch_feeder
        // resync) is the real content position; report that instead so the frontend's
        // position poll (and therefore the displayed timestamp/waveform playhead) moves
        // correctly during a scratch gesture instead of reading a meaningless value.
        if let Some(feeder) = &inner.scratch_feeder {
            if let Some(pcm) = &self.pcm_buffer {
                let frame = f64::from_bits(feeder.cursor_frames_bits.load(Ordering::Relaxed));
                return Some((frame / pcm.rate as f64).max(0.0));
            }
        }

        // A negative position is never meaningful to callers (the waveform's playhead
        // math divides by duration and draws off-canvas on a negative result) — clamp
        // defensively even though sampled query_position output (2000+ samples across
        // play/pause/seek/rate-change) never showed one in practice.
        inner
            .pipeline
            .query_position::<gst::ClockTime>()
            .map(|t| (t.nseconds() as f64 / 1_000_000_000.0).max(0.0))
    }
}

impl Drop for DeckAudioPipeline {
    fn drop(&mut self) {
        if let Some(ref mut inner) = self.inner {
            Self::take_and_join_feeder(inner);
            inner.uridecodebin_el.set_locked_state(false);
            inner.bus.set_flushing(true);
            let _ = inner.pipeline.set_state(gst::State::Null);
        }
    }
}

// ── Scratch feeder (docs/design/pcm-buffer-playback.md) ────────────────────────────

/// Feeder-thread handle for one active scratch gesture. Lives inside `PipelineInner`
/// only while a scratch is in progress; `None` the rest of the time.
struct ScratchFeeder {
    /// Signed rate (PCM-buffer frames advanced per output frame), updated live by
    /// every scratch() call during an ongoing gesture — no seek needed to change it.
    /// Ignored while `target_frames_bits` holds a real target (see below).
    rate_bits: Arc<AtomicU64>,
    /// Absolute target position in PCM-buffer frames for **position mode**, or NaN for
    /// **velocity mode** (the original free-running behaviour, still used by shuttle
    /// scratch). Written by `scratch_to()`; `scratch()` writes NaN, so a caller can
    /// switch a live gesture between the two without restarting the feeder.
    ///
    /// Position mode exists because velocity is the wrong control variable for anything
    /// driven by direct manipulation. The rate a gesture *should* produce is a function
    /// of how far the input moved, but a velocity estimate can only recover that by
    /// dividing by inter-event timing — and both of this app's direct-manipulation
    /// inputs deliver events in bursts (USB MIDI jog ticks; rAF-coalesced pointer
    /// moves), which makes that divisor meaningless and lets error accumulate for the
    /// whole gesture with nothing to correct it against. A target is absolute: it
    /// cannot drift, and coalescing several updates into the latest one loses nothing.
    target_frames_bits: Arc<AtomicU64>,
    /// Set by take_and_join_feeder() to tell the thread to fade out and exit.
    stop_requested: Arc<AtomicBool>,
    /// Buffer-frame cursor, updated by the feeder thread every chunk so
    /// take_and_join_feeder() can read the final scratch position after join.
    cursor_frames_bits: Arc<AtomicU64>,
    /// Timestamp of the most recent scratch() call for this gesture. Compared each
    /// chunk against `hold_ms` (captured by the thread at spawn, immutable for the
    /// gesture — see the shuttle/vinyl distinction on `spawn_scratch_feeder`) to decide
    /// whether the feeder should still be free-running at the last rate or has gone
    /// idle and should decay toward silence/hold. A Mutex is fine here: written at
    /// most once per scratch() call (≤ rAF rate, ~60Hz) and read once per 15ms chunk —
    /// no meaningful contention.
    last_update: Arc<Mutex<Instant>>,
    /// Inter-arrival gaps between position-mode target updates, in milliseconds, drained
    /// once a second by the feeder's telemetry.
    ///
    /// **Why this is measured rather than assumed.** `SCRATCH_SERVO_LAG_CHUNKS`'s whole
    /// justification rests on a claimed update cadence of "~25–40ms" — at which a 4-chunk
    /// (60ms) lag can never be outrun and the cursor never parks. The live evidence
    /// contradicts that: a hard gesture reports `arrived` on 41–48% of chunks (the cursor
    /// *did* catch up and mute, repeatedly) and a smooth one swings instantaneous rate
    /// 3–6× above its one-second mean (a lurch, i.e. a large error appearing at once).
    /// Both imply gaps far longer than 60ms. The cadence has never actually been
    /// instrumented, and the two candidate fixes — lengthen the lag, or coast through the
    /// gap at a decaying rate — are chosen by what this distribution turns out to be.
    ///
    /// Bounded to `TARGET_GAP_SAMPLE_CAP` so a wedged telemetry drain cannot grow it
    /// without limit; overflow is counted, not silently dropped.
    target_gaps_ms: Arc<Mutex<TargetGapStats>>,
    handle: Option<std::thread::JoinHandle<()>>,
}

/// Cap on retained per-second gap samples. One second of the fastest plausible update
/// cadence (rAF, ~60Hz) is 60 samples; 512 is far above that and still trivially small.
const TARGET_GAP_SAMPLE_CAP: usize = 512;

#[derive(Default)]
struct TargetGapStats {
    gaps_ms: Vec<u32>,
    /// Updates that arrived while `gaps_ms` was at cap. Non-zero here means the
    /// percentiles below are computed on a truncated sample — read them accordingly.
    dropped: u32,
}

impl TargetGapStats {
    fn record(&mut self, gap_ms: u32) {
        if self.gaps_ms.len() < TARGET_GAP_SAMPLE_CAP {
            self.gaps_ms.push(gap_ms);
        } else {
            self.dropped += 1;
        }
    }

    /// `(count, p50, p90, max, dropped)`, and clears. Percentiles use nearest-rank on the
    /// sorted sample — the distribution's *shape* is the question here (is there a tail of
    /// long gaps?), which a mean would hide entirely.
    fn drain(&mut self) -> (usize, u32, u32, u32, u32) {
        let dropped = std::mem::take(&mut self.dropped);
        let mut g = std::mem::take(&mut self.gaps_ms);
        if g.is_empty() {
            return (0, 0, 0, 0, dropped);
        }
        g.sort_unstable();
        let at = |q: f64| g[(((g.len() as f64 - 1.0) * q).round() as usize).min(g.len() - 1)];
        (g.len(), at(0.5), at(0.9), g[g.len() - 1], dropped)
    }
}

/// Wall-clock duration of each pushed appsrc buffer. Small enough for responsive rate
/// changes (a scratch() call takes effect on the feeder's next chunk) without thrashing
/// the appsrc/queue chain at the 60+ calls/sec queueScratchRate can produce.
const SCRATCH_CHUNK_MS: u64 = 15;
/// Fade-in/out ramp length in output frames (~5ms @ 48kHz), applied at scratch
/// start/stop and on any direction reversal. Every scratch gesture starts and ends
/// against silence (the deck is paused before/after), so this is what avoids a click
/// at those two splice points; direction reversals don't need it by construction (the
/// cursor is continuous — only its velocity's sign changes) but get a cheap re-ramp
/// anyway as insurance.
const SCRATCH_FADE_FRAMES: usize = 240;

/// Position mode: how close (in PCM frames) the cursor must be to the target to count as
/// "arrived". Below this the feeder stops advancing and fades to silence, so a stationary
/// finger/wheel produces silence rather than a stalled-cursor buzz — the same thing
/// `hold_ms` does for velocity mode, but keyed on the target instead of on elapsed time.
///
/// ⚠️ **Not "closer than the cursor can resolve" (half a frame), which is what this was
/// until 2026-08-08.** With `SCRATCH_SERVO_LAG_CHUNKS` the cursor approaches the target
/// asymptotically, so a half-frame epsilon keeps the gesture technically-moving — and
/// therefore audible — for a long exponential tail after the hand stops. A quarter of a
/// millisecond is inaudible as a position error and reaches silence in ~200ms of decay,
/// which sounds like a record coming to rest rather than like a stuck cursor.
const SCRATCH_TARGET_EPSILON_FRAMES: f64 = 12.0;

/// Position mode: how long the servo takes to close the distance to the target, in
/// 15ms chunks — the single most important number in this mode.
///
/// It was effectively 1 until 2026-08-08 (`rate = err / chunk_frames`), and that is what
/// made live scratch audio nearly silent. Covering the whole error inside one chunk means
/// the cursor moves for 15ms and then reports `arrived` — silence — until the next update
/// lands. Position updates arrive every ~25–40ms (rAF-coalesced pointer moves; USB MIDI
/// jog bursts), so the output was a train of ~15ms blips separated by silence, each one
/// additionally gain-ramped up and down through `SCRATCH_FADE_FRAMES`. The user report was
/// simply "scrubbing does not play back any audio", and the measurement agrees: at a
/// hand speed of 0.2x the duty cycle is under half, at a third of normal pitch.
///
/// Spreading the error over several chunks makes it a first-order lag instead, which is
/// the right filter for this input: for a *ramp* — a hand moving at a steady speed, which
/// is what a scrub is — a first-order lag settles to the **same slope** as its input. So
/// the cursor ends up walking the buffer at exactly the hand's speed, continuously, with
/// only a constant position lag behind the target (`hand_speed × lag`, e.g. 12ms of
/// content at 0.2x — inaudible). Continuous motion at the true speed is both the audible
/// fix and the pitch-correct one.
///
/// 4 chunks (~60ms) is short enough that the lag never reads as latency and long enough
/// that no realistic update cadence can outrun it.
const SCRATCH_SERVO_LAG_CHUNKS: f64 = 4.0;

/// Position mode: ceiling on servo speed, in buffer frames per output frame. Keeps a
/// large target change from becoming a screech; the cursor instead sweeps toward it over
/// several chunks, which is what dragging a record fast actually sounds like.
const SCRATCH_TARGET_MAX_RATE: f64 = 8.0;

/// Position mode: target changes larger than this stop being a scrub and become a jump —
/// the cursor snaps and re-ramps through `SCRATCH_FADE_FRAMES` instead of sweeping. At
/// `SCRATCH_TARGET_MAX_RATE` a sweep covers ~0.12s of content per 15ms chunk, so without
/// a snap a coarse drag across a whole-track overview (easily 100s in one gesture) would
/// spend many seconds racing through content nobody asked to hear.
const SCRATCH_TARGET_SNAP_SECS: f64 = 0.5;

/// Position mode: how long the cursor keeps moving after target updates stop, in 15ms
/// chunks, tapering linearly to a standstill across the window.
///
/// **Why any coasting at all** (measured 2026-08-08 night 2, `scratch-audio-downstream-delivery.md`
/// "RUN … the stall is absence of input"): a slowly-moving hand does not produce a steady
/// stream of pointer events. At 16s over a 1224px canvas the gentle drag was moving 13–27
/// px/s and the DOM delivered **5–12 events/s** — ~2.3px per event, with gaps to 1180ms —
/// while every other leg of the delivery path measured clean (`rafWait` 13ms, `ipc` 11ms,
/// `evQueue` 4ms on the event that ended the longest gap: freshly stamped, not late). The
/// events were never produced. Between them the servo converged inside
/// `SCRATCH_TARGET_EPSILON_FRAMES` and faded, so `arrived%` tracked hand speed inversely
/// and exactly: 15–45% muted below 0.35x, **0% for eleven straight seconds** above 0.96x.
/// The user's report was "the gentle one dropped out frequently; the hard drag created sound
/// consistently".
///
/// A platter has mass: when your hand stops feeding it motion it does not stop dead. That is
/// both the audible fix and the honest physical model, and it is why the window tapers rather
/// than ending abruptly.
///
/// **Sizing.** Position error is bounded by `SCRATCH_COAST_MAX_FRAMES`, not by this window, so
/// this is chosen purely for how long a silence it bridges. Silence begins once the servo
/// closes the last jump to within `SCRATCH_TARGET_EPSILON_FRAMES` — from a tight-burst update
/// (~228 frames at 0.28x) that takes ~150ms, which is why gaps as short as the measured 228ms
/// already produced 15% muted chunks. 20 chunks (300ms) plus that convergence tail covers
/// gaps to roughly 450ms, i.e. the frequent ones.
///
/// It is deliberately **not** long enough to bridge the measured 1180ms outlier. Covering that
/// would make this a flywheel, and a hand that crosses no pixel for 1.2s at 13–27px/s has
/// genuinely stopped — a held record is silent, which is correct.
const SCRATCH_COAST_CHUNKS: f64 = 20.0;

/// Hard cap on how far a coast may carry the cursor past the last real target, in PCM frames
/// (~50ms of content at 48kHz).
///
/// Coasting is dead reckoning, so it necessarily overshoots when the hand slows — the next
/// absolute target corrects it, and the correction is what the cap bounds. It also makes the
/// mechanism self-limiting exactly where it is not needed: a fast hand fills the cap in a
/// couple of chunks, and a fast hand was never the problem (`arrived 0%` above 0.96x).
const SCRATCH_COAST_MAX_FRAMES: f64 = 2400.0;

/// Smoothing on the hand-speed estimate, applied **per observed target change** rather than
/// per chunk (a per-chunk EMA would decay toward zero through the very gaps it has to
/// extrapolate across, biasing the estimate low precisely when it is used).
const SCRATCH_SPEED_EMA_ALPHA: f64 = 0.35;

/// Tracks how fast the caller's target is moving, so the servo can keep the cursor walking
/// through a gap in target updates instead of converging and falling silent.
///
/// ⚠️ **This estimates a velocity from an inter-event interval, which the rest of this design
/// deliberately refuses to do** (`docs/design/waveform-scrub.md`, "Why velocity was the wrong
/// control variable"). The distinction that makes it safe here: velocity is not the control
/// variable. Position still is — every real target re-anchors the cursor absolutely, so an
/// error in this estimate cannot accumulate across a gesture, and its only effect is a
/// bounded extrapolation (`SCRATCH_COAST_CHUNKS`, `SCRATCH_COAST_MAX_FRAMES`) that the next
/// target corrects. The old velocity path had neither bound nor correction.
#[derive(Debug, Clone, Copy)]
struct HandTracker {
    last_target: f64,
    /// Buffer frames per output frame — same units as `ServoStep::rate`, signed.
    speed: f64,
    /// Chunks since the target last changed.
    idle_chunks: f64,
    /// How far the coast has carried the aim point past `last_target`.
    coast_offset: f64,
}

impl HandTracker {
    fn new(target: f64) -> Self {
        Self { last_target: target, speed: 0.0, idle_chunks: 0.0, coast_offset: 0.0 }
    }

    /// Forget the gesture's history — after a snap, where any speed estimate is stale by
    /// construction (the user jumped rather than dragged).
    fn reset(&mut self, target: f64) {
        *self = Self::new(target);
    }

    /// Observe this chunk's target and return the point the servo should aim at: the target
    /// itself while updates are arriving, or a tapering extrapolation of it while they are
    /// not.
    fn step(&mut self, target: f64, chunk_frames: f64) -> f64 {
        let delta = target - self.last_target;
        if delta != 0.0 {
            // Divided by the elapsed chunks, not by 1: at a 200ms update cadence the target
            // jumps once every ~13 chunks, and dividing a 13-chunk displacement by one chunk
            // would read as 13x the real hand speed.
            let observed = delta / (chunk_frames * self.idle_chunks.max(1.0));
            self.speed += SCRATCH_SPEED_EMA_ALPHA * (observed - self.speed);
            self.last_target = target;
            self.idle_chunks = 0.0;
            // The hand's own position is authoritative again, so the extrapolation must go —
            // but it is *absorbed* against the motion the hand actually delivered, never
            // dropped outright.
            //
            // ⚠️ This was `self.coast_offset = 0.0` until 2026-08-09, and that is a
            // **backward jump of the aim point** whenever the coast ran further than the hand
            // did: the aim goes from `last_target + coast_offset` to `target`, which is behind
            // it. The servo chases backwards, `commanded_rate` goes negative, and the sign flip
            // in the feeder loop zeroes `fade_pos` — a 5ms gain ramp, then another when motion
            // resumes. Measured live on a strictly one-direction jog (`values=[1]`, net 247 of
            // 247 ticks): **2–8 ramps per second**, rising with `coast%` and vanishing above
            // ~0.4x where the coast barely engages (`ramps=0` at 0.44x–1.87x, 5 at 0.29x).
            // That fade chain is the "audio tapers out during a slow jog" report, and it is
            // the residue of the coasting fix that closed the *silence* half on 2026-08-08.
            //
            // Absorbing keeps the aim point monotonic in the direction of travel: if the hand
            // out-ran the coast the offset is fully consumed and the aim advances to `target`;
            // if it did not, the remainder is carried and the aim *holds still* rather than
            // reversing. Either way the offset only ever shrinks on a real target, so absolute
            // position stays authoritative and a bad speed estimate still cannot accumulate.
            self.coast_offset = if delta > 0.0 {
                (self.coast_offset - delta).max(0.0)
            } else {
                (self.coast_offset - delta).min(0.0)
            };
            return target + self.coast_offset;
        }

        self.idle_chunks += 1.0;
        if self.idle_chunks <= SCRATCH_COAST_CHUNKS {
            let taper = 1.0 - self.idle_chunks / SCRATCH_COAST_CHUNKS;
            self.coast_offset += self.speed * chunk_frames * taper;
            let cap = SCRATCH_COAST_MAX_FRAMES;
            self.coast_offset = self.coast_offset.clamp(-cap, cap);
        }
        // Past the window the offset is held, not unwound: unwinding would walk the cursor
        // backwards to the last real target, which is audible motion in the wrong direction
        // at exactly the moment the deck should be coming to rest. The residual is bounded by
        // the cap and superseded by the next target, or by the gesture's final one.
        target + self.coast_offset
    }

    /// True while the aim point is ahead of the last real target — i.e. this chunk is sounding
    /// only because of the coast. Reported as `coast%` in `[scratch-tel]`.
    fn coasting(&self) -> bool {
        self.coast_offset != 0.0
    }
}

/// What the position-mode servo decided for one chunk. Split out of the feeder loop so it
/// can be unit-tested without GStreamer: the properties that matter here are *statistical
/// over a whole gesture* (what fraction of chunks are silent, what mean speed the cursor
/// ends up walking at), which is exactly what a live listening test reports as "no audio"
/// and exactly what a single-step assertion cannot see.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ServoStep {
    /// Buffer frames to advance per output frame this chunk.
    rate: f64,
    /// Nothing left to cover — the feeder fades to silence (see `SCRATCH_TARGET_EPSILON_FRAMES`).
    arrived: bool,
    /// Target was too far to sweep: `cursor` was moved to it outright and the gain
    /// re-ramped, rather than racing through the intervening content.
    snapped: bool,
}

/// One chunk of the position-mode servo: given where the cursor is and where the caller
/// wants it, decide this chunk's rate. See `SCRATCH_SERVO_LAG_CHUNKS` for why the error is
/// spread over several chunks rather than closed inside one.
fn servo_step(target: f64, cursor: f64, chunk_frames: f64, snap_frames: f64) -> ServoStep {
    let err = target - cursor;
    if err.abs() > snap_frames {
        return ServoStep { rate: 0.0, arrived: true, snapped: true };
    }
    if err.abs() < SCRATCH_TARGET_EPSILON_FRAMES {
        return ServoStep { rate: 0.0, arrived: true, snapped: false };
    }
    let rate = (err / (chunk_frames * SCRATCH_SERVO_LAG_CHUNKS))
        .clamp(-SCRATCH_TARGET_MAX_RATE, SCRATCH_TARGET_MAX_RATE);
    ServoStep { rate, arrived: false, snapped: false }
}

/// Starts the feeder thread for one scratch gesture: walks `pcm` forward or backward
/// from `start_frame` at the (live-updatable) rate in `rate_bits`, linearly
/// interpolating between adjacent buffer samples for sub-sample step sizes, and pushes
/// each chunk into `appsrc`. Runs until `stop_requested` is set, at which point it
/// pushes one final buffer faded to silence and exits.
///
/// `hold_ms`: if no `scratch()` call refreshes `last_update` within this many
/// milliseconds, the feeder decays (over `SCRATCH_FADE_FRAMES`) to silence and freezes
/// the cursor, rather than continuing to free-run at the last rate. A large value
/// (shuttle mode) means this effectively never triggers within a real gesture,
/// preserving the original free-running-between-ticks behavior; a small value (vinyl
/// mode, tens of ms) makes the feeder stop almost as soon as ticks stop arriving,
/// approximating direct 1:1 position control — a stationary hand on real vinyl
/// produces silence, not continued motion.
fn spawn_scratch_feeder(
    deck_id: String,
    appsrc: AppSrc,
    pcm: Arc<PcmBuffer>,
    start_frame: f64,
    initial_rate: f64,
    initial_target: f64,
    hold_ms: u64,
    delivery: DeliveryProbes,
) -> ScratchFeeder {
    let rate_bits = Arc::new(AtomicU64::new(initial_rate.to_bits()));
    let target_frames_bits = Arc::new(AtomicU64::new(initial_target.to_bits()));
    let stop_requested = Arc::new(AtomicBool::new(false));
    let cursor_frames_bits = Arc::new(AtomicU64::new(start_frame.to_bits()));
    let last_update = Arc::new(Mutex::new(Instant::now()));
    let target_gaps = Arc::new(Mutex::new(TargetGapStats::default()));

    let rate_bits_t = rate_bits.clone();
    let target_t = target_frames_bits.clone();
    let stop_t = stop_requested.clone();
    let cursor_t = cursor_frames_bits.clone();
    let last_update_t = last_update.clone();
    let target_gaps_t = target_gaps.clone();

    let handle = std::thread::spawn(move || {
        let chunk_frames = ((pcm.rate as u64 * SCRATCH_CHUNK_MS) / 1000).max(1) as usize;
        let max_frame = pcm.frames().saturating_sub(1) as f64;
        let mut cursor = start_frame.clamp(0.0, max_frame);
        // 0.0 means "no direction established yet", so the first chunk that commands real
        // motion sets it and takes the fade-in exactly once, whichever way it goes.
        // Reading initial_rate here is only right in velocity mode: scratch_to() passes
        // rate 0.0, and Rust's `0.0_f64.signum()` is *1.0*, not 0.0 — so every reverse
        // gesture used to open by "reversing" from a forward direction it never had.
        let mut last_sign = if initial_target.is_nan() { initial_rate.signum() } else { 0.0 };
        // Position mode only; in velocity mode the target is NaN and this is never stepped.
        let mut hand = HandTracker::new(initial_target);
        let mut fade_pos: usize = 0; // frames into an in-progress fade-in/reversal ramp
        let mut hold_gain: f32 = 1.0; // ramps toward 0 while idle beyond hold_ms, else toward 1
        let mut next_wake = Instant::now();
        let snap_frames = SCRATCH_TARGET_SNAP_SECS * pcm.rate as f64;

        log::info!(
            "[scratch/{deck_id}] feeder start frame={start_frame:.0} rate={initial_rate:.3} \
             mode={} hold_ms={hold_ms}",
            if initial_target.is_nan() { "velocity" } else { "position" }
        );

        // Per-second feeder telemetry. Added 2026-08-08 after a live report of "a few
        // scratchy pops and then nothing" that no existing signal could adjudicate: the
        // feeder logs only start/stop, `push_buffer` warns only above 50ms, and the
        // `output_queue underrun` counter fires once per chunk by construction here (a
        // just-in-time feeder empties the queue every buffer — 66.8/s measured against a
        // 66.7/s chunk rate, so it is structurally uninformative during a scratch).
        //
        // `rms` is the field that settles it, and it is why this exists: it is measured on
        // the bytes actually handed to appsrc, after every gain stage. Audible RMS with
        // nothing coming out of the speakers puts the fault downstream in GStreamer;
        // collapsing RMS puts it in the servo or the gain logic. Everything else here is
        // context for whichever way that reads — `arrived%` and `snaps` say whether the
        // servo thinks it has nothing to do, `ramps` counts fade restarts (the pop
        // suspect), and `late%` says whether the thread is failing to hold its 15ms cadence.
        let mut tel_chunks: u64 = 0;
        let mut tel_arrived: u64 = 0;
        // Chunks that sounded only because of the coast. The direct readout for the fix: as
        // `coast%` picks up, `arrived%` should collapse on gentle gestures.
        let mut tel_coast: u64 = 0;
        let mut tel_snaps: u64 = 0;
        let mut tel_ramps: u64 = 0;
        let mut tel_late: u64 = 0;
        let mut tel_sumsq: f64 = 0.0;
        let mut tel_samples: u64 = 0;
        let mut tel_rate_sum: f64 = 0.0;
        let mut tel_rate_max: f64 = 0.0;
        let mut tel_cursor_start = cursor;
        let mut tel_since = Instant::now();
        // Baseline for the delivery counters, which are cumulative for the life of the
        // pipeline — only the per-second delta is meaningful, and the gesture starts
        // partway into whatever the file branch already delivered.
        let mut tel_delivery_last: Vec<u64> =
            delivery.iter().map(|p| p.count.load(Ordering::Relaxed)).collect();

        loop {
            let stopping = stop_t.load(Ordering::Relaxed);
            let rate = f64::from_bits(rate_bits_t.load(Ordering::Relaxed));
            let target = f64::from_bits(target_t.load(Ordering::Relaxed));

            // Position mode (NaN target = velocity mode, the original behaviour): derive
            // this chunk's rate from the distance still to cover, spread over
            // SCRATCH_SERVO_LAG_CHUNKS so the cursor keeps moving between updates instead
            // of lurching once and going quiet. Pitch bend comes out of this for free —
            // it is still just how fast the cursor walks the buffer, exactly as in
            // velocity mode. `arrived` means there is nothing left to cover, which is the
            // position-mode equivalent of velocity mode's hold_ms idle.
            let mut arrived = false;
            let mut coasting = false;
            let commanded_rate = if target.is_nan() {
                rate
            } else {
                // Aim at the hand, or — while no update has arrived — at where the hand would
                // be if it kept going, tapering to a standstill. See SCRATCH_COAST_CHUNKS:
                // a slow hand delivers 5-12 events/s, and without this the servo converges
                // between them and mutes for a third to a half of a gentle gesture.
                let aim = hand
                    .step(target.clamp(0.0, max_frame), chunk_frames as f64)
                    .clamp(0.0, max_frame);
                coasting = hand.coasting();
                let step = servo_step(aim, cursor, chunk_frames as f64, snap_frames);
                if step.snapped {
                    // Too far to sweep — jump, and re-ramp so the splice doesn't click.
                    cursor = target.clamp(0.0, max_frame);
                    fade_pos = 0;
                    tel_snaps += 1;
                    // A jump says nothing about hand speed, and coasting on a stale estimate
                    // after one would walk the cursor away from where the user just landed.
                    hand.reset(cursor);
                    coasting = false;
                }
                arrived = step.arrived;
                step.rate
            };
            if coasting && !arrived { tel_coast += 1; }
            tel_chunks += 1;
            if arrived { tel_arrived += 1; }
            tel_rate_sum += commanded_rate.abs();
            tel_rate_max = tel_rate_max.max(commanded_rate.abs());
            let fade_pos_before = fade_pos;

            if !stopping {
                // NOT `commanded_rate.signum()`: Rust returns *1.0* for `0.0_f64`, so a
                // stationary chunk read as "moving forward" and every stationary chunk
                // during a reverse gesture flipped last_sign, zeroed fade_pos, and forced
                // a 5ms gain ramp — then another one when motion resumed. Two spurious
                // ramps per pause, i.e. an audible click each time the hand hesitated or
                // crossed zero. This is the "scratchy pops" half of the 2026-08-08 live
                // report; the silence half was the servo (SCRATCH_SERVO_LAG_CHUNKS).
                let sign = if commanded_rate > 0.0 {
                    1.0
                } else if commanded_rate < 0.0 {
                    -1.0
                } else {
                    0.0
                };
                if sign != 0.0 && sign != last_sign {
                    fade_pos = 0;
                    last_sign = sign;
                }
            }
            if fade_pos == 0 && fade_pos_before != 0 { tel_ramps += 1; }

            // Checked once per chunk (15ms granularity is plenty for a hold decision).
            // Velocity mode: idle means no scratch() call refreshed last_update within
            // hold_ms. Position mode: idle means the cursor reached the target — a
            // stationary finger or hand should sound like a stationary hand on a record,
            // i.e. silence, not a stalled cursor buzzing on one sample. hold_ms still
            // applies as a backstop for a caller that stops updating without ever
            // calling stop_scratch().
            let idle = !stopping
                && (arrived
                    || last_update_t.lock().unwrap().elapsed().as_millis() as u64 > hold_ms);
            let effective_rate = if idle { 0.0 } else { commanded_rate };
            let target_hold_gain: f32 = if idle { 0.0 } else { 1.0 };
            let hold_step = 1.0 / SCRATCH_FADE_FRAMES as f32;

            let mut out = vec![0f32; chunk_frames * 2];
            for i in 0..chunk_frames {
                let idx = (cursor.floor() as usize).min(pcm.frames().saturating_sub(1));
                let idx2 = (idx + 1).min(pcm.frames().saturating_sub(1));
                let frac = (cursor - idx as f64) as f32;
                let l = pcm.samples[idx * 2] + (pcm.samples[idx2 * 2] - pcm.samples[idx * 2]) * frac;
                let r = pcm.samples[idx * 2 + 1] + (pcm.samples[idx2 * 2 + 1] - pcm.samples[idx * 2 + 1]) * frac;

                let base_gain = if stopping {
                    1.0 - (i as f32 / chunk_frames as f32) // fade to silence across the final chunk
                } else if fade_pos < SCRATCH_FADE_FRAMES {
                    fade_pos += 1;
                    fade_pos as f32 / SCRATCH_FADE_FRAMES as f32
                } else {
                    1.0
                };
                if hold_gain < target_hold_gain {
                    hold_gain = (hold_gain + hold_step).min(target_hold_gain);
                } else if hold_gain > target_hold_gain {
                    hold_gain = (hold_gain - hold_step).max(target_hold_gain);
                }
                let gain = base_gain * hold_gain;

                out[i * 2] = l * gain;
                out[i * 2 + 1] = r * gain;
                tel_sumsq += (l * gain) as f64 * (l * gain) as f64;

                if !stopping {
                    cursor = (cursor + effective_rate).clamp(0.0, max_frame);
                }
            }
            tel_samples += chunk_frames as u64;

            cursor_t.store(cursor.to_bits(), Ordering::Relaxed);

            let mut bytes = Vec::with_capacity(out.len() * 4);
            for s in &out {
                bytes.extend_from_slice(&s.to_le_bytes());
            }
            let t_push = Instant::now();
            let push_result = appsrc.push_buffer(gst::Buffer::from_slice(bytes));
            let push_ms = t_push.elapsed().as_secs_f64() * 1000.0;
            // push_buffer() can legitimately block on downstream backpressure/preroll —
            // a chunk should take low single-digit ms; anything far past the 15ms chunk
            // period means this call, not the feeder's own pacing, is what's actually
            // stalling audio delivery. See "Fifth mechanism" / reverse-scratch-silence
            // investigation in docs/design/pcm-buffer-playback.md.
            if push_ms > 50.0 {
                log::warn!(
                    "[scratch/{deck_id}] appsrc push_buffer took {push_ms:.1}ms (expected <15ms) — \
                     downstream stalled, not just slow"
                );
            }
            if push_result.is_err() {
                log::warn!("[scratch/{deck_id}] appsrc push_buffer failed, stopping feeder");
                break;
            }

            if stopping {
                log::info!("[scratch/{deck_id}] feeder stop frame={cursor:.0}");
                break;
            }

            next_wake += Duration::from_millis(SCRATCH_CHUNK_MS);
            let now = Instant::now();
            if next_wake > now {
                std::thread::sleep(next_wake - now);
            } else {
                // Missed the cadence — the chunk took longer than SCRATCH_CHUNK_MS to
                // build and push, so this feeder is producing slower than real time and
                // the sink will run dry no matter how healthy the samples are.
                next_wake = now;
                tel_late += 1;
            }

            let elapsed = tel_since.elapsed();
            if elapsed >= Duration::from_secs(1) {
                let secs = elapsed.as_secs_f64();
                let rms = if tel_samples > 0 {
                    (tel_sumsq / tel_samples as f64).sqrt()
                } else {
                    0.0
                };
                let dbfs = if rms > 0.0 { 20.0 * rms.log10() } else { -f64::INFINITY };
                // `<label>=<buffers/s>(<margin>)` per probed pad. Silence with these still
                // ticking means the buffers arrive and are not rendered; silence with them
                // at 0/s means the stall is upstream of that pad. See `DeliveryProbe`.
                let delivery_report = delivery
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        let now = p.count.load(Ordering::Relaxed);
                        let delta = now.saturating_sub(tel_delivery_last[i]);
                        tel_delivery_last[i] = now;
                        let margin = p.margin_us.load(Ordering::Relaxed);
                        let margin_str = if margin == i64::MIN {
                            "no ts".to_string()
                        } else {
                            format!("{:+.0}ms", margin as f64 / 1000.0)
                        };
                        format!("{}={:.0}/s({})", p.label, delta as f64 / secs, margin_str)
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                // Target-update cadence: the number SCRATCH_SERVO_LAG_CHUNKS is tuned
                // against, measured rather than assumed. p90/max are the fields that
                // matter — a long tail is what lets the cursor catch up and park.
                let (tgt_n, tgt_p50, tgt_p90, tgt_max, tgt_dropped) =
                    target_gaps_t.lock().unwrap().drain();
                let targets_report = if tgt_n == 0 {
                    "targets none".to_string()
                } else {
                    format!(
                        "targets {:.0}/s gap p50={tgt_p50} p90={tgt_p90} max={tgt_max}ms{}",
                        tgt_n as f64 / secs,
                        if tgt_dropped > 0 {
                            format!(" (+{tgt_dropped} over cap)")
                        } else {
                            String::new()
                        }
                    )
                };
                log::info!(
                    "[scratch-tel/{deck_id}] chunks={tel_chunks} ({:.0}/s, late {:.0}%) | \
                     rms={rms:.5} ({dbfs:.1} dBFS) | arrived {:.0}% coast {:.0}% \
                     snaps={tel_snaps} ramps={tel_ramps} | rate mean={:.3} max={:.3} | \
                     {targets_report} | \
                     cursor {:.3}s -> {:.3}s \
                     ({:+.3}s in {secs:.2}s = {:.2}x) | delivery {delivery_report}",
                    tel_chunks as f64 / secs,
                    100.0 * tel_late as f64 / tel_chunks.max(1) as f64,
                    100.0 * tel_arrived as f64 / tel_chunks.max(1) as f64,
                    100.0 * tel_coast as f64 / tel_chunks.max(1) as f64,
                    tel_rate_sum / tel_chunks.max(1) as f64,
                    tel_rate_max,
                    tel_cursor_start / pcm.rate as f64,
                    cursor / pcm.rate as f64,
                    (cursor - tel_cursor_start) / pcm.rate as f64,
                    (cursor - tel_cursor_start) / pcm.rate as f64 / secs,
                );
                tel_chunks = 0;
                tel_arrived = 0;
                tel_coast = 0;
                tel_snaps = 0;
                tel_ramps = 0;
                tel_late = 0;
                tel_sumsq = 0.0;
                tel_samples = 0;
                tel_rate_sum = 0.0;
                tel_rate_max = 0.0;
                tel_cursor_start = cursor;
                tel_since = Instant::now();
            }
        }
    });

    ScratchFeeder {
        rate_bits,
        target_frames_bits,
        stop_requested,
        cursor_frames_bits,
        last_update,
        target_gaps_ms: target_gaps,
        handle: Some(handle),
    }
}

/// Position-mode servo, tested as arithmetic rather than as audio. These run in a plain
/// `cargo test` — no GStreamer, no PCM file, no hardware — because the thing that was
/// broken live is a *statistical* property of the servo over a whole gesture (how much of
/// the time it is producing sound, and at what speed), which the existing `scratch_to`
/// smoke test cannot see: that test asserts the cursor arrives, and it did arrive. It
/// arrived in one chunk and then sat silent, which is precisely the bug.
#[cfg(test)]
mod servo_test {
    use super::*;

    const RATE: f64 = 48_000.0;
    /// 15ms at 48kHz — one feeder chunk.
    const CHUNK: f64 = 720.0;
    const SNAP: f64 = SCRATCH_TARGET_SNAP_SECS * RATE;

    /// Replays a gesture the way the feeder does, coast included: the hand moves
    /// *continuously* at `hand_speed`, the caller samples its position into the target only at
    /// the listed times, and the servo runs every `SCRATCH_CHUNK_MS`. Returns the fraction of
    /// chunks that produced no sound and the mean speed the cursor actually walked at.
    ///
    /// Sampling a continuously-moving hand is the measured reality rather than a convenience:
    /// a slow drag delivers 5–12 events/s at ~2.3px each with gaps to 1180ms, and the target
    /// only exists at those instants.
    fn replay_sampled(hand_speed: f64, updates_ms: &[f64], secs: f64) -> (f64, f64) {
        let mut cursor = 0.0f64;
        let mut target = 0.0f64;
        let mut hand = HandTracker::new(0.0);
        let chunks = (secs * 1000.0 / SCRATCH_CHUNK_MS as f64) as usize;
        let mut silent = 0usize;
        let mut counted = 0usize;
        let mut moving = false;
        let mut next = 0usize;
        for c in 0..chunks {
            let now_ms = c as f64 * SCRATCH_CHUNK_MS as f64;
            while next < updates_ms.len() && updates_ms[next] <= now_ms {
                let sampled = hand_speed * RATE * (updates_ms[next] / 1000.0);
                if sampled != target {
                    moving = true;
                }
                target = sampled;
                next += 1;
            }
            let step = servo_step(hand.step(target, CHUNK), cursor, CHUNK, SNAP);
            // Counted only once the target has actually moved. Before that the cursor sits on
            // it with zero error and reports `arrived` — correctly, there is nothing to play
            // yet — and counting those chunks made a uniform 300ms schedule read as "7.5%
            // silent" no matter what the servo did. That number was the harness measuring its
            // own first update period, and it moved not at all across a coast on/off A/B,
            // which is what exposed it.
            if moving {
                counted += 1;
                if step.arrived {
                    silent += 1;
                }
            }
            if !step.arrived {
                cursor += step.rate * CHUNK;
            }
        }
        (silent as f64 / counted.max(1) as f64, cursor / (secs * RATE))
    }

    /// Uniform update cadence — the original harness, now expressed as a schedule.
    fn replay(hand_speed: f64, update_every_ms: f64, secs: f64) -> (f64, f64) {
        let updates: Vec<f64> = (0..)
            .map(|i| i as f64 * update_every_ms)
            .take_while(|t| *t <= secs * 1000.0)
            .collect();
        replay_sampled(hand_speed, &updates, secs)
    }

    /// Bursts of `burst` updates `tight_ms` apart, one burst every `period_ms` — the measured
    /// shape of slow pointer delivery, and the shape that mutes the servo: a burst ends with a
    /// small jump, which the servo closes quickly, and then nothing arrives for the rest of
    /// the period.
    fn bursty(period_ms: f64, burst: usize, tight_ms: f64, secs: f64) -> Vec<f64> {
        let mut v = Vec::new();
        let mut t = 0.0;
        while t < secs * 1000.0 {
            for k in 0..burst {
                v.push(t + k as f64 * tight_ms);
            }
            t += period_ms;
        }
        v
    }

    /// The live failure, as a number. A hand moving at 0.2x — the speed measured from the
    /// 2026-08-08 log's jog gesture (1.31s of content in 6.6s) — must produce essentially
    /// continuous audio, not a train of blips.
    #[test]
    fn slow_scrub_is_not_mostly_silent() {
        let (silent_fraction, _) = replay(0.2, 30.0, 3.0);
        assert!(
            silent_fraction < 0.05,
            "servo went silent for {:.0}% of a steady 0.2x scrub — this is the \
             'scrubbing plays no audio' bug (rate = err/chunk_frames closed the whole \
             error inside one chunk and then reported arrived)",
            silent_fraction * 100.0
        );
    }

    /// A first-order lag tracks a ramp at the *input's* slope. That is what makes the
    /// scrub pitch-correct: the cursor walks the buffer at the hand's speed, not at some
    /// speed manufactured by the update cadence.
    #[test]
    fn cursor_speed_matches_hand_speed() {
        for &hand in &[0.05, 0.2, 1.0, 2.0] {
            for &update_ms in &[16.0, 30.0, 45.0] {
                let (_, measured) = replay(hand, update_ms, 4.0);
                let err = (measured - hand).abs() / hand;
                assert!(
                    err < 0.05,
                    "hand {hand}x with updates every {update_ms}ms produced cursor speed \
                     {measured:.4}x ({:.1}% off)",
                    err * 100.0
                );
            }
        }
    }

    /// Reverse is not a special case anywhere in the servo, and this pins that down —
    /// the live report singled reverse out, so a regression that quietly made one
    /// direction silent must fail here rather than wait for another listening session.
    #[test]
    fn reverse_behaves_identically_to_forward() {
        let (fwd_silent, fwd_speed) = replay(0.2, 30.0, 3.0);
        let (rev_silent, rev_speed) = replay(-0.2, 30.0, 3.0);
        assert_eq!(fwd_silent, rev_silent, "silent-chunk fraction differs by direction");
        assert!(
            (fwd_speed + rev_speed).abs() < 1e-9,
            "reverse speed {rev_speed:.4} is not the mirror of forward {fwd_speed:.4}"
        );
    }

    /// A stopped hand still has to reach silence promptly — the lag makes the approach
    /// asymptotic, so `SCRATCH_TARGET_EPSILON_FRAMES` is what ends it. Under a
    /// half-frame epsilon this tail ran on for the better part of a second.
    #[test]
    fn stopped_hand_reaches_silence() {
        // Steady-state lag from a 1.0x hand, the worst realistic case to decay from.
        let mut cursor = 0.0f64;
        let target = 1.0 * RATE * (SCRATCH_SERVO_LAG_CHUNKS * SCRATCH_CHUNK_MS as f64 / 1000.0);
        let mut chunks_to_silence = None;
        for c in 0..200 {
            let step = servo_step(target, cursor, CHUNK, SNAP);
            if step.arrived {
                chunks_to_silence = Some(c);
                break;
            }
            cursor += step.rate * CHUNK;
        }
        let chunks = chunks_to_silence.expect("servo never reached silence after the hand stopped");
        let ms = chunks as f64 * SCRATCH_CHUNK_MS as f64;
        assert!(ms < 400.0, "took {ms}ms to fall silent after the hand stopped");
    }

    /// The live failure of 2026-08-08 night 2, as a number: a gentle drag delivers its
    /// updates in bursts with a few hundred ms of nothing between them **while the hand keeps
    /// moving**, and the servo used to converge in those holes and mute. Measured live at
    /// 15–45% of chunks muted below 0.35x; the user heard it as "the gentle one dropped out
    /// frequently".
    ///
    /// **Measured, not assumed: 19.7% muted without `HandTracker`, 0.0% with it.** The A/B was
    /// run by setting `SCRATCH_COAST_CHUNKS` to 0 — worth repeating if this ever needs
    /// re-tuning, because the first schedule tried here (a 300ms period) came out at 1.5% and
    /// would have passed on the broken code, exactly as `scratch_to_smoke` did for Fault 1.
    ///
    /// What the A/B also showed, which is the real mechanism: **burstiness mutes the servo, not
    /// sparseness.** A uniform 300ms cadence never converges (each jump is large, and closing
    /// it takes about as long as the period) and measures 0% silent either way. A burst ends
    /// with a *small* jump the servo closes in ~150ms, and then nothing arrives for the rest of
    /// the period — which is precisely the shape the live log shows: `gap p50=18ms` with
    /// `gapMax` of 376–1180ms.
    #[test]
    fn sparse_slow_hand_stays_audible() {
        // 3 updates 17ms apart every 400ms: a 366ms hole after each burst, and the live
        // gentle gesture recorded a 376ms gap in the second that measured 40% muted.
        let updates = bursty(400.0, 3, 17.0, 4.0);
        let (silent_fraction, _) = replay_sampled(0.28, &updates, 4.0);
        assert!(
            silent_fraction < 0.05,
            "servo muted {:.0}% of a 0.28x drag delivering 10 updates/s in bursts — this is \
             the 'gentle drag drops out' bug (the servo converges inside the gaps and fades)",
            silent_fraction * 100.0
        );
    }

    /// The aim point must never move **backwards** while the input only moves forwards.
    ///
    /// This is the 2026-08-09 live failure, and it is a correctness property rather than a
    /// tuning one, which is why it is asserted here rather than left to a live listen. Zeroing
    /// `coast_offset` on each real target dropped the aim from `last_target + coast_offset` back
    /// to `target`; whenever the coast had out-run the hand that is a reversal, the feeder's
    /// sign check zeroes `fade_pos`, and the gesture picks up a 5ms gain ramp — twice per
    /// occurrence, since motion then resumes forward. The live jog measured **2–8 `ramps` per
    /// second** on a strictly one-direction wheel (`values=[1]`), scaling with `coast%` and
    /// disappearing above ~0.4x. The user heard it as the audio tapering out mid-gesture.
    ///
    /// The hand must **decelerate** for this to bite, which is the whole point: coasting is
    /// dead reckoning, so it overshoots exactly when the hand slows, and it is the overshoot
    /// that the next target used to correct by jumping the aim backwards. A constant-speed
    /// hand does not reproduce it at all — and neither does a wide burst gap, where each
    /// target advances far more than the 50ms cap and the aim only ever leaps forward. Both
    /// of those pass on the broken code; this schedule fails on it by 1000+ frames.
    ///
    /// A real jog is decelerating somewhere in almost every second — the live gestures ran
    /// `rate mean=0.18` against `max=0.37` within a single reporting window.
    #[test]
    fn forward_gesture_never_reverses_the_aim_point() {
        // Hand coasting to a stop: 0.40x decaying to ~0.04x over 3s, sampled every ~45ms
        // (the live jog delivered targets at 8-34/s).
        for &(fast, slow) in &[(0.40, 0.04), (0.28, 0.10), (0.60, 0.20)] {
            let mut tracker = HandTracker::new(0.0);
            let mut target = 0.0f64;
            let mut prev_aim = 0.0f64;
            let mut hand_pos = 0.0f64;
            let mut next_update_ms = 0.0f64;
            let mut worst = 0.0f64;
            for chunk in 0..200 {
                let t_ms = chunk as f64 * SCRATCH_CHUNK_MS as f64;
                let frac = t_ms / 3000.0;
                let speed = fast + (slow - fast) * frac.min(1.0); // decelerating
                hand_pos += speed * CHUNK;
                if t_ms >= next_update_ms {
                    target = hand_pos;
                    next_update_ms = t_ms + 45.0;
                }
                let aim = tracker.step(target, CHUNK);
                worst = worst.min(aim - prev_aim);
                prev_aim = aim;
            }
            assert!(
                worst >= -1e-6,
                "aim point went backwards by {:.0} frames on a forward-only gesture \
                 decelerating {fast}x -> {slow}x. That is a direction reversal, and the feeder \
                 answers every one of them with a 5ms fade — 2-8 per second, live.",
                -worst,
            );
        }
    }

    /// The coast must not become a flywheel. A hand that stops for over a second has really
    /// stopped — a held record is silent — so the deck has to come to rest, and promptly.
    /// Paired with the test above deliberately: one asserts sound where there should be sound,
    /// the other silence where there should be silence, and a wrong window fails one of them.
    #[test]
    fn long_input_gap_still_comes_to_rest() {
        let hand = 0.28;
        // Dense updates for 1s, then the hand stops feeding targets for 1.5s.
        let updates: Vec<f64> = (0..59).map(|i| i as f64 * 17.0).collect();
        let last_update_ms = *updates.last().unwrap();
        let mut cursor = 0.0f64;
        let mut target = 0.0f64;
        let mut tracker = HandTracker::new(0.0);
        let mut next = 0usize;
        let mut silence_at_ms = None;
        for c in 0..(2500 / SCRATCH_CHUNK_MS as usize) {
            let now_ms = c as f64 * SCRATCH_CHUNK_MS as f64;
            while next < updates.len() && updates[next] <= now_ms {
                target = hand * RATE * (updates[next] / 1000.0);
                next += 1;
            }
            let step = servo_step(tracker.step(target, CHUNK), cursor, CHUNK, SNAP);
            if step.arrived {
                if now_ms > last_update_ms && silence_at_ms.is_none() {
                    silence_at_ms = Some(now_ms - last_update_ms);
                }
            } else {
                cursor += step.rate * CHUNK;
            }
        }
        let ms = silence_at_ms.expect("never fell silent — the coast has become a flywheel");
        assert!(
            (250.0..800.0).contains(&ms),
            "fell silent {ms}ms after the hand stopped; wanted 250-800ms (under 250 means the \
             coast is not bridging real gaps, over 800 means it keeps playing content the hand \
             never asked for)"
        );
    }

    /// Dead reckoning must not systematically run ahead of the hand. If it did, a long gesture
    /// would end somewhere the user never dragged to — and pitch would read high throughout.
    #[test]
    fn coast_does_not_outrun_the_hand() {
        for &hand in &[0.1, 0.28, 0.6] {
            let updates = bursty(400.0, 3, 17.0, 4.0);
            let (_, measured) = replay_sampled(hand, &updates, 4.0);
            let err = (measured - hand).abs() / hand;
            assert!(
                err < 0.15,
                "hand {hand}x with bursty delivery produced cursor speed {measured:.4}x \
                 ({:.1}% off)",
                err * 100.0
            );
        }
    }

    /// The distance cap is the bound that makes coasting safe to do at all — it is what keeps
    /// a wrong speed estimate from walking the cursor away from the user's finger. A fast hand
    /// fills it in a couple of chunks, which is also why the mechanism is self-limiting at the
    /// speeds that never needed it.
    #[test]
    fn coast_is_bounded_by_the_distance_cap() {
        let mut tracker = HandTracker::new(0.0);
        // Two updates establish a 4x speed estimate, then updates stop for a long time.
        tracker.step(0.0, CHUNK);
        tracker.step(4.0 * CHUNK, CHUNK);
        let target = 4.0 * CHUNK;
        for _ in 0..200 {
            let aim = tracker.step(target, CHUNK);
            assert!(
                (aim - target).abs() <= SCRATCH_COAST_MAX_FRAMES + 1e-6,
                "coast carried the aim {:.0} frames past the target, cap is \
                 {SCRATCH_COAST_MAX_FRAMES}",
                aim - target
            );
        }
    }

    /// A snap means the user jumped rather than dragged, so any speed estimate is stale by
    /// construction — coasting on it would walk the cursor away from where they just landed.
    #[test]
    fn snap_clears_the_coast() {
        let mut tracker = HandTracker::new(0.0);
        tracker.step(0.0, CHUNK);
        tracker.step(1.0 * CHUNK, CHUNK);
        tracker.step(1.0 * CHUNK, CHUNK); // one idle chunk: coast engages
        assert!(tracker.coasting(), "coast never engaged, so this test proves nothing");
        tracker.reset(90.0 * RATE);
        assert!(!tracker.coasting());
        assert_eq!(tracker.step(90.0 * RATE, CHUNK), 90.0 * RATE);
    }


    /// A coarse overview drag must not race audibly through the content it skipped.
    #[test]
    fn far_target_snaps_silently() {
        let step = servo_step(60.0 * RATE, 0.0, CHUNK, SNAP);
        assert!(step.snapped && step.arrived && step.rate == 0.0, "{step:?}");
    }

    /// The gap instrument is about to decide between two different fixes, so it has to be
    /// right about the tail specifically — a p90 that silently reported the median would
    /// make a bursty cadence look uniform and point at the wrong one.
    #[test]
    fn target_gap_stats_report_the_tail() {
        let mut s = TargetGapStats::default();
        // Nine tight updates and one long stall. Nearest-rank p90 of ten samples is the
        // 9th smallest, so a lone 10% outlier belongs to `max` and NOT to p90 — worth
        // pinning, because reading p90 as "the worst case" would call a bursty cadence
        // uniform. Both fields are reported for exactly this reason.
        for _ in 0..9 {
            s.record(16);
        }
        s.record(300);
        let (n, p50, p90, max, dropped) = s.drain();
        assert_eq!((n, p50, max, dropped), (10, 16, 300, 0));
        assert_eq!(p90, 16, "a lone 10% outlier is max, not p90");

        // A sustained 20% tail is what p90 is there to catch.
        let mut tail = TargetGapStats::default();
        for _ in 0..8 {
            tail.record(16);
        }
        tail.record(300);
        tail.record(300);
        let (_, tp50, tp90, tmax, _) = tail.drain();
        assert_eq!((tp50, tp90, tmax), (16, 300, 300));

        // Draining clears, so per-second windows cannot bleed into each other.
        assert_eq!(s.drain(), (0, 0, 0, 0, 0));

        // Overflow is counted, never silently discarded.
        let mut s2 = TargetGapStats::default();
        for _ in 0..(TARGET_GAP_SAMPLE_CAP + 7) {
            s2.record(20);
        }
        let (n2, _, _, _, dropped2) = s2.drain();
        assert_eq!((n2, dropped2), (TARGET_GAP_SAMPLE_CAP, 7));
    }
}

#[cfg(test)]
mod scratch_smoke_test {
    use super::*;

    /// `log::warn!`/`info!` calls are no-ops in a bare `cargo test` process — nothing
    /// installs a logger backend the way `tauri-plugin-log` does in the real app, so
    /// diagnostic log lines (e.g. "appsrc push_buffer failed") are silently swallowed
    /// unless a logger is registered. This minimal stderr logger makes them visible
    /// under `--nocapture`. `set_logger` can only succeed once per process; ignore a
    /// failure (a previous test in the same run already installed it).
    struct TestLogger;
    impl log::Log for TestLogger {
        fn enabled(&self, _: &log::Metadata) -> bool { true }
        fn log(&self, record: &log::Record) {
            let line = format!("[{}] {}", record.level(), record.args());
            eprintln!("{line}");
            // Also captured so a test can *assert* on diagnostics rather than leaving a
            // human to eyeball --nocapture output. The sink-flow/queue-flow warnings are
            // the entire observable behaviour of instrument_sink_flow(), so a test that
            // does not read them back is not testing anything.
            if let Ok(mut c) = CAPTURED.lock() {
                c.push(line);
            }
        }
        fn flush(&self) {}
    }
    static TEST_LOGGER: TestLogger = TestLogger;
    static CAPTURED: Mutex<Vec<String>> = Mutex::new(Vec::new());
    fn init_test_logger() {
        let _ = log::set_logger(&TEST_LOGGER);
        log::set_max_level(log::LevelFilter::Debug);
    }
    fn captured_matching(needle: &str) -> Vec<String> {
        CAPTURED.lock().unwrap().iter().filter(|l| l.contains(needle)).cloned().collect()
    }
    fn clear_captured() {
        CAPTURED.lock().unwrap().clear();
    }
    const GAP_WARNING: &str = "buffer flow resumed after a";
    const UNDERRUN_WARNING: &str = "output_queue underrun";

    /// The cue branch's sink, so a test can stall the same pad `instrument_sink_flow()`
    /// watches. Taken from `PipelineInner` rather than found by walking the graph: the cue
    /// sink is a `pulsesink` like the main ones and `make_sink()` leaves them all with
    /// auto-generated names, so nothing in the built pipeline distinguishes them.
    fn cue_sink_of(p: &DeckAudioPipeline) -> Option<gst::Element> {
        p.inner.as_ref().map(|i| i.cue_sink_el.clone())
    }

    /// Every `pulsesink`/`autoaudiosink` in a built pipeline, so a test can attach its own
    /// probes to the same pads `instrument_sink_flow()` watches. ⚠️ Includes the **cue**
    /// sink when one is configured — the filter cannot tell the branches apart (see
    /// `cue_sink_of`). Main sinks are built first, so index 0 is a main sink.
    fn main_sinks_of(p: &DeckAudioPipeline) -> Vec<gst::Element> {
        let Some(inner) = p.inner.as_ref() else { return Vec::new() };
        inner
            .pipeline
            .iterate_recurse()
            .into_iter()
            .flatten()
            .filter(|e| {
                let f = e.factory().map(|f| f.name().to_string()).unwrap_or_default();
                f == "pulsesink" || f == "autoaudiosink"
            })
            .collect()
    }

    /// Effectively "never decays within a real gesture" — shuttle-mode tests want the
    /// original free-running-at-last-rate behavior across sleeps between scratch() calls.
    const SHUTTLE_HOLD_MS: u64 = 100_000;

    /// Manual smoke test against a real local file — not portable (hardcoded path),
    /// so it's `#[ignore]`d by default. Run explicitly with:
    ///   cargo test scratch_smoke -- --ignored --nocapture
    /// Exercises the full topology: load (incl. PCM decode), forward scratch, reverse
    /// scratch, direction reversal, stop, and resuming normal playback afterward.
    /// Used to derisk the pcm-buffer-playback design (see
    /// docs/design/pcm-buffer-playback.md) before wiring it into the real app — caught
    /// a real hang (pipewiresink stuck Playing→Paused ASYNC after a scratch, fixed by
    /// the flush-seek in stop_scratch_feeder) that pure code review would have missed.
    #[test]
    #[ignore]
    fn scratch_smoke() {
        gst::init().expect("gst init");
        let path = "/home/account/Downloads/audio.wav";

        let mut pipeline = DeckAudioPipeline::new("test-deck");
        let duration = pipeline.load(path).expect("load");
        println!("loaded, duration={duration:?}");
        assert!(pipeline.pcm_buffer.is_some(), "PCM buffer should have decoded");

        pipeline.play().expect("play");
        std::thread::sleep(Duration::from_millis(300));
        pipeline.pause().expect("pause");
        let pos_before = pipeline.position().unwrap();
        println!("paused at {pos_before:.3}s");

        // Forward scratch.
        pipeline.scratch(1.0, SHUTTLE_HOLD_MS).expect("scratch fwd");
        std::thread::sleep(Duration::from_millis(200));
        pipeline.scratch(1.5, SHUTTLE_HOLD_MS).expect("scratch fwd faster");
        std::thread::sleep(Duration::from_millis(200));

        // Reverse — this is the case that was structurally broken via segment-rate seeks.
        pipeline.scratch(-1.2, SHUTTLE_HOLD_MS).expect("scratch reverse");
        std::thread::sleep(Duration::from_millis(300));

        pipeline.stop_scratch().expect("stop_scratch");
        std::thread::sleep(Duration::from_millis(100)); // let the resync seek settle before querying
        let pos_after_scratch = pipeline.position().unwrap_or(0.0);
        println!("scratch ended, resynced position={pos_after_scratch:.3}s");

        // Resuming normal playback must not hang (this is exactly what was broken:
        // the main sink got stuck ASYNC Playing→Paused after an input-selector switch
        // with no fresh preroll buffer).
        pipeline.play().expect("play after scratch");
        std::thread::sleep(Duration::from_millis(200));
        let pos_advancing = pipeline.position().expect("position while playing");
        assert!(
            pos_advancing >= pos_after_scratch,
            "position should have advanced or held, not gone backward: {pos_after_scratch} -> {pos_advancing}"
        );
        println!("resumed playback at ~{pos_advancing:.3}s");

        pipeline.pause().expect("final pause");
        println!("scratch_smoke OK");
    }

    /// Repro for the phase-4 "silent stall a fraction of a second before every
    /// track's true end" finding (docs/design/webcodecs-video-path.md). Plays the
    /// short local test file to its natural end with plain (non-scratch) playback —
    /// no input-selector switch, no appsrc branch ever touched — and polls
    /// `position()` + the bus thread's `at_eos` flag every 100ms. If the bug
    /// reproduces, position stops advancing a fraction of a second before the
    /// real duration and `at_eos` never flips true (the bus thread's EOS handler
    /// never runs because no EOS message ever arrives — see the design doc's
    /// "zero bus messages after Paused→Playing" observation). Run under gdb via
    /// scripts/gdb-stall-catcher.py (adapted) to catch the exact blocked thread.
    #[test]
    #[ignore]
    fn eos_stall_repro() {
        init_test_logger();
        gst::init().expect("gst init");
        let path = "/home/account/Downloads/audio.wav";

        let mut pipeline = DeckAudioPipeline::new("test-deck-eos");
        let duration = pipeline.load(path).expect("load").expect("duration");
        println!("loaded, duration={duration:.6}s");

        pipeline.play().expect("play");

        let start = Instant::now();
        let mut last_pos: Option<f64> = None;
        let mut stuck_polls = 0u32;
        loop {
            std::thread::sleep(Duration::from_millis(100));
            let pos = pipeline.position();
            let at_eos = pipeline.inner.as_ref().unwrap().at_eos.load(Ordering::Relaxed);
            let state = pipeline.inner.as_ref().unwrap().pipeline.current_state();
            let elapsed = start.elapsed().as_secs_f64();
            println!(
                "t={elapsed:.3}s pos={pos:?} at_eos={at_eos} state={state:?} gap_from_end={:?}",
                pos.map(|p| duration - p)
            );

            if at_eos {
                println!("eos_stall_repro OK: at_eos flipped true, pipeline self-paused correctly");
                return;
            }

            match (last_pos, pos) {
                (Some(l), Some(p)) if (p - l).abs() < 1e-9 => {
                    stuck_polls += 1;
                    if stuck_polls >= 5 {
                        panic!(
                            "REPRODUCED THE BUG: position stuck at {p:.6}s for {stuck_polls} \
                             consecutive polls ({}ms), {:.3}s short of the true {duration:.6}s \
                             duration, and at_eos never fired — pipeline silently stalled near \
                             end of track. See docs/design/webcodecs-video-path.md phase 4 results.",
                            stuck_polls * 100, duration - p
                        );
                    }
                }
                _ => stuck_polls = 0,
            }
            last_pos = pos;

            if elapsed > 20.0 {
                panic!(
                    "timed out after 20s waiting for natural EOS (duration={duration:.6}s, \
                     last pos={last_pos:?}) — neither a clean EOS nor the expected stall pattern"
                );
            }
        }
    }

    /// Traces exactly how far the EOS event travels through the topology before
    /// `eos_stall_repro` freezes, via pad probes at every hop from `pitch` through
    /// the final sinks. A `gdb` backtrace of the stalled `queue0:src` thread (the
    /// uridecodebin-side `queue`'s own streaming thread) showed it blocked in
    /// `g_cond_wait` deep inside `libgstcoreelements.so`, having already synchronously
    /// pushed the event through `pitch` (`libgstsoundtouch.so` appears in the trace)
    /// and several more core elements — consistent with EOS reaching at least
    /// `valve_normal`/`input_selector` before blocking, but stripped release binaries
    /// give no symbol names for exactly which core element's sink event handler is
    /// the one actually blocking. This test pinpoints it precisely by logging the
    /// last pad an EOS event is observed at, walking the actual pad graph (via
    /// `peer()`) from `output_queue`'s src pad through `tee` and every branch —
    /// no hardcoded element names, so it can't drift out of sync with `load()`'s
    /// topology.
    #[test]
    #[ignore]
    fn eos_stall_probe_trace() {
        init_test_logger();
        gst::init().expect("gst init");
        let path = "/home/account/Downloads/audio.wav";

        let mut pipeline = DeckAudioPipeline::new("test-deck-probe");
        let duration = pipeline.load(path).expect("load").expect("duration");
        println!("loaded, duration={duration:.6}s");

        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        fn probe(pad: &gst::Pad, label: &str, seen: Arc<Mutex<Vec<String>>>) {
            let label = label.to_string();
            pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_, info| {
                if let Some(ev) = info.event() {
                    if ev.type_() == gst::EventType::Eos {
                        seen.lock().unwrap().push(label.clone());
                        println!("[probe] EOS at {label}");
                    }
                }
                gst::PadProbeReturn::Ok
            });
        }

        {
            let inner = pipeline.inner.as_ref().expect("pipeline loaded");
            probe(&inner.pitch_el.static_pad("src").unwrap(), "pitch:src", seen.clone());
            probe(&inner.valve_normal_el.static_pad("src").unwrap(), "valve_normal:src", seen.clone());
            probe(&inner.sel_normal_pad, "selector:sink_normal", seen.clone());
            probe(&inner.input_selector.static_pad("src").unwrap(), "selector:src", seen.clone());
            probe(&inner.output_queue_el.static_pad("sink").unwrap(), "output_queue:sink", seen.clone());
            let oq_src = inner.output_queue_el.static_pad("src").unwrap();
            probe(&oq_src, "output_queue:src", seen.clone());

            // Walk the real pad graph from here on, rather than hardcoding names —
            // tee's sink, every one of its requested src pads, and one hop further
            // into whatever each of those connects to (volume/valve/sink elements).
            if let Some(tee_sink) = oq_src.peer() {
                probe(&tee_sink, "tee:sink", seen.clone());
                let tee_el = tee_sink.parent_element().expect("tee sink pad has a parent");
                let pad_iter = tee_el.pads();
                for pad in pad_iter {
                    if pad.direction() != gst::PadDirection::Src { continue; }
                    let name = pad.name().to_string();
                    probe(&pad, &format!("tee:{name}"), seen.clone());
                    if let Some(next_sink) = pad.peer() {
                        let next_el = next_sink.parent_element().expect("peer pad has a parent");
                        let next_el_name = next_el.name().to_string();
                        probe(&next_sink, &format!("{next_el_name}:sink"), seen.clone());
                        // One more hop (e.g. volume -> real sink, or cue_valve -> cue_volume).
                        if let Some(next_src) = next_el.static_pad("src") {
                            if let Some(final_sink) = next_src.peer() {
                                let final_el = final_sink.parent_element().expect("peer pad has a parent");
                                probe(&final_sink, &format!("{}:sink", final_el.name()), seen.clone());
                            }
                        }
                    }
                }
            }
        }

        pipeline.play().expect("play");

        let start = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(100));
            let pos = pipeline.position();
            let at_eos = pipeline.inner.as_ref().unwrap().at_eos.load(Ordering::Relaxed);
            let elapsed = start.elapsed().as_secs_f64();
            println!("t={elapsed:.3}s pos={pos:?} at_eos={at_eos}");

            if at_eos {
                println!("eos_stall_probe_trace: at_eos flipped true — no stall this run, EOS reached: {:?}", seen.lock().unwrap());
                return;
            }
            if elapsed > 10.0 {
                println!(
                    "STALL: after {elapsed:.1}s, EOS was observed at exactly these pads (in order): {:?}",
                    seen.lock().unwrap()
                );
                panic!("EOS probe trace complete — see printed list above for the last pad EOS reached before the stall");
            }
        }
    }

    /// Vinyl-mode regression guard: a short `hold_ms` should freeze the feeder soon
    /// after scratch() calls stop arriving, instead of free-running at the last rate
    /// for the whole gap (that free-running behavior is exactly what shuttle mode
    /// wants, and exactly what vinyl mode must not do — see "Open question: shuttle
    /// mode vs. vinyl mode" in docs/design/pcm-buffer-playback.md).
    #[test]
    #[ignore]
    fn vinyl_hold_smoke() {
        gst::init().expect("gst init");
        let path = "/home/account/Downloads/audio.wav";
        const VINYL_HOLD_MS: u64 = 30;

        let mut pipeline = DeckAudioPipeline::new("test-deck-vinyl");
        pipeline.load(path).expect("load");
        pipeline.play().expect("play");
        std::thread::sleep(Duration::from_millis(300));
        pipeline.pause().expect("pause");
        let pos_before = pipeline.position().unwrap();

        pipeline.scratch(1.5, VINYL_HOLD_MS).expect("scratch vinyl");
        std::thread::sleep(Duration::from_millis(200)); // no further scratch() calls
        pipeline.stop_scratch().expect("stop_scratch");
        std::thread::sleep(Duration::from_millis(100));
        let pos_after = pipeline.position().unwrap_or(0.0);

        let advanced = pos_after - pos_before;
        // Free-running the full 200ms at rate=1.5 would advance ~0.3s. If the hold
        // decay worked, the cursor should have frozen not long after the 30ms hold
        // window — allow a generous margin (ramp-down isn't instant) but this must be
        // well under what uninterrupted free-running would produce.
        assert!(
            advanced < 0.15,
            "vinyl hold should have frozen the cursor well before 200ms elapsed, but advanced {advanced:.3}s"
        );
        println!("vinyl_hold_smoke OK: advanced {advanced:.3}s in a 200ms gap (hold_ms={VINYL_HOLD_MS})");

        pipeline.pause().expect("final pause");
    }

    /// Position-mode (`scratch_to`) regression guard, covering the two properties the
    /// waveform drag and vinyl jog both depend on:
    ///
    ///   1. **Convergence and hold.** The cursor reaches a commanded target and then
    ///      stays there. Velocity mode cannot do this — with no absolute reference it
    ///      keeps free-running (or decays on a timer) rather than stopping *somewhere
    ///      specific*, which is what made travel depend on event timing.
    ///   2. **Gesture-boundary continuity.** A second gesture started immediately after
    ///      the first resumes from where the first landed, rather than from
    ///      `query_position()`'s pre-gesture answer — the `last_scratch_frame` path. The
    ///      100ms gap here is deliberately inside `stop_scratch_feeder()`'s own ~300ms of
    ///      drain sleep and resync seeks, which is exactly the window that used to make
    ///      the track jump backward between short cueing nudges.
    #[test]
    #[ignore]
    fn scratch_to_smoke() {
        gst::init().expect("gst init");
        let path = "/home/account/Downloads/audio.wav";
        const HOLD_MS: u64 = 1000;

        let mut pipeline = DeckAudioPipeline::new("test-deck-scratch-to");
        pipeline.load(path).expect("load");
        pipeline.play().expect("play");
        std::thread::sleep(Duration::from_millis(300));
        pipeline.pause().expect("pause");

        let start = pipeline.position().unwrap();
        let target = start + 0.20;

        // Converge. Well inside SCRATCH_TARGET_SNAP_SECS, so this sweeps rather than
        // snapping — i.e. it exercises the servo, not the jump path.
        pipeline.scratch_to(target, HOLD_MS).expect("scratch_to");
        std::thread::sleep(Duration::from_millis(250));
        let arrived = pipeline.position().unwrap();
        assert!(
            (arrived - target).abs() < 0.02,
            "cursor should have converged on {target:.3}s, but sits at {arrived:.3}s"
        );

        // ...and hold. No further scratch_to() calls: in position mode silence and a
        // frozen cursor come from having arrived, not from hold_ms (1s here, so it
        // cannot be what stops the cursor within this window).
        std::thread::sleep(Duration::from_millis(300));
        let held = pipeline.position().unwrap();
        assert!(
            (held - arrived).abs() < 0.01,
            "cursor should hold at the target once arrived, but drifted {:.3}s",
            held - arrived
        );

        pipeline.stop_scratch().expect("stop_scratch");

        // Second gesture inside the resync window — must resume from the first's landing
        // frame, not from wherever the normal branch still thinks it is.
        std::thread::sleep(Duration::from_millis(100));
        let target2 = target + 0.10;
        pipeline.scratch_to(target2, HOLD_MS).expect("scratch_to 2");
        std::thread::sleep(Duration::from_millis(250));
        let arrived2 = pipeline.position().unwrap();
        assert!(
            (arrived2 - target2).abs() < 0.02,
            "second gesture should have converged on {target2:.3}s, but sits at {arrived2:.3}s \
             (a large negative error here means it restarted from a stale query_position)"
        );

        println!(
            "scratch_to_smoke OK: converged {start:.3}s -> {arrived:.3}s (target {target:.3}s), \
             held, then {arrived2:.3}s (target {target2:.3}s) across a gesture boundary"
        );

        pipeline.stop_scratch().expect("final stop_scratch");
        pipeline.pause().expect("final pause");
    }

    /// The sinks' timestamp-alignment tolerance is widened for the duration of a scratch
    /// gesture and restored when it ends — see `scratch_sink_alignment()` and
    /// docs/design/scratch-audio-downstream-delivery.md F10.
    ///
    /// Asserting the *restore* is the point of this test. The widened value cannot break
    /// anything during a gesture, but leaking it into normal playback silently changes how
    /// the sink handles a genuine decoder discontinuity — a regression with no symptom
    /// until some unrelated live session drifts audio away from video. `stop_scratch_feeder()`
    /// has several early returns, and this is what keeps the restore ahead of all of them.
    #[test]
    #[ignore]
    fn scratch_widens_sink_alignment_then_restores() {
        gst::init().expect("gst init");
        let mut pipeline = DeckAudioPipeline::new("test-deck-align");
        pipeline.load("/home/account/Downloads/audio.wav").expect("load");
        pipeline.play().expect("play");
        std::thread::sleep(Duration::from_millis(300));
        pipeline.pause().expect("pause");

        let sinks: Vec<gst::Element> = main_sinks_of(&pipeline)
            .into_iter()
            .filter(|s| s.find_property("alignment-threshold").is_some())
            .collect();
        assert!(!sinks.is_empty(), "no GstAudioBaseSink to assert on");

        let read = |s: &gst::Element| -> (u64, u64) {
            (s.property("alignment-threshold"), s.property("discont-wait"))
        };

        for s in &sinks {
            assert_eq!(
                read(s),
                SINK_ALIGN_DEFAULTS_NS,
                "sink should start at GStreamer's stock values — SINK_ALIGN_DEFAULTS_NS \
                 is hardcoded on the assumption that make_sink() never touches these"
            );
        }

        let start = pipeline.position().unwrap();
        pipeline.scratch_to(start + 0.20, 1000).expect("scratch_to");
        std::thread::sleep(Duration::from_millis(150));

        let expected = scratch_sink_alignment();
        for s in &sinks {
            assert_eq!(read(s), expected, "widened for the gesture");
        }

        pipeline.stop_scratch().expect("stop_scratch");
        for s in &sinks {
            assert_eq!(read(s), SINK_ALIGN_DEFAULTS_NS, "restored at gesture end");
        }

        pipeline.pause().expect("final pause");
    }

    /// Investigates the open "reverse scratch produced no audible output" bug from
    /// docs/design/pcm-buffer-playback.md. Original hypothesis was a direction-specific
    /// DSP/gain bug or an input-selector routing bug on a second gesture; empirically
    /// (see the doc's "Sixth mechanism" section) it's neither — it's a **timing race**:
    /// on a freshly-spawned scratch feeder (a *new* gesture, not a rate update on an
    /// existing one) whose *initial* rate is negative, `appsrc`'s own internal
    /// streaming task intermittently stalls for several hundred ms to ~1.6s before
    /// delivering any data, then catches up in a burst. A positive-rate second gesture
    /// never showed this. This is the same *class* of intermittent GStreamer/PipeWire
    /// stall already tracked as "mechanism 5" (the resync_seek stall) — likely a shared
    /// root cause, now reproducible headlessly (no MIDI hardware needed) instead of
    /// only via live repro.
    ///
    /// Uses pad probes (same technique as this doc's original appsrc-direction
    /// validation) at three points to localize *where* the delay originates:
    ///   1. `appsrc`'s own src pad — buffers actually leaving appsrc's internal queue.
    ///   2. `sel_scratch_pad` — input-selector's sink pad after convert2/resample2/
    ///      capsfilter2. Tracking (1) exactly confirms those elements are pure
    ///      pass-through here (same input/output rate) and add no delay of their own.
    ///   3. `input_selector`'s src pad — downstream of the active-pad switch.
    /// Empirically (1) and (2) always match exactly, meaning the delay is *inside*
    /// appsrc itself (between our thread's `push_buffer()` call — confirmed fast, see
    /// the push-timing warning in `spawn_scratch_feeder` — and appsrc's own task
    /// actually emitting the buffer), not in downstream routing or DSP.
    ///
    /// **This is a genuine race, not deterministic**: it reproduces roughly half the
    /// time in this environment, vanishes under `strace -f` or `GST_DEBUG` (both
    /// perturb scheduling enough to dodge the race — classic heisenbug signature), and
    /// its frequency drops (but doesn't reach zero) if the gap before the second
    /// scratch() call is stretched to 2s. Because of that, this test only asserts
    /// non-flaky invariants (probes are wired correctly; data eventually arrives and is
    /// never actually silent) — the printed `t=`/`epoch=` lines are what reveal the
    /// stall when it occurs. A run showing several repeated identical `total=` values
    /// across consecutive 200ms samples (e.g. stuck at 48 for 800ms) reproduced it; a
    /// smoothly increasing sequence did not that time — re-run a few times if you need
    /// to see the stall for further diagnosis.
    #[test]
    #[ignore]
    fn scratch_second_gesture_reverse_repro() {
        init_test_logger();
        gst::init().expect("gst init");
        let path = "/home/account/Downloads/audio.wav";
        const HOLD_MS: u64 = 100_000; // shuttle-style: isolate the direction/second-gesture question, not hold decay

        let mut pipeline = DeckAudioPipeline::new("test-deck-2nd-gesture");
        pipeline.load(path).expect("load");
        pipeline.play().expect("play");
        std::thread::sleep(Duration::from_millis(300));
        pipeline.pause().expect("pause");

        let (appsrc_src_pad, sel_scratch_pad, selector_src_pad) = {
            let inner = pipeline.inner.as_ref().expect("pipeline loaded");
            (
                inner.appsrc.static_pad("src").expect("appsrc has a src pad"),
                inner.sel_scratch_pad.clone(),
                inner.input_selector.static_pad("src").expect("input_selector has a src pad"),
            )
        };

        fn install_probe(pad: &gst::Pad, label: &'static str) -> (Arc<AtomicU64>, Arc<AtomicU64>) {
            let total = Arc::new(AtomicU64::new(0));
            let nonzero = Arc::new(AtomicU64::new(0));
            let total_p = total.clone();
            let nonzero_p = nonzero.clone();
            pad.add_probe(gst::PadProbeType::BUFFER, move |_, info| {
                if let Some(buffer) = info.buffer() {
                    total_p.fetch_add(1, Ordering::Relaxed);
                    if let Ok(map) = buffer.map_readable() {
                        let has_signal = map
                            .chunks_exact(4)
                            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                            .any(|v| v.abs() > 1e-6);
                        if has_signal {
                            nonzero_p.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
                gst::PadProbeReturn::Ok
            }).unwrap_or_else(|| panic!("failed to install probe on {label}"));
            (total, nonzero)
        }

        let (appsrc_src_total, appsrc_src_nonzero) = install_probe(&appsrc_src_pad, "appsrc src");
        let (scratch_pad_total, scratch_pad_nonzero) = install_probe(&sel_scratch_pad, "sel_scratch_pad");
        let (selector_src_total, selector_src_nonzero) = install_probe(&selector_src_pad, "input_selector src");

        // Gesture 1: forward. Expected (and previously confirmed) to work.
        pipeline.scratch(1.0, HOLD_MS).expect("scratch fwd");
        std::thread::sleep(Duration::from_millis(300));
        let g1_appsrc = appsrc_src_total.swap(0, Ordering::Relaxed);
        let g1 = (
            scratch_pad_total.swap(0, Ordering::Relaxed), scratch_pad_nonzero.swap(0, Ordering::Relaxed),
            selector_src_total.swap(0, Ordering::Relaxed), selector_src_nonzero.swap(0, Ordering::Relaxed),
        );
        appsrc_src_nonzero.store(0, Ordering::Relaxed);
        println!(
            "gesture1 (forward): appsrc_src total={}  sel_scratch_pad total={} nonzero={}  selector_src total={} nonzero={}",
            g1_appsrc, g1.0, g1.1, g1.2, g1.3
        );

        pipeline.stop_scratch().expect("stop_scratch after gesture1");
        std::thread::sleep(Duration::from_millis(100));

        // Gesture 2: reverse, after a full teardown/resync — this is the repro case.
        // Sampled every 200ms over 3s (rather than one 300ms window) to see the actual
        // catch-up curve if delivery is merely delayed rather than permanently broken.
        pipeline.scratch(-0.8, HOLD_MS).expect("scratch reverse");
        let gesture2_start = Instant::now();
        let mut g2_total_cumulative = 0u64;
        let mut samples: Vec<u64> = Vec::new();
        for _ in 0..15 {
            std::thread::sleep(Duration::from_millis(200));
            let a = appsrc_src_total.load(Ordering::Relaxed);
            let t = scratch_pad_total.load(Ordering::Relaxed);
            let nz = scratch_pad_nonzero.load(Ordering::Relaxed);
            g2_total_cumulative = t;
            samples.push(t);
            let epoch = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64();
            println!(
                "  epoch={epoch:.6}  t={:.0}ms  appsrc_src cumulative={}  sel_scratch_pad cumulative: total={} nonzero={}",
                gesture2_start.elapsed().as_secs_f64() * 1000.0, a, t, nz
            );
        }
        // Diagnostic only (not asserted — the race doesn't reproduce every run, see the
        // doc comment above): flag the longest run of consecutive 200ms samples with no
        // new buffers at all, i.e. a plateau in the cumulative count.
        let mut longest_stall_samples = 0usize;
        let mut current_stall_samples = 0usize;
        for pair in samples.windows(2) {
            if pair[1] == pair[0] {
                current_stall_samples += 1;
                longest_stall_samples = longest_stall_samples.max(current_stall_samples);
            } else {
                current_stall_samples = 0;
            }
        }
        if longest_stall_samples >= 2 {
            println!(
                "  >>> STALL DETECTED: {} consecutive 200ms samples with zero new sel_scratch_pad buffers \
                 (~{}ms of delivery gap) — this run reproduced the race",
                longest_stall_samples, longest_stall_samples * 200
            );
        } else {
            println!("  no stall detected this run (delivery was continuous) — re-run to try to catch the race");
        }
        let g2 = (
            scratch_pad_total.swap(0, Ordering::Relaxed), scratch_pad_nonzero.swap(0, Ordering::Relaxed),
            selector_src_total.swap(0, Ordering::Relaxed), selector_src_nonzero.swap(0, Ordering::Relaxed),
        );
        println!(
            "gesture2 (reverse, post-teardown, 3s total): sel_scratch_pad total={} nonzero={}  selector_src total={} nonzero={}  (cumulative during sampling was {})",
            g2.0, g2.1, g2.2, g2.3, g2_total_cumulative
        );

        pipeline.stop_scratch().expect("stop_scratch after gesture2");

        assert!(g1.0 > 0 && g1.1 > 0, "gesture1 (forward) sanity check failed — probes themselves are broken");

        // These CAN legitimately fail: that IS the bug reproducing, not a broken test.
        // Observed range across many runs: most resolve within ~1.6s: a full 3s window
        // with ZERO buffers delivered (assert below fails) has also been observed and
        // is a byte-for-byte match of the live report ("silence for its whole ~4s
        // duration") — see docs/design/pcm-buffer-playback.md, "Sixth mechanism".
        assert!(
            g2.0 > 0,
            "REPRODUCED THE BUG: zero buffers reached sel_scratch_pad in the full 3s window — \
             this is the reported 'reverse scratch produced no audible output' bug, not a broken \
             test. It's an intermittent race in appsrc's own delivery task, not deterministic — \
             re-run a few times if you need a passing baseline. See docs/design/pcm-buffer-playback.md."
        );
        assert!(
            g2.1 > 0,
            "gesture2: buffers reached sel_scratch_pad but all were silent (all-zero) — this WOULD be \
             a DSP/gain bug (fade/hold logic), distinct from the timing race above — not observed so far"
        );
        assert!(
            g2.2 > 0,
            "gesture2: sel_scratch_pad had signal but input_selector's src pad produced NO buffers — \
             would indicate the active-pad switch itself isn't forwarding — not observed so far"
        );
        assert!(
            g2.3 > 0,
            "gesture2: input_selector forwarded buffers but all were silent — signal is lost \
             between the selector and here, or the wrong (normal, silent-because-locked) pad is still active"
        );
        println!("scratch_second_gesture_reverse_repro OK — reverse gesture after teardown produced audible signal at every probe point");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  docs/design/audio-dropout-mid-playback.md — D2 verification and D1 reproducer
    // ─────────────────────────────────────────────────────────────────────────────

    /// Test media. Not committed (it is ~70MB) — regenerate with:
    /// ```text
    /// mkdir -p /var/tmp/cuemark-soak && gst-launch-1.0 -q \
    ///   audiotestsrc num-buffers=16875 samplesperbuffer=1024 wave=pink-noise volume=0.25 \
    ///   ! audio/x-raw,rate=48000,channels=2 ! audioconvert ! wavenc \
    ///   ! filesink location=/var/tmp/cuemark-soak/tone6min.wav
    /// cp /var/tmp/cuemark-soak/tone6min.wav /var/tmp/cuemark-soak/tone6min_b.wav
    /// ```
    /// A synthetic tone is adequate here on purpose: every hypothesis in the design doc
    /// is about sink/device scheduling, none about decoded content.
    const SOAK_A: &str = "/var/tmp/cuemark-soak/tone6min.wav";
    const SOAK_B: &str = "/var/tmp/cuemark-soak/tone6min_b.wav";

    fn soak_env(var: &str, default: &str) -> String {
        std::env::var(var).unwrap_or_else(|_| default.to_string())
    }

    /// **D2 verification** (docs/design/audio-dropout-mid-playback.md).
    ///
    /// Reproduces the exact shape of the six false positives from the 2026-08-05 live set
    /// — a deck that prerolls, sits there, then gets played, then paused, then played
    /// again — and asserts that `instrument_sink_flow()` stays silent through all of it.
    /// Then it induces a *genuine* stall (a second pad probe on the same sink pad that
    /// sleeps 2.5s while the pipeline is Playing) and asserts the warning still fires, so
    /// the gate cannot pass by simply having been turned off.
    ///
    /// Needs a real audio device and a real file, hence `#[ignore]`:
    ///   cargo test sink_flow_gap_gating -- --ignored --nocapture
    #[test]
    #[ignore]
    fn sink_flow_gap_gating() {
        init_test_logger();
        gst::init().expect("gst init");
        let path = soak_env("CUEMARK_TEST_AUDIO", SOAK_A);
        assert!(std::path::Path::new(&path).exists(), "missing test media {path} — see SOAK_A's doc comment");

        let mut deck = DeckAudioPipeline::new("gate-test");
        deck.set_gain(0.02).expect("set_gain"); // audible-but-quiet; buffers flow regardless

        // ── Negative arm: everything that used to produce a false "Ns gap" ────────
        clear_captured();
        deck.load(&path).expect("load"); // prerolls to Paused, one buffer reaches the sink
        println!("[arm-1] prerolled; holding 6s before play (this is false positive #1's shape)");
        std::thread::sleep(Duration::from_secs(6));
        deck.play().expect("play");
        std::thread::sleep(Duration::from_secs(4));
        deck.pause().expect("pause");
        println!("[arm-1] paused; holding 6s before resuming (false positive #2's shape)");
        std::thread::sleep(Duration::from_secs(6));
        deck.play().expect("play 2");
        std::thread::sleep(Duration::from_secs(4));
        deck.pause().expect("pause 2");
        std::thread::sleep(Duration::from_millis(500));

        let false_positives = captured_matching(GAP_WARNING);
        for l in &false_positives {
            println!("[arm-1] UNEXPECTED: {l}");
        }
        assert!(
            captured_matching("first buffer reached the sink").len() >= 1,
            "[arm-1] the probe never fired at all — the test proves nothing. Is there an audio device?"
        );
        assert!(
            false_positives.is_empty(),
            "[arm-1] {} preroll/pause gap warning(s) survived the D2 gate",
            false_positives.len()
        );
        println!("[arm-1] OK — 16s of preroll and pause waits produced zero gap warnings");

        // ── Positive arm: a real stall must still be reported ─────────────────────
        clear_captured();
        deck.play().expect("play 3");
        std::thread::sleep(Duration::from_secs(2));
        let sinks = main_sinks_of(&deck);
        assert!(!sinks.is_empty(), "[arm-2] no sink element found to stall");
        let stalled = Arc::new(AtomicBool::new(false));
        let stalled_probe = stalled.clone();
        let pad = sinks[0].static_pad("sink").expect("sink pad");
        // Added *after* instrument_sink_flow()'s probe, so it runs second: the flow probe
        // records this buffer's arrival, then this one holds the streaming thread for
        // 2.5s. The next buffer is therefore a genuine >1s gap taken entirely inside
        // PLAYING — the same shape as the live 10.8s dropout, on purpose.
        pad.add_probe(gst::PadProbeType::BUFFER, move |_p, _i| {
            if !stalled_probe.swap(true, Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(2500));
            }
            gst::PadProbeReturn::Ok
        });
        std::thread::sleep(Duration::from_secs(6));
        deck.pause().expect("final pause");

        let real = captured_matching(GAP_WARNING);
        for l in &real {
            println!("[arm-2] {l}");
        }
        assert!(
            !real.is_empty(),
            "[arm-2] a deliberate 2.5s stall inside PLAYING was NOT reported — the D2 gate is \
             suppressing real dropouts, which is worse than the noise it replaced"
        );
        assert!(
            real[0].contains("began "),
            "[arm-2] the warning must carry the gap's onset time, not just its duration: {}",
            real[0]
        );
        println!("sink_flow_gap_gating OK — false positives gone, real stall still reported with an onset");
    }

    /// **Cue-branch sibling of `sink_flow_gap_gating`** (2026-08-08,
    /// docs/design/audio-dropout-mid-playback.md H1).
    ///
    /// Instrumenting the cue sink reintroduces D2's trap in a new shape: `cue_valve` drops
    /// every buffer while cue is off, so a cue-off span is a perfect forgery of the dropout
    /// this probe exists to catch — and unlike the pause case, *no buffer ever arrives* to
    /// clear the stale timestamp, because the valve drops them upstream of the probed pad.
    /// That is why `set_cue_enabled()` invalidates `last` itself rather than relying on the
    /// gate alone. Arm 1 asserts the toggling is silent; arm 2 asserts a genuine stall on
    /// the cue sink, taken while cue is open, is still reported — because the cheapest way
    /// to pass arm 1 is to break the probe entirely.
    ///
    /// Needs a real audio device **and a real cue device**, hence `#[ignore]`:
    /// ```text
    ///   CUEMARK_CUE_DEVICE='alsa_output.usb-…analog-surround-40@RL,RR!FL,FR,RL,RR' \
    ///   cargo test cue_sink_flow_gap_gating -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn cue_sink_flow_gap_gating() {
        init_test_logger();
        gst::init().expect("gst init");
        let path = soak_env("CUEMARK_TEST_AUDIO", SOAK_A);
        assert!(std::path::Path::new(&path).exists(), "missing test media {path} — see SOAK_A's doc comment");
        let cue_dev = soak_env("CUEMARK_CUE_DEVICE", "");
        assert!(
            !cue_dev.is_empty(),
            "CUEMARK_CUE_DEVICE is unset — with no cue device the branch falls back to \
             fakesink and is deliberately uninstrumented, so this test would pass vacuously"
        );

        let mut deck = DeckAudioPipeline::new("cue-gate-test");
        deck.set_gain(0.02).expect("set_gain");
        deck.set_cue_gain(0.02).expect("set_cue_gain");
        deck.load(&path).expect("load");
        deck.set_cue_device(&cue_dev).expect("set_cue_device"); // rebuilds the pipeline

        const CUE_GAP: &str = "cue sink: buffer flow resumed after a";

        // ── Negative arm: cue toggling must never manufacture a gap ───────────────
        clear_captured();
        deck.play().expect("play");
        std::thread::sleep(Duration::from_secs(2));
        deck.set_cue_enabled(true).expect("cue on");
        std::thread::sleep(Duration::from_secs(3));
        deck.set_cue_enabled(false).expect("cue off");
        println!("[arm-1] cue off; holding 6s with the valve dropping everything");
        std::thread::sleep(Duration::from_secs(6));
        deck.set_cue_enabled(true).expect("cue on 2");
        std::thread::sleep(Duration::from_secs(3));
        // And across a pause, which stacks both gates at once.
        deck.pause().expect("pause");
        std::thread::sleep(Duration::from_secs(4));
        deck.play().expect("play 2");
        std::thread::sleep(Duration::from_secs(3));

        let false_positives = captured_matching(CUE_GAP);
        for l in &false_positives {
            println!("[arm-1] UNEXPECTED: {l}");
        }
        assert!(
            !captured_matching("cue sink: first buffer reached the sink").is_empty(),
            "[arm-1] the cue probe never fired — nothing reached the cue sink, so the test \
             proves nothing. Is CUEMARK_CUE_DEVICE a real device?"
        );
        assert!(
            false_positives.is_empty(),
            "[arm-1] {} cue-off/pause gap warning(s) survived the gate — set_cue_enabled() \
             is not invalidating the probe's last-buffer time",
            false_positives.len()
        );
        println!("[arm-1] OK — a 6s cue-off span and a 4s pause produced zero cue gap warnings");

        // ── Positive arm: a real stall on the cue sink must still be reported ─────
        clear_captured();
        let cue_sink = cue_sink_of(&deck).expect("[arm-2] no cue sink element found to stall");
        let stalled = Arc::new(AtomicBool::new(false));
        let stalled_probe = stalled.clone();
        let pad = cue_sink.static_pad("sink").expect("cue sink pad");
        pad.add_probe(gst::PadProbeType::BUFFER, move |_p, _i| {
            if !stalled_probe.swap(true, Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(2500));
            }
            gst::PadProbeReturn::Ok
        });
        std::thread::sleep(Duration::from_secs(6));
        deck.pause().expect("final pause");

        let real = captured_matching(CUE_GAP);
        for l in &real {
            println!("[arm-2] {l}");
        }
        assert!(
            !real.is_empty(),
            "[arm-2] a deliberate 2.5s stall on the cue sink inside PLAYING with cue open \
             was NOT reported — the cue gate is suppressing real dropouts"
        );
        println!("cue_sink_flow_gap_gating OK — cue toggling silent, real cue stall still reported");
    }

    /// **D1 reproducer attempt** (docs/design/audio-dropout-mid-playback.md).
    ///
    /// Two decks on the real hardware, playing continuously, with headphone cue toggled
    /// on and off and the master volume churned at MIDI rate — the conditions present when
    /// the live 10.8s dropout happened. Counts post-D2 sink-flow gaps and `output_queue`
    /// underruns per deck.
    ///
    /// **Arms** (`CUEMARK_SOAK_ARM`), which differ only in cue routing:
    /// - `cue-same` — main and cue on the same USB device, cue toggled. The live config.
    /// - `cue-off`  — cue device configured but the valve never opened. Control: the cue
    ///   sink exists on the device but passes nothing.
    /// - `cue-other` — cue on a *different* device (the onboard PCI codec). This is the
    ///   arm that separates "the cue branch" from "two sinks on one USB device"; it is
    ///   the same move that cracked the 2026-08-02 investigation.
    /// - `no-cue`   — no cue device at all (fakesink). Floor.
    ///
    /// ```text
    /// CUEMARK_SOAK_ARM=cue-same CUEMARK_SOAK_SECS=600 \
    ///   CUEMARK_MAIN_DEVICE=alsa_output.usb-…analog-surround-40 \
    ///   CUEMARK_CUE_DEVICE='alsa_output.usb-…analog-surround-40@RL,RR!FL,FR,RL,RR' \
    ///   CUEMARK_OTHER_DEVICE=alsa_output.pci-0000_00_1b.0.analog-stereo \
    ///   cargo test cue_dropout_soak -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn cue_dropout_soak() {
        init_test_logger();
        gst::init().expect("gst init");
        let arm = soak_env("CUEMARK_SOAK_ARM", "cue-same");
        let secs: u64 = soak_env("CUEMARK_SOAK_SECS", "600").parse().expect("CUEMARK_SOAK_SECS");
        let main_dev = soak_env("CUEMARK_MAIN_DEVICE", "");
        let cue_dev = soak_env("CUEMARK_CUE_DEVICE", "");
        let other_dev = soak_env("CUEMARK_OTHER_DEVICE", "");

        let cue_target = match arm.as_str() {
            "cue-same" | "cue-off" => cue_dev.clone(),
            "cue-other" => other_dev.clone(),
            "no-cue" => String::new(),
            other => panic!("unknown CUEMARK_SOAK_ARM {other:?}"),
        };
        let toggles_cue = arm == "cue-same" || arm == "cue-other";

        println!("=== soak arm={arm} secs={secs} main={main_dev:?} cue={cue_target:?} toggles_cue={toggles_cue}");

        // 1 = the live topology exactly (one playing deck, main + cue on one node — deck-1
        // did not reach Playing until *after* the 2026-08-05 stall). 2 = the same node
        // carrying four pulsesinks, which is the worst case a two-deck set produces.
        let n_decks: usize = soak_env("CUEMARK_SOAK_DECKS", "2").parse().expect("CUEMARK_SOAK_DECKS");
        let mut decks: Vec<DeckAudioPipeline> = Vec::new();
        for (i, path) in [SOAK_A, SOAK_B].iter().take(n_decks).enumerate() {
            assert!(std::path::Path::new(path).exists(), "missing test media {path}");
            let mut d = DeckAudioPipeline::new(&format!("soak-{i}"));
            if !main_dev.is_empty() {
                d.devices = vec![main_dev.clone()];
            }
            d.cue_device = cue_target.clone();
            d.set_gain(0.02).expect("set_gain");
            d.set_cue_gain(0.02).expect("set_cue_gain");
            d.load(path).expect("load");
            decks.push(d);
        }
        clear_captured();
        for d in &mut decks {
            d.play().expect("play");
        }

        let start = Instant::now();
        let mut tick = 0u64;
        let mut cue_on = false;
        let mut last_report = Instant::now();
        while start.elapsed() < Duration::from_secs(secs) {
            // MIDI-rate master-volume churn on both decks — H3 in the design doc. Present
            // in every arm so it is a constant, not a variable.
            let f = if tick % 4 == 0 { 0.0 } else { 0.5 + 0.5 * ((tick % 8) as f32 / 8.0) };
            for d in &mut decks {
                d.set_master_volume_factor(f);
            }
            std::thread::sleep(Duration::from_millis(500));
            tick += 1;

            // Cue toggles every 15s, matching the live set's on-for-93s / off pattern
            // closely enough to exercise both the valve open and the valve close.
            if toggles_cue && tick % 30 == 0 {
                cue_on = !cue_on;
                for d in &mut decks {
                    d.set_cue_enabled(cue_on).expect("set_cue_enabled");
                }
                println!("[{:>5.0}s] cue {}", start.elapsed().as_secs_f64(), if cue_on { "ON" } else { "OFF" });
            }

            // Loop each deck back to the top well before EOS. Without this the 6-minute
            // file simply ends mid-soak and the rest of the arm measures silence — the
            // bus thread pauses the pipeline on EOS, so `playing` goes false and every
            // metric freezes while the wall clock keeps running. (Caught exactly that way
            // on the first attempt: position pinned at 360.0 for the last 9 minutes.)
            for d in &mut decks {
                if d.position().unwrap_or(0.0) > 300.0 {
                    let _ = d.seek(2.0);
                }
            }

            if last_report.elapsed() >= Duration::from_secs(30) {
                last_report = Instant::now();
                let pos: Vec<String> = decks.iter().map(|d| format!("{:.1}", d.position().unwrap_or(-1.0))).collect();
                println!(
                    "[{:>5.0}s] pos=[{}]  gaps={}  underruns={}",
                    start.elapsed().as_secs_f64(),
                    pos.join(", "),
                    captured_matching(GAP_WARNING).len(),
                    captured_matching(UNDERRUN_WARNING).len(),
                );
            }
        }
        for d in &mut decks {
            let _ = d.pause();
        }
        std::thread::sleep(Duration::from_millis(500));

        let gaps = captured_matching(GAP_WARNING);
        let underruns = captured_matching(UNDERRUN_WARNING);
        println!("\n=== RESULT arm={arm} ran {}s", start.elapsed().as_secs());
        println!("    sink-flow gaps : {}", gaps.len());
        for g in &gaps {
            println!("      {g}");
        }
        println!("    queue underruns: {}", underruns.len());
        for u in underruns.iter().take(10) {
            println!("      {u}");
        }
        // Deliberately NOT asserted: a clean run is the expected (and so far only)
        // outcome, and a failing assertion here would read as "the harness broke" rather
        // than "the fault reproduced". Record the counts in the design doc instead.
    }
}
