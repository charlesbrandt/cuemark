//! Snapcast group claiming — pointing a Snapcast server's speaker groups at this app's
//! `tcp://` stream source while a network target is enabled in Settings, and putting
//! them back where they were when it is disabled.
//!
//! This closes the "group routing is entirely manual" open item in
//! `docs/design/network-audio-output.md`: until now, ticking Stream in Settings started
//! audio flowing to the server but left every speaker group listening to whatever it was
//! on before — the exact "cuemark looks fine but the room is silent" failure that doc
//! calls the expected first check.
//!
//! **Why this is safe where adding the source to a `meta://` stream is forbidden.** The
//! keepalive makes this app's stream permanently "playing", so a meta stream would select
//! it forever and Spotify/AirPlay would never get the speakers back. Claiming is the
//! deliberate, event-driven version of the same thing: the switch happens on an explicit
//! user action (ticking/unticking the target, quitting the app), never on audio state —
//! and the release path always restores a stream that auto-selects, so the house falls
//! back to normal service rather than to silence.
//!
//! **Nothing here hardcodes a stream name or a network.** The stream to claim is found
//! by matching the target's port against the server's `tcp://` source URIs from
//! `Server.GetStatus` (`uri.host` arrives as `"<bind-addr>:<port>"`, e.g.
//! `"0.0.0.0:4953"`), and the streams to restore are whatever each group was actually
//! on when it was claimed. The JSON-RPC port is snapserver's own default (`1780`), not a
//! property of any particular network — and it is deliberately *not* derived from the
//! device id, whose port belongs to the `tcp://` audio source, a different listener on
//! the same machine.
//!
//! **Failure containment.** Claim/release failures are logged, never propagated: audio
//! streams to the `tcp://` source regardless of group routing, so a claim that cannot
//! reach the server degrades to the previous manual-switch behaviour, not to silence.
//!
//! **Crash leftovers self-heal.** A claim that is never released (app killed mid-set)
//! leaves groups pointed at this app's stream. The next `claim()` observes a group
//! already on that stream, knows its true prior stream is unknowable, and records the
//! server's `meta://` stream instead — the one stream that gives the speakers back to
//! whichever of Spotify/AirPlay is producing. Toggling the target off then restores
//! normal service even after an unclean exit.

use serde_json::{json, Value};

use super::pipeline::parse_snapcast_device;

/// snapserver's default JSON-RPC port. A different one would have to be as configurable
/// as the audio port is (Settings), which has not been needed — see the module doc for
/// why it cannot just be read out of the device id.
pub const RPC_PORT: u16 = 1780;

/// One round trip of Snapcast's JSON-RPC over HTTP. Bounded because the caller runs on
/// the audio-settings IPC path: an unreachable server must cost seconds, never the OS's
/// own TCP timeout.
const RPC_TIMEOUT_SECS: u64 = 3;

/// A live claim: which server/stream was taken over, and what to give back.
#[derive(Debug)]
pub struct Claim {
    host: String,
    /// The `tcp://` source's listen port — half of how the stream was found.
    audio_port: u16,
    rpc_port: u16,
    stream_id: String,
    /// `(group id, stream to restore)` per group this claim switched, in switch order.
    saved: Vec<(String, String)>,
}

impl Claim {
    /// One line for the log, naming the thing claimed rather than the mechanism.
    pub fn describe(&self) -> String {
        format!(
            "stream '{}' (tcp :{}) on {} — {} group(s) restored on release",
            self.stream_id, self.audio_port, self.host, self.saved.len()
        )
    }
}

/// POST one JSON-RPC call and return its `result`.
fn rpc(host: &str, rpc_port: u16, method: &str, params: Value) -> Result<Value, String> {
    let url = format!("http://{host}:{rpc_port}/jsonrpc");
    let body = json!({"id": 1, "jsonrpc": "2.0", "method": method, "params": params});
    let response = ureq::post(&url)
        .timeout(std::time::Duration::from_secs(RPC_TIMEOUT_SECS))
        .send_json(body)
        .map_err(|e| format!("{method} → {host}:{rpc_port}: {e}"))?;
    let parsed: Value = response
        .into_json()
        .map_err(|e| format!("{method} → {host}:{rpc_port}: bad reply: {e}"))?;
    if let Some(error) = parsed.get("error") {
        return Err(format!("{method}: {}", error.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| error.to_string())));
    }
    Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
}

fn streams_of(server: &Value) -> &[Value] {
    server.get("streams").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn groups_of(server: &Value) -> &[Value] {
    server.get("groups").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// The listen port of a `tcp://` stream source, from `uri.host` (`"0.0.0.0:4953"`).
/// `rsplit_once` so an IPv6 bind address (`"[::]:4953"`) still yields its port.
fn tcp_source_port(stream: &Value) -> Option<u16> {
    let host = stream.pointer("/uri/host")?.as_str()?;
    host.rsplit_once(':')?.1.parse().ok()
}

fn scheme_of(stream: &Value) -> Option<&str> {
    stream.pointer("/uri/scheme").and_then(Value::as_str)
}

fn id_of(entry: &Value) -> Option<&str> {
    entry.get("id").and_then(Value::as_str)
}

/// Point every speaker group at this app's `tcp://` source, remembering what each one
/// was on. `claim(device)` uses snapserver's default RPC port; tests drive
/// `claim_with_rpc_port` directly at their own fake server.
pub fn claim(device: &str) -> Result<Claim, String> {
    claim_with_rpc_port(device, RPC_PORT)
}

pub fn claim_with_rpc_port(device: &str, rpc_port: u16) -> Result<Claim, String> {
    let (host, audio_port) = parse_snapcast_device(device)
        .ok_or_else(|| format!("{device:?} is not a snapcast://host:port device id"))?;

    let server = rpc(&host, rpc_port, "Server.GetStatus", json!({}))?
        .get("server")
        .cloned()
        .ok_or_else(|| format!("Server.GetStatus → {host}:{rpc_port}: reply has no server object"))?;

    // Which stream on this server is ours: the tcp:// source listening on the target's
    // port. A port match rather than a name match because the port is the one thing both
    // sides necessarily agree on — the stream *id* is whatever `name=` says in the
    // server's config, which this app has never seen.
    let mut stream_id: Option<String> = None;
    for stream in streams_of(&server) {
        if scheme_of(stream) == Some("tcp") && tcp_source_port(stream) == Some(audio_port) {
            stream_id = id_of(stream).map(str::to_string);
            break;
        }
    }
    let Some(stream_id) = stream_id else {
        return Err(format!(
            "no tcp:// stream source listening on port {audio_port} at {host}:{rpc_port} — add \
             one to snapserver.conf's [stream] section (mode=server) and restart snapserver"
        ));
    };

    // The meta stream, if the server has one, is the only safe answer for "a group that
    // was already on our stream before this claim" — see the module doc's crash-leftover
    // note. None existing is fine; such groups simply get no restore target.
    let meta_stream = streams_of(&server)
        .iter()
        .find(|s| scheme_of(s) == Some("meta"))
        .and_then(id_of)
        .map(str::to_string);

    let mut saved = Vec::new();
    for group in groups_of(&server) {
        let (Some(gid), Some(current)) = (id_of(group), group.get("stream_id").and_then(Value::as_str))
        else {
            continue;
        };
        let restore_to = if current == stream_id {
            match &meta_stream {
                Some(meta) => meta.clone(),
                None => continue, // already ours, nothing safe to restore to — leave it
            }
        } else {
            current.to_string()
        };
        rpc(&host, rpc_port, "Group.SetStream", json!({"id": gid, "stream_id": stream_id}))?;
        log::info!("[audio/snapcast] group {gid} → '{stream_id}' (was '{restore_to}')");
        saved.push((gid.to_string(), restore_to));
    }

    Ok(Claim { host, audio_port, rpc_port, stream_id, saved })
}

/// Give back everything a claim took. Deliberately conservative, because the world may
/// have moved since the claim:
/// - a group that no longer exists (its client disconnected, the server re-formed groups)
///   is skipped, not re-created;
/// - a group that is *no longer on our stream* was re-routed by someone in the meantime
///   and is left alone;
/// - a saved stream that no longer exists (server restarted with different sources) is
///   not set — `Group.SetStream` errors on unknown ids.
pub fn release(claim: &Claim) -> Result<(), String> {
    let server = rpc(&claim.host, claim.rpc_port, "Server.GetStatus", json!({}))?
        .get("server")
        .cloned()
        .ok_or_else(|| format!("Server.GetStatus → {}: reply has no server object", claim.host))?;

    let live_streams: Vec<&str> = streams_of(&server).iter().filter_map(id_of).collect();
    let mut live_groups = std::collections::HashMap::new();
    for group in groups_of(&server) {
        if let (Some(gid), Some(sid)) = (id_of(group), group.get("stream_id").and_then(Value::as_str)) {
            live_groups.insert(gid.to_string(), sid.to_string());
        }
    }

    for (gid, restore_to) in &claim.saved {
        let Some(current) = live_groups.get(gid) else {
            log::info!("[audio/snapcast] group {gid} is gone — nothing to release");
            continue;
        };
        if current != &claim.stream_id {
            log::info!(
                "[audio/snapcast] group {gid} moved to '{current}' since the claim — leaving it alone"
            );
            continue;
        }
        if !live_streams.contains(&restore_to.as_str()) {
            log::warn!(
                "[audio/snapcast] stream '{restore_to}' no longer exists — group {gid} stays on \
                 '{}'; switch it manually",
                claim.stream_id
            );
            continue;
        }
        rpc(&claim.host, claim.rpc_port, "Group.SetStream", json!({"id": gid, "stream_id": restore_to}))?;
        log::info!("[audio/snapcast] group {gid} → '{restore_to}' (released)");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::sync::{Arc, Mutex};
    use tiny_http::{Response, Server};

    /// Scripted JSON-RPC responder standing in for snapserver: every request is recorded
    /// (method + params), replies are popped from the front of the script in arrival
    /// order. Claim/release sequences are deterministic, so a linear script is enough.
    struct FakeSnapserver {
        requests: Arc<Mutex<Vec<(String, Value)>>>,
        port: u16,
    }

    impl FakeSnapserver {
        fn start(script: Vec<Value>) -> Self {
            let server = Server::http("127.0.0.1:0").expect("bind fake snapserver");
            let port = server.server_addr().to_ip().expect("ipv4").port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let recorder = requests.clone();
            std::thread::spawn(move || {
                let mut script = script.into_iter();
                for mut request in server.incoming_requests() {
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    let parsed: Value = serde_json::from_str(&body).expect("valid json-rpc request");
                    let method = parsed.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
                    let params = parsed.get("params").cloned().unwrap_or(Value::Null);
                    recorder.lock().unwrap().push((method, params));
                    let reply = script
                        .next()
                        .unwrap_or_else(|| json!({"error": {"message": "script exhausted"}}));
                    let _ = request.respond(Response::from_string(reply.to_string()));
                }
            });
            Self { requests, port }
        }

        fn set_stream_calls(&self) -> Vec<(String, String)> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, _)| m == "Group.SetStream")
                .map(|(_, p)| {
                    (
                        p.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                        p.get("stream_id").and_then(Value::as_str).unwrap_or_default().to_string(),
                    )
                })
                .collect()
        }
    }

    fn tcp_source(id: &str, port: u16) -> Value {
        json!({"id": id, "status": "idle", "uri": {"scheme": "tcp", "host": format!("0.0.0.0:{port}")}})
    }

    fn meta_source(id: &str) -> Value {
        json!({"id": id, "uri": {"scheme": "meta"}})
    }

    fn group(id: &str, stream_id: &str) -> Value {
        json!({"id": id, "stream_id": stream_id, "clients": []})
    }

    fn ok_status(streams: Vec<Value>, groups: Vec<Value>) -> Value {
        json!({"id": 1, "jsonrpc": "2.0", "result": {"server": {"streams": streams, "groups": groups}}})
    }

    fn ok_set_stream() -> Value {
        json!({"id": 1, "jsonrpc": "2.0", "result": {"stream_id": "Cuemark"}})
    }

    /// The port inside the device id (the audio source) is deliberately unrelated to the
    /// fake server's port (the RPC endpoint) — same as production, where they are
    /// different listeners on the same snapserver host.
    const DEVICE: &str = "snapcast://127.0.0.1:4953";

    #[test]
    fn claim_switches_groups_and_release_restores_them() {
        let fake = FakeSnapserver::start(vec![
            ok_status(
                vec![tcp_source("Cuemark", 4953), meta_source("House")],
                vec![group("g1", "House"), group("g2", "Spotify")],
            ),
            ok_set_stream(),
            ok_set_stream(),
            // release-time status: both groups on our stream
            ok_status(
                vec![tcp_source("Cuemark", 4953), meta_source("House"), json!({"id": "Spotify"})],
                vec![group("g1", "Cuemark"), group("g2", "Cuemark")],
            ),
            ok_set_stream(),
            ok_set_stream(),
        ]);

        let claim = claim_with_rpc_port(DEVICE, fake.port).expect("claim");
        assert_eq!(claim.stream_id, "Cuemark");
        assert_eq!(claim.saved, vec![("g1".into(), "House".into()), ("g2".into(), "Spotify".into())]);
        assert_eq!(
            fake.set_stream_calls(),
            vec![("g1".into(), "Cuemark".into()), ("g2".into(), "Cuemark".into())]
        );

        release(&claim).expect("release");
        assert_eq!(
            fake.set_stream_calls(),
            vec![
                ("g1".into(), "Cuemark".into()),
                ("g2".into(), "Cuemark".into()),
                ("g1".into(), "House".into()),
                ("g2".into(), "Spotify".into()),
            ]
        );
    }

    /// A group already on our stream at claim time is a leftover from an unclean exit —
    /// its real prior stream is unknowable, so the meta stream is recorded instead. This
    /// is what makes a crash leftover self-heal on the next toggle.
    #[test]
    fn claim_on_a_crash_leftover_saves_the_meta_stream() {
        let fake = FakeSnapserver::start(vec![
            ok_status(
                vec![meta_source("House"), tcp_source("Cuemark", 4953)],
                vec![group("g1", "Cuemark"), group("g2", "House")],
            ),
            ok_set_stream(),
            ok_set_stream(),
            ok_status(
                vec![meta_source("House"), tcp_source("Cuemark", 4953)],
                vec![group("g1", "Cuemark"), group("g2", "Cuemark")],
            ),
            ok_set_stream(),
            ok_set_stream(),
        ]);

        let claim = claim_with_rpc_port(DEVICE, fake.port).expect("claim");
        assert_eq!(claim.saved, vec![("g1".into(), "House".into()), ("g2".into(), "House".into())]);

        release(&claim).expect("release");
        assert!(fake.set_stream_calls().contains(&("g1".into(), "House".into())));
    }

    /// Release must not stomp a group someone re-routed mid-claim, and must not address
    /// a saved stream that no longer exists.
    #[test]
    fn release_leaves_moved_groups_and_vanished_streams_alone() {
        let fake = FakeSnapserver::start(vec![
            ok_status(
                vec![tcp_source("Cuemark", 4953), meta_source("House"), json!({"id": "Spotify"})],
                vec![group("g1", "House"), group("g2", "House")],
            ),
            ok_set_stream(),
            ok_set_stream(),
            // At release: g2 was re-routed to Spotify by someone else; g1 is still ours,
            // but the stream it came from (House) is gone.
            ok_status(
                vec![tcp_source("Cuemark", 4953), json!({"id": "Spotify"})],
                vec![group("g1", "Cuemark"), group("g2", "Spotify")],
            ),
        ]);

        let claim = claim_with_rpc_port(DEVICE, fake.port).expect("claim");
        release(&claim).expect("release");
        // Only the two claim-time switches happened; neither group is restored.
        assert_eq!(
            fake.set_stream_calls(),
            vec![("g1".into(), "Cuemark".into()), ("g2".into(), "Cuemark".into())]
        );
    }

    /// The stream to claim is found by port, so a server without a tcp:// source on that
    /// port must fail loudly (and mention the port) rather than claim nothing silently.
    #[test]
    fn claim_fails_when_no_tcp_source_matches_the_port() {
        let fake = FakeSnapserver::start(vec![ok_status(
            vec![meta_source("House"), json!({"id": "Spotify"})],
            vec![group("g1", "House")],
        )]);
        let err = claim_with_rpc_port(DEVICE, fake.port).expect_err("must fail");
        assert!(err.contains("4953"), "error should name the unmatched port: {err}");
    }
}
