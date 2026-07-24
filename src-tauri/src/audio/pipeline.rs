/// Per-deck GStreamer audio pipeline.
///
/// Topology:
///   uridecodebin → queue(max-buffers=2) → audioconvert → audioresample
///     → capsfilter(48kHz) → pitch → [spectrum] → output_queue → tee
///         ├─ volume₀ → sink₀  ┐
///         ├─ volume₁ → sink₁  ┤  one branch per main output device (≥1; empty → system default)
///         └─ cue_valve → cue_volume → cue_queue → pipewiresink(cue) | fakesink
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

fn make_el(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory)
        .build()
        .map_err(|e| format!("GStreamer element '{factory}' not found: {e}"))
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

/// Build the audio output sink element.
///
/// Prefers `pipewiresink` (direct PipeWire stream) over `autoaudiosink`.
/// On a PipeWire+pipewire-pulse system, `autoaudiosink` picks `pulsesink` and routes
/// audio through extra layers with additional buffering.
/// Direct `pipewiresink` removes that hop and keeps latency predictable.
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
fn compute_cue_remap(target: &str, full_layout: &str) -> Option<CueRemap> {
    if target == "FL,FR" || full_layout.is_empty() {
        return None; // default front pair — no remap needed
    }

    let all_channels: Vec<&str> = full_layout.split(',').map(str::trim).collect();
    let n = all_channels.len();
    if n <= 2 {
        return None;
    }

    let target_chs: Vec<&str> = target.split(',').map(str::trim).collect();

    // Compute GStreamer channel-mask covering all channels in the full layout.
    let mut mask: u64 = 0;
    for &ch in &all_channels {
        let bit = pw_channel_to_gst_bit(ch)?;
        mask |= 1u64 << bit;
    }

    // For each target channel, find its buffer index within the full layout.
    // Index = number of set bits in mask that are strictly below this channel's bit.
    let target_indices: Vec<usize> = target_chs.iter()
        .map(|&ch| {
            let bit = pw_channel_to_gst_bit(ch)? as u64;
            if mask & (1 << bit) == 0 { return None; }
            Some((0..bit).filter(|&b| mask & (1 << b) != 0).count())
        })
        .collect::<Option<Vec<_>>>()?;

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
    Some(CueRemap { out_channels: n as i32, channel_mask: mask, matrix_rows })
}

fn make_sink(device: &str, deck_id: &str) -> Result<gst::Element, String> {
    // Device string may encode a stereo-pair target: "node-name@CH1,CH2".
    // Strip the @suffix here — the actual channel remapping is done via GStreamer caps
    // inserted before this sink by the caller (pipewiresink uses caps channel positions
    // for PipeWire port routing, not stream-property metadata).
    let node_name = match device.find('@') {
        Some(at) => &device[..at],
        None => device,
    };

    const BUFFER_TIME_US: i64 = 50_000;
    const LATENCY_TIME_US: i64 = 10_000;

    if let Ok(sink) = gst::ElementFactory::make("pipewiresink").build() {
        if !node_name.is_empty() {
            sink.set_property("target-object", node_name);
        }
        let stream_props = gst::Structure::builder("props")
            .field("node.latency", "1024/48000")
            .build();
        sink.set_property("stream-properties", &stream_props);
        log::info!(
            "[audio/{}] sink: pipewiresink target={:?} node.latency=1024/48000 (~21ms)",
            deck_id, node_name
        );
        return Ok(sink);
    }

    log::warn!(
        "[audio/{}] pipewiresink unavailable (apt install gstreamer1.0-pipewire); \
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
        child.set_property("buffer-time", BUFFER_TIME_US);
        child.set_property("latency-time", LATENCY_TIME_US);
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
        // Use a real sink only when a device is configured; fakesink otherwise so that
        // the pipeline loads cleanly even when no headphone device is selected.
        let cue_sink = if self.cue_device.is_empty() {
            log::warn!("[audio/{}-cue] no device set — cue output routed to fakesink", self.deck_id);
            let fs = make_el("fakesink")?;
            fs.set_property("sync", false);
            fs
        } else {
            make_sink(&self.cue_device, &format!("{}-cue", self.deck_id))?
        };
        // The cue branch is a monitoring output. async=false means it never participates in
        // pipeline preroll, so the valve dropping all buffers (cue off) doesn't block the
        // pipeline from completing PAUSED — only the main sink controls preroll timing.
        cue_sink.set_property("async", false);

        // Optional channel remapping for multi-channel sinks (e.g. DJControl Starlight Rear).
        //
        // WirePlumber (PipeWire session manager) always routes stereo streams to the first pair
        // of a multi-channel sink regardless of channel-position labels in the GStreamer caps.
        // The fix: output an N-channel stream (matching the sink's full channel count) with audio
        // only in the target channels and silence elsewhere. PipeWire does a 1:1 port connection
        // for same-count streams, so audio ends up exactly in the right physical output.
        //
        // Device ID format: `node@target!full_layout` e.g. `alsa_out...@RL,RR!FL,FR,RL,RR`
        let cue_channel_remap: Option<(gst::Element, gst::Element)> = {
            let remap = self.cue_device.find('@').and_then(|at| {
                let after = &self.cue_device[at + 1..];
                let bang = after.find('!')?;
                let target = &after[..bang];
                let full   = &after[bang + 1..];
                compute_cue_remap(target, full)
            });

            if let Some(r) = remap {
                let ch_conv = make_el("audioconvert")?;

                // N×2 mix-matrix: routes the two input (stereo) channels into the correct
                // output channel slots; all other output channels stay at 0 (silence).
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
            } else {
                None
            }
        };

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
        for vol in &volume_els {
            vol.set_property("volume", (self.gain * self.vol) as f64);
        }
        pitch.set_property("tempo", self.rate as f32);
        queue.set_property("max-size-buffers", 2u32);
        queue.set_property("max-size-bytes", 0u32);
        queue.set_property("max-size-time", 0u64);
        // Time-based output queue: absorb soundtouch's variable-sized output chunks
        // (~82ms WSOLA window) while keeping tempo-change latency audibly tight.
        // 100ms gives ~5× the PipeWire quantum (21ms) of headroom; 500ms caused
        // up to 500ms of old-rate audio to drain before the new tempo was audible.
        output_queue.set_property("max-size-buffers", 0u32);
        output_queue.set_property("max-size-bytes", 0u32);
        output_queue.set_property("max-size-time", OUTPUT_QUEUE_STEADY_CAP_NS);

        cue_valve.set_property("drop", !self.cue_enabled);
        cue_volume.set_property("volume", (self.gain * self.cue_gain) as f64);
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
        let bus_thread = bus.clone();
        let deck_id_log = self.deck_id.clone();
        let eos_cb = self.eos_callback.clone();
        let app_handle = self.app.clone();

        std::thread::spawn(move || {
            for msg in bus_thread.iter_timed(None) {
                match msg.view() {
                    gst::MessageView::Eos(_) => {
                        log::info!("[bus/{}] EOS", deck_id_log);
                        at_eos_thread.store(true, Ordering::Relaxed);
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

        let position = self.position().unwrap_or(0.0);
        let was_playing = self
            .inner
            .as_ref()
            .map(|i| i.pipeline.current_state() == gst::State::Playing)
            .unwrap_or(false);

        self.load(&file_path)?;

        if position > 0.01 {
            let _ = self.seek(position);
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

        let position = self.position().unwrap_or(0.0);
        let was_playing = self
            .inner
            .as_ref()
            .map(|i| i.pipeline.current_state() == gst::State::Playing)
            .unwrap_or(false);

        self.load(&file_path)?;

        if position > 0.01 {
            let _ = self.seek(position);
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

    pub fn seek(&mut self, secs: f64) -> Result<(), String> {
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

        let start_secs = inner
            .pipeline
            .query_position::<gst::ClockTime>()
            .map(|t| (t.nseconds() as f64 / 1_000_000_000.0).max(0.0))
            .unwrap_or(0.0);
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
        let t_seek2 = Instant::now();
        let _ = inner.pipeline.seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE, target);
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
