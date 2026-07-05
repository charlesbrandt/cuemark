pub mod audio;
pub mod media_server;
pub mod midi;
pub mod midi_state;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

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
        .manage(MediaServerPort(media_server::start()))
        .invoke_handler(tauri::generate_handler![
            open_output_window,
            media_server_port,
            midi_state::midi_get_saved_state,
            midi_state::midi_benchmark_save,
            audio::list_audio_devices,
            audio::audio_load,
            audio::audio_unload,
            audio::audio_play,
            audio::audio_pause,
            audio::audio_seek,
            audio::audio_set_rate,
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
        ])
        .setup(|app| {
            let persist = midi_state::new_persist();
            app.manage(persist.clone());
            midi::spawn_listener(app.handle().clone(), persist)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
