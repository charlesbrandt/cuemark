/// Real-time FFT: the GStreamer `spectrum` element emits structured messages
/// on the pipeline bus. This module reads those messages and forwards them to
/// the frontend as Tauri events at ~30 fps.
///
/// Event name:  "audio-fft"
/// Payload:     { deckId, bass, mid, high, waveform: f32[] }
///
/// Step 1 / stub: types and function signatures only.

use gstreamer;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFftEvent {
    pub deck_id: String,
    pub bass: f32,
    pub mid: f32,
    pub high: f32,
    /// Normalized magnitude per FFT band (0–1). Length determined by spectrum interval/bands config.
    pub bands: Vec<f32>,
}

/// Start polling the GStreamer bus of `pipeline` for `spectrum` messages and
/// emitting `audio-fft` Tauri events. Called once per deck when its pipeline
/// reaches PLAYING state.
///
/// Step 6: implement bus polling loop on a background thread.
pub fn start_fft_relay(
    _deck_id: &str,
    _pipeline: &gstreamer::Pipeline,
    _app: &tauri::AppHandle,
) {
    // TODO step 6: poll GStreamer bus for spectrum messages and emit "audio-fft" events.
}
