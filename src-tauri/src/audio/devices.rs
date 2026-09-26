use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AudioDevice {
    /// PipeWire node name — passed to `pipewiresink target-object=<id>`.
    pub id: String,
    /// Human-readable label shown in the device picker.
    pub label: String,
}

/// List audio output sinks available as routing targets.
///
/// Tries `pw-dump` (PipeWire native JSON) first; falls back to `pactl list sinks`
/// (PulseAudio / PipeWire compat layer) if pw-dump is unavailable.
pub fn list_audio_devices() -> Vec<AudioDevice> {
    if let Ok(devs) = query_pw_dump() {
        if !devs.is_empty() {
            return devs;
        }
    }
    match query_pactl() {
        Ok(devs) => devs,
        Err(e) => {
            log::error!("[audio/devices] device enumeration failed: {e}");
            vec![]
        }
    }
}

/// The PipeWire node name the system default sink currently resolves to (`pw-dump`'s
/// `default` metadata, key `default.audio.sink` — the *effective* default, not
/// `default.configured.audio.sink`, which may be a placeholder such as `auto_null`).
/// `None` when it cannot be determined; callers then treat `""` as its own device.
pub fn default_sink_name() -> Option<String> {
    let out = std::process::Command::new("pw-dump").output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_default_sink(&String::from_utf8_lossy(&out.stdout))
}

fn parse_default_sink(json_text: &str) -> Option<String> {
    let objs: Vec<serde_json::Value> = serde_json::from_str(json_text).ok()?;
    for obj in &objs {
        if obj.get("type").and_then(|t| t.as_str()) != Some("PipeWire:Interface:Metadata") {
            continue;
        }
        if obj.pointer("/props/metadata.name").and_then(|v| v.as_str()) != Some("default") {
            continue;
        }
        for entry in obj.get("metadata").and_then(|m| m.as_array()).into_iter().flatten() {
            if entry.get("key").and_then(|k| k.as_str()) != Some("default.audio.sink") {
                continue;
            }
            // Spa:String:JSON — `{"name": "..."}`, sometimes delivered as a JSON string.
            let value = entry.get("value")?;
            let name = match value {
                serde_json::Value::String(s) => serde_json::from_str::<serde_json::Value>(s)
                    .ok()
                    .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string)),
                v => v.get("name").and_then(|n| n.as_str()).map(str::to_string),
            };
            return name.filter(|n| !n.is_empty());
        }
    }
    None
}

/// Removes main-output ids that would put the same audio into the same device twice.
///
/// `""` means "the system default", so `["", "<the default sink's node name>"]` is one
/// device listed twice — and each entry gets its own `pulsesink` stream, the two streams
/// meet in the DAC at a slightly different delay, and the listener hears the track doubled
/// (live 2026-09-26). De-duplicating by id *string* could not see this. Ids are compared as
/// full strings after resolving `""`, so `dev@front` and `dev@rear` (deliberately two
/// branches on one node, different channel pairs) are **not** duplicates. The first
/// occurrence wins. Returns `(kept, dropped)`.
pub fn dedupe_main_devices(ids: &[String], default_sink: Option<&str>) -> (Vec<String>, Vec<String>) {
    let mut kept: Vec<String> = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    let mut dropped = Vec::new();
    for id in ids {
        let canon: &str = if id.is_empty() { default_sink.unwrap_or("") } else { id };
        if seen.contains(&canon) {
            dropped.push(id.clone());
        } else {
            seen.push(canon);
            kept.push(id.clone());
        }
    }
    (kept, dropped)
}

// ── pw-dump (PipeWire native) ─────────────────────────────────────────────────

fn query_pw_dump() -> Result<Vec<AudioDevice>, Box<dyn std::error::Error>> {
    let out = std::process::Command::new("pw-dump").output()?;
    if !out.status.success() {
        return Err(format!("pw-dump exited {}", out.status.code().unwrap_or(-1)).into());
    }
    parse_pw_dump(&String::from_utf8_lossy(&out.stdout))
}

struct SinkRaw {
    node_name: String,
    nick: String,
    description: String,
    /// Channel positions from audio.position (e.g. ["FL","FR","RL","RR"]).
    position: Vec<String>,
}

fn parse_pw_dump(json_text: &str) -> Result<Vec<AudioDevice>, Box<dyn std::error::Error>> {
    let nodes: Vec<serde_json::Value> = serde_json::from_str(json_text)?;
    let mut raw: Vec<SinkRaw> = vec![];

    for node in &nodes {
        let props = match node.get("info").and_then(|i| i.get("props")) {
            Some(p) => p,
            None => continue,
        };

        if props.get("media.class").and_then(|v| v.as_str()) != Some("Audio/Sink") {
            continue;
        }

        let node_name = match props.get("node.name").and_then(|v| v.as_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        let description = props
            .get("node.description")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| node_name.clone());

        let nick = props
            .get("node.nick")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| description.clone());

        // pw-dump's real-world `audio.position` value is bracket-wrapped
        // (`"[ FL, FR, RL, RR ]"`), not the bare `"FL,FR,RL,RR"` the original parser
        // assumed — confirmed live 2026-08-02 (`pw-dump` on this machine/PipeWire
        // version). Trimming each comma-split token only strips whitespace, so the
        // untrimmed brackets rode straight into the first/last channel tokens (`"[ FL"`,
        // `"RR ]"`), which then failed `pw_channel_to_gst_bit` matches downstream in
        // pipeline.rs's `compute_cue_remap` — silently disabling the cue channel remap
        // and contributing to a PipeWire node-negotiation deadlock (see that function's
        // doc comment). Strip the outer brackets before splitting so this survives
        // either format.
        let position: Vec<String> = props
            .get("audio.position")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().trim_start_matches('[').trim_end_matches(']'))
            .map(|s| s.split(',').map(|ch| ch.trim().to_string()).collect())
            .unwrap_or_default();

        raw.push(SinkRaw { node_name, nick, description, position });
    }

    // When multiple sinks share the same nick, use node.description to disambiguate.
    let mut nick_counts = std::collections::HashMap::<String, usize>::new();
    for r in &raw {
        *nick_counts.entry(r.nick.clone()).or_insert(0) += 1;
    }

    let mut devices = vec![];

    for r in raw {
        let base_label = if nick_counts.get(&r.nick).copied().unwrap_or(0) > 1 {
            r.description.clone()
        } else {
            r.nick.clone()
        };

        // Multi-channel sinks: expose one entry per stereo pair so the user can pick
        // e.g. "DJControl Starlight — Front" vs "DJControl Starlight — Rear".
        // ID format: `node_name@target_pair!full_layout`
        // e.g. `alsa_output...@RL,RR!FL,FR,RL,RR`
        // The pipeline uses both pieces to build the correct N-channel mix-matrix.
        if r.position.len() > 2 {
            let pairs = stereo_pairs(&r.position);
            if pairs.len() > 1 {
                let full_layout = r.position.join(",");
                for (channels, pair_label) in pairs {
                    devices.push(AudioDevice {
                        id: format!("{}@{}!{}", r.node_name, channels.join(","), full_layout),
                        label: format!("{} — {}", base_label, pair_label),
                    });
                }
                continue;
            }
        }

        devices.push(AudioDevice { id: r.node_name, label: base_label });
    }

    Ok(devices)
}

/// Group channel positions into adjacent stereo pairs and return friendly labels.
fn stereo_pairs(positions: &[String]) -> Vec<(Vec<String>, String)> {
    positions
        .chunks(2)
        .filter(|pair| pair.len() == 2)
        .map(|pair| {
            let label = match (pair[0].as_str(), pair[1].as_str()) {
                ("FL", "FR") => "Front".to_string(),
                ("RL", "RR") => "Rear".to_string(),
                ("SL", "SR") => "Side".to_string(),
                ("FC", "LFE1") | ("FC", "LFE") => "Center/Sub".to_string(),
                (a, b) => format!("{}/{}", a, b),
            };
            (pair.to_vec(), label)
        })
        .collect()
}

// ── pactl list sinks (PulseAudio / PipeWire compat) ───────────────────────────

fn query_pactl() -> Result<Vec<AudioDevice>, Box<dyn std::error::Error>> {
    let out = std::process::Command::new("pactl")
        .args(["list", "sinks"])
        .output()?;
    if !out.status.success() {
        return Err(format!("pactl exited {}", out.status.code().unwrap_or(-1)).into());
    }
    Ok(parse_pactl_sinks(&String::from_utf8_lossy(&out.stdout)))
}

fn parse_pactl_sinks(text: &str) -> Vec<AudioDevice> {
    let mut devices = vec![];
    let mut current_name: Option<String> = None;
    let mut current_desc: Option<String> = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Sink #") {
            if let Some(name) = current_name.take() {
                let label = current_desc.take().unwrap_or_else(|| name.clone());
                devices.push(AudioDevice { id: name, label });
            } else {
                current_desc = None;
            }
        } else if let Some(name) = trimmed.strip_prefix("Name:") {
            current_name = Some(name.trim().to_string());
        } else if let Some(desc) = trimmed.strip_prefix("Description:") {
            current_desc = Some(desc.trim().to_string());
        }
    }
    if let Some(name) = current_name {
        let label = current_desc.unwrap_or_else(|| name.clone());
        devices.push(AudioDevice { id: name, label });
    }

    devices
}

#[cfg(test)]
mod tests {
    use super::{dedupe_main_devices, parse_default_sink, parse_pactl_sinks, parse_pw_dump};

    const CODEC: &str = "alsa_output.usb-BurrBrown.analog-stereo";
    const STARLIGHT: &str = "alsa_output.usb-Guillemot.analog-surround-40";

    fn v(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn default_and_its_explicit_id_are_one_device() {
        // The 2026-09-26 doubling: ["", CODEC] with the default being CODEC.
        let (kept, dropped) = dedupe_main_devices(&v(&["", CODEC]), Some(CODEC));
        assert_eq!(kept, v(&[""]));
        assert_eq!(dropped, v(&[CODEC]));
        // Order does not matter for detection; first wins.
        let (kept, dropped) = dedupe_main_devices(&v(&[CODEC, ""]), Some(CODEC));
        assert_eq!(kept, v(&[CODEC]));
        assert_eq!(dropped, v(&[""]));
    }

    #[test]
    fn distinct_devices_are_untouched() {
        let ids = v(&["", STARLIGHT]);
        let (kept, dropped) = dedupe_main_devices(&ids, Some(CODEC));
        assert_eq!(kept, ids);
        assert!(dropped.is_empty());
        // Unknown default: "" stays its own entry, nothing is guessed.
        let ids = v(&["", CODEC]);
        let (kept, dropped) = dedupe_main_devices(&ids, None);
        assert_eq!(kept, ids);
        assert!(dropped.is_empty());
    }

    #[test]
    fn channel_pair_variants_on_one_node_are_not_duplicates() {
        let front = format!("{STARLIGHT}@front");
        let rear = format!("{STARLIGHT}@rear");
        let ids = vec![front.clone(), rear.clone()];
        let (kept, dropped) = dedupe_main_devices(&ids, Some(STARLIGHT));
        assert_eq!(kept, ids);
        assert!(dropped.is_empty());
        // ...but an exact repeat is.
        let (kept, dropped) = dedupe_main_devices(&[front.clone(), front.clone()], None);
        assert_eq!(kept, vec![front.clone()]);
        assert_eq!(dropped, vec![front]);
    }

    #[test]
    fn default_sink_read_from_metadata() {
        let json = r#"[
          {"type":"PipeWire:Interface:Metadata","props":{"metadata.name":"settings"},"metadata":[]},
          {"type":"PipeWire:Interface:Metadata","props":{"metadata.name":"default"},"metadata":[
            {"subject":0,"key":"default.configured.audio.sink","type":"Spa:String:JSON","value":{"name":"auto_null"}},
            {"subject":0,"key":"default.audio.sink","type":"Spa:String:JSON","value":{"name":"alsa_output.x"}}
          ]}]"#;
        assert_eq!(parse_default_sink(json).as_deref(), Some("alsa_output.x"));
        let as_string = json.replace(r#"{"name":"alsa_output.x"}"#, r#""{\"name\":\"alsa_output.y\"}""#);
        assert_eq!(parse_default_sink(&as_string).as_deref(), Some("alsa_output.y"));
        assert_eq!(parse_default_sink("[]"), None);
        assert_eq!(parse_default_sink("not json"), None);
    }

    #[test]
    fn pw_dump_extracts_audio_sinks() {
        let json = r#"[
          {
            "id": 42,
            "info": {
              "props": {
                "media.class": "Audio/Sink",
                "node.name": "alsa_output.usb-foo.analog-stereo",
                "node.nick": "USB AUDIO CODEC"
              }
            }
          },
          {
            "id": 43,
            "info": {
              "props": {
                "media.class": "Audio/Source",
                "node.name": "alsa_input.usb-foo.mono",
                "node.nick": "USB Microphone"
              }
            }
          }
        ]"#;
        let devs = parse_pw_dump(json).unwrap();
        assert_eq!(devs.len(), 1);
        assert_eq!(devs[0].id, "alsa_output.usb-foo.analog-stereo");
        assert_eq!(devs[0].label, "USB AUDIO CODEC");
    }

    #[test]
    fn pw_dump_disambiguates_shared_nick() {
        // Two separate sink nodes from one physical device: different node.description.
        let json = r#"[
          {
            "id": 10,
            "info": {
              "props": {
                "media.class": "Audio/Sink",
                "node.name": "alsa_output.usb-djcontrol.analog-stereo",
                "node.nick": "DJControl Starlight",
                "node.description": "DJControl Starlight Master"
              }
            }
          },
          {
            "id": 11,
            "info": {
              "props": {
                "media.class": "Audio/Sink",
                "node.name": "alsa_output.usb-djcontrol.analog-stereo2",
                "node.nick": "DJControl Starlight",
                "node.description": "DJControl Starlight Headphones"
              }
            }
          }
        ]"#;
        let devs = parse_pw_dump(json).unwrap();
        assert_eq!(devs.len(), 2);
        // Both share the nick, so description is used for both.
        assert_eq!(devs[0].label, "DJControl Starlight Master");
        assert_eq!(devs[1].label, "DJControl Starlight Headphones");
    }

    #[test]
    fn pw_dump_expands_multichannel_sink_into_pairs() {
        // A 4-channel analog-surround-40 sink (FL,FR,RL,RR) should produce two entries:
        // one for Front (FL,FR) and one for Rear (RL,RR).
        let json = r#"[
          {
            "id": 242,
            "info": {
              "props": {
                "media.class": "Audio/Sink",
                "node.name": "alsa_output.usb-Guillemot.analog-surround-40",
                "node.nick": "DJControl Starlight",
                "node.description": "DJControl Starlight Analog Surround 4.0",
                "audio.channels": 4,
                "audio.position": "FL,FR,RL,RR"
              }
            }
          }
        ]"#;
        let devs = parse_pw_dump(json).unwrap();
        assert_eq!(devs.len(), 2);
        assert_eq!(devs[0].id, "alsa_output.usb-Guillemot.analog-surround-40@FL,FR!FL,FR,RL,RR");
        assert_eq!(devs[0].label, "DJControl Starlight — Front");
        assert_eq!(devs[1].id, "alsa_output.usb-Guillemot.analog-surround-40@RL,RR!FL,FR,RL,RR");
        assert_eq!(devs[1].label, "DJControl Starlight — Rear");
    }

    #[test]
    fn pw_dump_strips_brackets_from_real_audio_position_format() {
        // Real `pw-dump` output (confirmed live 2026-08-02) wraps audio.position in
        // brackets with a space after each comma — not the bare "FL,FR,RL,RR" the
        // other fixtures use. A parser that only trims whitespace per token leaves
        // "[ FL" / "RR ]" as the first/last channels, corrupting every downstream id.
        let json = r#"[
          {
            "id": 71,
            "info": {
              "props": {
                "media.class": "Audio/Sink",
                "node.name": "alsa_output.usb-Guillemot.analog-surround-40",
                "node.nick": "DJControl Starlight",
                "node.description": "DJControl Starlight Analog Surround 4.0",
                "audio.channels": 4,
                "audio.position": "[ FL, FR, RL, RR ]"
              }
            }
          }
        ]"#;
        let devs = parse_pw_dump(json).unwrap();
        assert_eq!(devs.len(), 2);
        assert_eq!(devs[0].id, "alsa_output.usb-Guillemot.analog-surround-40@FL,FR!FL,FR,RL,RR");
        assert_eq!(devs[1].id, "alsa_output.usb-Guillemot.analog-surround-40@RL,RR!FL,FR,RL,RR");
    }

    #[test]
    fn pactl_parses_two_sinks() {
        let input = "\
Sink #0
\tName: alsa_output.pci-0000_00_1f.3.analog-stereo
\tDescription: Built-in Audio Analog Stereo

Sink #1
\tName: bluez_sink.AA_BB_CC_DD_EE_FF.a2dp_sink
\tDescription: Sony WH-1000XM4
";
        let devs = parse_pactl_sinks(input);
        assert_eq!(devs.len(), 2);
        assert_eq!(devs[0].id, "alsa_output.pci-0000_00_1f.3.analog-stereo");
        assert_eq!(devs[0].label, "Built-in Audio Analog Stereo");
        assert_eq!(devs[1].label, "Sony WH-1000XM4");
    }
}
