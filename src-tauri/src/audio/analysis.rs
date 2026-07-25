/// Waveform peak extraction for the frontend waveform display.
///
/// Replaces the Web Audio API `decodeAudioData` path, which triggers WebKit's
/// internal GStreamer pipeline. That pipeline instantiates the VA-API AV1 video
/// decoder (`vaav1dec`) for files that contain video tracks, corrupting the VA-API
/// driver state and breaking subsequent `<video>` element decoding for the session.
///
/// This implementation uses the same `autoplug-select` guard as `DeckAudioPipeline`
/// to skip all video decoder factories, so only audio is decoded.

use gstreamer::{self as gst, glib, prelude::*};
use gstreamer_app::AppSink;
use serde::Serialize;

use super::pipeline::file_to_uri;

// ── Real-time FFT event (emitted by the spectrum element in DeckAudioPipeline) ──

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFftEvent {
    pub deck_id: String,
    pub bass: f32,
    pub mid: f32,
    pub high: f32,
    pub bands: Vec<f32>,
}

/// Peaks per second returned to the frontend. Must match `PEAKS_PER_SECOND` in waveform.ts.
pub const PEAKS_PER_SECOND: usize = 30;

/// Envelope hops per second for beat-grid onset detection. Must match `ENVELOPE_RATE`
/// in waveform.ts. 210 divides 44100 exactly (hop = 210 samples), so envelope index i
/// maps to time i/210 with no cumulative rounding drift — timing precision is the whole
/// point of this array (±2.4 ms per hop ≈ 0.5% of a beat at 128 BPM).
pub const ENVELOPE_RATE: usize = 210;

/// Result of `compute_analysis`: coarse peaks for the waveform display plus a
/// high-rate RMS envelope for beat-grid fitting in the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisData {
    /// Peak amplitude per 1/30 s chunk (waveform display).
    pub peaks: Vec<f32>,
    /// RMS amplitude per 1/210 s hop (onset detection for the beat grid).
    pub envelope: Vec<f32>,
}

/// Decode audio from `file_path` and return waveform peaks (30/s) plus an RMS
/// envelope (210/s) in a single decode pass.
/// Runs synchronously; caller should run this off the main thread for long files.
pub fn compute_analysis(file_path: &str) -> Result<AnalysisData, String> {
    const SAMPLE_RATE: i32 = 44_100;
    let chunk_samples = SAMPLE_RATE as usize / PEAKS_PER_SECOND; // 1470
    let hop_samples = SAMPLE_RATE as usize / ENVELOPE_RATE; // 210

    let pipeline = gst::Pipeline::new();

    let src = gst::ElementFactory::make("uridecodebin")
        .build().map_err(|e| format!("uridecodebin: {e}"))?;
    let convert = gst::ElementFactory::make("audioconvert")
        .build().map_err(|e| format!("audioconvert: {e}"))?;
    let resample = gst::ElementFactory::make("audioresample")
        .build().map_err(|e| format!("audioresample: {e}"))?;
    let caps_filter = gst::ElementFactory::make("capsfilter")
        .build().map_err(|e| format!("capsfilter: {e}"))?;
    let sink_el = gst::ElementFactory::make("appsink")
        .build().map_err(|e| format!("appsink: {e}"))?;

    // Same guard as DeckAudioPipeline: skip video decoder factories so vaav1dec
    // is never instantiated and VA-API driver state is not corrupted.
    src.connect("autoplug-select", false, |values| {
        let factory = values.get(3).and_then(|v| v.get::<gst::ElementFactory>().ok())?;
        let klass = factory.metadata("klass").unwrap_or_default();
        let is_video_decoder = klass.contains("Decoder") && klass.contains("Video");
        let result_int = if is_video_decoder { 2i32 } else { 0i32 };
        let enum_class = glib::Type::from_name("GstAutoplugSelectResult")
            .and_then(glib::EnumClass::with_type)?;
        enum_class.to_value(result_int)
    });

    src.set_property("uri", file_to_uri(file_path));

    // Force mono F32LE at a fixed rate so peak computation is simple.
    let caps = gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("layout", "interleaved")
        .field("channels", 1i32)
        .field("rate", SAMPLE_RATE)
        .build();
    caps_filter.set_property("caps", &caps);

    let appsink = sink_el.downcast_ref::<AppSink>().unwrap().clone();
    appsink.set_sync(false); // decode as fast as possible, don't sync to wall clock

    pipeline.add_many([&src, &convert, &resample, &caps_filter, &sink_el])
        .map_err(|e| format!("add_many: {e}"))?;
    gst::Element::link_many([&convert, &resample, &caps_filter, &sink_el])
        .map_err(|e| format!("link: {e}"))?;

    // uridecodebin creates audio pads dynamically; link the first audio pad to convert.
    let convert_weak = convert.downgrade();
    src.connect_pad_added(move |_, pad| {
        let Some(convert) = convert_weak.upgrade() else { return };
        let caps = pad.current_caps().unwrap_or_else(gst::Caps::new_any);
        if caps.structure(0).map_or(false, |s| s.name().starts_with("audio/")) {
            let sink_pad = convert.static_pad("sink").unwrap();
            if !sink_pad.is_linked() {
                let _ = pad.link(&sink_pad);
            }
        }
    });

    if let Err(e) = pipeline.set_state(gst::State::Playing) {
        return Err(format!("set_state(Playing): {e}"));
    }

    let mut peaks = Vec::new();
    let mut chunk_max = 0.0f32;
    let mut chunk_pos = 0usize;
    let mut envelope = Vec::new();
    let mut hop_sum_sq = 0.0f32;
    let mut hop_pos = 0usize;

    loop {
        match appsink.pull_sample() {
            Ok(sample) => {
                let Some(buf) = sample.buffer() else { continue };
                let Ok(map) = buf.map_readable() else { continue };
                for chunk in map.as_slice().chunks_exact(4) {
                    let s = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]).abs();
                    if s > chunk_max { chunk_max = s; }
                    chunk_pos += 1;
                    if chunk_pos >= chunk_samples {
                        peaks.push(chunk_max);
                        chunk_max = 0.0;
                        chunk_pos = 0;
                    }
                    hop_sum_sq += s * s;
                    hop_pos += 1;
                    if hop_pos >= hop_samples {
                        envelope.push((hop_sum_sq / hop_samples as f32).sqrt());
                        hop_sum_sq = 0.0;
                        hop_pos = 0;
                    }
                }
            }
            Err(_) => break, // EOS or error
        }
    }
    if chunk_pos > 0 {
        peaks.push(chunk_max);
    }
    if hop_pos > 0 {
        envelope.push((hop_sum_sq / hop_pos as f32).sqrt());
    }

    let _ = pipeline.set_state(gst::State::Null);
    log::info!("[analysis] peaks={} envelope={} for {}", peaks.len(), envelope.len(), file_path);
    Ok(AnalysisData { peaks, envelope })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end smoke test: synthesize a 10 s WAV with GStreamer, run
    /// compute_analysis on it, and check both output arrays have the expected
    /// per-second rates. Verifies the decode pipeline, the autoplug guard, and
    /// the peaks/envelope chunking stay in agreement with the declared constants.
    #[test]
    fn analysis_rates_match_constants() {
        gst::init().expect("gstreamer init");
        let wav_path = std::env::temp_dir().join("cuemark-analysis-test.wav");
        let wav_str = wav_path.to_str().unwrap();

        // 10 s of 440 Hz sine at 44.1 kHz mono.
        let launch = format!(
            "audiotestsrc num-buffers=431 samplesperbuffer=1024 wave=sine freq=440 \
             ! audio/x-raw,rate=44100,channels=1 ! wavenc ! filesink location={wav_str}"
        );
        let pipeline = gst::parse::launch(&launch).expect("parse_launch");
        pipeline.set_state(gst::State::Playing).expect("play");
        let bus = pipeline.bus().unwrap();
        bus.timed_pop_filtered(
            gst::ClockTime::from_seconds(30),
            &[gst::MessageType::Eos, gst::MessageType::Error],
        );
        pipeline.set_state(gst::State::Null).expect("null");

        let data = compute_analysis(wav_str).expect("compute_analysis");
        let duration_secs = 431.0 * 1024.0 / 44_100.0; // ≈ 10.0

        let expected_peaks = duration_secs * PEAKS_PER_SECOND as f64;
        let expected_env = duration_secs * ENVELOPE_RATE as f64;
        assert!(
            (data.peaks.len() as f64 - expected_peaks).abs() <= 2.0,
            "peaks len {} != expected ~{expected_peaks}", data.peaks.len()
        );
        assert!(
            (data.envelope.len() as f64 - expected_env).abs() <= 5.0,
            "envelope len {} != expected ~{expected_env}", data.envelope.len()
        );
        // A steady sine has RMS ≈ peak / √2; check the envelope is in a sane band.
        let mid = data.envelope[data.envelope.len() / 2];
        assert!(mid > 0.5 && mid < 0.8, "sine RMS out of range: {mid}");

        let _ = std::fs::remove_file(&wav_path);
    }
}

// ── Analysis cache (freeze-watchdog.md phase 2) ───────────────────────────────

/// Caches the last few `compute_analysis` results so session recovery's waveform
/// re-fetch (every deck re-runs `audio_analyze_file` on rehydration, since the JS-side
/// peaks/envelope arrays died with the old webview) returns instantly instead of
/// re-decoding the whole file for seconds per deck. Also speeds ordinary repeat loads
/// (same track loaded onto a different deck, or reloaded after being swapped out).
/// Capacity of 8 comfortably covers "every deck in a set" without unbounded growth.
const CACHE_CAPACITY: usize = 8;

struct AnalysisCacheInner {
    // Insertion order for FIFO eviction — small enough that a Vec scan beats the
    // bookkeeping of a real LRU for a cache this size.
    order: std::collections::VecDeque<std::path::PathBuf>,
    entries: std::collections::HashMap<std::path::PathBuf, AnalysisData>,
}

pub struct AnalysisCache {
    inner: std::sync::Mutex<AnalysisCacheInner>,
}

impl AnalysisCache {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(AnalysisCacheInner {
                order: std::collections::VecDeque::new(),
                entries: std::collections::HashMap::new(),
            }),
        }
    }

    /// Returns a cached result for `file_path` if present, otherwise runs
    /// `compute_analysis` and caches the result before returning it.
    pub fn get_or_compute(&self, file_path: &str) -> Result<AnalysisData, String> {
        let key = std::path::PathBuf::from(file_path);
        if let Some(hit) = self.inner.lock().unwrap().entries.get(&key) {
            return Ok(hit.clone());
        }
        let data = compute_analysis(file_path)?;
        let mut inner = self.inner.lock().unwrap();
        inner.order.push_back(key.clone());
        inner.entries.insert(key, data.clone());
        if inner.order.len() > CACHE_CAPACITY {
            if let Some(evict) = inner.order.pop_front() {
                inner.entries.remove(&evict);
            }
        }
        Ok(data)
    }
}
