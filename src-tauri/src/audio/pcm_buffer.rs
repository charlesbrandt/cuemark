/// Full-file PCM decode for scratch playback.
///
/// See docs/design/pcm-buffer-playback.md. Decodes an entire track to interleaved
/// stereo F32LE at 48kHz (matching `DeckAudioPipeline`'s `capsfilter(rate=48000)`, so
/// the scratch feed needs no resample step) and keeps the raw samples in memory for
/// the deck's lifetime. Reuses the same `autoplug-select` video-skip guard as
/// `analysis.rs`/`pipeline.rs` so AV1/video-in-container files never touch a VA-API
/// decoder.

use gstreamer::{self as gst, glib, prelude::*};
use gstreamer_app::AppSink;

use super::pipeline::file_to_uri;

/// Sample rate the scratch buffer is decoded at. Matches `DeckAudioPipeline`'s
/// `capsfilter(rate=48000)` so the scratch feeder needs no resample step.
pub const SCRATCH_SAMPLE_RATE: u32 = 48_000;
const SCRATCH_CHANNELS: u32 = 2;

/// Interleaved stereo F32 PCM samples for one track, decoded once at load time.
pub struct PcmBuffer {
    /// Interleaved L/R samples: `samples[2*i]` = left, `samples[2*i+1]` = right.
    pub samples: Vec<f32>,
    pub rate: u32,
}

impl PcmBuffer {
    pub fn frames(&self) -> usize {
        self.samples.len() / SCRATCH_CHANNELS as usize
    }
}

/// Decode `file_path` to interleaved stereo F32LE PCM at `SCRATCH_SAMPLE_RATE`.
/// Runs synchronously; caller should run this off the IPC thread for long files.
pub fn decode_stereo_48k(file_path: &str) -> Result<PcmBuffer, String> {
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

    // Same guard as DeckAudioPipeline/analysis.rs: skip video decoder factories so
    // vaav1dec is never instantiated and VA-API driver state is not corrupted.
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

    // Stereo (not mono — scratch audio should preserve the source's channel image,
    // unlike the mono-forced analysis.rs peak-extraction path) at the pipeline's
    // native 48kHz.
    let caps = gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("layout", "interleaved")
        .field("channels", SCRATCH_CHANNELS as i32)
        .field("rate", SCRATCH_SAMPLE_RATE as i32)
        .build();
    caps_filter.set_property("caps", &caps);

    let appsink = sink_el.downcast_ref::<AppSink>().unwrap().clone();
    appsink.set_sync(false);

    pipeline.add_many([&src, &convert, &resample, &caps_filter, &sink_el])
        .map_err(|e| format!("add_many: {e}"))?;
    gst::Element::link_many([&convert, &resample, &caps_filter, &sink_el])
        .map_err(|e| format!("link: {e}"))?;

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
        let _ = pipeline.set_state(gst::State::Null);
        return Err(format!("set_state(Playing): {e}"));
    }

    let mut samples: Vec<f32> = Vec::new();
    loop {
        match appsink.pull_sample() {
            Ok(sample) => {
                let Some(buf) = sample.buffer() else { continue };
                let Ok(map) = buf.map_readable() else { continue };
                for chunk in map.as_slice().chunks_exact(4) {
                    samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
                }
            }
            Err(_) => break, // EOS or error
        }
    }

    let _ = pipeline.set_state(gst::State::Null);
    log::info!(
        "[scratch] decoded {} frames ({:.1}s) stereo/{}Hz for {}",
        samples.len() / SCRATCH_CHANNELS as usize,
        samples.len() as f64 / SCRATCH_CHANNELS as f64 / SCRATCH_SAMPLE_RATE as f64,
        SCRATCH_SAMPLE_RATE,
        file_path
    );
    Ok(PcmBuffer { samples, rate: SCRATCH_SAMPLE_RATE })
}
