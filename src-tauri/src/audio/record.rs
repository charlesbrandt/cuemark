/// Session recording: taps the master mix tee and encodes to a file.
///
/// The recording sink chain attaches to MasterMix's output tee on start
/// and releases its pad on stop, leaving the live output uninterrupted.
///
/// Supported formats:
///   "opus"  → Opus audio in OGG container  (lossy, small files)
///   "flac"  → FLAC audio in Matroska container (lossless, archival)
///
/// GStreamer chain (once wired in step 8):
///   [tee src pad] → queue → audioconvert → audioresample
///     → opusenc|flacenc → oggmux|matroskamux → filesink
///
/// Step 1 / stub: struct and command signatures only.

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

    /// Attach to the master mix tee and begin writing to `output_path`.
    /// No-op if already recording.
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
        // Step 8: build encoder chain and link to tee.
        eprintln!("[record] start recording to {:?} ({})", self.output_path, self.format);
        Ok(())
    }

    /// Detach from the tee, flush, and close the file.
    pub fn stop(&mut self) -> Result<(), String> {
        if !self.active {
            return Err("not recording".into());
        }
        self.active = false;
        eprintln!("[record] stop recording");
        // Step 8: send EOS, wait for pipeline drain, unlink from tee.
        Ok(())
    }

    pub fn is_active(&self) -> bool {
        self.active
    }
}
