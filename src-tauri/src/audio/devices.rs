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
            eprintln!("[audio/devices] device enumeration failed: {e}");
            vec![]
        }
    }
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

        let position: Vec<String> = props
            .get("audio.position")
            .and_then(|v| v.as_str())
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
    use super::{parse_pw_dump, parse_pactl_sinks};

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
