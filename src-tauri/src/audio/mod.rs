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
    let mut mgr = state.lock().unwrap();
    let main_devices = mgr.main_devices.clone();
    let cue_device = mgr.cue_device.clone();
    let pipeline = mgr
        .pipelines
        .entry(deck_id.clone())
        .or_insert_with(|| {
            let mut p = DeckAudioPipeline::new(&deck_id);
            p.devices = main_devices;
            p.cue_device = cue_device;
            let app_clone = app.clone();
            let did = deck_id.clone();
            p.set_eos_callback(move || {
                let _ = app_clone.emit("deck-eos", did.clone());
            });
            p
        });
    pipeline.set_app(app.clone());
    pipeline.load(&file_path)
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
    state.lock().unwrap().mixer.set_master_volume(volume)
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
#[tauri::command]
pub fn audio_analyze_file(file_path: String) -> Result<Vec<f32>, String> {
    analysis::compute_peaks(&file_path)
}
