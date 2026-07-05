use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::Manager;

pub struct Inner {
    pub values: HashMap<String, f32>,
    dirty: bool,
}

impl Inner {
    fn new() -> Self {
        Self { values: HashMap::new(), dirty: false }
    }
}

/// Shared persist handle: captured by the MIDI callback and registered in Tauri managed state.
pub type MidiPersist = Arc<Mutex<Inner>>;

pub fn new_persist() -> MidiPersist {
    Arc::new(Mutex::new(Inner::new()))
}

/// Load the saved state file. Returns an empty map if the file is missing or malformed.
pub fn load(path: &PathBuf) -> HashMap<String, f32> {
    let Ok(data) = fs::read_to_string(path) else { return HashMap::new(); };
    serde_json::from_str(&data).unwrap_or_default()
}

/// Spawn the background flusher thread. Wakes every 100ms; writes to disk only when dirty.
/// Lock is released before I/O; a temp-file + rename keeps writes atomic.
pub fn spawn_flusher(persist: MidiPersist, path: PathBuf) {
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(100));
            let snapshot = {
                let mut inner = persist.lock().unwrap();
                if !inner.dirty {
                    None
                } else {
                    inner.dirty = false;
                    Some(inner.values.clone())
                }
            };
            let Some(values) = snapshot else { continue };
            if let Ok(json) = serde_json::to_string(&values) {
                let tmp = path.with_extension("tmp");
                if let Some(parent) = path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if fs::write(&tmp, &json).is_ok() {
                    let _ = fs::rename(&tmp, &path);
                }
            }
        }
    });
}

/// Called from the MIDI callback — only updates in-memory state, no I/O.
pub fn mark_dirty(persist: &MidiPersist, key: &str, value: f32) {
    let mut inner = persist.lock().unwrap();
    inner.values.insert(key.to_string(), value);
    inner.dirty = true;
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Returns the saved MIDI control state. Called once at startup to pre-populate
/// sliders/faders to their last-seen positions.
#[tauri::command]
pub fn midi_get_saved_state(app: tauri::AppHandle) -> HashMap<String, f32> {
    let path = match app.path().app_data_dir() {
        Ok(d) => d.join("midi_state.json"),
        Err(_) => return HashMap::new(),
    };
    load(&path)
}

/// Benchmark the raw file write path: runs `n` atomic writes and returns timing stats.
/// Used by the latency-test.sh step 9 to measure Rust-side I/O latency independently
/// of the debounce logic (which only triggers once per 100ms in production).
#[tauri::command]
pub fn midi_benchmark_save(
    persist: tauri::State<'_, MidiPersist>,
    app: tauri::AppHandle,
    n: u32,
) -> Result<serde_json::Value, String> {
    let path = app.path().app_data_dir()
        .map_err(|e| e.to_string())?
        .join("midi_state.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Use current in-memory values; fall back to representative dummy data if no
    // MIDI events have arrived yet (e.g. running the benchmark before the controller).
    let values: HashMap<String, f32> = {
        let inner = persist.lock().unwrap();
        if inner.values.is_empty() {
            [
                ("deck-0.gain".to_string(), 0.75f32),
                ("deck-0.playbackRate".to_string(), 1.0f32),
                ("deck-1.gain".to_string(), 0.5f32),
                ("crossfader".to_string(), 0.5f32),
                ("masterVolume".to_string(), 0.8f32),
                ("cueGain".to_string(), 0.6f32),
            ].into()
        } else {
            inner.values.clone()
        }
    };

    let json = serde_json::to_string(&values).map_err(|e| e.to_string())?;
    let mut timings: Vec<f64> = Vec::with_capacity(n as usize);

    for _ in 0..n {
        let t0 = std::time::Instant::now();
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, &json).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        timings.push(t0.elapsed().as_secs_f64() * 1000.0);
    }

    timings.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let len = timings.len() as f64;
    let mean = timings.iter().sum::<f64>() / len;
    let fmt = |v: f64| (v * 100.0).round() / 100.0;
    let idx = |pct: f64| (timings.len() as f64 * pct) as usize;

    Ok(serde_json::json!({
        "n": n,
        "min_ms":  fmt(timings[0]),
        "p50_ms":  fmt(timings[idx(0.50)]),
        "p99_ms":  fmt(timings[idx(0.99)]),
        "max_ms":  fmt(*timings.last().unwrap()),
        "mean_ms": fmt(mean),
    }))
}
