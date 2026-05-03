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

fn parse_pw_dump(json_text: &str) -> Result<Vec<AudioDevice>, Box<dyn std::error::Error>> {
    let nodes: Vec<serde_json::Value> = serde_json::from_str(json_text)?;
    let mut devices = vec![];

    for node in &nodes {
        let props = match node.get("info").and_then(|i| i.get("props")) {
            Some(p) => p,
            None => continue,
        };

        if props.get("media.class").and_then(|v| v.as_str()) != Some("Audio/Sink") {
            continue;
        }

        let id = match props.get("node.name").and_then(|v| v.as_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        // Prefer nick (short name like "USB AUDIO CODEC") over description (longer).
        let label = props
            .get("node.nick")
            .or_else(|| props.get("node.description"))
            .and_then(|v| v.as_str())
            .unwrap_or(&id)
            .trim()
            .to_string();

        devices.push(AudioDevice { id, label });
    }

    Ok(devices)
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
