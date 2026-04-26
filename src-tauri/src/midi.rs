use std::collections::HashMap;
use std::sync::Arc;

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
    DeckVolume { deck_id: String, value: f32 },
    DeckPlaybackRate { deck_id: String, value: f32 },
    Crossfader { value: f32 },
    CueJump { deck_id: String },
    HotCue { deck_id: String, index: u8 },
    LoopToggle { deck_id: String },
}

/// What a specific MIDI control does. Stored in the mapping table so the
/// same logic handles any controller: just swap the map (Phase 2: MIDI learn).
#[derive(Clone, Debug)]
pub enum ControlBinding {
    DeckPlayToggle { deck_id: String },
    DeckVolume { deck_id: String },
    DeckPlaybackRate { deck_id: String },
    Crossfader,
    CueJump { deck_id: String },
    HotCue { deck_id: String, index: u8 },
    LoopToggle { deck_id: String },
    /// Relative jog wheel (center=64, above=faster, below=slower)
    JogWheel { deck_id: String },
}

/// Key: (message_type_nibble, data1). Channel nibble is masked out so any
/// MIDI channel works — most DJ controllers send on channel 0.
type MidiMap = HashMap<(u8, u8), ControlBinding>;

/// Default mapping for Hercules DJ Control Starlight.
///
/// Calibration: run `aseqdump -p <port>` while pressing controls to verify
/// the CC/note numbers. Adjust the values below to match your unit.
fn hercules_starlight_map() -> MidiMap {
    let mut m = MidiMap::new();

    // Note On (0x90) ── buttons ─────────────────────────────────────────────
    m.insert((0x90, 11), ControlBinding::DeckPlayToggle { deck_id: "deck-0".into() });
    m.insert((0x90, 12), ControlBinding::DeckPlayToggle { deck_id: "deck-1".into() });
    m.insert((0x90, 13), ControlBinding::CueJump { deck_id: "deck-0".into() });
    m.insert((0x90, 14), ControlBinding::CueJump { deck_id: "deck-1".into() });
    m.insert((0x90, 21), ControlBinding::LoopToggle { deck_id: "deck-0".into() });
    m.insert((0x90, 22), ControlBinding::LoopToggle { deck_id: "deck-1".into() });
    // Hot cues: 3 per deck
    m.insert((0x90, 31), ControlBinding::HotCue { deck_id: "deck-0".into(), index: 0 });
    m.insert((0x90, 32), ControlBinding::HotCue { deck_id: "deck-0".into(), index: 1 });
    m.insert((0x90, 33), ControlBinding::HotCue { deck_id: "deck-0".into(), index: 2 });
    m.insert((0x90, 34), ControlBinding::HotCue { deck_id: "deck-1".into(), index: 0 });
    m.insert((0x90, 35), ControlBinding::HotCue { deck_id: "deck-1".into(), index: 1 });
    m.insert((0x90, 36), ControlBinding::HotCue { deck_id: "deck-1".into(), index: 2 });

    // Control Change (0xB0) ── knobs, faders, wheels ────────────────────────
    m.insert((0xB0, 23), ControlBinding::Crossfader);
    m.insert((0xB0, 24), ControlBinding::DeckVolume { deck_id: "deck-0".into() });
    m.insert((0xB0, 25), ControlBinding::DeckVolume { deck_id: "deck-1".into() });
    m.insert((0xB0, 33), ControlBinding::JogWheel { deck_id: "deck-0".into() });
    m.insert((0xB0, 34), ControlBinding::JogWheel { deck_id: "deck-1".into() });

    m
}

fn resolve_action(binding: &ControlBinding, data2: u8) -> Option<MidiAction> {
    let v = data2 as f32 / 127.0; // 0–1 for absolute controls
    match binding {
        ControlBinding::DeckPlayToggle { deck_id } => {
            (data2 > 0).then_some(MidiAction::DeckPlayToggle { deck_id: deck_id.clone() })
        }
        ControlBinding::DeckVolume { deck_id } => {
            Some(MidiAction::DeckVolume { deck_id: deck_id.clone(), value: v })
        }
        ControlBinding::Crossfader => Some(MidiAction::Crossfader { value: v }),
        ControlBinding::CueJump { deck_id } => {
            (data2 > 0).then_some(MidiAction::CueJump { deck_id: deck_id.clone() })
        }
        ControlBinding::HotCue { deck_id, index } => {
            (data2 > 0).then_some(MidiAction::HotCue { deck_id: deck_id.clone(), index: *index })
        }
        ControlBinding::LoopToggle { deck_id } => {
            (data2 > 0).then_some(MidiAction::LoopToggle { deck_id: deck_id.clone() })
        }
        ControlBinding::JogWheel { deck_id } => {
            // Relative encoder: 64 = centre, 65+ = faster, 63- = slower
            let delta = (data2 as f32 - 64.0) / 64.0;
            let rate = (1.0 + delta * 0.1_f32).clamp(0.25, 4.0);
            Some(MidiAction::DeckPlaybackRate { deck_id: deck_id.clone(), value: rate })
        }
        ControlBinding::DeckPlaybackRate { deck_id } => {
            Some(MidiAction::DeckPlaybackRate { deck_id: deck_id.clone(), value: v * 4.0 })
        }
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

    let _conn = midi_in.connect(
        &port,
        "cuemark-midi",
        move |_stamp, msg, _| {
            if msg.len() < 3 { return; }
            let key = (msg[0] & 0xF0, msg[1]); // mask channel nibble
            if let Some(binding) = map.get(&key) {
                if let Some(action) = resolve_action(binding, msg[2]) {
                    let _ = app.emit("midi-action", action);
                }
            }
        },
        (),
    )?;

    // Hold the connection open. `_conn` drops (closing MIDI) if this returns.
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}
