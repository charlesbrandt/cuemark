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
use serde::Serialize;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

enum CacheEntry {
    InProgress,
    Ready(String),
}

/// Phase 1 of docs/design/queue-prefetch-cache.md — read-only usage snapshot for the
/// Settings "Storage" tab. `pending`/`in_flight` are phase-2 concepts (the background
/// prefetch worker doesn't exist yet); they're in the struct now so the eventual real
/// implementation is a non-breaking fill-in rather than a frontend contract change.
#[derive(Debug, Clone, Serialize)]
pub struct MediaCacheStats {
    pub bytes: u64,
    pub files: u64,
    pub free_bytes: u64,
    pub pending: u64,
    pub in_flight: Option<String>,
}

pub struct MediaCache {
    dir: PathBuf,
    /// original path -> cache state, so the HTTP media server (media_server.rs)
    /// and audio_analyze_file can find an already-cached copy without touching the
    /// network themselves — only ensure_cached() (called once from audio_load) does
    /// the actual network read. `cond` wakes lookup_wait() callers when an entry
    /// transitions out of InProgress.
    resolved: Mutex<HashMap<String, CacheEntry>>,
    cond: Condvar,
}

impl MediaCache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, resolved: Mutex::new(HashMap::new()), cond: Condvar::new() }
    }

    /// Best-effort, non-blocking lookup of an already-cached local path. Never touches
    /// the network and never waits — a path still InProgress reads as a miss.
    pub fn lookup(&self, original_path: &str) -> Option<String> {
        match self.resolved.lock().unwrap().get(original_path) {
            Some(CacheEntry::Ready(p)) => Path::new(p).is_file().then(|| p.clone()),
            _ => None,
        }
    }

    /// Like lookup(), but if ensure_cached() is currently copying this exact path, waits
    /// (up to `timeout`) for it to finish instead of reporting an immediate miss. Fixes a
    /// race where a video's first HTTP request (media_server.rs) can arrive before
    /// audio_load's ensure_cached() finishes copying the file locally — previously that
    /// request (and any using the same still-open connection) would silently fall back to
    /// streaming straight off the SMB-mounted original, exposing video playback to the same
    /// "SMB idle-reconnect stall" class of bug already root-caused and fixed for the audio
    /// path and scratch's resync_seek (docs/design/pcm-buffer-playback.md, "Second freeze
    /// mechanism") but never patched for this path. Confirmed live: a sustained non-1.0-rate
    /// playback session stalled WebKit's <video> element at ~90% through a track — readyState
    /// stuck at HAVE_CURRENT_DATA, every GStreamer streaming thread parked waiting for data
    /// that never arrived — while the Rust audio pipeline (already on the local cache) kept
    /// playing fine (see "Ninth mechanism", same doc, 2026-07-25). A path that was never
    /// requested to be cached at all (no matching entry) still returns None immediately —
    /// this only waits out a copy that's actually in flight.
    pub fn lookup_wait(&self, original_path: &str, timeout: Duration) -> Option<String> {
        let mut guard = self.resolved.lock().unwrap();
        let deadline = Instant::now() + timeout;
        loop {
            match guard.get(original_path) {
                Some(CacheEntry::Ready(p)) => return Path::new(p).is_file().then(|| p.clone()),
                Some(CacheEntry::InProgress) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return None;
                    }
                    let (g, _) = self.cond.wait_timeout(guard, remaining).unwrap();
                    guard = g;
                }
                None => return None,
            }
        }
    }

    /// Copies `original_path` into the cache dir if not already there, and records the
    /// mapping for lookup(). Blocking (a full-file network read on a cache miss) —
    /// call off the IPC thread for large files. Idempotent: a second call for the same
    /// path that hasn't changed size is a cheap stat, not a re-copy.
    ///
    /// `remote_fallback`, if given, is a Digger `GET /files/{id}` URL tried only when
    /// `original_path` doesn't stat locally at all — e.g. cuemark running on a machine
    /// without the NAS mounted, Digger reachable over the LAN instead. See
    /// docs/design/offline-crate.md (digger repo) "Rejected alternative: streaming as the
    /// primary load path" for why this fetches once into the same local cache slot rather
    /// than streaming the URL directly into GStreamer/the `<video>` element every time.
    pub fn ensure_cached(&self, original_path: &str, remote_fallback: Option<&str>) -> Result<String, String> {
        let start = Instant::now();
        {
            let mut guard = self.resolved.lock().unwrap();
            match guard.get(original_path) {
                Some(CacheEntry::Ready(p)) => {
                    // lookup()/lookup_wait() both re-check is_file() before trusting a Ready
                    // entry; this branch didn't, and eviction (a later phase) will make that
                    // gap reachable — a Ready entry pointing at a since-deleted file must fall
                    // through to a re-copy below, not hand back a dead path.
                    if Path::new(p).is_file() {
                        log::info!(
                            "[media_cache] hit path={original_path} ms={:.1}",
                            start.elapsed().as_secs_f64() * 1000.0
                        );
                        return Ok(p.clone());
                    }
                    guard.insert(original_path.to_string(), CacheEntry::InProgress);
                }
                Some(CacheEntry::InProgress) => {
                    // Another caller is already copying this exact path (shouldn't normally
                    // happen — audio_load is the only ensure_cached() caller — but wait
                    // rather than racing a duplicate copy if it ever does).
                    drop(guard);
                    return self
                        .lookup_wait(original_path, Duration::from_secs(60))
                        .ok_or_else(|| format!("timed out waiting for concurrent cache of {original_path}"));
                }
                None => {
                    guard.insert(original_path.to_string(), CacheEntry::InProgress);
                }
            }
        }

        let result = (|| -> Result<String, String> {
            let src = Path::new(original_path);
            let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("bin");

            match fs::metadata(src) {
                Ok(meta) => {
                    // Cache key includes size so a replaced/changed source file re-copies
                    // instead of silently serving stale cached bytes forever.
                    let cached_path = self.dir.join(format!("{:016x}-{}.{ext}", path_hash(original_path), meta.len()));

                    if !cached_path.is_file() {
                        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
                        // Copy to a temp name first and rename into place — an interrupted
                        // copy (app killed mid-load) must never leave a truncated file at
                        // the final path that a later lookup() would trust as complete.
                        let tmp_path = self.dir.join(format!("{:016x}-{}.{ext}.part", path_hash(original_path), meta.len()));
                        if let Err(e) = fs::copy(src, &tmp_path) {
                            // Previously left tmp_path on disk forever on a failed copy — the
                            // remote-fetch branch below already cleans up on a truncated
                            // transfer; mirror that here so a permission error or an ENOSPC
                            // mid-copy doesn't leak an invisible .part file that counts
                            // against disk usage permanently.
                            let _ = fs::remove_file(&tmp_path);
                            return Err(format!("cache copy {original_path}: {e}"));
                        }
                        fs::rename(&tmp_path, &cached_path).map_err(|e| e.to_string())?;
                        log::info!(
                            "[media_cache] copy path={original_path} bytes={} ms={:.1}",
                            meta.len(),
                            start.elapsed().as_secs_f64() * 1000.0
                        );
                    } else {
                        log::info!(
                            "[media_cache] hit path={original_path} ms={:.1} (on-disk)",
                            start.elapsed().as_secs_f64() * 1000.0
                        );
                    }

                    Ok(cached_path.to_string_lossy().into_owned())
                }
                Err(local_err) => {
                    let url = remote_fallback
                        .ok_or_else(|| format!("stat {original_path}: {local_err}"))?;

                    // A previous run may have already fetched this exact file into the cache
                    // dir — the in-memory `resolved` map (what the InProgress/Ready check at
                    // the top of this function looks at) resets on every process restart, but
                    // the file on disk doesn't. Without this check, every restart re-downloads
                    // the whole file from Digger even when a byte-identical copy already sits
                    // locally, needlessly widening the exact ensure_cached()-vs-lookup_wait()
                    // race this fallback was built to close (see digger-integration/SKILL.md).
                    // The remote-fetch cache key can't be predicted up front (filename embeds
                    // the downloaded byte count, unlike the local-stat branch above, which
                    // knows the size from fs::metadata) — scan for any file already using this
                    // path's hash prefix instead.
                    let prefix = format!("{:016x}-", path_hash(original_path));
                    let existing = fs::read_dir(&self.dir).ok().and_then(|entries| {
                        entries.filter_map(|e| e.ok()).find_map(|e| {
                            let name = e.file_name();
                            let name = name.to_str()?;
                            (name.starts_with(&prefix) && name.ends_with(&format!(".{ext}")))
                                .then(|| self.dir.join(name))
                        })
                    });
                    if let Some(cached_path) = existing {
                        log::info!(
                            "[media_cache] {original_path} not found locally, reusing existing cache {}",
                            cached_path.display()
                        );
                        return Ok(cached_path.to_string_lossy().into_owned());
                    }

                    log::info!("[media_cache] {original_path} not found locally, fetching from {url}");

                    let resp = ureq::get(url)
                        .timeout(Duration::from_secs(30))
                        .call()
                        .map_err(|e| format!("fetch {url}: {e}"))?;
                    // Read off before into_reader() consumes the response — an early
                    // connection close reads as a clean EOF to io::copy below, not an
                    // error, so without this a truncated transfer would be written to
                    // disk and cached as if it were the complete file. Live-hit
                    // 2026-08-28: a 536MB fetch "succeeded" 3.6MB short of what its own
                    // MP4 moov atom declared, and — because ensure_cached()'s existing-
                    // file scan above trusts any file already at this path's hash prefix
                    // — every subsequent load kept reusing the same truncated file
                    // forever, never re-fetching.
                    let expected_len: Option<u64> =
                        resp.header("Content-Length").and_then(|v| v.parse().ok());

                    fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
                    // Size isn't known up front for a remote fetch (unlike the local-stat
                    // path above), so the tmp name can't include it — the final cache-key
                    // filename below uses the byte count actually written.
                    let tmp_path = self.dir.join(format!("{:016x}.download", path_hash(original_path)));
                    let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
                    let written = std::io::copy(&mut resp.into_reader(), &mut file)
                        .map_err(|e| format!("download {url}: {e}"))?;
                    file.flush().map_err(|e| e.to_string())?;
                    drop(file);

                    if let Some(expected) = expected_len {
                        if written != expected {
                            let _ = fs::remove_file(&tmp_path);
                            return Err(format!(
                                "download {url}: truncated — got {written} bytes, server declared {expected}"
                            ));
                        }
                    }

                    let cached_path = self.dir.join(format!("{:016x}-{}.{ext}", path_hash(original_path), written));
                    fs::rename(&tmp_path, &cached_path).map_err(|e| e.to_string())?;
                    log::info!(
                        "[media_cache] fetch path={original_path} bytes={written} ms={:.1} url={url}",
                        start.elapsed().as_secs_f64() * 1000.0
                    );

                    Ok(cached_path.to_string_lossy().into_owned())
                }
            }
        })();

        let mut guard = self.resolved.lock().unwrap();
        match &result {
            Ok(local) => {
                guard.insert(original_path.to_string(), CacheEntry::Ready(local.clone()));
            }
            Err(_) => {
                // Allow a later retry instead of permanently reporting InProgress/miss.
                guard.remove(original_path);
            }
        }
        drop(guard);
        self.cond.notify_all();
        result
    }

    /// Rescans the cache dir on every call rather than tracking an incremental counter —
    /// deliberately, per docs/design/queue-prefetch-cache.md §7: "this deliberately
    /// eliminates the entire class of incremental counter drifted from reality bugs."
    /// This is a Settings-panel-only read, not a hot path (a handful of files today,
    /// microseconds even at thousands), so the cost of a full walk is fine.
    pub fn stats(&self) -> MediaCacheStats {
        let mut bytes: u64 = 0;
        let mut files: u64 = 0;
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let Ok(meta) = entry.metadata() else { continue };
                if !meta.is_file() {
                    continue;
                }
                bytes += meta.len();
                // .part/.download are in-flight copies, not cache hits — they occupy
                // space and must count toward `bytes`, but not toward `files`.
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.ends_with(".part") && !name.ends_with(".download") {
                    files += 1;
                }
            }
        }
        // available_space() needs an existing path to stat; the cache dir may not have
        // been created yet (nothing cached this run) — fall back to its parent, which
        // is the app data dir and always exists by the time Tauri is running.
        let free_bytes = fs4::available_space(&self.dir)
            .or_else(|_| fs4::available_space(self.dir.parent().unwrap_or(&self.dir)))
            .unwrap_or(0);
        MediaCacheStats { bytes, files, free_bytes, pending: 0, in_flight: None }
    }
}

fn path_hash(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}
