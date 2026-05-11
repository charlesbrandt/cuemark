pub mod audio;
pub mod midi;

use std::io::{Read, Seek, SeekFrom};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// Decode %XX sequences in a URL path component
fn url_decode(s: &str) -> String {
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

fn mime_from_path(path: &str) -> &'static str {
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
fn parse_range(header: &str, file_size: u64) -> Option<(u64, u64)> {
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

fn serve_media(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let file_path = url_decode(request.uri().path());
    let range_hdr = request
        .headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    let mut file = match std::fs::File::open(&file_path) {
        Ok(f) => f,
        Err(e) => {
            return tauri::http::Response::builder()
                .status(404)
                .header("Access-Control-Allow-Origin", "*")
                .body(format!("not found: {e}").into_bytes())
                .unwrap();
        }
    };
    let file_size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mime = mime_from_path(&file_path);

    if let Some((start, end)) = range_hdr.as_deref().and_then(|h| parse_range(h, file_size)) {
        let length = end - start + 1;
        let mut buf = vec![0u8; length as usize];
        if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
            return tauri::http::Response::builder()
                .status(500)
                .header("Access-Control-Allow-Origin", "*")
                .body(b"read error".to_vec())
                .unwrap();
        }
        tauri::http::Response::builder()
            .status(206)
            .header("Content-Type", mime)
            .header("Content-Range", format!("bytes {start}-{end}/{file_size}"))
            .header("Content-Length", length.to_string())
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "*")
            .body(buf)
            .unwrap()
    } else {
        // Non-range GET: return full file (initial probe; GStreamer uses Range for seeks)
        let mut buf = Vec::new();
        let _ = file.read_to_end(&mut buf);
        tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", mime)
            .header("Content-Length", file_size.to_string())
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "*")
            .body(buf)
            .unwrap()
    }
}

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
        .plugin(tauri_plugin_dialog::init())
        .manage(audio::AudioState::new(audio::AudioManager::new()))
        .register_asynchronous_uri_scheme_protocol("media", |_app, request, responder| {
            std::thread::spawn(move || {
                responder.respond(serve_media(request));
            });
        })
        .invoke_handler(tauri::generate_handler![
            open_output_window,
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
        ])
        .setup(|app| {
            midi::spawn_listener(app.handle().clone())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
