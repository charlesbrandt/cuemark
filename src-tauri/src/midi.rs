use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use midir::MidiInput;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::midi_state;

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
    /// Low EQ band, in **dB** (already mapped from the knob — see `knob_to_eq_db`).
    DeckEqLow { deck_id: String, value: f32 },
    /// Sweep filter position, **−1…+1** (already mapped — see `knob_to_filter`).
    DeckFilter { deck_id: String, value: f32 },
}

/// ── The Starlight's dual-function tone knob ───────────────────────────────────
///
/// Each deck has **one** knob that acts as either a bass control or a filter sweep,
/// switched by the global Bass/Filter button at `(0x90, 1)`.
///
/// **The controller does the switching itself, in firmware** — verified live 2026-08-17
/// by capturing the same physical knob across a button press:
///
/// ```text
///   0xB1 d1= 2  d2=63,2,0,38,64,106      ← knob sweeping (fine on CC 34)
///   0x90 d1= 1  d2=127 → d2=0            ← Bass/Filter button, momentary
///   0xB1 d1= 1  d2=127,96,73,63,32,15,0  ← same knob, different CC (fine on CC 33)
/// ```
///
/// So cuemark holds **no mode state at all**: the two modes arrive as two different CCs
/// and map to two different destinations, exactly like Shift's firmware pad remapping.
/// `(0x90, 1)` stays deliberately unmapped — there is nothing for the host to do with it,
/// and consuming it would imply a mode the host does not (and must not) track.
///
/// The button is momentary (127 on press, 0 on release) and does **not** report which
/// mode it just selected, which is the other reason host-side tracking would be a bad
/// idea: after a reconnect the host's guess and the hardware could silently disagree.
/// Fine CCs (34/33) are ignored — 7-bit is plenty for a tone knob, matching the
/// volume/crossfader decision above.

/// Knob (0–127) → low-EQ gain in dB.
///
/// Centre is flat, with cut and boost on either side. The travel is **asymmetric**
/// because the element's range is (−24…+12): a real mixer's bass knob behaves the same
/// way, cutting far harder than it boosts.
fn knob_to_eq_db(data2: u8) -> f32 {
    let t = (data2 as f32 / 127.0 - 0.5) * 2.0; // −1 … +1
    if t.abs() < KNOB_CENTRE_SNAP {
        return 0.0;
    }
    if t < 0.0 {
        t.abs() * crate::audio::pipeline::EQ_MIN_DB
    } else {
        t * crate::audio::pipeline::EQ_MAX_DB
    }
}

/// Knob (0–127) → filter position, −1 (full low-pass) … +1 (full high-pass).
fn knob_to_filter(data2: u8) -> f32 {
    let t = (data2 as f32 / 127.0 - 0.5) * 2.0;
    if t.abs() < KNOB_CENTRE_SNAP {
        0.0
    } else {
        t
    }
}

/// The knob is a plain pot with no centre detent, so an exact centre is not reachable by
/// feel. Without this snap, "off" would be a value the user cannot actually select, and
/// the filter or EQ would sit imperceptibly engaged whenever they tried — the same
/// always-on-never-noticed failure the tone stage's transparency measurement guards
/// against at the GStreamer end.
const KNOB_CENTRE_SNAP: f32 = 0.02;

// ── Raw MIDI monitor ──────────────────────────────────────────────────────────
//
// A live, **unthrottled** view of every byte arriving on the port, mapped or not. This
// exists because neither of the two ways to watch MIDI here can answer the questions that
// authoring a controller profile actually asks:
//
//   * `[midi]` log lines throttle continuous controls to one per 500ms per key (see
//     `log_throttle` in `run_midi_loop`), so a jog wheel spinning at ~131 msg/s prints a
//     tidy ±1 twice a second. That hides the tick *rate*, which is the measurement — the
//     `vinylTally` instrument in `handler.ts` exists solely because of this, and its
//     comment says so.
//   * `amidi -d` cannot run at all while cuemark holds the port: it fails with "Device or
//     resource busy", and the first attempt in a session can present as a *silent empty
//     capture* rather than an error.
//
// See `docs/design/controller-mapping.md` §7a. It is the tool the DDJ-FLX4 profile is
// meant to be authored with, and §8's unknown list is the set of questions it answers.

/// Off by default; flipped by `midi_monitor_set` while the monitor panel is open.
///
/// The gate is not defensive tidiness. Two jog wheels alone deliver ~260 messages/s, and
/// each emit is a serialize plus a webview dispatch on the GTK main thread — the same
/// thread every audio IPC call crosses. `postFrame()` learned this lesson the expensive
/// way (`docs/design/control-window-frame-budget.md`): work done for a listener that isn't
/// there is invisible and permanent. Monitoring is a bench activity, not a performance one.
static MONITOR: AtomicBool = AtomicBool::new(false);

/// Name of the port `run_midi_loop` actually opened, for `midi_list_ports` to flag.
/// `None` until a port is connected — including the case where none matched.
static CONNECTED_PORT: Mutex<Option<String>> = Mutex::new(None);

/// Cap on bytes carried per message. Ordinary channel-voice messages are 3; this exists so
/// a SysEx dump (a controller identity reply, say) is *visible* rather than dropped, without
/// letting one message push megabytes through the event channel.
const MAX_RAW_BYTES: usize = 16;

/// One observed message, exactly as it arrived.
#[derive(Serialize, Clone, Debug)]
pub struct MidiRaw {
    /// Which surface this came from. Redundant today (one port is opened); carried now
    /// because multi-port support is next and "which controller sent it" is part of the
    /// observation, not of the context around it.
    pub port: String,
    /// Raw bytes, truncated to `MAX_RAW_BYTES`. Not split into status/d1/d2 here: a
    /// discovery tool that assumes 3 bytes cannot show the shapes it was opened to find.
    pub bytes: Vec<u8>,
    /// True length before truncation, so a clipped SysEx is obvious rather than plausible.
    pub len: usize,
    /// Wall-clock epoch ms — the one clock the frontend and the Rust log can be differenced
    /// across (see `epoch_ms` in lib.rs).
    pub t: f64,
    /// Debug spelling of the binding this resolves to, or `None` when the map ignores it.
    /// Deliberately the `ControlBinding` debug form: it carries the deck id, so a mapping
    /// that fires on the *wrong deck* reads as wrong here instead of merely as "mapped".
    pub mapped: Option<String>,
}

/// Turn the raw feed on or off. Called from the monitor panel's mount/unmount.
#[tauri::command]
pub fn midi_monitor_set(enabled: bool) {
    MONITOR.store(enabled, Ordering::Relaxed);
    log::info!("[midi] raw monitor {}", if enabled { "ON" } else { "off" });
}

#[derive(Serialize, Clone, Debug)]
pub struct MidiPortInfo {
    pub name: String,
    /// Whether this is the port cuemark opened. Exactly one port is opened today, so a
    /// controller that is plugged in and enumerating but *not* connected shows up here as
    /// present-and-unclaimed — which is the first question to ask of any new device.
    pub connected: bool,
}

/// Enumerate input ports live, without disturbing the open connection.
///
/// Answers `docs/design/controller-mapping.md` §8.1 ("does it enumerate as class-compliant
/// MIDI at all") from inside the app, which matters because cuemark holds its port
/// exclusively and `amidi -l` is therefore not always available as a second opinion.
/// Enumerating is not opening: constructing a second `MidiInput` to list ports does not
/// contend with the live connection.
#[tauri::command]
pub fn midi_list_ports() -> Result<Vec<MidiPortInfo>, String> {
    let midi_in = MidiInput::new("cuemark-enum").map_err(|e| e.to_string())?;
    let connected = CONNECTED_PORT.lock().unwrap().clone();
    Ok(midi_in
        .ports()
        .iter()
        .map(|p| {
            let name = midi_in.port_name(p).unwrap_or_default();
            MidiPortInfo {
                connected: connected.as_deref() == Some(name.as_str()),
                name,
            }
        })
        .collect())
}

/// Write a captured session to `<app_data>/midi-captures/` and return the path.
///
/// The capture is the input to offline profile work: a byte log replayed through the
/// resolver in a test asserts an action sequence without the controller attached
/// (`docs/design/controller-mapping.md` §9). It also makes "I turned the knob and it
/// seemed right" into something a later session can re-examine, which matters because
/// mapping bugs here are silent and plausible — a swapped assignment gives a knob that
/// does something, just not the labelled thing.
#[tauri::command]
pub fn midi_capture_save(app: AppHandle, json: String) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("midi-captures");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("capture-{}.json", crate::epoch_ms() as u64));
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    let path = path.display().to_string();
    log::info!("[midi] capture saved: {path}");
    Ok(path)
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
    /// The dual-function tone knob in its **bass** position — see the block comment above.
    DeckEqLow { deck_id: String },
    /// The same physical knob in its **filter** position, arriving on a different CC.
    DeckFilter { deck_id: String },
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
    // CC: the dual-function tone knob. ONE physical knob, two CCs — the controller
    // swaps which one it sends when the Bass/Filter button is pressed (see the block
    // comment on knob_to_eq_db). Fine CCs 34/33 ignored, 7-bit is plenty.
    m.insert((0xB1, 2),  ControlBinding::DeckEqLow      { deck_id: "deck-0".into() });
    m.insert((0xB1, 1),  ControlBinding::DeckFilter     { deck_id: "deck-0".into() });
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
    m.insert((0xB2, 2),  ControlBinding::DeckEqLow      { deck_id: "deck-1".into() });
    m.insert((0xB2, 1),  ControlBinding::DeckFilter     { deck_id: "deck-1".into() });
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
    //   (0x90, 1)  = Bass/Filter button — same deal: the controller swaps the tone knob's
    //                CC in firmware (CC 2 ⇄ CC 1), so both modes are already mapped above
    //                and there is nothing for the host to do on the button itself.
    //                ⚠️ Do NOT "improve" this by tracking mode here — the button is
    //                momentary and never reports which mode it selected, so a host-side
    //                guess would drift out of sync with the hardware after a reconnect.
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
            | ControlBinding::DeckEqLow { .. }
            | ControlBinding::DeckFilter { .. }
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
        ControlBinding::DeckEqLow { deck_id } => Some(MidiAction::DeckEqLow {
            deck_id: deck_id.clone(),
            value: knob_to_eq_db(data2),
        }),
        ControlBinding::DeckFilter { deck_id } => Some(MidiAction::DeckFilter {
            deck_id: deck_id.clone(),
            value: knob_to_filter(data2),
        }),
        ControlBinding::JogWheel { deck_id } => {
            // 7-bit two's complement: values 1–63 = CW (+), 64–127 = CCW (−).
            let step = if data2 >= 64 { data2 as i32 - 128 } else { data2 as i32 };
            Some(MidiAction::JogNudge { deck_id: deck_id.clone(), value: step as f32 })
        }
        // 14-bit rate bindings are handled in run_midi_loop where MSB/LSB state lives.
        ControlBinding::DeckPlaybackRate { .. } | ControlBinding::DeckPlaybackRateLsb { .. } => None,
    }
}

/// Key for persisting a MidiAction's value. Returns None for discrete events (buttons)
/// that have no position to restore (play/pause, hot-cues, loop, jog).
fn persist_kv(action: &MidiAction) -> Option<(String, f32)> {
    match action {
        MidiAction::DeckGain         { deck_id, value } => Some((format!("{deck_id}.gain"),         *value)),
        MidiAction::DeckVolume       { deck_id, value } => Some((format!("{deck_id}.volume"),       *value)),
        MidiAction::DeckPlaybackRate { deck_id, value } => Some((format!("{deck_id}.playbackRate"), *value)),
        MidiAction::Crossfader       { value }          => Some(("crossfader".into(),               *value)),
        MidiAction::MasterVolume     { value }          => Some(("masterVolume".into(),             *value)),
        MidiAction::CueGain          { value }          => Some(("cueGain".into(),                  *value)),
        // Restored into `deck.eq.low` (not a flat field) — see restoreMidiControlState().
        MidiAction::DeckEqLow        { deck_id, value } => Some((format!("{deck_id}.eqLow"),        *value)),
        MidiAction::DeckFilter       { deck_id, value } => Some((format!("{deck_id}.filter"),       *value)),
        _ => None,
    }
}

pub fn spawn_listener(app: AppHandle, persist: midi_state::MidiPersist) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    let state_path = app.path().app_data_dir()?.join("midi_state.json");
    midi_state::spawn_flusher(Arc::clone(&persist), state_path);

    let midi_map = Arc::new(hercules_starlight_map());
    std::thread::spawn(move || {
        if let Err(e) = run_midi_loop(&app, &midi_map, &persist) {
            log::error!("[midi] listener error: {e}");
        }
    });
    Ok(())
}

fn run_midi_loop(app: &AppHandle, midi_map: &Arc<MidiMap>, persist: &midi_state::MidiPersist) -> Result<(), Box<dyn std::error::Error>> {
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
                log::warn!("[midi] Hercules Starlight not found. Available ports:");
                for p in &ports2 {
                    log::warn!("  {}", midi_in.port_name(p).unwrap_or_default());
                }
                return Ok(());
            }
        }
    };

    let port_name = midi_in.port_name(&port)?;
    log::info!("[midi] connected to: {port_name}");
    *CONNECTED_PORT.lock().unwrap() = Some(port_name.clone());

    let app = app.clone();
    let map = Arc::clone(midi_map);
    let persist = Arc::clone(persist);

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
            // Raw monitor first, ahead of *every* filter below — the length check, the map
            // lookup and the log throttle. Each of those drops something the monitor exists
            // to reveal: a 2-byte program change, an unmapped control, the true rate of a
            // continuous one. Anything filtered before this point is invisible to profile
            // authoring, which is the whole job (docs/design/controller-mapping.md §7a).
            if MONITOR.load(Ordering::Relaxed) {
                let mapped = if msg.len() >= 2 {
                    map.get(&(msg[0], msg[1])).map(|b| format!("{b:?}"))
                } else {
                    None
                };
                let _ = app.emit("midi-raw", MidiRaw {
                    port: port_name.clone(),
                    bytes: msg.iter().take(MAX_RAW_BYTES).copied().collect(),
                    len: msg.len(),
                    t: crate::epoch_ms(),
                    mapped,
                });
            }

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
                log::info!("[midi] {msg_type} ch{channel:02}  status=0x{:02X}  d1={:3}  d2={:3}",
                    msg[0], msg[1], msg[2]);
            }

            let Some(binding) = map.get(&key) else {
                if should_log { log::info!("[midi]   (unmapped)"); }
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
                if should_log { log::info!("[midi]   => {:?}", action); }
                if let Some((key, val)) = persist_kv(&action) {
                    midi_state::mark_dirty(&persist, &key, val);
                }
                let _ = app.emit("midi-action", action);
            } else if should_log {
                log::info!("[midi]   (no action)");
            }
        },
        (),
    )?;

    // Hold the connection open. `_conn` drops (closing MIDI) if this returns.
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}

#[cfg(test)]
mod tone_knob_tests {
    use super::{knob_to_eq_db, knob_to_filter, hercules_starlight_map, ControlBinding, KNOB_CENTRE_SNAP};
    use crate::audio::pipeline::{EQ_MAX_DB, EQ_MIN_DB};

    /// The knob's whole travel, as a table. Centre must be exactly neutral — a knob that
    /// cannot be returned to "off" is the failure this snap exists to prevent.
    #[test]
    fn eq_knob_travel() {
        assert_eq!(knob_to_eq_db(0), EQ_MIN_DB, "full left = full cut");
        assert_eq!(knob_to_eq_db(127), EQ_MAX_DB, "full right = full boost");
        assert_eq!(knob_to_eq_db(64), 0.0, "centre must be exactly flat");
        assert_eq!(knob_to_eq_db(63), 0.0, "just below centre is still within the snap");
        assert!(knob_to_eq_db(32) < 0.0, "left half cuts");
        assert!(knob_to_eq_db(96) > 0.0, "right half boosts");
    }

    /// Cut and boost are deliberately asymmetric, because the element's range is.
    /// Equal rotation either side of centre must NOT give equal dB.
    #[test]
    fn eq_knob_is_asymmetric_like_the_element() {
        let cut = knob_to_eq_db(0).abs();
        let boost = knob_to_eq_db(127).abs();
        assert!(
            cut > boost,
            "cut ({cut}) should exceed boost ({boost}) — the element's range is −24…+12, \
             and a symmetric mapping would silently throw away half the available cut"
        );
    }

    #[test]
    fn filter_knob_travel() {
        assert_eq!(knob_to_filter(0), -1.0, "full left = full low-pass");
        assert_eq!(knob_to_filter(127), 1.0, "full right = full high-pass");
        assert_eq!(knob_to_filter(64), 0.0, "centre must be exactly off");
        assert!(knob_to_filter(32) < 0.0);
        assert!(knob_to_filter(96) > 0.0);
    }

    /// Everything inside the snap band reads as neutral, on both controls.
    #[test]
    fn centre_snap_covers_both_controls() {
        for d2 in 0u8..=127 {
            let t = (d2 as f32 / 127.0 - 0.5) * 2.0;
            if t.abs() < KNOB_CENTRE_SNAP {
                assert_eq!(knob_to_eq_db(d2), 0.0, "d2={d2} is inside the snap band");
                assert_eq!(knob_to_filter(d2), 0.0, "d2={d2} is inside the snap band");
            }
        }
    }

    /// Both halves of the dual-function knob must be mapped, for BOTH decks. Live capture
    /// (2026-08-17) showed the controller swapping CC 2 ⇄ CC 1 on the Bass/Filter button;
    /// mapping only the mode that happened to be active would leave the knob dead after
    /// one button press, which reads as "the knob stopped working" rather than as a gap.
    #[test]
    fn both_knob_modes_are_mapped_on_both_decks() {
        let m = hercules_starlight_map();
        for (status, deck) in [(0xB1u8, "deck-0"), (0xB2u8, "deck-1")] {
            match m.get(&(status, 2)) {
                Some(ControlBinding::DeckEqLow { deck_id }) => assert_eq!(deck_id, deck),
                other => panic!("({status:#04X}, 2) should be DeckEqLow for {deck}, got {other:?}"),
            }
            match m.get(&(status, 1)) {
                Some(ControlBinding::DeckFilter { deck_id }) => assert_eq!(deck_id, deck),
                other => panic!("({status:#04X}, 1) should be DeckFilter for {deck}, got {other:?}"),
            }
        }
    }

    /// The Bass/Filter button itself must stay unmapped: the controller already switched
    /// the knob's CC in firmware, so binding the button would mean tracking a mode the
    /// host cannot observe.
    #[test]
    fn bass_filter_button_stays_unmapped() {
        assert!(
            hercules_starlight_map().get(&(0x90, 1)).is_none(),
            "(0x90,1) must stay unmapped — the CC swap already carries the mode"
        );
    }
}
