pub mod analysis;
pub mod devices;
pub mod mixer;
pub mod pipeline;
pub mod record;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{Emitter, State};

use self::devices::AudioDevice;
use self::mixer::MasterMix;
use self::pipeline::DeckAudioPipeline;
use self::record::{RecordFormat, RecordingSink};

/// Central audio state, held behind a Mutex in Tauri's managed state.
pub struct AudioManager {
    pipelines: HashMap<String, DeckAudioPipeline>,
    /// PipeWire sink names for the main outputs (empty vec = single system-default output).
    /// Passed to new pipelines at load time and applied to existing ones on change.
    main_devices: Vec<String>,
    /// PipeWire sink name for the headphone cue output (empty = no cue output).
    cue_device: String,
    /// Master volume factor (0–1). Applied to all deck pipelines as a multiplier on top of
    /// gain×vol. Stored here so new pipelines pick it up at load time.
    master_volume: f32,
    mixer: MasterMix,
    record: RecordingSink,
}

impl AudioManager {
    pub fn new() -> Self {
        gstreamer::init().expect("GStreamer init failed");
        Self {
            pipelines: HashMap::new(),
            main_devices: Vec::new(),
            cue_device: String::new(),
            master_volume: 1.0,
            mixer: MasterMix::new(),
            record: RecordingSink::new(),
        }
    }

    fn pipeline_mut(&mut self, deck_id: &str) -> Result<&mut DeckAudioPipeline, String> {
        self.pipelines
            .get_mut(deck_id)
            .ok_or_else(|| format!("no audio pipeline for deck '{deck_id}'"))
    }
}

pub type AudioState = Mutex<AudioManager>;

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_audio_devices(_state: State<'_, AudioState>) -> Vec<AudioDevice> {
    devices::list_audio_devices()
}

#[tauri::command]
pub fn audio_load(app: tauri::AppHandle, state: State<'_, AudioState>, deck_id: String, file_path: String) -> Result<Option<f64>, String> {
    // Pull the pipeline out of the map before calling load() so the mutex is not held
    // during GStreamer preroll (which can block for up to 5 seconds). Without this,
    // every other audio command (audio_get_position, audio_play, …) waits on the mutex
    // for the full preroll duration, making the UI unresponsive on first track load.
    let mut pipeline = {
        let mut mgr = state.lock().unwrap();
        let main_devices = mgr.main_devices.clone();
        let cue_device = mgr.cue_device.clone();
        let master_volume = mgr.master_volume;
        mgr.pipelines.remove(&deck_id).unwrap_or_else(|| {
            let mut p = DeckAudioPipeline::new(&deck_id);
            p.devices = main_devices;
            p.cue_device = cue_device;
            p.master_volume = master_volume;
            let app_clone = app.clone();
            let did = deck_id.clone();
            p.set_eos_callback(move || {
                let _ = app_clone.emit("deck-eos", did.clone());
            });
            p
        })
        // mutex released here
    };

    pipeline.set_app(app.clone());
    let result = pipeline.load(&file_path); // preroll runs without holding the mutex

    // Re-insert the pipeline (even on error, to preserve the object for future loads).
    state.lock().unwrap().pipelines.insert(deck_id, pipeline);

    result
}

#[tauri::command]
pub fn audio_unload(state: State<'_, AudioState>, deck_id: String) -> Result<(), String> {
    let mut mgr = state.lock().unwrap();
    mgr.pipelines.remove(&deck_id);
    Ok(())
}

#[tauri::command]
pub fn audio_play(state: State<'_, AudioState>, deck_id: String) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.play()
}

#[tauri::command]
pub fn audio_pause(state: State<'_, AudioState>, deck_id: String) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.pause()
}

#[tauri::command]
pub fn audio_seek(state: State<'_, AudioState>, deck_id: String, secs: f64) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.seek(secs)
}

#[tauri::command]
pub fn audio_set_rate(state: State<'_, AudioState>, deck_id: String, rate: f64) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.set_rate(rate)
}

#[tauri::command]
pub fn audio_set_gain(state: State<'_, AudioState>, deck_id: String, gain: f32) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.set_gain(gain)
}

#[tauri::command]
pub fn audio_set_volume(state: State<'_, AudioState>, deck_id: String, volume: f32) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.set_volume(volume)
}

#[tauri::command]
pub fn audio_set_eq(
    state: State<'_, AudioState>,
    deck_id: String,
    low_db: f32,
    mid_db: f32,
    high_db: f32,
) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.set_eq(low_db, mid_db, high_db)
}

#[tauri::command]
pub fn audio_set_cue(state: State<'_, AudioState>, deck_id: String, enabled: bool) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.set_cue_enabled(enabled)
}

/// Returns the pipeline's current position in seconds, or null if unknown.
/// The frontend uses this as the authoritative clock for video sync.
#[tauri::command]
pub fn audio_get_position(state: State<'_, AudioState>, deck_id: String) -> Option<f64> {
    state.lock().unwrap().pipelines.get(&deck_id)?.position()
}

#[tauri::command]
pub fn audio_set_master_volume(state: State<'_, AudioState>, volume: f32) -> Result<(), String> {
    let mut mgr = state.lock().unwrap();
    let factor = volume.clamp(0.0, 1.0);
    mgr.master_volume = factor;
    for pipeline in mgr.pipelines.values_mut() {
        pipeline.set_master_volume_factor(factor);
    }
    Ok(())
}

#[tauri::command]
pub fn audio_set_main_devices(state: State<'_, AudioState>, device_ids: Vec<String>) -> Result<(), String> {
    let mut mgr = state.lock().unwrap();
    mgr.main_devices = device_ids.clone();
    // MasterMix uses the first device as its primary target (or empty = default).
    let primary = device_ids.first().map(|s| s.as_str()).unwrap_or("");
    mgr.mixer.set_main_device(primary)?;
    for pipeline in mgr.pipelines.values_mut() {
        if let Err(e) = pipeline.set_devices(&device_ids) {
            log::error!("[audio] set_devices failed for {}: {e}", pipeline.deck_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn audio_set_cue_device(state: State<'_, AudioState>, device_id: String) -> Result<(), String> {
    let mut mgr = state.lock().unwrap();
    mgr.cue_device = device_id.clone();
    mgr.mixer.set_cue_device(&device_id)?;
    for pipeline in mgr.pipelines.values_mut() {
        if let Err(e) = pipeline.set_cue_device(&device_id) {
            log::error!("[audio] set_cue_device failed for {}: {e}", pipeline.deck_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn audio_set_cue_gain(state: State<'_, AudioState>, gain: f32) -> Result<(), String> {
    let mut mgr = state.lock().unwrap();
    mgr.mixer.set_cue_gain(gain)?;
    for pipeline in mgr.pipelines.values_mut() {
        if let Err(e) = pipeline.set_cue_gain(gain) {
            log::error!("[audio] set_cue_gain failed for {}: {e}", pipeline.deck_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn audio_record_start(
    state: State<'_, AudioState>,
    output_path: String,
    format: RecordFormat,
) -> Result<(), String> {
    state
        .lock()
        .unwrap()
        .record
        .start(output_path.into(), format)
}

#[tauri::command]
pub fn audio_record_stop(state: State<'_, AudioState>) -> Result<(), String> {
    state.lock().unwrap().record.stop()
}

/// Compute waveform peaks for a file entirely in Rust, bypassing WebKit's
/// `decodeAudioData` path which triggers vaav1dec on video+audio containers
/// and corrupts VA-API driver state.
///
/// Async so the Tauri IPC thread is not blocked during the full-file GStreamer decode.
/// `spawn_blocking` runs compute_peaks on a dedicated OS thread so it doesn't starve
/// the async executor.
#[tauri::command]
pub async fn audio_analyze_file(file_path: String) -> Result<Vec<f32>, String> {
    tauri::async_runtime::spawn_blocking(move || analysis::compute_peaks(&file_path))
        .await
        .map_err(|e| e.to_string())?
}
