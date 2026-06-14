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

/// Decode audio from `file_path` and return one peak amplitude value per 1/30s chunk.
/// Runs synchronously; caller should run this off the main thread for long files.
pub fn compute_peaks(file_path: &str) -> Result<Vec<f32>, String> {
    const SAMPLE_RATE: i32 = 44_100;
    let chunk_samples = SAMPLE_RATE as usize / PEAKS_PER_SECOND; // 1470

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
                }
            }
            Err(_) => break, // EOS or error
        }
    }
    if chunk_pos > 0 {
        peaks.push(chunk_max);
    }

    let _ = pipeline.set_state(gst::State::Null);
    eprintln!("[analysis] peaks={} for {}", peaks.len(), file_path);
    Ok(peaks)
}
