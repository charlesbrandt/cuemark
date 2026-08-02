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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

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
fn instrument_sink_flow(sink: &gst::Element, deck_id: &str, label: &str) {
    let Some(pad) = sink.static_pad("sink") else {
        log::warn!("[audio/{deck_id}] {label}: no sink pad to probe for flow diagnostics");
        return;
    };
    let deck_id = deck_id.to_string();
    let label = label.to_string();
    // None until the first buffer arrives; then the arrival time of the most recent one.
    let last_seen = Arc::new(Mutex::new(None::<Instant>));
    pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        let now = Instant::now();
        let mut seen = last_seen.lock().unwrap();
        match *seen {
            None => log::info!(
                "[audio/{deck_id}] {label}: first buffer reached the sink — audio is \
                 being delivered to the device"
            ),
            Some(prev) if now.duration_since(prev) > Duration::from_secs(1) => log::warn!(
                "[audio/{deck_id}] {label}: buffer flow resumed after a {:.1}s gap — the \
                 device received no audio for that span",
                now.duration_since(prev).as_secs_f64()
            ),
            Some(_) => {}
        }
        *seen = Some(now);
        gst::PadProbeReturn::Ok
    });
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
        let scratch_caps = gst::Caps::builder("audio/x-raw")
            .field("format", "F32LE")
            .field("layout", "interleaved")
            .field("channels", 2i32)
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

        // One (volume, sink) pair per main output device. Empty devices list = single default.
        let main_devs: Vec<String> = if self.devices.is_empty() {
            vec![String::new()]
        } else {
            self.devices.clone()
        };
        let mut volume_els: Vec<gst::Element> = Vec::with_capacity(main_devs.len());
        let mut main_sinks: Vec<gst::Element> = Vec::with_capacity(main_devs.len());
        for (i, dev) in main_devs.iter().enumerate() {
            let vol = make_el("volume")?;
            let snk = make_sink(dev, &format!("{}/{}", self.deck_id, i))?;
            // Only the primary sink (i=0) participates in preroll — it controls the
            // pipeline's READY→PAUSED state transition. Secondary sinks use async=false
            // so they don't block preroll; they join at PLAYING time using the primary's clock.
            if i > 0 {
                snk.set_property("async", false);
            }
            instrument_sink_flow(&snk, &self.deck_id, &format!("main sink {i}"));
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

        let caps_48k = gst::Caps::builder("audio/x-raw")
            .field("rate", 48_000i32)
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
        // Written by the bus thread's StateChanged handler below, read lock-free by the
        // underrun/overrun handlers on the queue's streaming thread — see
        // instrument_queue_flow() for why this isn't a current_state() query.
        let at_playing = Arc::new(AtomicBool::new(false));
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
                            at_playing_thread
                                .store(s.current() == gst::State::Playing, Ordering::Relaxed);
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
    pub fn set_cue_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.cue_enabled = enabled;
        if let Some(inner) = &self.inner {
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
        let pcm = self.pcm_buffer.clone().ok_or_else(|| {
            format!("[{}] no PCM buffer decoded — scratch unavailable for this file", self.deck_id)
        })?;
        let inner = self.inner.as_mut().ok_or_else(|| "no pipeline loaded".to_string())?;
        inner.at_eos.store(false, Ordering::Relaxed);

        if let Some(feeder) = &inner.scratch_feeder {
            feeder.rate_bits.store(rate.to_bits(), Ordering::Relaxed);
            *feeder.last_update.lock().unwrap() = Instant::now();
            return Ok(());
        }

        // query_position() is in the seek/output domain (see seek()'s doc comment) —
        // scale by self.rate (the tempo currently in effect) to recover true content
        // time before indexing into the PCM buffer, which is authored at real content
        // time (scratch bypasses `pitch` entirely — see the module doc comment on
        // this branch). Without this, starting a scratch gesture after playing at a
        // non-1.0 rate begins the feeder from the wrong point in the file, off by the
        // same tempo ratio as the seek-domain bug in seek() (see
        // docs/design/rate-position-drift.md).
        let start_secs = inner
            .pipeline
            .query_position::<gst::ClockTime>()
            .map(|t| (t.nseconds() as f64 / 1_000_000_000.0).max(0.0))
            .unwrap_or(0.0)
            * self.rate;
        let start_frame = start_secs * pcm.rate as f64;

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
            hold_ms,
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

        // Narrow output_queue back to the steady cap — the normal branch is
        // about to become active again and wants tight tempo-change latency,
        // not the widened scratch-startup allowance (see scratch()'s comment
        // on why this narrows here, at gesture end, rather than on a timer).
        inner.output_queue_el.set_property("max-size-time", OUTPUT_QUEUE_STEADY_CAP_NS);

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
    rate_bits: Arc<AtomicU64>,
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
    handle: Option<std::thread::JoinHandle<()>>,
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
    hold_ms: u64,
) -> ScratchFeeder {
    let rate_bits = Arc::new(AtomicU64::new(initial_rate.to_bits()));
    let stop_requested = Arc::new(AtomicBool::new(false));
    let cursor_frames_bits = Arc::new(AtomicU64::new(start_frame.to_bits()));
    let last_update = Arc::new(Mutex::new(Instant::now()));

    let rate_bits_t = rate_bits.clone();
    let stop_t = stop_requested.clone();
    let cursor_t = cursor_frames_bits.clone();
    let last_update_t = last_update.clone();

    let handle = std::thread::spawn(move || {
        let chunk_frames = ((pcm.rate as u64 * SCRATCH_CHUNK_MS) / 1000).max(1) as usize;
        let max_frame = pcm.frames().saturating_sub(1) as f64;
        let mut cursor = start_frame.clamp(0.0, max_frame);
        let mut last_sign = initial_rate.signum();
        let mut fade_pos: usize = 0; // frames into an in-progress fade-in/reversal ramp
        let mut hold_gain: f32 = 1.0; // ramps toward 0 while idle beyond hold_ms, else toward 1
        let mut next_wake = Instant::now();

        log::info!("[scratch/{deck_id}] feeder start frame={start_frame:.0} rate={initial_rate:.3} hold_ms={hold_ms}");

        loop {
            let stopping = stop_t.load(Ordering::Relaxed);
            let rate = f64::from_bits(rate_bits_t.load(Ordering::Relaxed));

            if !stopping {
                let sign = rate.signum();
                if sign != 0.0 && sign != last_sign {
                    fade_pos = 0;
                    last_sign = sign;
                }
            }

            // Checked once per chunk (15ms granularity is plenty for a hold decision) —
            // idle means no scratch() call has refreshed last_update within hold_ms.
            let idle = !stopping
                && last_update_t.lock().unwrap().elapsed().as_millis() as u64 > hold_ms;
            let effective_rate = if idle { 0.0 } else { rate };
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

                if !stopping {
                    cursor = (cursor + effective_rate).clamp(0.0, max_frame);
                }
            }

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
                next_wake = now;
            }
        }
    });

    ScratchFeeder { rate_bits, stop_requested, cursor_frames_bits, last_update, handle: Some(handle) }
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
            eprintln!("[{}] {}", record.level(), record.args());
        }
        fn flush(&self) {}
    }
    static TEST_LOGGER: TestLogger = TestLogger;
    fn init_test_logger() {
        let _ = log::set_logger(&TEST_LOGGER);
        log::set_max_level(log::LevelFilter::Debug);
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
}
