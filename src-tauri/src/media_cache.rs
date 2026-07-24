// Local disk cache for media files loaded from a network share.
//
// The music library here is served over SMB/CIFS (`/media/memory/...`), not local
// storage. Scratch playback deliberately leaves the normal `uridecodebin` playback
// branch frozen for the length of a gesture — only the pre-decoded in-RAM PCM buffer
// is touched (see pcm_buffer.rs) — and a live repro showed that resuming that branch
// with an `ACCURATE` seek after several idle seconds can block for ~10s, almost
// certainly an SMB idle-reconnect/re-negotiation stall. See docs/design/
// pcm-buffer-playback.md, "network share" investigation, 2026-07-23.
//
// Fix: copy the file to local disk once at load time and read everything else (PCM
// decode, uridecodebin preroll/seeks, waveform analysis, and video playback via
// media_server.rs) from that local copy instead. The network is touched exactly once
// per track (the same full-file read PCM decode already required), instead of
// repeatedly and unpredictably on every seek.
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct MediaCache {
    dir: PathBuf,
    /// original path -> local cached path, so the HTTP media server (media_server.rs)
    /// and audio_analyze_file can find an already-cached copy without touching the
    /// network themselves — only ensure_cached() (called once from audio_load) does
    /// the actual network read.
    resolved: Mutex<HashMap<String, String>>,
}

impl MediaCache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, resolved: Mutex::new(HashMap::new()) }
    }

    /// Best-effort, non-blocking lookup of an already-cached local path. Never touches
    /// the network — callers fall back to the original path on a miss.
    pub fn lookup(&self, original_path: &str) -> Option<String> {
        let hit = self.resolved.lock().unwrap().get(original_path).cloned()?;
        Path::new(&hit).is_file().then_some(hit)
    }

    /// Copies `original_path` into the cache dir if not already there, and records the
    /// mapping for lookup(). Blocking (a full-file network read on a cache miss) —
    /// call off the IPC thread for large files. Idempotent: a second call for the same
    /// path that hasn't changed size is a cheap stat, not a re-copy.
    pub fn ensure_cached(&self, original_path: &str) -> Result<String, String> {
        if let Some(hit) = self.lookup(original_path) {
            return Ok(hit);
        }

        let src = Path::new(original_path);
        let meta = fs::metadata(src).map_err(|e| format!("stat {original_path}: {e}"))?;
        let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("bin");
        // Cache key includes size so a replaced/changed source file re-copies instead of
        // silently serving stale cached bytes forever.
        let cached_path = self.dir.join(format!("{:016x}-{}.{ext}", path_hash(original_path), meta.len()));

        if !cached_path.is_file() {
            fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
            // Copy to a temp name first and rename into place — an interrupted copy
            // (app killed mid-load) must never leave a truncated file at the final path
            // that a later lookup() would trust as complete.
            let tmp_path = self.dir.join(format!("{:016x}-{}.{ext}.part", path_hash(original_path), meta.len()));
            fs::copy(src, &tmp_path).map_err(|e| format!("cache copy {original_path}: {e}"))?;
            fs::rename(&tmp_path, &cached_path).map_err(|e| e.to_string())?;
            log::info!("[media_cache] cached {original_path} ({} bytes) -> {}", meta.len(), cached_path.display());
        }

        let local = cached_path.to_string_lossy().into_owned();
        self.resolved.lock().unwrap().insert(original_path.to_string(), local.clone());
        Ok(local)
    }
}

fn path_hash(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}
