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

use crate::{mime_from_path, parse_range, url_decode};

fn handle(request: tiny_http::Request) {
    let file_path = url_decode(request.url());
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
pub fn start() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind media server port");
    let port = listener.local_addr().unwrap().port();
    let server = tiny_http::Server::from_listener(listener, None)
        .expect("failed to start media server");

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            std::thread::spawn(move || handle(request));
        }
    });

    port
}
