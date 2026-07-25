pub mod analysis;
pub mod devices;
pub mod mixer;
pub mod pcm_buffer;
pub mod pipeline;
pub mod record;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{Emitter, State};

use crate::media_cache::MediaCache;
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

    /// Live status of every loaded pipeline — the ground truth for session recovery
    /// (docs/design/freeze-watchdog.md phase 2). A webview freeze/reload loses all JS
    /// state, but these pipelines are a separate OS process's objects and never stop;
    /// session_store.rs's `session_restore()` blends this on top of the (possibly ~1s
    /// stale) JSON snapshot the frontend last pushed.
    pub fn audio_status(&self) -> Vec<DeckAudioStatus> {
        self.pipelines
            .values()
            .map(|p| DeckAudioStatus {
                deck_id: p.deck_id.clone(),
                file_path: p.file_path.clone(),
                position_secs: p.position(),
                playing: p.is_playing(),
                rate: p.rate(),
            })
            .collect()
    }
}

/// Live snapshot of one deck's audio pipeline. See `AudioManager::audio_status`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckAudioStatus {
    pub deck_id: String,
    pub file_path: Option<String>,
    pub position_secs: Option<f64>,
    pub playing: bool,
    pub rate: f64,
}

pub type AudioState = Mutex<AudioManager>;

/// Runs `f` against one deck's pipeline without holding `state`'s mutex for the
/// duration of `f` itself — only for the HashMap remove/insert around it. Same pattern
/// as `audio_load`'s preroll fix below, generalized: any deck command whose pipeline
/// call can block for a while (GStreamer preroll, the scratch-teardown resync seek in
/// `stop_scratch_feeder`) must not do so while every other deck's audio IPC (position
/// polls, rate/gain syncs) is queued up behind the same global lock. A concurrent call
/// for *this same* deck_id while it's detached fails fast with "no audio pipeline for
/// deck" (already a handled, `.catch()`'d error path everywhere on the frontend) rather
/// than racing on the pipeline's internal GStreamer state — see
/// docs/design/pcm-buffer-playback.md and project memory project_pcm_scratch_status.md
/// for the live-hardware stall this fixes (vinyl-mode jog decks became unresponsive).
fn with_pipeline_detached<T>(
    state: &Mutex<AudioManager>,
    deck_id: &str,
    f: impl FnOnce(&mut DeckAudioPipeline) -> T,
) -> Result<T, String> {
    // Logged with millisecond precision (see lib.rs's custom log formatter) so a stall
    // report can be correlated against the last MIDI tick's own timestamp — narrows
    // down "JS-side delay before the IPC call was even issued" vs. "Rust-side work
    // itself took a long time" without guessing.
    log::info!("[audio/{deck_id}] detached-pipeline IPC received");
    let mut pipeline = {
        let mut mgr = state.lock().unwrap();
        mgr.pipelines
            .remove(deck_id)
            .ok_or_else(|| format!("no audio pipeline for deck '{deck_id}'"))?
        // mutex released here
    };
    let result = f(&mut pipeline);
    state.lock().unwrap().pipelines.insert(deck_id.to_string(), pipeline);
    Ok(result)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_audio_devices(_state: State<'_, AudioState>) -> Vec<AudioDevice> {
    devices::list_audio_devices()
}

#[tauri::command]
pub fn audio_load(app: tauri::AppHandle, state: State<'_, AudioState>, cache: State<'_, Arc<MediaCache>>, deck_id: String, file_path: String) -> Result<Option<f64>, String> {
    // Resolve to a local disk copy before touching GStreamer at all — see media_cache.rs.
    // The library here is served over SMB/CIFS; scratch leaves the normal playback
    // branch idle for a whole gesture, and resuming it against the network share after
    // that idle period was measured blocking for ~10s on a live repro (SMB
    // re-negotiation). PCM decode and uridecodebin preroll below both read this same
    // local path, so the network is touched at most once per track, not repeatedly.
    // Caching is an optimization, not a requirement: fall back to the original path on
    // any failure (permissions, disk full, source not stat-able yet) rather than
    // failing the load outright.
    let load_path = cache.ensure_cached(&file_path).unwrap_or_else(|e| {
        log::warn!("[audio/{deck_id}] media cache miss, loading directly from source: {e}");
        file_path.clone()
    });

    // Pull the pipeline out of the map before calling load() so the mutex is not held
    // during GStreamer preroll (which can block for up to 5 seconds). Without this,
    // every other audio command (audio_get_position, audio_play, …) waits on the mutex
    // for the full preroll duration, making the UI unresponsive on first track load.
    let mut pipeline = {
        let mut mgr = state.lock().unwrap();
        // Temporary assertion (freeze-watchdog.md phases 2-3, "Adoption bugs" risk):
        // session recovery must NEVER call audio_load on a deck whose pipeline is
        // already loaded+playing — that's the one way rehydration could audibly
        // glitch a track that survived the freeze untouched. Any real caller hitting
        // this is a bug in the adoption-skip logic (App.svelte's pendingAdoption),
        // not an expected state; log loudly instead of silently reloading.
        if let Some(existing) = mgr.pipelines.get(&deck_id) {
            if existing.is_playing() {
                log::error!(
                    "[audio/{deck_id}] audio_load called while pipeline is already playing \
                     (pos={:?}) — this will audibly glitch; see freeze-watchdog.md \"Adoption bugs\" risk",
                    existing.position()
                );
            }
        }
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
    let result = pipeline.load(&load_path); // preroll runs without holding the mutex

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
    // Detached: pause() may run stop_scratch_feeder()'s ~130-400ms teardown+resync
    // (drain sleep + two flush seeks) if a scratch was active — see
    // with_pipeline_detached's doc comment above.
    with_pipeline_detached(&state, &deck_id, |p| p.pause())?
}

#[tauri::command]
pub fn audio_seek(state: State<'_, AudioState>, deck_id: String, secs: f64) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.seek(secs)
}

#[tauri::command]
pub fn audio_set_rate(state: State<'_, AudioState>, deck_id: String, rate: f64) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.set_rate(rate)
}

/// Variable-rate scratch playback while paused (PCM-buffer feeder branch, negative =
/// reverse). `hold_ms` controls how long the feeder keeps free-running at the last
/// `rate` after ticks stop arriving before decaying to silence/hold — large for
/// shuttle-style scratch (effectively never decays within a gesture), small for
/// vinyl-style direct manipulation (decays almost immediately, like a stationary
/// hand on a real record). See `DeckAudioPipeline::scratch` and
/// docs/design/pcm-buffer-playback.md.
#[tauri::command]
pub fn audio_scratch(state: State<'_, AudioState>, deck_id: String, rate: f64, hold_ms: u64) -> Result<(), String> {
    state.lock().unwrap().pipeline_mut(&deck_id)?.scratch(rate, hold_ms)
}

#[tauri::command]
pub fn audio_stop_scratch(state: State<'_, AudioState>, deck_id: String) -> Result<(), String> {
    // Detached — same reason as audio_pause above.
    with_pipeline_detached(&state, &deck_id, |p| p.stop_scratch())?
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

/// Compute waveform peaks (30/s) and beat-grid RMS envelope (210/s) for a file
/// entirely in Rust, bypassing WebKit's `decodeAudioData` path which triggers
/// vaav1dec on video+audio containers and corrupts VA-API driver state.
///
/// Async so the Tauri IPC thread is not blocked during the full-file GStreamer decode.
/// `spawn_blocking` runs compute_analysis on a dedicated OS thread so it doesn't starve
/// the async executor.
#[tauri::command]
pub async fn audio_analyze_file(
    cache: State<'_, Arc<MediaCache>>,
    analysis_cache: State<'_, Arc<analysis::AnalysisCache>>,
    file_path: String,
) -> Result<analysis::AnalysisData, String> {
    // Waits out an in-progress ensure_cached() copy (see media_cache.rs's lookup_wait())
    // instead of a bare best-effort lookup — this runs independently of/racing with
    // audio_load, so without waiting it could resolve to the original (network) path for
    // the whole analysis pass. A path never requested to be cached still falls back
    // immediately. Done inside spawn_blocking since lookup_wait() can block synchronously.
    let cache = cache.inner().clone();
    let analysis_cache = analysis_cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = cache
            .lookup_wait(&file_path, std::time::Duration::from_secs(10))
            .unwrap_or(file_path);
        analysis_cache.get_or_compute(&path)
    })
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod concurrency_stress_test {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// Regression guard for the vinyl-mode stall fixed by `with_pipeline_detached`:
    /// before this fix, `audio_pause`/`audio_stop_scratch` held the single
    /// `Mutex<AudioManager>` for the entire scratch-teardown resync (~130-400ms: a
    /// drain sleep plus two flush seeks in `stop_scratch_feeder`), so every other
    /// deck's audio IPC — including a plain position poll — queued up behind it.
    /// Drives deck-a through repeated scratch → pause (teardown) cycles on one thread
    /// while hammering deck-b's `position()` on another, and asserts deck-b's
    /// worst-case call latency never approaches the teardown's blocking duration.
    /// Manually run (`cargo test concurrency_stress -- --ignored --nocapture`) — like
    /// the pipeline.rs smoke tests, it needs real GStreamer init and a real local file.
    #[test]
    #[ignore]
    fn other_deck_ipc_stays_responsive_during_teardown() {
        gstreamer::init().expect("gst init");
        let path = "/home/account/Downloads/audio.wav";

        let mgr = Mutex::new(AudioManager::new());
        {
            let mut m = mgr.lock().unwrap();
            let mut a = DeckAudioPipeline::new("deck-a");
            a.load(path).expect("load deck-a");
            m.pipelines.insert("deck-a".to_string(), a);
            let mut b = DeckAudioPipeline::new("deck-b");
            b.load(path).expect("load deck-b");
            m.pipelines.insert("deck-b".to_string(), b);
        }
        let mgr = Arc::new(mgr);

        let stop = Arc::new(AtomicBool::new(false));
        let max_latency_us = Arc::new(AtomicU64::new(0));

        // Thread A: repeatedly start a scratch gesture on deck-a, then immediately
        // pause it — pause() runs the full teardown+resync every time, same as a real
        // vinyl-mode nudge-then-release cycle.
        let mgr_a = mgr.clone();
        let stop_a = stop.clone();
        let deck_a = std::thread::spawn(move || {
            while !stop_a.load(Ordering::Relaxed) {
                let _ = with_pipeline_detached(&mgr_a, "deck-a", |p| {
                    let _ = p.scratch(1.0, 100_000);
                    std::thread::sleep(Duration::from_millis(10));
                    let _ = p.pause();
                });
            }
        });

        // Thread B: hammer deck-b's position() and record worst-case call latency.
        let mgr_b = mgr.clone();
        let stop_b = stop.clone();
        let max_b = max_latency_us.clone();
        let deck_b = std::thread::spawn(move || {
            while !stop_b.load(Ordering::Relaxed) {
                let t0 = Instant::now();
                let _ = with_pipeline_detached(&mgr_b, "deck-b", |p| p.position());
                let us = t0.elapsed().as_micros() as u64;
                max_b.fetch_max(us, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(5));
            }
        });

        std::thread::sleep(Duration::from_secs(3));
        stop.store(true, Ordering::Relaxed);
        deck_a.join().unwrap();
        deck_b.join().unwrap();

        let max_ms = max_latency_us.load(Ordering::Relaxed) as f64 / 1000.0;
        println!("deck-b worst-case position() latency during deck-a teardown churn: {max_ms:.1}ms");
        assert!(
            max_ms < 50.0,
            "deck-b's position() should never wait behind deck-a's teardown; worst case was {max_ms:.1}ms"
        );
    }
}
