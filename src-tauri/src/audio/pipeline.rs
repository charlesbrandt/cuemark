/// Per-deck GStreamer audio pipeline.
///
/// Topology:
///   uridecodebin → audioconvert → audioresample → volume → autoaudiosink / pipewiresink
///
/// `pipewiresink` with an empty `target-object` routes to the system default.
/// When a specific device is set via `set_device()`, the pipeline is rebuilt
/// against that PipeWire node name (as reported by `pactl list sinks`).

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

use gstreamer::{self as gst, prelude::*};

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
            // RFC 3986 unreserved chars + path separators — safe unencoded in a URI path.
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'.' | b'_' | b'~'
            | b'/' | b':' | b'@'
            | b'!' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b'+' | b',' | b';' | b'=' => {
                out.push(byte as char);
            }
            // Everything else — spaces, non-ASCII UTF-8 bytes, #, ?, etc.
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
    /// Set to true by the bus monitor thread when an ERROR message arrives.
    /// The bus thread also attempts a flush-seek recovery. set_rate() checks this
    /// flag and resets applied_rate so the next rate event forces a fresh seek.
    at_error: Arc<AtomicBool>,
    /// True while a FLUSH seek is in progress; cleared by the bus thread on AsyncDone.
    seek_in_flight: Arc<AtomicBool>,
    /// Position (ns) and wall-clock instant recorded when AsyncDone last fired.
    /// query_position() returns the seek target for a brief window after AsyncDone
    /// because the pipeline clock hasn't advanced yet — MIDI events arrive faster
    /// than that window closes, so successive seeks all target the same timestamp.
    /// set_rate() uses this to estimate the true current position instead.
    last_async_done: Arc<Mutex<Option<(u64, std::time::Instant)>>>,
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
        let at_error = Arc::new(AtomicBool::new(false));
        let at_error_thread = at_error.clone();
        let seek_in_flight = Arc::new(AtomicBool::new(false));
        let seek_in_flight_thread = seek_in_flight.clone();
        let last_async_done: Arc<Mutex<Option<(u64, std::time::Instant)>>> = Arc::new(Mutex::new(None));
        let last_async_done_thread = last_async_done.clone();
        let bus_thread = bus.clone();
        let deck_id_log = self.deck_id.clone();

        std::thread::spawn(move || {
            for msg in bus_thread.iter_timed(None) {
                match msg.view() {
                    gst::MessageView::Eos(_) => {
                        eprintln!("[bus/{}] EOS", deck_id_log);
                        at_eos_thread.store(true, Ordering::Relaxed);
                    }
                    gst::MessageView::Error(e) => {
                        eprintln!("[bus/{}] ERROR: {} (debug: {:?})", deck_id_log, e.error(), e.debug());
                        at_error_thread.store(true, Ordering::Relaxed);
                        // Do NOT attempt a recovery seek here — seeking on a qtdemux error
                        // state triggers further errors and cascades into a crash.
                        // Recovery is handled at the call site (set_rate / play).
                    }
                    gst::MessageView::Warning(w) => {
                        eprintln!("[bus/{}] WARNING: {} (debug: {:?})", deck_id_log, w.error(), w.debug());
                    }
                    gst::MessageView::Info(i) => {
                        eprintln!("[bus/{}] INFO: {} (debug: {:?})", deck_id_log, i.error(), i.debug());
                    }
                    gst::MessageView::Buffering(b) => {
                        eprintln!("[bus/{}] buffering {}%", deck_id_log, b.percent());
                    }
                    gst::MessageView::StateChanged(s) => {
                        // Filter to pipeline-level only — per-element noise drowns the signal.
                        let src = msg.src().map(|e| e.name().to_string()).unwrap_or_default();
                        if src.starts_with("pipeline") {
                            eprintln!("[bus/{}] pipeline: {:?} → {:?} (pending {:?})",
                                deck_id_log, s.old(), s.current(), s.pending());
                        }
                    }
                    gst::MessageView::AsyncDone(_) => {
                        let pos_ns = msg.src()
                            .and_then(|e| e.downcast_ref::<gst::Pipeline>())
                            .and_then(|p| p.query_position::<gst::ClockTime>())
                            .map(|t| t.nseconds())
                            .unwrap_or(0);
                        // Record position + wall-clock instant so set_rate() can estimate
                        // the true current position rather than calling query_position(),
                        // which returns the seek target until the clock has advanced.
                        if let Ok(mut g) = last_async_done_thread.lock() {
                            *g = Some((pos_ns, std::time::Instant::now()));
                        }
                        seek_in_flight_thread.store(false, Ordering::Relaxed);
                        eprintln!("[bus/{}] async-done  pos={}ms", deck_id_log, pos_ns / 1_000_000);
                    }
                    gst::MessageView::Qos(q) => {
                        // QOS messages indicate dropped/late buffers — relevant if
                        // the rate-change seeks are causing audio samples to duplicate.
                        let (jitter, proportion, quality) = q.values();
                        eprintln!("[bus/{}] QOS  jitter={jitter}ns  proportion={proportion:.3}  quality={quality}",
                            deck_id_log);
                    }
                    gst::MessageView::Latency(_) => {
                        eprintln!("[bus/{}] latency recalculation requested", deck_id_log);
                    }
                    gst::MessageView::StreamStatus(ss) => {
                        eprintln!("[bus/{}] stream status: {:?}", deck_id_log, ss.type_());
                    }
                    _ => {}
                }
            }
            eprintln!("[bus/{}] monitor thread exiting", deck_id_log);
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
                // Stop the bus monitor thread and transition elements to NULL before
                // the local `pipeline` drops — GStreamer emits CRITICAL warnings if
                // elements are disposed while still in READY or PAUSED state.
                bus.set_flushing(true);
                let _ = pipeline.set_state(gst::State::Null);
                return Err(format!("[{}] preroll failed", self.deck_id));
            }
            Ok(gst::StateChangeSuccess::Async) => {
                eprintln!("[audio/{}] preroll still pending after 5s timeout", self.deck_id);
            }
            _ => {}
        }

        self.inner = Some(PipelineInner { pipeline, volume_el: volume, bus, at_eos, at_error, seek_in_flight, last_async_done });
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
        // The bus thread already attempted a recovery seek on error; clear the flag.
        inner.at_error.store(false, Ordering::Relaxed);
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

        // If the pipeline recovered from an error, invalidate applied_rate and clear
        // seek_in_flight so the next event forces a fresh seek regardless of the guards.
        if inner.at_error.swap(false, Ordering::Relaxed) {
            self.applied_rate = 0.0;
            self.last_rate_seek = None;
            inner.seek_in_flight.store(false, Ordering::Relaxed);
        }

        // Guard: skip if GStreamer already has this rate.
        if (self.applied_rate - self.rate).abs() < 1e-9 {
            return Ok(());
        }

        // Gate on AsyncDone: don't issue a new seek until the previous one completes.
        // The bus thread clears seek_in_flight when AsyncDone fires. This prevents
        // query_position() from returning the previous seek's target (position hasn't
        // advanced yet), which caused every seek to target the same timestamp and the
        // pipeline to loop audio from that point → two audible copies at a fixed offset.
        //
        // Safety fallback: if AsyncDone never fires (e.g. pipeline error stalled it),
        // allow a seek after 500ms so the fader doesn't become permanently unresponsive.
        let now = std::time::Instant::now();
        if inner.seek_in_flight.load(Ordering::Relaxed) {
            let stale = self.last_rate_seek
                .map_or(true, |last| now.duration_since(last) >= std::time::Duration::from_millis(500));
            if !stale {
                return Ok(());
            }
            eprintln!("[audio/{}] seek_in_flight timeout — forcing rate seek", self.deck_id);
        }

        // Minimum play time between seeks: each FLUSH seek pauses the pipeline and
        // flushes GStreamer's internal buffers, causing an audible dropout. Gating
        // only on AsyncDone (~90ms seek duration) leaves zero time in Playing state
        // between seeks. Enforce 200ms from the last seek so the pipeline plays ~110ms
        // of stable audio between dropouts.
        if self.last_rate_seek
            .map_or(false, |last| now.duration_since(last) < std::time::Duration::from_millis(200))
        {
            return Ok(());
        }

        // Capture the previous rate before updating — it's the rate the pipeline has
        // actually been playing at since AsyncDone, used to estimate current position.
        let prev_rate = self.applied_rate;
        self.applied_rate = self.rate;
        self.last_rate_seek = Some(now);
        inner.seek_in_flight.store(true, Ordering::Relaxed);

        eprintln!("[audio/{}] set_rate → {:.4}", self.deck_id, self.rate);

        // Use a flush seek at the current position to apply the new rate.
        // INSTANT_RATE_CHANGE would avoid the flush, but it causes qtdemux (gst-plugins-good)
        // to emit repeated GST_FLOW_ERROR (-5) messages for MP4 files, leading to an error
        // cascade that deadlocks the app. A flush seek produces a brief audio dropout
        // but is fully reliable.
        //
        // ACCURATE (not KEY_UNIT): KEY_UNIT snaps seeks to the nearest video keyframe
        // (typically 2s intervals for music videos). All rate-change seeks within a 2s window
        // land at the same keyframe, so the pipeline replays the same audio segment repeatedly
        // while the hardware buffer drains audio from further along → audible doubling.
        // ACCURATE decodes forward from the keyframe to the exact target, eliminating snap.
        //
        // Position is estimated from AsyncDone position + elapsed × prev_rate rather than
        // query_position(), which returns the seek target until the pipeline clock advances.
        let pos = {
            let guard = inner.last_async_done.lock().ok();
            guard
                .as_ref()
                .and_then(|g| g.as_ref())
                .map(|(pos_ns, done_at)| {
                    let elapsed_ns = now.saturating_duration_since(*done_at).as_nanos() as u64;
                    let advance_ns = (elapsed_ns as f64 * prev_rate) as u64;
                    gst::ClockTime::from_nseconds(pos_ns.saturating_add(advance_ns))
                })
                .unwrap_or_else(|| {
                    inner.pipeline.query_position::<gst::ClockTime>().unwrap_or(gst::ClockTime::ZERO)
                })
        };
        inner
            .pipeline
            .seek(
                self.rate,
                gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
                gst::SeekType::Set,
                pos,
                gst::SeekType::None,
                gst::ClockTime::NONE,
            )
            .map_err(|e| e.to_string())
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
