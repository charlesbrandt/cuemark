/// Per-deck GStreamer audio pipeline.
///
/// Topology:
///   uridecodebin → queue(max-buffers=2) → audioconvert → audioresample
///     → capsfilter(48kHz) → pitch → [spectrum] → output_queue → volume → pipewiresink
///
/// `spectrum` (gst-plugins-good) is inserted inline after `pitch` when available.
/// It is a passthrough transform — it adds no latency. The bus thread reads its messages
/// and emits "audio-fft" Tauri events at ~30 fps for audio-reactive shader uniforms.

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
fn file_to_uri(path: &str) -> String {
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
fn make_sink(device: &str, deck_id: &str) -> Result<gst::Element, String> {
    const BUFFER_TIME_US: i64 = 50_000;
    const LATENCY_TIME_US: i64 = 10_000;

    if let Ok(sink) = gst::ElementFactory::make("pipewiresink").build() {
        if !device.is_empty() {
            sink.set_property("target-object", device);
        }
        let stream_props = gst::Structure::builder("props")
            .field("node.latency", "1024/48000")
            .build();
        sink.set_property("stream-properties", &stream_props);
        eprintln!(
            "[audio/{}] sink: pipewiresink target={:?} node.latency=1024/48000 (~21ms)",
            deck_id, device
        );
        return Ok(sink);
    }

    eprintln!(
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
        eprintln!(
            "[audio/{}] sink: {} buffer-time={}us latency-time={}us",
            deck_id_owned, factory, bt, lt
        );
        None
    });
    Ok(sink)
}

struct PipelineInner {
    pipeline: gst::Pipeline,
    volume_el: gst::Element,
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
    pub(super) device: String,
    gain: f32,
    vol: f32,
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
            device: String::new(),
            gain: 1.0,
            vol: 1.0,
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

    pub fn load(&mut self, file_path: &str) -> Result<(), String> {
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
            eprintln!(
                "[audio/{}] spectrum element not available — audio-fft events disabled. \
                 Install gstreamer1.0-plugins-good.",
                self.deck_id
            );
        } else {
            eprintln!("[audio/{}] spectrum element ready (32 bands, ~30 fps)", self.deck_id);
        }
        // output_queue buffers pitch's variable-sized output chunks (soundtouch produces
        // non-uniform sizes at non-1.0 tempos). Without this, the PipeWire pull callback
        // can starve when soundtouch hasn't yet produced a full 1024-sample quantum.
        let output_queue = make_el("queue")?;
        let volume       = make_el("volume")?;
        let sink         = make_sink(&self.device, &self.deck_id)?;

        let caps_48k = gst::Caps::builder("audio/x-raw")
            .field("rate", 48_000i32)
            .build();
        rate_caps.set_property("caps", &caps_48k);

        src.set_property("uri", file_to_uri(file_path));
        volume.set_property("volume", (self.gain * self.vol) as f64);
        pitch.set_property("tempo", self.rate as f32);
        queue.set_property("max-size-buffers", 2u32);
        queue.set_property("max-size-bytes", 0u32);
        queue.set_property("max-size-time", 0u64);
        // Time-based output queue: hold up to 200ms worth of post-pitch audio.
        output_queue.set_property("max-size-buffers", 0u32);
        output_queue.set_property("max-size-bytes", 0u32);
        output_queue.set_property("max-size-time", 500_000_000u64); // 500ms in nanoseconds

        pipeline
            .add_many([&src, &queue, &convert, &resample, &rate_caps, &pitch, &output_queue, &volume, &sink])
            .map_err(|e| format!("[{}] pipeline add_many: {e}", self.deck_id))?;
        if let Some(ref s) = spectrum_opt {
            pipeline.add(s).map_err(|e| format!("[{}] pipeline add spectrum: {e}", self.deck_id))?;
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
        output_queue.link(&volume).map_err(|e| format!("output_queue→volume: {e}"))?;
        volume.link(&sink).map_err(|e| format!("volume→sink: {e}"))?;

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
                eprintln!("[audio/{deck_id}] pad link error: {e}");
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
                        eprintln!("[bus/{}] EOS", deck_id_log);
                        at_eos_thread.store(true, Ordering::Relaxed);
                        if let Some(cb) = &eos_cb { cb(); }
                    }
                    gst::MessageView::Error(e) => {
                        eprintln!("[bus/{}] ERROR: {} (debug: {:?})", deck_id_log, e.error(), e.debug());
                        at_error_thread.store(true, Ordering::Relaxed);
                    }
                    gst::MessageView::Warning(w) => {
                        eprintln!("[bus/{}] WARNING: {} (debug: {:?})", deck_id_log, w.error(), w.debug());
                    }
                    gst::MessageView::AsyncDone(_) => {
                        let pos_ms = msg.src()
                            .and_then(|e| e.downcast_ref::<gst::Pipeline>())
                            .and_then(|p| p.query_position::<gst::ClockTime>())
                            .map(|t| t.mseconds())
                            .unwrap_or(0);
                        eprintln!("[bus/{}] async-done  pos={}ms", deck_id_log, pos_ms);
                    }
                    gst::MessageView::StateChanged(s) => {
                        let src = msg.src().map(|e| e.name().to_string()).unwrap_or_default();
                        if src.starts_with("pipeline") {
                            eprintln!("[bus/{}] pipeline: {:?} → {:?} (pending {:?})",
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
                            eprintln!("[bus/{}] spectrum: no magnitude field; structure={}", deck_id_log, structure);
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
                            eprintln!(
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
            eprintln!("[bus/{}] monitor thread exiting", deck_id_log);
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
                eprintln!("[audio/{}] preroll still pending after 5s timeout", self.deck_id);
            }
            _ => {}
        }

        let duration = pipeline
            .query_duration::<gst::ClockTime>()
            .map(|d| d.nseconds() as f64 / 1_000_000_000.0);
        if let Some(dur) = duration {
            eprintln!("[audio/{}] duration={:.3}s", self.deck_id, dur);
        }

        self.inner = Some(PipelineInner { pipeline, volume_el: volume, pitch_el: pitch, bus, at_eos, at_error });
        Ok(())
    }

    /// Switch output to a different PipeWire sink.
    ///
    /// PipeWire's `pipewiresink` does not support runtime target changes, so the
    /// pipeline must be torn down and rebuilt. Playback position and play/pause
    /// state are restored after the rebuild.
    pub fn set_device(&mut self, device: &str) -> Result<(), String> {
        self.device = device.to_string();
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

    fn apply_volume(&self) {
        if let Some(inner) = &self.inner {
            inner
                .volume_el
                .set_property("volume", (self.gain * self.vol) as f64);
        }
    }

    /// EQ bands in dB. No-op until equalizer-3bands element is added.
    pub fn set_eq(&self, _low_db: f32, _mid_db: f32, _high_db: f32) -> Result<(), String> {
        Ok(())
    }

    /// Gate cue branch. No-op until cue tee branch is added.
    pub fn set_cue_enabled(&self, _enabled: bool) -> Result<(), String> {
        Ok(())
    }

    /// Current playback position in seconds. None if no pipeline is loaded.
    pub fn position(&self) -> Option<f64> {
        self.inner
            .as_ref()?
            .pipeline
            .query_position::<gst::ClockTime>()
            .map(|t| t.nseconds() as f64 / 1_000_000_000.0)
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
