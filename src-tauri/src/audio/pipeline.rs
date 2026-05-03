/// Per-deck GStreamer audio pipeline.
///
/// Topology:
///   uridecodebin → audioconvert → audioresample → volume → autoaudiosink / pipewiresink
///
/// `pipewiresink` with an empty `target-object` routes to the system default.
/// When a specific device is set via `set_device()`, the pipeline is rebuilt
/// against that PipeWire node name (as reported by `pactl list sinks`).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use gstreamer::{self as gst, prelude::*};

fn make_el(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory)
        .build()
        .map_err(|e| format!("GStreamer element '{factory}' not found: {e}"))
}

/// Encode a filesystem path as a file:// URI suitable for uridecodebin.
fn file_to_uri(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 7);
    out.push_str("file://");
    for byte in path.bytes() {
        match byte {
            b' ' => out.push_str("%20"),
            b'#' => out.push_str("%23"),
            b'?' => out.push_str("%3F"),
            b => out.push(b as char),
        }
    }
    out
}

/// Build the audio output sink element.
///
/// Default case (empty device): uses `autoaudiosink`, which auto-selects the best
/// available sink (PipeWire, PulseAudio, ALSA) without needing PipeWire-specific
/// setup. This is more reliable for the "just play audio" case.
///
/// Explicit device: uses `pipewiresink target-object=<node-name>` to route to a
/// specific PipeWire sink. Falls back to `autoaudiosink` if the plugin is missing.
fn make_sink(device: &str) -> Result<gst::Element, String> {
    if device.is_empty() {
        return gst::ElementFactory::make("autoaudiosink")
            .build()
            .map_err(|e| format!("autoaudiosink not found: {e}"));
    }
    match gst::ElementFactory::make("pipewiresink").build() {
        Ok(sink) => {
            sink.set_property("target-object", device);
            Ok(sink)
        }
        Err(_) => {
            eprintln!(
                "[audio] pipewiresink not available (apt install gstreamer1.0-pipewire); \
                 device={device:?} ignored, falling back to autoaudiosink"
            );
            gst::ElementFactory::make("autoaudiosink")
                .build()
                .map_err(|e| format!("no audio sink available: {e}"))
        }
    }
}

struct PipelineInner {
    pipeline: gst::Pipeline,
    volume_el: gst::Element,
    /// Held so we can call set_flushing(true) to stop the bus monitor thread on drop/reload.
    bus: gst::Bus,
    /// Set to true by the bus monitor thread when an EOS message arrives.
    /// Read by play() to seek back to start instead of stalling at end-of-stream.
    at_eos: Arc<AtomicBool>,
}

pub struct DeckAudioPipeline {
    pub deck_id: String,
    inner: Option<PipelineInner>,
    /// Path most recently loaded; retained so `set_device` can rebuild the pipeline.
    pub(super) file_path: Option<String>,
    /// PipeWire sink name (`pactl list sinks` → Name field). Empty = system default.
    pub(super) device: String,
    gain: f32,
    vol: f32,
    /// Desired playback rate (last value requested by the frontend).
    rate: f64,
    /// Rate actually applied to the GStreamer pipeline. Starts at 1.0 after each load().
    /// Tracked separately so the no-change guard compares against pipeline reality, not
    /// the last requested value — otherwise loading a new file while rate ≠ 1.0 would
    /// silently leave the new pipeline running at the wrong speed.
    applied_rate: f64,
    /// Time of the last rate-change seek sent to GStreamer. Used to throttle INSTANT_RATE_CHANGE
    /// events; even at 60/s they can stall the pipeline.
    last_rate_seek: Option<std::time::Instant>,
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
            applied_rate: 1.0,
            last_rate_seek: None,
        }
    }

    pub fn load(&mut self, file_path: &str) -> Result<(), String> {
        self.file_path = Some(file_path.to_string());

        // Flush the old bus monitor thread before tearing down the pipeline.
        if let Some(ref inner) = self.inner {
            inner.bus.set_flushing(true);
            let _ = inner.pipeline.set_state(gst::State::Null);
        }
        self.inner = None;

        let pipeline = gst::Pipeline::new();
        let src      = make_el("uridecodebin")?;
        let convert  = make_el("audioconvert")?;
        let resample = make_el("audioresample")?;
        let volume   = make_el("volume")?;
        let sink     = make_sink(&self.device)?;

        src.set_property("uri", file_to_uri(file_path));
        volume.set_property("volume", (self.gain * self.vol) as f64);

        pipeline
            .add_many([&src, &convert, &resample, &volume, &sink])
            .map_err(|e| format!("[{}] pipeline add_many: {e}", self.deck_id))?;

        convert.link(&resample).map_err(|e| format!("audioconvert→audioresample: {e}"))?;
        resample.link(&volume).map_err(|e| format!("audioresample→volume: {e}"))?;
        volume.link(&sink).map_err(|e| format!("volume→sink: {e}"))?;

        // uridecodebin creates its src pad(s) only after probing the stream.
        let convert_weak = convert.downgrade();
        let deck_id = self.deck_id.clone();
        src.connect_pad_added(move |_, pad| {
            let Some(convert) = convert_weak.upgrade() else { return };
            let is_audio = pad
                .current_caps()
                .map(|c| {
                    c.structure(0)
                        .map(|s| s.name().starts_with("audio/"))
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if !is_audio { return; }
            let sink_pad = match convert.static_pad("sink") {
                Some(p) => p,
                None => return,
            };
            if sink_pad.is_linked() { return; }
            if let Err(e) = pad.link(&sink_pad) {
                eprintln!("[audio/{deck_id}] pad link error: {e}");
            }
        });

        // Grab bus before starting state changes so we don't miss early messages.
        let bus = pipeline.bus().ok_or_else(|| format!("[{}] no bus", self.deck_id))?;

        let at_eos = Arc::new(AtomicBool::new(false));
        let at_eos_thread = at_eos.clone();
        let bus_thread = bus.clone();
        let deck_id_log = self.deck_id.clone();

        std::thread::spawn(move || {
            for msg in bus_thread.iter_timed(None) {
                match msg.view() {
                    gst::MessageView::Eos(_) => {
                        at_eos_thread.store(true, Ordering::Relaxed);
                    }
                    gst::MessageView::Error(e) => {
                        eprintln!("[bus/{}] ERROR: {} (debug: {:?})", deck_id_log, e.error(), e.debug());
                    }
                    gst::MessageView::Warning(w) => {
                        eprintln!("[bus/{}] WARNING: {} (debug: {:?})", deck_id_log, w.error(), w.debug());
                    }
                    _ => {}
                }
            }
        });

        // Start preroll (async state change to PAUSED).
        pipeline
            .set_state(gst::State::Paused)
            .map_err(|e| format!("[{}] set_state(Paused) failed: {e}", self.deck_id))?;

        // Wait for preroll to complete before returning. This ensures play() is never
        // called on a pipeline that hasn't buffered data yet, which causes initial stutter.
        let (ret, _cur, _pending) = pipeline.state(Some(gst::ClockTime::from_seconds(5)));
        match ret {
            Err(_) => {
                return Err(format!("[{}] preroll failed", self.deck_id));
            }
            Ok(gst::StateChangeSuccess::Async) => {
                eprintln!("[audio/{}] preroll still pending after 5s timeout", self.deck_id);
            }
            _ => {}
        }

        self.inner = Some(PipelineInner { pipeline, volume_el: volume, bus, at_eos });
        self.applied_rate = 1.0;
        self.last_rate_seek = None;
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
            None => return Ok(()), // no pipeline loaded; device stored for next load
        };

        let position = self.position().unwrap_or(0.0);
        let was_playing = self
            .inner
            .as_ref()
            .map(|i| i.pipeline.current_state() == gst::State::Playing)
            .unwrap_or(false);

        self.load(&file_path)?;
        // load() now waits for preroll, so the seek below lands correctly without an extra wait.

        if position > 0.01 {
            let _ = self.seek(position);
        }
        if was_playing {
            self.play()?;
        }

        Ok(())
    }

    pub fn play(&self) -> Result<(), String> {
        let inner = self.inner.as_ref().ok_or_else(|| "no pipeline loaded".to_string())?;
        // If the bus monitor saw EOS, seek back to start so the track replays.
        if inner.at_eos.swap(false, Ordering::Relaxed) {
            let _ = inner.pipeline.seek_simple(
                gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                gst::ClockTime::ZERO,
            );
        }
        inner
            .pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn pause(&self) -> Result<(), String> {
        let inner = self.inner.as_ref().ok_or_else(|| "no pipeline loaded".to_string())?;
        inner
            .pipeline
            .set_state(gst::State::Paused)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn seek(&self, secs: f64) -> Result<(), String> {
        let inner = self.inner.as_ref().ok_or_else(|| "no pipeline loaded".to_string())?;
        let pos = gst::ClockTime::from_nseconds((secs * 1_000_000_000.0) as u64);
        inner
            .pipeline
            .seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT, pos)
            .map_err(|e| e.to_string())
    }

    pub fn set_rate(&mut self, rate: f64) -> Result<(), String> {
        self.rate = rate.clamp(0.0625, 4.0);

        let inner = match self.inner.as_ref() {
            Some(i) => i,
            None => return Ok(()), // stored; will be applied after the next load
        };

        // Guard: skip if GStreamer already has this rate.
        if (self.applied_rate - self.rate).abs() < 1e-9 {
            return Ok(());
        }

        // Throttle: cap at ~10 seeks/second. syncVideoElements fires every rAF frame;
        // even INSTANT_RATE_CHANGE at 60/s causes the pipeline to stall. The rAF loop
        // keeps calling set_rate with the latest desired value, so the final value will
        // always be applied once the 100ms window opens.
        let now = std::time::Instant::now();
        if let Some(last) = self.last_rate_seek {
            if now.duration_since(last) < std::time::Duration::from_millis(100) {
                return Ok(());
            }
        }

        self.applied_rate = self.rate;
        self.last_rate_seek = Some(now);

        eprintln!("[audio/{}] set_rate → {:.4}", self.deck_id, self.rate);

        // INSTANT_RATE_CHANGE (GStreamer ≥ 1.18): adjusts rate in-place without flushing,
        // so there are no audible clicks or position jumps during tempo/jog changes.
        let ok = inner
            .pipeline
            .seek(
                self.rate,
                gst::SeekFlags::INSTANT_RATE_CHANGE,
                gst::SeekType::None,
                gst::ClockTime::NONE,
                gst::SeekType::None,
                gst::ClockTime::NONE,
            )
            .is_ok();
        if !ok {
            eprintln!("[audio/{}] INSTANT_RATE_CHANGE failed, falling back to flush seek", self.deck_id);
            let pos = inner
                .pipeline
                .query_position::<gst::ClockTime>()
                .unwrap_or(gst::ClockTime::ZERO);
            inner
                .pipeline
                .seek(
                    self.rate,
                    gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                    gst::SeekType::Set,
                    pos,
                    gst::SeekType::None,
                    gst::ClockTime::NONE,
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Pre-fader trim (0–1). Effective audio = gain × volume.
    pub fn set_gain(&mut self, gain: f32) -> Result<(), String> {
        self.gain = gain.clamp(0.0, 1.0);
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

    /// Current playback position in seconds. None if the pipeline is not loaded.
    /// The frontend uses this as the authoritative clock; video elements seek to match.
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
