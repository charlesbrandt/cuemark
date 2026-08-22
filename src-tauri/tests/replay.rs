//! Capture-and-replay: real byte captures from the raw MIDI monitor
//! (docs/design/controller-mapping.md §7a/§9), fed through the actual decoder with no
//! controller attached. Fixtures copied from `~/.local/share/com.cuemark.app/midi-captures/`
//! into `tests/captures/` on 2026-08-22.

use cuemark_lib::midi::decode::Decoder;
use cuemark_lib::midi::profile::builtins;
use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize)]
struct Capture {
    messages: Vec<Msg>,
}

#[derive(Deserialize)]
struct Msg {
    bytes: Vec<u8>,
}

fn load(path: &str) -> Capture {
    let full = Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    let data = std::fs::read_to_string(&full).unwrap_or_else(|e| panic!("failed to read {full:?}: {e}"));
    serde_json::from_str(&data).unwrap_or_else(|e| panic!("failed to parse {full:?}: {e}"))
}

/// The load-bearing assertion from the plan: `jog_ticks_per_rev` must stay ~721.7, or
/// this fails loudly instead of quietly running the FLX4's jog 2.8x off. The capture
/// is ~10 physical revolutions (5 slow + 5 fast, per the live calibration session);
/// summing decoded JogTurn.value should land close to 10.0 regardless of the mix of
/// slow/fast ticks in between, since revolutions are ticks / jog_ticks_per_rev.
#[test]
fn flx4_jog_replay_lands_near_ten_revolutions() {
    let capture = load("tests/captures/flx4-jog-10rev.json");
    let profile = builtins().into_iter().find(|p| p.id == "pioneer-ddj-flx4").unwrap();
    let mut decoder = Decoder::new();

    let mut total_revs = 0.0f32;
    let mut n_actions = 0;
    for m in &capture.messages {
        if let Some(action) = decoder.decode(&profile, &m.bytes) {
            if let cuemark_lib::midi::MidiAction::JogTurn { value, .. } = action {
                total_revs += value.abs();
                n_actions += 1;
            }
        }
    }

    assert!(n_actions > 1000, "expected thousands of jog ticks in this capture, got {n_actions}");
    assert!(
        (total_revs - 10.0).abs() < 1.0,
        "expected ~10 revolutions (5 slow + 5 fast) at jog_ticks_per_rev=721.7, got {total_revs:.2} \
         from {n_actions} ticks — a wrong constant (e.g. the Starlight's 256) would land far off this"
    );
}

/// Sanity check that the Starlight capture still decodes through its own profile —
/// not a calibration assertion (this file is a short bench sample, not a
/// counted-revolution capture), just proof the replay path works for both profiles.
#[test]
fn starlight_capture_replays_without_panicking() {
    let capture = load("tests/captures/starlight-sample.json");
    let profile = builtins().into_iter().find(|p| p.id == "hercules-starlight").unwrap();
    let mut decoder = Decoder::new();

    let mut n_actions = 0;
    for m in &capture.messages {
        if decoder.decode(&profile, &m.bytes).is_some() {
            n_actions += 1;
        }
    }
    assert!(n_actions > 0, "expected at least one message in this capture to decode to an action");
}
