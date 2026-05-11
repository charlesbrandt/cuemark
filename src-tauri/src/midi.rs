use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use midir::MidiInput;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Actions emitted to the frontend via Tauri IPC.
/// All deck references use string IDs, never indices, so N-deck sessions work.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MidiAction {
    DeckPlayToggle { deck_id: String },
    DeckOpacity { deck_id: String, value: f32 },
    DeckGain { deck_id: String, value: f32 },
    DeckVolume { deck_id: String, value: f32 },
    DeckPlaybackRate { deck_id: String, value: f32 },
    /// Relative jog nudge: value is steps (-63..+63); frontend applies ±2%/step and resets after idle.
    JogNudge { deck_id: String, value: f32 },
    Crossfader { value: f32 },
    MasterVolume { value: f32 },
    CueGain { value: f32 },
    CueJump { deck_id: String },
    HotCue { deck_id: String, index: u8 },
    HotCueSet { deck_id: String, index: u8 },
    LoopToggle { deck_id: String },
    SyncToggle { deck_id: String },
    HeadphoneCue { deck_id: String },
    PhaseNudge { deck_id: String },
}

/// What a specific MIDI control does. Stored in the mapping table so the
/// same logic handles any controller: just swap the map (Phase 2: MIDI learn).
#[derive(Clone, Debug)]
pub enum ControlBinding {
    DeckPlayToggle { deck_id: String },
    /// Pre-fader trim: normalizes source level independently of the crossfader.
    DeckGain { deck_id: String },
    DeckVolume { deck_id: String },
    /// Coarse (MSB) half of a 14-bit pitch/tempo fader.
    /// Fine (LSB) CC is this CC + 32; both are combined in run_midi_loop.
    DeckPlaybackRate { deck_id: String },
    /// Fine (LSB) half of the 14-bit pitch/tempo pair. Handled alongside the MSB.
    DeckPlaybackRateLsb { deck_id: String },
    Crossfader,
    MasterVolume,
    CueGain,
    CueJump { deck_id: String },
    HotCue { deck_id: String, index: u8 },
    HotCueSet { deck_id: String, index: u8 },
    LoopToggle { deck_id: String },
    SyncToggle { deck_id: String },
    HeadphoneCue { deck_id: String },
    // Nudge deck phase toward the reference deck's phase. No free button on the
    // Starlight — assign via MIDI learn (Phase 2) or add to a custom map.
    PhaseNudge { deck_id: String },
    /// Relative jog wheel (7-bit two's complement: 1–63 = CW, 64–127 = CCW)
    JogWheel { deck_id: String },
}

/// Key: (full_status_byte, data1).
/// Channel is NOT masked — the Starlight sends left/right decks on separate
/// MIDI channels (0x90/0xB0 = ch1 left, 0x91/0xB1 = ch2 right).
type MidiMap = HashMap<(u8, u8), ControlBinding>;

/// Hercules DJControl Starlight MIDI map.
/// Keys are (full_status_byte, data1) — channel nibble is NOT masked.
///
/// Channel layout (confirmed by hardware):
///   ch 2  (0x91 Note On, 0xB1 CC) = left deck
///   ch 3  (0x92 Note On, 0xB2 CC) = right deck
///   ch 7  (0x96 Note On)          = left hot cues
///   ch 8  (0x97 Note On)          = right hot cues (by symmetry; unverified)
///   ch 1  (0xB0 CC)               = global (crossfader)
///
/// 14-bit CC pairs: controller sends coarse MSB on CC N and fine LSB on CC N+32.
/// We map the MSB only; 7-bit (128-step) resolution is sufficient for all controls.
fn hercules_starlight_map() -> MidiMap {
    let mut m = MidiMap::new();

    // ── Left deck (ch 2) ──────────────────────────────────────────────────
    m.insert((0x91, 7),  ControlBinding::DeckPlayToggle { deck_id: "deck-0".into() });
    m.insert((0x91, 6),  ControlBinding::CueJump        { deck_id: "deck-0".into() });
    // Notes 3 and 5 confirmed by hardware: Loop=note3, Vinyl/Scratch(Sync)=note5
    m.insert((0x91, 3),  ControlBinding::LoopToggle     { deck_id: "deck-0".into() });
    m.insert((0x91, 5),  ControlBinding::SyncToggle     { deck_id: "deck-0".into() });
    // CC: volume/gain fader (CC 0 coarse; CC 32 fine — ignored)
    // Mapped to DeckGain (pre-fader trim) so the fader normalizes source level;
    // crossfader drives DeckVolume separately.
    m.insert((0xB1, 0),  ControlBinding::DeckGain       { deck_id: "deck-0".into() });
    // CC: tempo/pitch fader — 14-bit pair: CC 8 (MSB) + CC 40 (LSB, = 8+32)
    m.insert((0xB1, 8),  ControlBinding::DeckPlaybackRate    { deck_id: "deck-0".into() });
    m.insert((0xB1, 40), ControlBinding::DeckPlaybackRateLsb { deck_id: "deck-0".into() });
    // CC: bass/filter knob (CC 2 coarse; CC 34 fine — ignored)
    // TODO: wire to shader u_bass_gain once Phase 2 audio-reactive uniforms land
    // Jog wheel rotation (relative encoder, CC 10, two's complement)
    m.insert((0xB1, 10), ControlBinding::JogWheel       { deck_id: "deck-0".into() });
    // Hot cues on ch 7 (d1 = cue index 0–3); Shift+pad sends d1+8 on same channel
    m.insert((0x96, 0),  ControlBinding::HotCue    { deck_id: "deck-0".into(), index: 0 });
    m.insert((0x96, 1),  ControlBinding::HotCue    { deck_id: "deck-0".into(), index: 1 });
    m.insert((0x96, 2),  ControlBinding::HotCue    { deck_id: "deck-0".into(), index: 2 });
    m.insert((0x96, 3),  ControlBinding::HotCue    { deck_id: "deck-0".into(), index: 3 });
    m.insert((0x96, 8),  ControlBinding::HotCueSet { deck_id: "deck-0".into(), index: 0 });
    m.insert((0x96, 9),  ControlBinding::HotCueSet { deck_id: "deck-0".into(), index: 1 });
    m.insert((0x96, 10), ControlBinding::HotCueSet { deck_id: "deck-0".into(), index: 2 });
    m.insert((0x96, 11), ControlBinding::HotCueSet { deck_id: "deck-0".into(), index: 3 });

    // ── Right deck (ch 3) ─────────────────────────────────────────────────
    m.insert((0x92, 7),  ControlBinding::DeckPlayToggle { deck_id: "deck-1".into() });
    m.insert((0x92, 6),  ControlBinding::CueJump        { deck_id: "deck-1".into() });
    m.insert((0x92, 3),  ControlBinding::LoopToggle     { deck_id: "deck-1".into() });
    m.insert((0x92, 5),  ControlBinding::SyncToggle     { deck_id: "deck-1".into() });
    m.insert((0xB2, 0),  ControlBinding::DeckGain       { deck_id: "deck-1".into() });
    m.insert((0xB2, 8),  ControlBinding::DeckPlaybackRate    { deck_id: "deck-1".into() });
    m.insert((0xB2, 40), ControlBinding::DeckPlaybackRateLsb { deck_id: "deck-1".into() });
    m.insert((0xB2, 10), ControlBinding::JogWheel       { deck_id: "deck-1".into() });
    // Right hot cues on ch 8; Shift+pad sends d1+8 on same channel
    m.insert((0x97, 0),  ControlBinding::HotCue    { deck_id: "deck-1".into(), index: 0 });
    m.insert((0x97, 1),  ControlBinding::HotCue    { deck_id: "deck-1".into(), index: 1 });
    m.insert((0x97, 2),  ControlBinding::HotCue    { deck_id: "deck-1".into(), index: 2 });
    m.insert((0x97, 3),  ControlBinding::HotCue    { deck_id: "deck-1".into(), index: 3 });
    m.insert((0x97, 8),  ControlBinding::HotCueSet { deck_id: "deck-1".into(), index: 0 });
    m.insert((0x97, 9),  ControlBinding::HotCueSet { deck_id: "deck-1".into(), index: 1 });
    m.insert((0x97, 10), ControlBinding::HotCueSet { deck_id: "deck-1".into(), index: 2 });
    m.insert((0x97, 11), ControlBinding::HotCueSet { deck_id: "deck-1".into(), index: 3 });

    // ── Global (ch 1) ─────────────────────────────────────────────────────
    // Crossfader: 14-bit pair — CC 0 (MSB) mapped; CC 32 (LSB) ignored
    m.insert((0xB0, 0),  ControlBinding::Crossfader);
    // Master volume: 14-bit pair — CC 3 (MSB) mapped; CC 35 (LSB) ignored
    m.insert((0xB0, 3),  ControlBinding::MasterVolume);
    // Headphone volume knob: 14-bit pair — CC 4 (MSB) mapped; CC 36 (LSB) ignored
    m.insert((0xB0, 4),  ControlBinding::CueGain);
    // Headphone CUE buttons (Note On, velocity > 0 = press)
    m.insert((0x91, 12), ControlBinding::HeadphoneCue { deck_id: "deck-0".into() });
    m.insert((0x92, 12), ControlBinding::HeadphoneCue { deck_id: "deck-1".into() });
    // Unmapped (no action needed):
    //   (0x90, 3)  = Shift button — controller remaps pads in firmware; no host tracking needed
    //   (0x90, 1)  = Bass/filter toggle
    //   (0x91, 15) = Hot-cue mode btn  (0x91, 16) = Loop mode btn

    m
}

/// Returns true for controls that fire many events/second (faders, encoders).
/// These get log-throttled; discrete controls (buttons) always log.
fn is_continuous(binding: Option<&ControlBinding>, status: u8) -> bool {
    match binding {
        Some(
            ControlBinding::DeckPlaybackRate { .. }
            | ControlBinding::DeckPlaybackRateLsb { .. }
            | ControlBinding::DeckGain { .. }
            | ControlBinding::DeckVolume { .. }
            | ControlBinding::Crossfader
            | ControlBinding::MasterVolume
            | ControlBinding::CueGain
            | ControlBinding::JogWheel { .. },
        ) => true,
        None => (status & 0xF0) == 0xB0, // unmapped CC — throttle too
        _ => false,
    }
}

/// Combine 14-bit MSB+LSB into a playback rate.
/// 14-bit range: 0–16383; center = 8192 (MSB=64, LSB=0); full throw = ±50%.
fn rate_from_14bit(msb: u8, lsb: u8) -> f32 {
    let combined = (msb as u16) << 7 | lsb as u16;
    // Starlight sends higher values for negative pitch (pushing down = faster).
    // Negate so that down (lower combined) → rate > 1.0.
    let delta = (8192.0_f32 - combined as f32) / 8192.0;
    (1.0 + delta * 0.5_f32).clamp(0.25, 4.0)
}

fn resolve_action(binding: &ControlBinding, data2: u8) -> Option<MidiAction> {
    let v = data2 as f32 / 127.0; // 0–1 for absolute controls
    match binding {
        ControlBinding::DeckPlayToggle { deck_id } => {
            (data2 > 0).then_some(MidiAction::DeckPlayToggle { deck_id: deck_id.clone() })
        }
        ControlBinding::DeckGain { deck_id } => {
            Some(MidiAction::DeckGain { deck_id: deck_id.clone(), value: v })
        }
        ControlBinding::DeckVolume { deck_id } => {
            Some(MidiAction::DeckVolume { deck_id: deck_id.clone(), value: v })
        }
        ControlBinding::Crossfader => Some(MidiAction::Crossfader { value: v }),
        ControlBinding::MasterVolume => Some(MidiAction::MasterVolume { value: v }),
        ControlBinding::CueGain => Some(MidiAction::CueGain { value: v }),
        ControlBinding::CueJump { deck_id } => {
            (data2 > 0).then_some(MidiAction::CueJump { deck_id: deck_id.clone() })
        }
        ControlBinding::HotCue { deck_id, index } => {
            (data2 > 0).then_some(MidiAction::HotCue { deck_id: deck_id.clone(), index: *index })
        }
        ControlBinding::HotCueSet { deck_id, index } => {
            (data2 > 0).then_some(MidiAction::HotCueSet { deck_id: deck_id.clone(), index: *index })
        }
        ControlBinding::LoopToggle { deck_id } => {
            (data2 > 0).then_some(MidiAction::LoopToggle { deck_id: deck_id.clone() })
        }
        ControlBinding::SyncToggle { deck_id } => {
            (data2 > 0).then_some(MidiAction::SyncToggle { deck_id: deck_id.clone() })
        }
        ControlBinding::HeadphoneCue { deck_id } => {
            (data2 > 0).then_some(MidiAction::HeadphoneCue { deck_id: deck_id.clone() })
        }
        ControlBinding::PhaseNudge { deck_id } => {
            (data2 > 0).then_some(MidiAction::PhaseNudge { deck_id: deck_id.clone() })
        }
        ControlBinding::JogWheel { deck_id } => {
            // 7-bit two's complement: values 1–63 = CW (+), 64–127 = CCW (−).
            let step = if data2 >= 64 { data2 as i32 - 128 } else { data2 as i32 };
            Some(MidiAction::JogNudge { deck_id: deck_id.clone(), value: step as f32 })
        }
        // 14-bit rate bindings are handled in run_midi_loop where MSB/LSB state lives.
        ControlBinding::DeckPlaybackRate { .. } | ControlBinding::DeckPlaybackRateLsb { .. } => None,
    }
}

pub fn spawn_listener(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let midi_map = Arc::new(hercules_starlight_map());
    std::thread::spawn(move || {
        if let Err(e) = run_midi_loop(&app, &midi_map) {
            eprintln!("[midi] listener error: {e}");
        }
    });
    Ok(())
}

fn run_midi_loop(app: &AppHandle, midi_map: &Arc<MidiMap>) -> Result<(), Box<dyn std::error::Error>> {
    let midi_in = MidiInput::new("cuemark")?;
    let ports = midi_in.ports();

    let port = {
        let mut found = None;
        for p in ports {
            let name = midi_in.port_name(&p).unwrap_or_default().to_lowercase();
            if name.contains("hercules") || name.contains("starlight") {
                found = Some(p);
                break;
            }
        }
        match found {
            Some(p) => p,
            None => {
                let ports2 = midi_in.ports();
                eprintln!("[midi] Hercules Starlight not found. Available ports:");
                for p in &ports2 {
                    eprintln!("  {}", midi_in.port_name(p).unwrap_or_default());
                }
                return Ok(());
            }
        }
    };

    let port_name = midi_in.port_name(&port)?;
    println!("[midi] connected to: {port_name}");

    let app = app.clone();
    let map = Arc::clone(midi_map);

    // 14-bit CC pair state: keyed by (status_byte, msb_cc_num).
    // Both MSB and LSB handlers look up by the MSB key (LSB key = MSB key with cc+32).
    let mut cc14_msb: HashMap<(u8, u8), u8> = HashMap::new();
    let mut cc14_lsb: HashMap<(u8, u8), u8> = HashMap::new();
    // Log throttle for continuous controls: only log once per 500 ms per key.
    let mut log_throttle: HashMap<(u8, u8), Instant> = HashMap::new();

    let _conn = midi_in.connect(
        &port,
        "cuemark-midi",
        move |_stamp, msg, _| {
            if msg.len() < 3 { return; }
            let msg_type = match msg[0] & 0xF0 {
                0x80 => "NoteOff",
                0x90 => "NoteOn ",
                0xB0 => "CC     ",
                _    => "Other  ",
            };
            let channel = (msg[0] & 0x0F) + 1;
            let key = (msg[0], msg[1]);

            // Continuous controls (faders, encoders) are throttled to one log line
            // per 500 ms so they don't drown out button/note events.
            let should_log = if is_continuous(map.get(&key), msg[0]) {
                let now = Instant::now();
                let due = log_throttle
                    .get(&key)
                    .map(|&t| now.duration_since(t) >= Duration::from_millis(500))
                    .unwrap_or(true);
                if due { log_throttle.insert(key, now); }
                due
            } else {
                true
            };

            if should_log {
                eprintln!("[midi] {msg_type} ch{channel:02}  status=0x{:02X}  d1={:3}  d2={:3}",
                    msg[0], msg[1], msg[2]);
            }

            let Some(binding) = map.get(&key) else {
                if should_log { eprintln!("[midi]   (unmapped)"); }
                return;
            };

            // 14-bit rate bindings need mutable state; handle them before resolve_action.
            let action = match binding {
                ControlBinding::DeckPlaybackRate { deck_id } => {
                    let msb_key = key;
                    cc14_msb.insert(msb_key, msg[2]);
                    let lsb = cc14_lsb.get(&msb_key).copied().unwrap_or(0);
                    Some(MidiAction::DeckPlaybackRate {
                        deck_id: deck_id.clone(),
                        value: rate_from_14bit(msg[2], lsb),
                    })
                }
                ControlBinding::DeckPlaybackRateLsb { deck_id } => {
                    // LSB CC = MSB CC + 32, so MSB key = (same status, this_cc - 32)
                    let msb_key = (msg[0], msg[1] - 32);
                    cc14_lsb.insert(msb_key, msg[2]);
                    let msb = cc14_msb.get(&msb_key).copied().unwrap_or(64);
                    Some(MidiAction::DeckPlaybackRate {
                        deck_id: deck_id.clone(),
                        value: rate_from_14bit(msb, msg[2]),
                    })
                }
                other => resolve_action(other, msg[2]),
            };

            if let Some(action) = action {
                if should_log { eprintln!("[midi]   => {:?}", action); }
                let _ = app.emit("midi-action", action);
            } else if should_log {
                eprintln!("[midi]   (no action)");
            }
        },
        (),
    )?;

    // Hold the connection open. `_conn` drops (closing MIDI) if this returns.
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}
