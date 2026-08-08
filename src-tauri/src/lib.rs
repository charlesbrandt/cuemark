pub mod audio;
pub mod grid_store;
pub mod media_cache;
pub mod media_server;
pub mod midi;
pub mod midi_state;
pub mod session_store;
pub mod video_demux;
pub mod watchdog;

use std::sync::Arc;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Log which build this is, as the first line of every run.
///
/// Every log file and screenshot then answers "which code produced this?" without
/// anyone having to reconstruct it later. `exe` is the load-bearing field: it
/// distinguishes the `cargo tauri dev` binary from the desktop-launcher one
/// (`~/.local/bin/cuemark`), which never auto-rebuilds. See the `run-app` skill,
/// "Making sure a change actually reached the running app".
fn log_build_provenance() {
    let built_at = env!("CUEMARK_BUILT_AT")
        .parse::<i64>()
        .ok()
        .and_then(|secs| time::OffsetDateTime::from_unix_timestamp(secs).ok())
        .and_then(|t| {
            t.format(&time::macros::format_description!(
                "[year]-[month]-[day] [hour]:[minute]:[second]Z"
            ))
            .ok()
        })
        .unwrap_or_else(|| "unknown".into());

    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "unknown".into());

    log::info!(
        "[build] cuemark {} ({}) profile={} built={} exe={}",
        env!("CUEMARK_GIT_SHA"),
        env!("CUEMARK_GIT_DIRTY"),
        if cfg!(debug_assertions) { "debug" } else { "release" },
        built_at,
        exe
    );
}

// Decode %XX sequences in a URL path component
pub(crate) fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hi = (b[i + 1] as char).to_digit(16);
            let lo = (b[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push(((hi << 4) | lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) fn mime_from_path(path: &str) -> &'static str {
    match path.rsplit('.').next().map(|s| s.to_lowercase()).as_deref() {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("mov") | Some("qt") => "video/quicktime",
        Some("avi") => "video/x-msvideo",
        Some("ogv") | Some("ogg") => "video/ogg",
        _ => "application/octet-stream",
    }
}

// Parse "bytes=start-end" or "bytes=start-" HTTP Range header
pub(crate) fn parse_range(header: &str, file_size: u64) -> Option<(u64, u64)> {
    let rest = header.strip_prefix("bytes=")?;
    let (start_s, end_s) = rest.split_once('-')?;
    let start: u64 = start_s.parse().ok()?;
    let end: u64 = if end_s.is_empty() {
        file_size.saturating_sub(1)
    } else {
        end_s.parse::<u64>().ok()?.min(file_size.saturating_sub(1))
    };
    Some((start, end))
}

#[tauri::command]
fn media_server_port(state: tauri::State<MediaServerPort>) -> u16 {
    state.0
}

// Lets frontend-side timing land in the same millisecond-timestamped log file as the
// Rust backend, so a live-hardware stall can be localized to a layer (JS main thread
// frozen vs. IPC round-trip slow vs. Rust busy) by reading one timeline instead of
// cross-referencing two clocks. Debug-instrumentation only — see App.svelte/handler.ts
// call sites for what's being measured.
#[tauri::command]
fn frontend_log(msg: String) {
    log::info!("[frontend] {msg}");
}

/// Wall-clock epoch milliseconds — the one clock the Rust process and both webviews
/// can compare directly (`Date.now()` reads the same clock). `performance.now()` and
/// `Instant` are per-process monotonic origins and cannot be differenced across the
/// IPC boundary; epoch ms can, which is what lets `audio_get_position` report *where*
/// a slow poll spent its time rather than just how long it took.
pub(crate) fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Control arm for IPC-latency measurement: does nothing but report when it ran.
///
/// A synchronous `#[tauri::command]` runs on the GTK main thread, the same thread that
/// dispatches every IPC call and pumps the webview. So a round trip measured from JS
/// covers three legs — JS → GTK main thread, the command body, GTK main thread → JS —
/// and only the middle one is "the backend being slow". Firing this alongside a real
/// command isolates the two transport legs from the work: if the no-op is just as slow,
/// the callee is exonerated and the main thread (or the JS thread that must run the
/// promise callback) is the bottleneck. See `[position-poll]`/`[ipc-ping]` in
/// `src/lib/audio/pollStats.ts`.
#[tauri::command]
fn ipc_ping() -> f64 {
    epoch_ms()
}

struct MediaServerPort(u16);

#[tauri::command]
fn open_output_window(app: tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("output").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "output", WebviewUrl::App("output.html".into()))
        .title("Cuemark — Output")
        .inner_size(1280.0, 720.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                // Millisecond-precision timestamps — the default format only has
                // 1-second resolution, which isn't enough to diagnose the class of
                // real-time-audio timing bug this app tends to hit (MIDI-tick-rate vs.
                // GStreamer-pipeline stalls of tens to thousands of ms). See
                // docs/design/pcm-buffer-playback.md, "choked up" investigation.
                .format(|out, message, record| {
                    let fmt = time::macros::format_description!(
                        "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond digits:3]"
                    );
                    let now = tauri_plugin_log::TimezoneStrategy::UseUtc.get_now();
                    out.finish(format_args!(
                        "[{}][{}][{}] {}",
                        now.format(&fmt).unwrap_or_default(),
                        record.target(),
                        record.level(),
                        message
                    ))
                })
                // The plugin's defaults (40KB, KeepOne) are far too small for this app's log
                // volume: a single track load emits hundreds of lines, so a session self-
                // erased in under two minutes and rotation silently deleted the *only* copy
                // of the window being diagnosed. That happened mid-investigation on
                // 2026-08-03 — the build-provenance line CLAUDE.md says to check first had
                // already been rotated away, taking with it the evidence the run existed to
                // collect. 8MB × KeepAll is a few sessions' worth of history and still
                // trivial on disk; the date-stamped rotated files are what let a report from
                // last week still be read.
                .max_file_size(8 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(audio::AudioState::new(audio::AudioManager::new()))
        .manage(Arc::new(audio::analysis::AnalysisCache::new()))
        .manage(session_store::SessionStoreState::new())
        .manage(Arc::new(video_demux::VideoDemuxRegistry::new()))
        .invoke_handler(tauri::generate_handler![
            open_output_window,
            media_server_port,
            frontend_log,
            ipc_ping,
            midi_state::midi_get_saved_state,
            midi_state::midi_benchmark_save,
            watchdog::watchdog_heartbeat,
            session_store::session_sync,
            session_store::session_restore,
            grid_store::grid_get_saved,
            grid_store::grid_save,
            audio::list_audio_devices,
            audio::audio_load,
            audio::audio_unload,
            audio::audio_play,
            audio::audio_pause,
            audio::audio_seek,
            audio::audio_set_rate,
            audio::audio_scratch,
            audio::audio_scratch_to,
            audio::audio_stop_scratch,
            audio::audio_set_gain,
            audio::audio_set_volume,
            audio::audio_set_eq,
            audio::audio_set_cue,
            audio::audio_get_position,
            audio::audio_set_master_volume,
            audio::audio_set_main_devices,
            audio::audio_set_cue_device,
            audio::audio_set_cue_gain,
            audio::audio_record_start,
            audio::audio_record_stop,
            audio::audio_analyze_file,
            video_demux::video_demux_load,
            video_demux::video_demux_unload,
        ])
        // A closed window must stop being watched. Otherwise its heartbeat entry goes
        // stale, trips the watchdog's silence threshold, and drives the full recovery
        // cascade — up to and including tier3's SIGKILL of every WebKit process in the
        // app — against a window that is gone because the user closed it on purpose.
        // See watchdog::forget_window for the incident this comes from.
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }) {
                // try_state, not state: window events can fire before setup() has run
                // app.manage(), and a panic on this thread would take the app down.
                if let Some(state) = window.app_handle().try_state::<watchdog::WatchdogPersist>() {
                    watchdog::forget_window(&state, window.label());
                }
            }
        })
        .setup(|app| {
            log_build_provenance();

            let persist = midi_state::new_persist();
            app.manage(persist.clone());
            midi::spawn_listener(app.handle().clone(), persist)?;

            let watchdog_persist = watchdog::new_persist();
            app.manage(watchdog_persist.clone());
            watchdog::spawn_watchdog(watchdog_persist, app.handle().clone());

            // See media_cache.rs — resolved here (not at builder-config time, before
            // media_server::start()) because it needs app.path(), which requires an
            // AppHandle only available inside setup().
            let cache_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("media_cache");
            let media_cache = Arc::new(media_cache::MediaCache::new(cache_dir));
            app.manage(media_cache.clone());
            let video_demux_registry = app.state::<Arc<video_demux::VideoDemuxRegistry>>().inner().clone();
            app.manage(MediaServerPort(media_server::start(media_cache, video_demux_registry)));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
