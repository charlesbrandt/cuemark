//! MIDI input: multiple controllers, each described by a data-driven profile
//! (`profile.rs`), each decoded independently (`decode.rs`), with a hotplug-polling
//! supervisor here that can hold several live connections at once — e.g. the Hercules
//! Starlight and a Pioneer DDJ-FLX4 simultaneously, each addressing its own decks via
//! `Session.midiMapping` (keyed by profile id) on the frontend.
//!
//! Replaces the old single-port, single-hardcoded-map `hercules_starlight_map()` +
//! `run_midi_loop()`. See `docs/design/controller-mapping.md` for the full design.
//!
//! **What this pass deliberately did NOT build** (trimmed scope — see the doc's §11
//! and the commit history around this comment): the EQ/tempo dB→bipolar wire-format
//! normalization (values stay denormalized — actual dB, actual rate — same as before
//! this refactor), a `midi_state.json` version-field migration (the slot-based key
//! rename is a one-time silent break instead, see `decode::persist_kv`'s doc comment),
//! and a multi-controller routing UI in Settings (default slot *i* → `decks[i]` covers
//! the common case; `AudioSettings.svelte`'s L/R selects retarget whichever profile is
//! connected rather than being redesigned for N controllers).

pub mod decode;
pub mod profile;
pub mod monitor;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub use decode::MidiAction;
pub use monitor::MidiRaw;

use decode::Decoder;
use profile::{ActionId, Profile};

use crate::midi_state;

/// Poll interval for hotplug detection. `midir` has no hotplug notification; polling
/// `MidiInput::ports()` and diffing names is the standard approach and is cheap.
const HOTPLUG_POLL: Duration = Duration::from_secs(2);

static NEXT_SOURCE: AtomicU32 = AtomicU32::new(1);

struct Conn {
    source: u32,
    profile_id: String,
    profile_name: String,
    slots: u8,
    jog_ticks_per_rev: f32,
    profile: Arc<Profile>,
    /// `None` when no output port of the same name exists, or opening it failed
    /// (e.g. the controller only exposes a MIDI-in port). LED sends are then a
    /// silent no-op rather than an error — see `send_led`.
    output: Option<MidiOutputConnection>,
    _conn: MidiInputConnection<()>,
}

/// Opens an output connection to the port with this exact name, if one exists.
/// A controller's input and output ports are enumerated separately by `midir` but
/// share the same name on every controller seen so far (Starlight, FLX4) — matching
/// by name is what pairs them up, same as `connect_port` already does for input.
fn connect_output(name: &str) -> Option<MidiOutputConnection> {
    let midi_out = MidiOutput::new("cuemark-out").ok()?;
    let port = midi_out
        .ports()
        .into_iter()
        .find(|p| midi_out.port_name(p).map(|n| n == name).unwrap_or(false))?;
    match midi_out.connect(&port, "cuemark-midi-out") {
        Ok(conn) => Some(conn),
        Err(e) => {
            log::warn!("[midi] failed to open output port {name}: {e}");
            None
        }
    }
}

/// Sends a plain Note On (`on`, vel 127) / Note Off (`on=false`, vel 0) to a
/// bench-verified LED-capable control. Silently does nothing if this connection has
/// no output port or the profile has no `led = true` row for `(slot, action)` — a
/// missing LED byte is a "not captured yet" fact, not an error (see `Control::led`).
fn send_led(conn: &mut Conn, slot: u8, action: ActionId, on: bool) {
    let Some((status, note)) = conn.profile.led_control(slot, action) else { return };
    let Some(out) = conn.output.as_mut() else { return };
    let vel: u8 = if on { 0x7F } else { 0x00 };
    match out.send(&[status, note, vel]) {
        Ok(()) => log::info!(
            "[midi] LED {}: {:?} slot {slot} -> {} (0x{status:02X} 0x{note:02X} 0x{vel:02X})",
            conn.profile_id, action, if on { "on" } else { "off" }
        ),
        Err(e) => log::warn!("[midi] LED send failed on {}: {e}", conn.profile_id),
    }
}

/// Sends Note Off to every bench-verified LED-capable control on this profile, right
/// after its output port connects. Cuemark has no shutdown hook that turns LEDs back
/// off when the app quits or crashes (or loses power) — a controller's LED is a plain
/// latched Note On, not something that times out on its own, so a play/cue/sync LED
/// left lit when the app closed while a deck was live stays lit indefinitely on the
/// hardware until *something* sends the matching Note Off. Blanking here means every
/// launch starts from a known-off state regardless of how the previous run ended,
/// rather than relying on the frontend's reactive LED sync (`ledSync.ts`) to happen to
/// touch that exact control again — which it only does when a deck's boolean actually
/// changes, so a control whose state doesn't change this session would otherwise stay
/// however the previous session left it. Runs once per connect (initial + hotplug
/// reconnect), independent of any frontend/session state, so it can't race the
/// frontend's async controller-list fetch the way a purely JS-side reset would.
fn blank_all_leds(output: &mut MidiOutputConnection, profile: &Profile, port_name: &str) {
    let mut n = 0;
    for (status, note) in profile.all_led_bytes() {
        if output.send(&[status, note, 0x00]).is_ok() {
            n += 1;
        }
    }
    if n > 0 {
        log::info!("[midi] blanked {n} LED(s) on {port_name} ({})", profile.id);
    }
}

/// Generic LED-mirror command — any deck-state boolean (headphone cue, play, sync
/// lock, …) that has a bench-verified `led = true` row for `(slot, action)` on the
/// named profile. `action` deserializes from the same snake_case strings the TOML
/// files use (`ActionId`'s `serde(rename_all = "snake_case")`).
#[tauri::command]
pub fn midi_set_led(profile_id: String, slot: u8, action: ActionId, on: bool) -> Result<(), String> {
    let mut guard = CONNS.lock().unwrap();
    let Some(map) = guard.as_mut() else { return Ok(()) };
    for conn in map.values_mut() {
        if conn.profile_id == profile_id {
            send_led(conn, slot, action, on);
        }
    }
    Ok(())
}

/// Live connections, keyed by port name. `None` until `spawn_listener` runs.
static CONNS: Mutex<Option<HashMap<String, Conn>>> = Mutex::new(None);

/// Full-payload event sent to the frontend: `source`/`profile` disambiguate which
/// controller sent this when two are live, `#[serde(flatten)]` keeps the wire shape
/// as `{source, profile, type, slot, value, ...}` so `handler.ts`'s `switch (a.type)`
/// needs no restructuring beyond reading `slot` instead of `deck_id`.
#[derive(Serialize, Clone)]
struct MidiEvent {
    source: u32,
    profile: String,
    #[serde(flatten)]
    action: MidiAction,
}

#[derive(Serialize, Clone, Debug)]
pub struct MidiPortInfo {
    pub name: String,
    pub connected: bool,
}

/// Enumerate input ports live, without disturbing any open connection. Constructing a
/// second `MidiInput` to list ports does not contend with a live one.
#[tauri::command]
pub fn midi_list_ports() -> Result<Vec<MidiPortInfo>, String> {
    let midi_in = MidiInput::new("cuemark-enum").map_err(|e| e.to_string())?;
    let connected: HashSet<String> = CONNS
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    Ok(midi_in
        .ports()
        .iter()
        .map(|p| {
            let name = midi_in.port_name(p).unwrap_or_default();
            MidiPortInfo { connected: connected.contains(&name), name }
        })
        .collect())
}

#[derive(Serialize, Clone, Debug)]
pub struct ControllerInfo {
    pub source: u32,
    pub port: String,
    pub profile_id: String,
    pub profile_name: String,
    pub slots: u8,
    pub jog_ticks_per_rev: f32,
}

/// The live controller list — what `AudioSettings.svelte` needs to know which
/// profile(s) are connected right now, for its slot-routing selects. Also emitted as
/// `"midi-controllers"` on every connect/disconnect so the UI doesn't have to poll.
#[tauri::command]
pub fn midi_list_controllers() -> Vec<ControllerInfo> {
    CONNS
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| {
            m.iter()
                .map(|(port, c)| ControllerInfo {
                    source: c.source,
                    port: port.clone(),
                    profile_id: c.profile_id.clone(),
                    profile_name: c.profile_name.clone(),
                    slots: c.slots,
                    jog_ticks_per_rev: c.jog_ticks_per_rev,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn emit_controllers(app: &AppHandle) {
    let _ = app.emit("midi-controllers", midi_list_controllers());
}

pub fn spawn_listener(app: AppHandle, persist: midi_state::MidiPersist) -> Result<(), Box<dyn std::error::Error>> {
    let state_path = app.path().app_data_dir()?.join("midi_state.json");
    midi_state::spawn_flusher(Arc::clone(&persist), state_path);

    let app_data = app.path().app_data_dir()?;
    let profiles = Arc::new(profile::load_all(&app_data));
    log::info!(
        "[midi] loaded {} profile(s): {}",
        profiles.len(),
        profiles.iter().map(|p| p.id.as_str()).collect::<Vec<_>>().join(", ")
    );

    *CONNS.lock().unwrap() = Some(HashMap::new());

    std::thread::spawn(move || supervisor_loop(app, profiles, persist));
    Ok(())
}

/// Polls for new/gone ports every `HOTPLUG_POLL`, opening one connection per matched
/// profile and closing any whose port disappeared. Runs forever on its own thread.
fn supervisor_loop(app: AppHandle, profiles: Arc<Vec<Profile>>, persist: midi_state::MidiPersist) {
    let mut seen_unmatched: HashSet<String> = HashSet::new();

    loop {
        if let Ok(midi_in) = MidiInput::new("cuemark-enum") {
            let ports = midi_in.ports();
            let mut live_names: HashSet<String> = HashSet::new();

            for p in &ports {
                let Ok(name) = midi_in.port_name(p) else { continue };
                live_names.insert(name.clone());

                let already_open = CONNS
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|m| m.contains_key(&name))
                    .unwrap_or(false);
                if already_open {
                    continue;
                }

                let lname = name.to_lowercase();
                let Some(profile) = profiles.iter().find(|pr| pr.match_names.iter().any(|m| lname.contains(m.as_str()))) else {
                    // Log once per unmatched name so a DAW keyboard plugged into the
                    // same machine doesn't spam the log every poll.
                    if seen_unmatched.insert(name.clone()) {
                        log::info!("[midi] unmatched port (not opened): {name}");
                    }
                    continue;
                };

                match connect_port(&app, &name, profile, &persist) {
                    Ok(conn) => {
                        log::info!("[midi] connected to: {name} (profile: {})", conn.profile_id);
                        CONNS.lock().unwrap().as_mut().unwrap().insert(name.clone(), conn);
                        emit_controllers(&app);
                    }
                    Err(e) => log::warn!("[midi] failed to connect {name}: {e}"),
                }
            }

            let mut removed = false;
            {
                let mut guard = CONNS.lock().unwrap();
                if let Some(m) = guard.as_mut() {
                    let gone: Vec<String> = m.keys().filter(|k| !live_names.contains(*k)).cloned().collect();
                    for k in gone {
                        m.remove(&k);
                        log::info!("[midi] disconnected: {k}");
                        removed = true;
                    }
                }
            }
            if removed {
                emit_controllers(&app);
            }
        }

        std::thread::sleep(HOTPLUG_POLL);
    }
}

/// Open one connection. A fresh `MidiInput` is required here (not the enumerating one
/// from the caller) because `midir`'s `connect()` consumes `self`, and the caller
/// needs to keep enumerating other ports in the same poll pass.
fn connect_port(app: &AppHandle, name: &str, profile: &Profile, persist: &midi_state::MidiPersist) -> Result<Conn, String> {
    let midi_in = MidiInput::new("cuemark").map_err(|e| e.to_string())?;
    let mut midi_in = midi_in;
    midi_in.ignore(Ignore::None);
    let port = midi_in
        .ports()
        .into_iter()
        .find(|p| midi_in.port_name(p).map(|n| n == name).unwrap_or(false))
        .ok_or_else(|| "port vanished before connect".to_string())?;

    let source = NEXT_SOURCE.fetch_add(1, Ordering::Relaxed);
    let app2 = app.clone();
    let persist2 = Arc::clone(persist);
    let profile_arc = Arc::new(profile.clone());
    let profile2 = Arc::clone(&profile_arc);
    let port_name = name.to_string();
    let mut output = connect_output(name);
    if let Some(out) = output.as_mut() {
        log::info!("[midi] opened output port: {name}");
        blank_all_leds(out, &profile, name);
    }
    let mut decoder = Decoder::new();
    let mut log_throttle: HashMap<(u8, u8), Instant> = HashMap::new();

    let conn = midi_in
        .connect(
            &port,
            "cuemark-midi",
            move |_stamp, msg, _| {
                // Raw monitor first, ahead of every filter below — see monitor.rs and
                // docs/design/controller-mapping.md §7a for why nothing may run before this.
                if monitor::is_monitor_on() {
                    let mapped = if msg.len() >= 2 {
                        profile2.map.get(&(msg[0], msg[1])).map(|b| format!("{b:?}"))
                    } else {
                        None
                    };
                    let _ = app2.emit(
                        "midi-raw",
                        MidiRaw {
                            source,
                            port: port_name.clone(),
                            bytes: msg.iter().take(monitor::MAX_RAW_BYTES).copied().collect(),
                            len: msg.len(),
                            t: crate::epoch_ms(),
                            mapped,
                        },
                    );
                }

                if msg.len() < 3 {
                    return;
                }
                let key = (msg[0], msg[1]);
                let is_cont = profile2.is_continuous(key);
                let should_log = if is_cont {
                    let now = Instant::now();
                    let due = log_throttle
                        .get(&key)
                        .map(|&t| now.duration_since(t) >= Duration::from_millis(500))
                        .unwrap_or(true);
                    if due {
                        log_throttle.insert(key, now);
                    }
                    due
                } else {
                    true
                };

                if should_log {
                    log::info!(
                        "[midi/{port_name}] status=0x{:02X}  d1={:3}  d2={:3}",
                        msg[0], msg[1], msg[2]
                    );
                }

                let Some(action) = decoder.decode(&profile2, msg) else {
                    if should_log {
                        log::info!("[midi/{port_name}]   (unmapped/no action)");
                    }
                    return;
                };

                if should_log {
                    log::info!("[midi/{port_name}]   => {:?}", action);
                }
                if let Some((k, v)) = decode::persist_kv(&profile2.id, &action) {
                    midi_state::mark_dirty(&persist2, &k, v);
                }
                let _ = app2.emit(
                    "midi-action",
                    MidiEvent { source, profile: profile2.id.clone(), action },
                );
            },
            (),
        )
        .map_err(|e| e.to_string())?;

    Ok(Conn {
        source,
        profile_id: profile.id.clone(),
        profile_name: profile.name.clone(),
        slots: profile.slots,
        jog_ticks_per_rev: profile.jog_ticks_per_rev,
        profile: profile_arc,
        output,
        _conn: conn,
    })
}
