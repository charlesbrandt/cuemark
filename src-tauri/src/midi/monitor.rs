//! Raw MIDI monitor — every byte arriving on any connected port, mapped or not.
//! Unchanged in spirit from the single-controller version; now carries `source` so a
//! two-controller session's rows can be told apart (`MidiMonitor.svelte` keys by
//! `port` already, `source` rides along for completeness). See
//! `docs/design/controller-mapping.md` §7a for why this exists at all.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::AppHandle;

/// Off by default; flipped by `midi_monitor_set` while the monitor panel is open. Two
/// jog wheels alone deliver ~260 messages/s and every emit is a serialize plus a
/// webview dispatch on the GTK main thread, so this stays off whenever nobody's
/// watching (see `docs/design/control-window-frame-budget.md`).
static MONITOR: AtomicBool = AtomicBool::new(false);

pub(super) fn is_monitor_on() -> bool {
    MONITOR.load(Ordering::Relaxed)
}

/// Cap on bytes carried per message — big enough that a SysEx dump is visible rather
/// than dropped, without letting one message push megabytes through the event channel.
pub(super) const MAX_RAW_BYTES: usize = 16;

/// One observed message, exactly as it arrived.
#[derive(Serialize, Clone, Debug)]
pub struct MidiRaw {
    /// Which connection this came from — stable per-connection id (see `mod.rs`'s
    /// `NEXT_SOURCE`), for telling two live controllers apart even if their port
    /// names happen to look similar.
    pub source: u32,
    pub port: String,
    /// Raw bytes, truncated to `MAX_RAW_BYTES`.
    pub bytes: Vec<u8>,
    /// True length before truncation, so a clipped SysEx is obvious rather than plausible.
    pub len: usize,
    /// Wall-clock epoch ms — the one clock the frontend and the Rust log can be
    /// differenced across (see `epoch_ms` in lib.rs).
    pub t: f64,
    /// Debug spelling of the binding this resolves to, or `None` when the map ignores it.
    pub mapped: Option<String>,
}

/// Turn the raw feed on or off. Called from the monitor panel's mount/unmount.
#[tauri::command]
pub fn midi_monitor_set(enabled: bool) {
    MONITOR.store(enabled, Ordering::Relaxed);
    log::info!("[midi] raw monitor {}", if enabled { "ON" } else { "off" });
}

/// Write a captured session to `<app_data>/midi-captures/` and return the path. The
/// capture is a replayable fixture: a byte log fed through `Decoder::decode` in a test
/// asserts an action sequence without the controller attached (see
/// `docs/design/controller-mapping.md` §9 and `src-tauri/tests/replay.rs`).
#[tauri::command]
pub fn midi_capture_save(app: AppHandle, json: String) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("midi-captures");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("capture-{}.json", crate::epoch_ms() as u64));
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    let path = path.display().to_string();
    log::info!("[midi] capture saved: {path}");
    Ok(path)
}
