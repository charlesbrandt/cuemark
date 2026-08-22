//! Controller profiles as data. A profile is a TOML file describing one controller's
//! physical control layout — `(status, d1)` wire bytes to actions — with no deck
//! identity baked in (that's `slot`, resolved to a software deck by the frontend's
//! `Session.midiMapping`). See `docs/design/controller-mapping.md` §3.
//!
//! Built-ins ship embedded (`include_str!`) so the app works with zero files on disk;
//! a user profile in `<app_data>/profiles/*.toml` with the same `id` shadows a built-in.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

fn d_centre_snap() -> f32 {
    0.02
}
fn d_ticks_per_rev() -> f32 {
    256.0
}

#[derive(Deserialize, Debug, Clone)]
pub struct ProfileFile {
    pub id: String,
    pub name: String,
    #[serde(rename = "match", default)]
    pub match_names: Vec<String>,
    pub slots: u8,
    /// Dead-band for centre-detentless pots, applied to bipolar controls (EQ, filter).
    /// A pot with a real centre detent wants this at 0.0.
    #[serde(default = "d_centre_snap")]
    pub centre_snap: f32,
    /// Jog encoder ticks per physical revolution — a measured hardware fact, distinct
    /// per controller (Starlight 256, FLX4 ~721.7). Rust divides by this so every
    /// consumer downstream receives revolutions, never raw ticks.
    #[serde(default = "d_ticks_per_rev")]
    pub jog_ticks_per_rev: f32,
    #[serde(rename = "control", default)]
    pub controls: Vec<Control>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Control {
    /// Full status byte — channel is NOT masked. DJ controllers put left/right decks
    /// on separate MIDI channels; masking it is the documented way to break the map.
    pub status: u8,
    pub d1: u8,
    pub kind: Kind,
    pub action: ActionId,
    #[serde(default)]
    pub slot: u8,
    /// hot_cue / loop_preset only — which slot of that action (e.g. hot cue index).
    #[serde(default)]
    pub index: u8,
    /// fader14 only — the LSB's `d1`. Defaults to `d1 + 32` (the near-universal
    /// convention), but is explicit because "+32" is a convention, not a rule
    /// (controller-mapping.md §3.3).
    #[serde(default)]
    pub lsb_d1: Option<u8>,
    /// relative only — how a delta is spelled on the wire.
    #[serde(default)]
    pub encoding: Option<Encoding>,
    /// tempo only — this controller's fader sign convention vs. the shared formula.
    #[serde(default)]
    pub invert: bool,
    /// Provenance, ignored at runtime — e.g. "from Mixxx mapping, not live-verified".
    #[serde(default)]
    #[allow(dead_code)]
    pub note: Option<String>,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Button,
    Fader,
    Fader14,
    Relative,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Encoding {
    Twos7,
    Offset64,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ActionId {
    PlayToggle,
    CueJump,
    LoopToggle,
    LoopPreset,
    SyncToggle,
    HeadphoneCue,
    PhaseNudge,
    HotCue,
    HotCueSet,
    Gain,
    Volume,
    Opacity,
    Tempo,
    EqLow,
    EqMid,
    EqHigh,
    Filter,
    JogTurn,
    Crossfader,
    MasterVolume,
    CueGain,
}

/// Compiled form of one control — what the decoder actually reads. Distinguishes a
/// plain (button/fader/relative) row from the two halves of a 14-bit pair: the MSB
/// row is authored, the LSB row is synthesized by `compile()` from `lsb_d1`.
#[derive(Debug, Clone)]
pub enum Binding {
    Simple(Control),
    Msb14(Control),
    /// `msb_key` points back at the authored `Msb14` row so the LSB handler can read
    /// its action/invert without duplicating that data.
    Lsb14 { msb_key: (u8, u8) },
}

#[derive(Debug, Clone)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub slots: u8,
    pub centre_snap: f32,
    pub jog_ticks_per_rev: f32,
    pub match_names: Vec<String>,
    pub map: HashMap<(u8, u8), Binding>,
}

impl Profile {
    /// Whether a control fires many events/second (faders, encoders) and should be
    /// log-throttled. Unmapped CC is also treated as continuous — matches the
    /// original single-controller behaviour, which throttled unknown faders too.
    pub fn is_continuous(&self, key: (u8, u8)) -> bool {
        match self.map.get(&key) {
            Some(Binding::Simple(c)) => c.kind == Kind::Relative,
            Some(Binding::Msb14(_)) | Some(Binding::Lsb14 { .. }) => true,
            None => (key.0 & 0xF0) == 0xB0,
        }
    }
}

/// Compile a parsed `ProfileFile` into a lookup-ready `Profile`, validating structural
/// invariants along the way. Returns the first error found.
pub fn compile(f: ProfileFile) -> Result<Profile, String> {
    let mut map: HashMap<(u8, u8), Binding> = HashMap::new();

    for c in &f.controls {
        if c.slot >= f.slots {
            return Err(format!(
                "{}: control ({:#04X},{:#04X}) has slot {} but profile only has {} slots",
                f.id, c.status, c.d1, c.slot, f.slots
            ));
        }
        if c.kind == Kind::Relative && c.encoding.is_none() {
            return Err(format!(
                "{}: relative control ({:#04X},{:#04X}) has no encoding",
                f.id, c.status, c.d1
            ));
        }

        let msb_key = (c.status, c.d1);
        if map.contains_key(&msb_key) {
            return Err(format!(
                "{}: duplicate control key ({:#04X},{:#04X})",
                f.id, c.status, c.d1
            ));
        }

        if c.kind == Kind::Fader14 {
            let lsb_d1 = c.lsb_d1.unwrap_or(c.d1.wrapping_add(32));
            let lsb_key = (c.status, lsb_d1);
            if lsb_key == msb_key {
                return Err(format!(
                    "{}: control ({:#04X},{:#04X}) LSB key collides with its own MSB key",
                    f.id, c.status, c.d1
                ));
            }
            if map.contains_key(&lsb_key) {
                return Err(format!(
                    "{}: control ({:#04X},{:#04X})'s synthesized LSB key ({:#04X},{:#04X}) \
                     collides with an existing row",
                    f.id, c.status, c.d1, lsb_key.0, lsb_key.1
                ));
            }
            map.insert(msb_key, Binding::Msb14(c.clone()));
            map.insert(lsb_key, Binding::Lsb14 { msb_key });
        } else {
            map.insert(msb_key, Binding::Simple(c.clone()));
        }
    }

    // Second pass: two different fader14 rows could still synthesize colliding LSB
    // keys with each other even though neither collided with an MSB row above (the
    // per-insert checks above only check against what's been inserted so far in
    // authoring order, which already catches this since insertion is sequential —
    // kept as an explicit invariant check here rather than relying on that ordering
    // being obviously correct on a re-read).
    let mut seen: HashMap<(u8, u8), &str> = HashMap::new();
    for (k, b) in &map {
        let label = match b {
            Binding::Simple(_) => "simple",
            Binding::Msb14(_) => "msb14",
            Binding::Lsb14 { .. } => "lsb14",
        };
        if let Some(prev) = seen.insert(*k, label) {
            return Err(format!(
                "{}: key ({:#04X},{:#04X}) bound twice ({} and {})",
                f.id, k.0, k.1, prev, label
            ));
        }
    }

    Ok(Profile {
        id: f.id,
        name: f.name,
        slots: f.slots,
        centre_snap: f.centre_snap,
        jog_ticks_per_rev: f.jog_ticks_per_rev,
        match_names: f.match_names.into_iter().map(|s| s.to_lowercase()).collect(),
        map,
    })
}

fn parse(id_for_errors: &str, toml_src: &str) -> Result<Profile, String> {
    let f: ProfileFile = toml::from_str(toml_src)
        .map_err(|e| format!("{id_for_errors}: parse error: {e}"))?;
    compile(f)
}

const HERCULES_STARLIGHT_TOML: &str = include_str!("../../profiles/hercules-starlight.toml");
const PIONEER_DDJ_FLX4_TOML: &str = include_str!("../../profiles/pioneer-ddj-flx4.toml");

/// Built-in profiles, embedded in the binary. Panics on a malformed built-in — a
/// compile error here should fail the build/tests, never surface at runtime, and the
/// profile-validation tests below exercise exactly this path.
pub fn builtins() -> Vec<Profile> {
    vec![
        parse("hercules-starlight (builtin)", HERCULES_STARLIGHT_TOML)
            .expect("built-in hercules-starlight.toml failed to compile"),
        parse("pioneer-ddj-flx4 (builtin)", PIONEER_DDJ_FLX4_TOML)
            .expect("built-in pioneer-ddj-flx4.toml failed to compile"),
    ]
}

/// Built-ins plus any user profile in `<app_data>/profiles/*.toml`. A user profile
/// with the same `id` as a built-in replaces it entirely (not merged).
pub fn load_all(app_data: &Path) -> Vec<Profile> {
    let mut by_id: HashMap<String, Profile> = HashMap::new();
    for p in builtins() {
        by_id.insert(p.id.clone(), p);
    }

    let dir = app_data.join("profiles");
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("toml") {
                continue;
            }
            match std::fs::read_to_string(&path) {
                Ok(src) => match parse(&path.display().to_string(), &src) {
                    Ok(p) => {
                        log::info!("[midi] loaded user profile: {} ({})", p.id, path.display());
                        by_id.insert(p.id.clone(), p);
                    }
                    Err(e) => log::warn!("[midi] skipping invalid user profile {}: {e}", path.display()),
                },
                Err(e) => log::warn!("[midi] failed to read {}: {e}", path.display()),
            }
        }
    }

    by_id.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_builtins_compile() {
        let profiles = builtins();
        assert_eq!(profiles.len(), 2);
    }

    /// Data-driven over every shipped profile — no duplicate keys, every slot in range,
    /// every relative control has an encoding. `compile()` already enforces these; this
    /// test exists so a future third profile is checked the same way with zero new code.
    #[test]
    fn every_builtin_is_internally_consistent() {
        for p in builtins() {
            for (key, binding) in &p.map {
                if let Binding::Simple(c) | Binding::Msb14(c) = binding {
                    assert!(c.slot < p.slots, "{}: slot out of range at {:?}", p.id, key);
                    if c.kind == Kind::Relative {
                        assert!(c.encoding.is_some(), "{}: relative with no encoding at {:?}", p.id, key);
                    }
                }
            }
        }
    }

    #[test]
    fn starlight_tone_knob_both_modes_both_decks() {
        let p = builtins().into_iter().find(|p| p.id == "hercules-starlight").unwrap();
        for (status, slot) in [(0xB1u8, 0u8), (0xB2u8, 1u8)] {
            match p.map.get(&(status, 2)) {
                Some(Binding::Simple(c)) => {
                    assert_eq!(c.action, ActionId::EqLow);
                    assert_eq!(c.slot, slot);
                }
                other => panic!("({status:#04X},2) should be EqLow slot {slot}, got {other:?}"),
            }
            match p.map.get(&(status, 1)) {
                Some(Binding::Simple(c)) => {
                    assert_eq!(c.action, ActionId::Filter);
                    assert_eq!(c.slot, slot);
                }
                other => panic!("({status:#04X},1) should be Filter slot {slot}, got {other:?}"),
            }
        }
    }

    #[test]
    fn starlight_bass_filter_button_stays_unmapped() {
        let p = builtins().into_iter().find(|p| p.id == "hercules-starlight").unwrap();
        assert!(
            p.map.get(&(0x90, 1)).is_none(),
            "(0x90,1) must stay unmapped — the CC swap already carries the mode"
        );
    }

    #[test]
    fn flx4_has_no_deck_slot_switch() {
        let p = builtins().into_iter().find(|p| p.id == "pioneer-ddj-flx4").unwrap();
        assert_eq!(p.slots, 2, "FLX4 §8.4: confirmed no deck 1/3 switch on this unit");
    }

    #[test]
    fn duplicate_key_is_rejected() {
        let src = r#"
            id = "dup"
            name = "dup"
            slots = 1
            [[control]]
            status = 0x90
            d1 = 1
            kind = "button"
            action = "play_toggle"
            [[control]]
            status = 0x90
            d1 = 1
            kind = "button"
            action = "cue_jump"
        "#;
        assert!(parse("dup", src).is_err());
    }

    #[test]
    fn fader14_lsb_collision_is_rejected() {
        let src = r#"
            id = "collide"
            name = "collide"
            slots = 1
            [[control]]
            status = 0xB0
            d1 = 0
            kind = "fader14"
            action = "tempo"
            [[control]]
            status = 0xB0
            d1 = 32
            kind = "button"
            action = "play_toggle"
        "#;
        assert!(parse("collide", src).is_err());
    }

    #[test]
    fn relative_without_encoding_is_rejected() {
        let src = r#"
            id = "noenc"
            name = "noenc"
            slots = 1
            [[control]]
            status = 0xB0
            d1 = 10
            kind = "relative"
            action = "jog_turn"
        "#;
        assert!(parse("noenc", src).is_err());
    }

    #[test]
    fn slot_out_of_range_is_rejected() {
        let src = r#"
            id = "badslot"
            name = "badslot"
            slots = 1
            [[control]]
            status = 0x90
            d1 = 1
            kind = "button"
            action = "play_toggle"
            slot = 1
        "#;
        assert!(parse("badslot", src).is_err());
    }
}
