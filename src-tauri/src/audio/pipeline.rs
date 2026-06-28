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

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

type EosCallback = Arc<dyn Fn() + Send + Sync>;

use gstreamer::{self as gst, glib, prelude::*};
use tauri::Emitter;
use super::analysis;

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
        }
    }

    pub fn set_eos_callback(&mut self, f: impl Fn() + Send + Sync + 'static) {
        self.eos_callback = Some(Arc::new(f));
    }

    pub fn set_app(&mut self, app: tauri::AppHandle) {
        self.app = Some(app);
    }

    pub fn load(&mut self, file_path: &str) -> Result<Option<f64>, String> {
        self.file_path = Some(file_path.to_string());

        if let Some(ref inner) = self.inner {
            inner.bus.set_flushing(true);
            let _ = inner.pipeline.set_state(gst::State::Null);
        }
        self.inner = None;

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
        output_queue.set_property("max-size-time", 100_000_000u64); // 100ms in nanoseconds

        cue_valve.set_property("drop", !self.cue_enabled);
        cue_volume.set_property("volume", (self.gain * self.cue_gain) as f64);
        cue_queue.set_property("max-size-buffers", 2u32);
        cue_queue.set_property("max-size-bytes", 0u32);
        cue_queue.set_property("max-size-time", 0u64);

        pipeline
            .add_many([&src, &queue, &convert, &resample, &rate_caps, &pitch, &output_queue,
                       &tee, &cue_valve, &cue_volume, &cue_queue, &cue_sink])
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
        // pitch → [spectrum →] output_queue
        if let Some(ref s) = spectrum_opt {
            pitch.link(s).map_err(|e| format!("pitch→spectrum: {e}"))?;
            s.link(&output_queue).map_err(|e| format!("spectrum→output_queue: {e}"))?;
        } else {
            pitch.link(&output_queue).map_err(|e| format!("pitch→output_queue: {e}"))?;
        }
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
        self.playing = false;
        let inner = self.inner.as_ref().ok_or_else(|| "no pipeline loaded".to_string())?;
        inner
            .pipeline
            .set_state(gst::State::Paused)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn seek(&self, secs: f64) -> Result<(), String> {
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

    /// Current playback position in seconds. None if no pipeline is loaded.
    pub fn position(&self) -> Option<f64> {
        // A negative position is never meaningful to callers (the waveform's playhead
        // math divides by duration and draws off-canvas on a negative result) — clamp
        // defensively even though sampled query_position output (2000+ samples across
        // play/pause/seek/rate-change) never showed one in practice.
        self.inner
            .as_ref()?
            .pipeline
            .query_position::<gst::ClockTime>()
            .map(|t| (t.nseconds() as f64 / 1_000_000_000.0).max(0.0))
    }
}

impl Drop for DeckAudioPipeline {
    fn drop(&mut self) {
        if let Some(ref inner) = self.inner {
            inner.bus.set_flushing(true);
            let _ = inner.pipeline.set_state(gst::State::Null);
        }
    }
}
