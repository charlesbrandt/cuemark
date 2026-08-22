/// Session recording: encodes to a file, structurally excluding cue/headphone audio.
///
/// This struct is just the on/off flag and the target path/format — a deliberately thin
/// state holder. The actual GStreamer wiring lives in two other places, since a recording
/// spans every deck plus a dedicated output-graph node, neither of which `RecordingSink`
/// has any access to:
///   - `DeckAudioPipeline::attach_record_branch()`/`detach_record_branch()` (`pipeline.rs`)
///     tap each deck directly off its own tee, upstream of `cue_valve`/`cue_volume` — there
///     is no graph edge from the cue chain into a recording, by construction, not convention.
///   - `OutputGraph`'s `RECORD_DEVICE_KEY` node (`mixer.rs`) — `set_record_target()`,
///     `create_node()`'s encoder chain, and `finish_recording()`'s EOS-and-teardown — mirrors
///     every other output node except that it is explicitly torn down on stop rather than
///     retained for the process's life.
/// `AudioManager::audio_record_start`/`audio_record_stop` (`mod.rs`) are what actually call
/// all of the above, for every currently-loaded deck.
///
/// Supported formats — both mux into Ogg, deliberately: Ogg pages are self-delimiting and
/// written sequentially with no footer/index to finalize, so a recording cut off by a crash
/// (app kill, power loss) is still a valid, playable file up to the last completed page. See
/// `mixer.rs`'s `build_record_sink_chain()` doc comment for why FLAC moved off Matroska to
/// get the same property.
///   "opus"  → Opus audio in Ogg container   (lossy, small files)
///   "flac"  → FLAC audio in Ogg container   (lossless, archival, crash-safe like opus)
///
/// GStreamer chain, per deck, into the shared record node:
///   [deck tee src pad] → volume → appsink ⇒ handoff ⇒ appsrc → queue → matrix → caps → mixer
///     → master_volume → audioconvert → audioresample → opusenc|flacenc → oggmux → filesink

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordFormat {
    Opus,
    Flac,
}

impl std::fmt::Display for RecordFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecordFormat::Opus => write!(f, "opus"),
            RecordFormat::Flac => write!(f, "flac"),
        }
    }
}

pub struct RecordingSink {
    output_path: Option<std::path::PathBuf>,
    format: RecordFormat,
    active: bool,
}

impl RecordingSink {
    pub fn new() -> Self {
        Self {
            output_path: None,
            format: RecordFormat::Opus,
            active: false,
        }
    }

    /// Record the on/off flag and the chosen target. Errors (does not no-op) if already
    /// recording — the caller (`AudioManager::audio_record_start`) is expected to check
    /// `is_active()` if it wants idempotent behavior instead. Building the actual GStreamer
    /// chain (the output graph's record node, then every deck's tap into it) is the caller's
    /// job too — see this module's doc comment for why `RecordingSink` itself doesn't do it.
    pub fn start(
        &mut self,
        output_path: std::path::PathBuf,
        format: RecordFormat,
    ) -> Result<(), String> {
        if self.active {
            return Err("already recording".into());
        }
        self.output_path = Some(output_path);
        self.format = format;
        self.active = true;
        log::info!("[record] start recording to {:?} ({})", self.output_path, self.format);
        Ok(())
    }

    /// Clear the on/off flag. As with `start()`, tearing down the actual GStreamer chain
    /// (every deck's tap, then the record node's own EOS-and-teardown) is the caller's job.
    pub fn stop(&mut self) -> Result<(), String> {
        if !self.active {
            return Err("not recording".into());
        }
        self.active = false;
        log::info!("[record] stop recording");
        // Step 8: send EOS, wait for pipeline drain, unlink from tee.
        Ok(())
    }

    pub fn is_active(&self) -> bool {
        self.active
    }
}
