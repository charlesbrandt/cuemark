// Phase 2 of docs/design/freeze-watchdog.md: session-of-record. The webview is
// disposable (any WebKitGTK freeze/reload wipes all JS state), so authoritative
// session state can't live only in the Svelte store. The frontend pushes a debounced
// snapshot of its Session (opaque JSON — this module never mirrors the TS shape, to
// avoid type drift) here and to disk; on rehydration `session_restore()` returns that
// snapshot blended with LIVE per-deck audio status, since the GStreamer pipelines in
// `AudioManager` are a separate OS process's objects that survive the freeze intact —
// they are ground truth for position/playing, the JSON snapshot may be up to ~1s stale.

use std::fs;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::audio::{AudioState, DeckAudioStatus};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedSession {
    snapshot: serde_json::Value,
    saved_at_ms: u64,
    instance_id: String,
}

pub struct SessionStore {
    current: Mutex<Option<SavedSession>>,
    // Distinguishes "this app run" from a stale session-recovery.json left by a
    // previous run — doesn't need to be globally unique, just differ across process
    // starts (there's no other consumer of this id, so a uuid dependency isn't worth it).
    instance_id: String,
}

pub type SessionStoreState = SessionStore;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
            instance_id: format!("{}-{}", std::process::id(), now_ms()),
        }
    }
}

fn recovery_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("session-recovery.json"))
}

/// Pushed on a 1s debounce after any frontend Session store change (see
/// sessionRecovery.ts) — never at MIDI event rates; continuous controls already only
/// reach the Svelte store at <=60fps (audioSync.ts discipline) before this debounce
/// even applies. Stores in managed state (cheap, always current) and write-through to
/// disk (atomic: write temp file, rename) so a full app restart, not just a webview
/// reload, can also offer recovery.
#[tauri::command]
pub fn session_sync(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionStoreState>,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    let saved = SavedSession {
        snapshot,
        saved_at_ms: now_ms(),
        instance_id: state.instance_id.clone(),
    };
    let json = serde_json::to_string(&saved).map_err(|e| e.to_string())?;
    *state.current.lock().unwrap() = Some(saved);

    let path = recovery_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRestoreResult {
    /// The last-pushed Session snapshot, opaque JSON. `None` on a genuinely clean boot
    /// (no prior run ever synced one). The frontend decides whether this is actually a
    /// recovery boot by cross-checking `audio` below — a stale file from a *previous*
    /// app run must not ghost-restore decks when this run's pipelines are all empty.
    pub snapshot: Option<serde_json::Value>,
    pub audio: Vec<DeckAudioStatus>,
}

/// Called from App.svelte's onMount, before normal init. Managed-state `current` is
/// checked first (covers a same-process webview reload); the on-disk file is the
/// fallback (covers a full app restart, per the design doc). Either way, live pipeline
/// status is queried fresh from `AudioManager` — see module doc comment.
#[tauri::command]
pub fn session_restore(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionStoreState>,
    audio_state: tauri::State<'_, AudioState>,
) -> Result<SessionRestoreResult, String> {
    let snapshot = {
        let guard = state.current.lock().unwrap();
        guard.as_ref().map(|s| s.snapshot.clone())
    };
    let snapshot = match snapshot {
        Some(s) => Some(s),
        None => {
            let path = recovery_path(&app)?;
            fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<SavedSession>(&raw).ok())
                .map(|s| s.snapshot)
        }
    };

    let audio = audio_state.lock().unwrap().audio_status();

    Ok(SessionRestoreResult { snapshot, audio })
}
