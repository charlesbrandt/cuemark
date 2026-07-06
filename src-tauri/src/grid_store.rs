use std::collections::HashMap;
use std::fs;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct GridEntry {
    pub bpm: f64,
    pub downbeat: f64,
}

fn load_all(path: &std::path::Path) -> HashMap<String, GridEntry> {
    let Ok(data) = fs::read_to_string(path) else { return HashMap::new(); };
    serde_json::from_str(&data).unwrap_or_default()
}

#[tauri::command]
pub fn grid_get_saved(app: tauri::AppHandle, file_path: String) -> Option<GridEntry> {
    let path = app.path().app_data_dir().ok()?.join("grids.json");
    load_all(&path).get(&file_path).copied()
}

#[tauri::command]
pub fn grid_save(app: tauri::AppHandle, file_path: String, bpm: f64, downbeat: f64) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("grids.json");
    let mut all = load_all(&path);
    all.insert(file_path, GridEntry { bpm, downbeat });
    let json = serde_json::to_string(&all).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}
