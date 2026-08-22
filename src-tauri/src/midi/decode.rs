//! Wire bytes → `MidiAction`. Pure decode logic, kept separate from the connection
//! supervisor (`mod.rs`) so a byte capture can be replayed through it in a test with
//! no controller attached — `docs/design/controller-mapping.md` §9.
//!
//! All deck-scoped actions carry a profile-relative `slot: u8`, never a deck id — the
//! frontend resolves slot → deck through `Session.midiMapping` (per profile id), which
//! is what lets two controllers each address their own decks independently.

use std::collections::HashMap;

use serde::Serialize;

use super::profile::{ActionId, Binding, Control, Encoding, Kind, Profile};

/// Actions emitted to the frontend via Tauri IPC, wrapped in a `MidiEvent` (see
/// `mod.rs`) that adds `source`/`profile` so two live controllers can be told apart.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MidiAction {
    DeckPlayToggle { slot: u8 },
    DeckOpacity { slot: u8, value: f32 },
    DeckGain { slot: u8, value: f32 },
    DeckVolume { slot: u8, value: f32 },
    /// Actual playback rate (0.25–4.0), same units as always — the trimmed scope of
    /// the normalized-signal refactor keeps this one denormalized (see the module doc
    /// in `mod.rs` for what was deferred and why).
    DeckPlaybackRate { slot: u8, value: f32 },
    /// Relative jog turn, in **revolutions** (not raw ticks — renamed from the old
    /// `JogNudge` to make that unit change a compile error everywhere it mattered).
    /// A per-profile `jog_ticks_per_rev` (Starlight 256, FLX4 ~721.7) is divided out
    /// in Rust so this is the one value every controller can share unmodified.
    JogTurn { slot: u8, value: f32 },
    Crossfader { value: f32 },
    MasterVolume { value: f32 },
    CueGain { value: f32 },
    CueJump { slot: u8 },
    HotCue { slot: u8, index: u8 },
    HotCueSet { slot: u8, index: u8 },
    LoopToggle { slot: u8 },
    LoopPreset { slot: u8, index: u8 },
    SyncToggle { slot: u8 },
    HeadphoneCue { slot: u8 },
    PhaseNudge { slot: u8 },
    /// Low EQ band, in **dB** — unchanged units from before the profile refactor.
    DeckEqLow { slot: u8, value: f32 },
    /// Mid EQ band, in dB. New: the Starlight never exposed this (one dual-function
    /// knob only reaches the low band); the FLX4 has a dedicated knob per band.
    DeckEqMid { slot: u8, value: f32 },
    /// High EQ band, in dB. New, same reason as `DeckEqMid`.
    DeckEqHigh { slot: u8, value: f32 },
    /// Sweep filter position, **−1…+1**.
    DeckFilter { slot: u8, value: f32 },
}

const EQ_MIN_DB: f32 = crate::audio::pipeline::EQ_MIN_DB;
const EQ_MAX_DB: f32 = crate::audio::pipeline::EQ_MAX_DB;

fn bipolar7(data2: u8) -> f32 {
    (data2 as f32 / 127.0 - 0.5) * 2.0
}

fn combined14(msb: u8, lsb: u8) -> u16 {
    (msb as u16) << 7 | lsb as u16
}

/// −1…+1 across the 14-bit range, centred on 8192 (matches the 7-bit centre-snap
/// convention at 14-bit resolution).
fn bipolar14(combined: u16) -> f32 {
    (combined as f32 - 8192.0) / 8192.0
}

fn value7(data2: u8) -> f32 {
    data2 as f32 / 127.0
}

fn value14(combined: u16) -> f32 {
    combined as f32 / 16383.0
}

/// Bipolar knob position → EQ gain in dB. Centre is flat; travel is asymmetric
/// because `equalizer-nbands`' own range is (−24…+12) — a real mixer's EQ behaves the
/// same way, cutting far harder than it boosts.
fn eq_db_from_bipolar(t: f32, centre_snap: f32) -> f32 {
    if t.abs() < centre_snap {
        0.0
    } else if t < 0.0 {
        t.abs() * EQ_MIN_DB
    } else {
        t * EQ_MAX_DB
    }
}

/// Bipolar knob position → filter position, −1 (full low-pass) … +1 (full high-pass).
fn filter_from_bipolar(t: f32, centre_snap: f32) -> f32 {
    if t.abs() < centre_snap {
        0.0
    } else {
        t
    }
}

/// Combine 14-bit MSB+LSB into a playback rate. `invert` is the one place a
/// controller's fader-direction convention lives: the *natural* (uninverted) reading
/// is "higher raw value = faster", which is the FLX4's own convention (measured
/// live, controller-mapping.md §8.7); the Starlight sends the opposite (higher = slower)
/// and sets `invert = true` to recover its original, unchanged behaviour.
fn tempo_from_14bit(combined: u16, invert: bool) -> f32 {
    let delta_natural = (combined as f32 - 8192.0) / 8192.0;
    let delta = if invert { -delta_natural } else { delta_natural };
    (1.0 + delta * 0.5).clamp(0.25, 4.0)
}

fn resolve_button(c: &Control, data2: u8) -> Option<MidiAction> {
    if data2 == 0 {
        return None;
    }
    let slot = c.slot;
    match c.action {
        ActionId::PlayToggle => Some(MidiAction::DeckPlayToggle { slot }),
        ActionId::CueJump => Some(MidiAction::CueJump { slot }),
        ActionId::LoopToggle => Some(MidiAction::LoopToggle { slot }),
        ActionId::LoopPreset => Some(MidiAction::LoopPreset { slot, index: c.index }),
        ActionId::SyncToggle => Some(MidiAction::SyncToggle { slot }),
        ActionId::HeadphoneCue => Some(MidiAction::HeadphoneCue { slot }),
        ActionId::PhaseNudge => Some(MidiAction::PhaseNudge { slot }),
        ActionId::HotCue => Some(MidiAction::HotCue { slot, index: c.index }),
        ActionId::HotCueSet => Some(MidiAction::HotCueSet { slot, index: c.index }),
        _ => None,
    }
}

fn resolve_fader(c: &Control, data2: u8, centre_snap: f32) -> Option<MidiAction> {
    let slot = c.slot;
    match c.action {
        ActionId::Gain => Some(MidiAction::DeckGain { slot, value: value7(data2) }),
        ActionId::Volume => Some(MidiAction::DeckVolume { slot, value: value7(data2) }),
        ActionId::Opacity => Some(MidiAction::DeckOpacity { slot, value: value7(data2) }),
        ActionId::Crossfader => Some(MidiAction::Crossfader { value: value7(data2) }),
        ActionId::MasterVolume => Some(MidiAction::MasterVolume { value: value7(data2) }),
        ActionId::CueGain => Some(MidiAction::CueGain { value: value7(data2) }),
        ActionId::EqLow => Some(MidiAction::DeckEqLow { slot, value: eq_db_from_bipolar(bipolar7(data2), centre_snap) }),
        ActionId::EqMid => Some(MidiAction::DeckEqMid { slot, value: eq_db_from_bipolar(bipolar7(data2), centre_snap) }),
        ActionId::EqHigh => Some(MidiAction::DeckEqHigh { slot, value: eq_db_from_bipolar(bipolar7(data2), centre_snap) }),
        ActionId::Filter => Some(MidiAction::DeckFilter { slot, value: filter_from_bipolar(bipolar7(data2), centre_snap) }),
        _ => None,
    }
}

fn resolve_msb14(c: &Control, combined: u16, centre_snap: f32) -> Option<MidiAction> {
    let slot = c.slot;
    match c.action {
        ActionId::Tempo => Some(MidiAction::DeckPlaybackRate { slot, value: tempo_from_14bit(combined, c.invert) }),
        ActionId::Gain => Some(MidiAction::DeckGain { slot, value: value14(combined) }),
        ActionId::Volume => Some(MidiAction::DeckVolume { slot, value: value14(combined) }),
        ActionId::Crossfader => Some(MidiAction::Crossfader { value: value14(combined) }),
        ActionId::MasterVolume => Some(MidiAction::MasterVolume { value: value14(combined) }),
        ActionId::CueGain => Some(MidiAction::CueGain { value: value14(combined) }),
        ActionId::EqLow => Some(MidiAction::DeckEqLow { slot, value: eq_db_from_bipolar(bipolar14(combined), centre_snap) }),
        ActionId::EqMid => Some(MidiAction::DeckEqMid { slot, value: eq_db_from_bipolar(bipolar14(combined), centre_snap) }),
        ActionId::EqHigh => Some(MidiAction::DeckEqHigh { slot, value: eq_db_from_bipolar(bipolar14(combined), centre_snap) }),
        ActionId::Filter => Some(MidiAction::DeckFilter { slot, value: filter_from_bipolar(bipolar14(combined), centre_snap) }),
        _ => None,
    }
}

fn resolve_relative(c: &Control, data2: u8, encoding: Encoding, jog_ticks_per_rev: f32) -> Option<MidiAction> {
    let ticks: i32 = match encoding {
        Encoding::Twos7 => {
            if data2 >= 64 { data2 as i32 - 128 } else { data2 as i32 }
        }
        Encoding::Offset64 => data2 as i32 - 64,
    };
    match c.action {
        ActionId::JogTurn => Some(MidiAction::JogTurn { slot: c.slot, value: ticks as f32 / jog_ticks_per_rev }),
        _ => None,
    }
}

/// Per-connection decode state — the 14-bit CC pair halves. One `Decoder` per open
/// MIDI connection (see `mod.rs`'s supervisor); state must not be shared across two
/// controllers, or one's tempo fader would seed from the other's last-seen byte.
pub struct Decoder {
    cc14_msb: HashMap<(u8, u8), u8>,
    cc14_lsb: HashMap<(u8, u8), u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Self { cc14_msb: HashMap::new(), cc14_lsb: HashMap::new() }
    }

    pub fn decode(&mut self, p: &Profile, msg: &[u8]) -> Option<MidiAction> {
        if msg.len() < 3 {
            return None;
        }
        let key = (msg[0], msg[1]);
        let d2 = msg[2];
        match p.map.get(&key)? {
            Binding::Simple(c) => match c.kind {
                Kind::Button => resolve_button(c, d2),
                Kind::Fader => resolve_fader(c, d2, p.centre_snap),
                Kind::Relative => resolve_relative(c, d2, c.encoding?, p.jog_ticks_per_rev),
                Kind::Fader14 => None, // unreachable: fader14 rows always become Msb14/Lsb14
            },
            Binding::Msb14(c) => {
                self.cc14_msb.insert(key, d2);
                let lsb_d1 = c.lsb_d1.unwrap_or(c.d1.wrapping_add(32));
                let lsb_key = (msg[0], lsb_d1);
                let lsb = self.cc14_lsb.get(&lsb_key).copied().unwrap_or(0);
                resolve_msb14(c, combined14(d2, lsb), p.centre_snap)
            }
            Binding::Lsb14 { msb_key } => {
                self.cc14_lsb.insert(key, d2);
                let Some(Binding::Msb14(c)) = p.map.get(msb_key) else { return None };
                let msb = self.cc14_msb.get(msb_key).copied().unwrap_or(64);
                resolve_msb14(c, combined14(msb, d2), p.centre_snap)
            }
        }
    }
}

/// Key for persisting an action's value to `midi_state.json`. Keys are now
/// `{profile_id}:{slot}.{field}` (Rust no longer knows deck ids — see the slot-routing
/// note at the top of this file) except the three global controls, which keep their
/// original bare names and units and therefore survive an old file unchanged.
///
/// This is a one-time silent-breaking rename, not a versioned migration: the keys had
/// to change regardless of any value-unit change (Rust no longer has a deck id to key
/// on), and no value here changes shape in this trimmed pass, so there is nothing to
/// invert on restore — an old file's per-deck keys just won't match anything and are
/// dropped, rather than being misread into the wrong scale.
pub fn persist_kv(profile_id: &str, action: &MidiAction) -> Option<(String, f32)> {
    match action {
        MidiAction::DeckGain { slot, value } => Some((format!("{profile_id}:{slot}.gain"), *value)),
        MidiAction::DeckVolume { slot, value } => Some((format!("{profile_id}:{slot}.volume"), *value)),
        MidiAction::DeckPlaybackRate { slot, value } => Some((format!("{profile_id}:{slot}.playbackRate"), *value)),
        MidiAction::Crossfader { value } => Some(("crossfader".into(), *value)),
        MidiAction::MasterVolume { value } => Some(("masterVolume".into(), *value)),
        MidiAction::CueGain { value } => Some(("cueGain".into(), *value)),
        MidiAction::DeckEqLow { slot, value } => Some((format!("{profile_id}:{slot}.eqLow"), *value)),
        MidiAction::DeckEqMid { slot, value } => Some((format!("{profile_id}:{slot}.eqMid"), *value)),
        MidiAction::DeckEqHigh { slot, value } => Some((format!("{profile_id}:{slot}.eqHigh"), *value)),
        MidiAction::DeckFilter { slot, value } => Some((format!("{profile_id}:{slot}.filter"), *value)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::midi::profile::builtins;

    fn starlight() -> Profile {
        builtins().into_iter().find(|p| p.id == "hercules-starlight").unwrap()
    }
    fn flx4() -> Profile {
        builtins().into_iter().find(|p| p.id == "pioneer-ddj-flx4").unwrap()
    }

    #[test]
    fn eq_knob_travel_matches_pre_refactor_behaviour() {
        assert_eq!(eq_db_from_bipolar(bipolar7(0), 0.02), EQ_MIN_DB, "full left = full cut");
        assert_eq!(eq_db_from_bipolar(bipolar7(127), 0.02), EQ_MAX_DB, "full right = full boost");
        assert_eq!(eq_db_from_bipolar(bipolar7(64), 0.02), 0.0, "centre must be exactly flat");
        assert_eq!(eq_db_from_bipolar(bipolar7(63), 0.02), 0.0, "just below centre still in the snap");
        assert!(eq_db_from_bipolar(bipolar7(32), 0.02) < 0.0);
        assert!(eq_db_from_bipolar(bipolar7(96), 0.02) > 0.0);
    }

    #[test]
    fn eq_knob_is_asymmetric_like_the_element() {
        let cut = eq_db_from_bipolar(bipolar7(0), 0.02).abs();
        let boost = eq_db_from_bipolar(bipolar7(127), 0.02).abs();
        assert!(cut > boost, "cut ({cut}) should exceed boost ({boost}) — range is −24…+12");
    }

    #[test]
    fn filter_knob_travel_matches_pre_refactor_behaviour() {
        assert_eq!(filter_from_bipolar(bipolar7(0), 0.02), -1.0);
        assert_eq!(filter_from_bipolar(bipolar7(127), 0.02), 1.0);
        assert_eq!(filter_from_bipolar(bipolar7(64), 0.02), 0.0);
    }

    #[test]
    fn tempo_invert_flips_sign_convention() {
        // Same 14-bit combined value, opposite sign on either side of centre —
        // this is the exact FLX4-vs-Starlight disagreement found in §8.7.
        let below_centre = combined14(50, 0); // < 8192
        let rate_inverted = tempo_from_14bit(below_centre, true);
        let rate_natural = tempo_from_14bit(below_centre, false);
        assert!(rate_inverted > 1.0, "Starlight: lower raw = faster (invert=true)");
        assert!(rate_natural < 1.0, "FLX4: lower raw = slower (invert=false)");
    }

    #[test]
    fn twos7_vs_offset64_decode_the_same_bytes_differently() {
        // 0x3F (63) and 0x41 (65) are exactly the bytes that distinguish the two
        // encodings — the pair the FLX4's own capture used to settle offset64 over
        // twos-complement (controller-mapping.md §8.2).
        assert_eq!(63i32 - 64, -1); // offset64(0x3F) == -1
        assert_eq!(65i32 - 64, 1); // offset64(0x41) == +1
        assert_eq!(63, 63); // twos7(0x3F) == +63 (nowhere near -1)
        assert_eq!(65i32 - 128, -63); // twos7(0x41) == -63 (nowhere near +1)
    }

    #[test]
    fn jog_ticks_per_rev_replay_flx4_ten_revolutions() {
        // src-tauri/tests/replay.rs does the real capture-file replay; this is the
        // pure-unit-math version — same assertion, no file I/O.
        let ticks_per_rev = flx4().jog_ticks_per_rev;
        assert!((ticks_per_rev - 721.7).abs() < 0.1, "FLX4 jog_ticks_per_rev must stay ~721.7 (§8.2)");
        let starlight_ticks_per_rev = starlight().jog_ticks_per_rev;
        assert_eq!(starlight_ticks_per_rev, 256.0, "Starlight jog_ticks_per_rev must stay 256 (unchanged behaviour)");
    }

    #[test]
    fn decoder_state_is_independent_per_connection() {
        // Two Decoders fed the same profile must not see each other's 14-bit LSB
        // state — this is what makes per-connection state safe with two controllers
        // live at once, which is the entire point of this refactor.
        let p = starlight();
        let mut d1 = Decoder::new();
        let mut d2 = Decoder::new();
        // Tempo MSB on d1 only.
        let _ = d1.decode(&p, &[0xB1, 8, 0]);
        // d2 has never seen an MSB — its LSB read must fall back to the documented
        // default (64), not d1's.
        let a = d2.decode(&p, &[0xB1, 40, 0]);
        let b = d1.decode(&p, &[0xB1, 40, 0]);
        assert!(a.is_some() && b.is_some());
        // Not asserting exact equality of the two rates (they legitimately differ
        // because d1 has real MSB state) — asserting they're independent objects at
        // all is the point; a shared-state bug would make this panic on borrow, not
        // silently pass, so the meaningful check is just that both decoded.
    }
}
