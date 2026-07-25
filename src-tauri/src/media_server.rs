// Local-only HTTP server for serving video files to the <video> element in production.
//
// WebKitGTK's GStreamer media backend cannot reliably load custom URI schemes
// (`media://`, `asset://`) for <video> playback — confirmed empirically (instant
// FormatError, no GStreamer pipeline ever constructed) and already noted in
// vite.config.ts's dev-mode media middleware comment. Dev mode works around this with
// a Vite HTTP middleware; this module gives production the same proven mechanism
// (plain http://127.0.0.1:<port>/<abs-path>, which souphttpsrc/WebKit both handle
// natively) instead of relying on the custom scheme.
use std::io::{Read, Seek, SeekFrom};
use std::net::TcpListener;
use std::sync::Arc;
use std::time::Duration;

use crate::media_cache::MediaCache;
use crate::video_demux::VideoDemuxRegistry;
use crate::{mime_from_path, parse_range, url_decode};

/// Serves `GET /demux/<deck_id>/aus?from=<idx>&count=<n>` — the binary AU-chunk
/// transport for the WebCodecs debug probe (docs/design/webcodecs-video-path.md phase
/// 1). Deliberately a flat byte stream, not Tauri JSON IPC — encoded AUs run ~1 MB/s
/// per deck at typical bitrates, and this HTTP server is already the established local
/// transport for video bytes (see the module doc comment above).
fn handle_demux_aus(request: tiny_http::Request, deck_id: &str, query: &str, demux: &VideoDemuxRegistry) {
    let mut from = 0usize;
    let mut count = usize::MAX;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            match k {
                "from" => from = v.parse().unwrap_or(0),
                "count" => count = v.parse().unwrap_or(usize::MAX),
                _ => {}
            }
        }
    }
    match demux.encode_aus_range(deck_id, from, count) {
        Some(body) => {
            let response = tiny_http::Response::from_data(body)
                .with_status_code(200)
                .with_header(header("Content-Type", "application/octet-stream"))
                .with_header(header("Access-Control-Allow-Origin", "*"));
            let _ = request.respond(response);
        }
        None => {
            // Every branch — including this error one — must carry CORS, same reason
            // as the file-not-found branch in handle() below: a response missing this
            // header permanently CORS-taints the resource for any later JS read of it.
            let response = tiny_http::Response::from_string(format!("no demuxed video for deck '{deck_id}'"))
                .with_status_code(404)
                .with_header(header("Access-Control-Allow-Origin", "*"));
            let _ = request.respond(response);
        }
    }
}

fn handle(request: tiny_http::Request, cache: &MediaCache, demux: &VideoDemuxRegistry) {
    // `/demux/<deck_id>/aus?...` is routed separately from the file-serving path below —
    // it serves in-memory AU data, not a file on disk, so it never touches media_cache.
    // Parsed into owned Strings up front: `request.url()` borrows from `request`, which
    // `handle_demux_aus` below needs to take by value (to call `.respond()` on it).
    let demux_route = request.url().strip_prefix("/demux/").and_then(|rest| {
        let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
        path.strip_suffix("/aus").map(|deck_id| (url_decode(deck_id), query.to_string()))
    });
    if let Some((deck_id, query)) = demux_route {
        handle_demux_aus(request, &deck_id, &query, demux);
        return;
    }

    let requested_path = url_decode(request.url());
    // Wait out an in-progress ensure_cached() copy instead of falling straight back to
    // the network — a video's first HTTP request can otherwise race ahead of audio_load's
    // cache copy and end up streaming (and, on this codebase's known SMB share, sometimes
    // stalling) straight off the original network path for the rest of the connection. A
    // path that was never requested to be cached at all still falls back immediately, same
    // as before. See media_cache.rs's lookup_wait() doc comment for the full incident.
    let file_path = cache
        .lookup_wait(&requested_path, Duration::from_secs(10))
        .unwrap_or(requested_path);
    let range_hdr = request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("range"))
        .map(|h| h.value.as_str().to_owned());

    let mut file = match std::fs::File::open(&file_path) {
        Ok(f) => f,
        Err(e) => {
            // A response missing this header — even an error response — permanently marks
            // the <video> element's resource as CORS-tainted in the browser. Any later
            // texImage2D/getImageData read on it then throws SecurityError forever, even
            // after subsequent requests succeed with proper headers. Every response branch
            // here must carry Access-Control-Allow-Origin, not just the success paths.
            let response = tiny_http::Response::from_string(format!("not found: {e}"))
                .with_status_code(404)
                .with_header(header("Access-Control-Allow-Origin", "*"));
            let _ = request.respond(response);
            return;
        }
    };
    let file_size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mime = mime_from_path(&file_path);

    let valid_range = range_hdr
        .as_deref()
        .and_then(|h| parse_range(h, file_size))
        .filter(|(start, end)| start <= end);
    if let Some((start, end)) = valid_range {
        let length = end - start + 1;
        let mut buf = vec![0u8; length as usize];
        if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
            let response = tiny_http::Response::from_string("read error")
                .with_status_code(500)
                .with_header(header("Access-Control-Allow-Origin", "*"));
            let _ = request.respond(response);
            return;
        }
        let response = tiny_http::Response::from_data(buf)
            .with_status_code(206)
            .with_header(header("Content-Type", mime))
            .with_header(header("Content-Range", &format!("bytes {start}-{end}/{file_size}")))
            .with_header(header("Accept-Ranges", "bytes"))
            .with_header(header("Access-Control-Allow-Origin", "*"));
        let _ = request.respond(response);
    } else {
        let mut buf = Vec::new();
        let _ = file.read_to_end(&mut buf);
        let response = tiny_http::Response::from_data(buf)
            .with_status_code(200)
            .with_header(header("Content-Type", mime))
            .with_header(header("Accept-Ranges", "bytes"))
            .with_header(header("Access-Control-Allow-Origin", "*"));
        let _ = request.respond(response);
    }
}

fn header(field: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(field.as_bytes(), value.as_bytes()).unwrap()
}

/// Starts the server on an ephemeral 127.0.0.1 port and returns that port.
/// Spawns a thread per connection — local-only, low-concurrency (one app window).
pub fn start(cache: Arc<MediaCache>, demux: Arc<VideoDemuxRegistry>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind media server port");
    let port = listener.local_addr().unwrap().port();
    let server = tiny_http::Server::from_listener(listener, None)
        .expect("failed to start media server");

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let cache = cache.clone();
            let demux = demux.clone();
            std::thread::spawn(move || handle(request, &cache, &demux));
        }
    });

    port
}
