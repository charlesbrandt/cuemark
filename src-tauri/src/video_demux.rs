/// Parse-only video demux service (docs/design/webcodecs-video-path.md, phase 1).
///
/// Pipeline: `filesrc ! parsebin ! h264parse config-interval=-1
/// ! video/x-h264,stream-format=byte-stream,alignment=au ! appsink`. `parsebin` demuxes
/// the container and auto-selects a parser like `decodebin` auto-selects decoders — but
/// **stops before decoding**, so this never instantiates a video decoder element and
/// cannot touch the VA-API corruption class of bug documented in `project_av1_vaapi_bug`.
/// We add our own explicit `h264parse` downstream regardless of what parsebin already
/// did internally (harmless to re-parse an already-parsed stream) so `config-interval`
/// and the byte-stream/AU output format are guaranteed, not dependent on parsebin's
/// internal autoplug choices.
///
/// Phase 1 supports H.264 only: the WebCodecs `avc1.PPCCLL` codec string is read
/// directly off the SPS NAL's profile_idc/constraint_flags/level_idc bytes (present
/// verbatim in every keyframe AU once `config-interval=-1` forces in-band SPS/PPS),
/// which is exact — no name-to-code table for h264parse's string-valued `profile`/
/// `level` caps fields (e.g. "high"/"4.1") needed. Any other codec returns an honest
/// `Err` (see the design doc's explicit allowance) — the frontend already has the
/// legacy `<video>` fallback for a deck whose source fails this path.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use gstreamer::{self as gst, prelude::*};
use gstreamer_app::AppSink;
use tauri::State;

use crate::media_cache::MediaCache;

/// One encoded access unit, byte-stream (Annex-B) formatted.
struct Au {
    pts_us: i64,
    dur_us: i64,
    key: bool,
    data: Vec<u8>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyframeEntry {
    pub au_index: u32,
    pub pts_us: i64,
}

/// Returned to the frontend by `video_demux_load` and cached for the follow-up
/// `getAudioTime`-style debug hooks; not persisted anywhere.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DemuxResult {
    pub codec: String,
    pub coded_width: i32,
    pub coded_height: i32,
    pub fps_hint: f64,
    pub au_count: u32,
    pub keyframes: Vec<KeyframeEntry>,
    /// Seconds — matches `DeckSource.duration`'s unit convention elsewhere in the app.
    pub duration: f64,
}

struct DemuxedVideo {
    coded_width: i32,
    coded_height: i32,
    fps_hint: f64,
    aus: Vec<Au>,
    keyframes: Vec<KeyframeEntry>,
    duration: f64,
    codec: String,
}

impl DemuxedVideo {
    fn to_result(&self) -> DemuxResult {
        DemuxResult {
            codec: self.codec.clone(),
            coded_width: self.coded_width,
            coded_height: self.coded_height,
            fps_hint: self.fps_hint,
            au_count: self.aus.len() as u32,
            keyframes: self.keyframes.clone(),
            duration: self.duration,
        }
    }
}

/// Per-deck demuxed-AU store, shared (via `Arc`) between the Tauri commands below and
/// `media_server.rs`'s `/demux/<deck_id>/aus` HTTP route. One entry per `deck_id`,
/// replaced wholesale on the next `video_demux_load` for that deck — this is live state
/// for whatever's currently loaded, not a keyed cache like `analysis::AnalysisCache`, so
/// no LRU/capacity bound is needed.
pub struct VideoDemuxRegistry {
    demuxed: Mutex<HashMap<String, DemuxedVideo>>,
}

impl VideoDemuxRegistry {
    pub fn new() -> Self {
        Self { demuxed: Mutex::new(HashMap::new()) }
    }

    fn insert(&self, deck_id: String, video: DemuxedVideo) {
        self.demuxed.lock().unwrap().insert(deck_id, video);
    }

    fn remove(&self, deck_id: &str) {
        self.demuxed.lock().unwrap().remove(deck_id);
    }

    /// Binary framing for the HTTP route: per AU,
    /// `[u32 le length][u8 flags(bit0=key)][i64 le pts_us][i64 le dur_us][data…]`,
    /// concatenated for AUs `[from, from+count)`. `None` only means "no such deck" —
    /// a range past the end of the AU list returns `Some(empty vec)`, a valid (if
    /// useless) response rather than a 404, since "ran past the end" is a normal
    /// outcome of the frontend's decode-ahead loop, not an error.
    pub fn encode_aus_range(&self, deck_id: &str, from: usize, count: usize) -> Option<Vec<u8>> {
        let guard = self.demuxed.lock().unwrap();
        let video = guard.get(deck_id)?;
        if from >= video.aus.len() {
            return Some(Vec::new());
        }
        let end = from.saturating_add(count).min(video.aus.len());
        let mut out = Vec::new();
        for au in &video.aus[from..end] {
            out.extend_from_slice(&(au.data.len() as u32).to_le_bytes());
            out.push(if au.key { 1 } else { 0 });
            out.extend_from_slice(&au.pts_us.to_le_bytes());
            out.extend_from_slice(&au.dur_us.to_le_bytes());
            out.extend_from_slice(&au.data);
        }
        Some(out)
    }
}

fn make_el(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory)
        .build()
        .map_err(|e| format!("GStreamer element '{factory}' not found: {e}"))
}

/// Sets the pipeline to `Null` when dropped, so every early `?` return in `demux_file`
/// tears the pipeline down instead of leaking it or leaving a background streaming
/// thread running past the function's lifetime.
struct PipelineGuard(gst::Pipeline);
impl Drop for PipelineGuard {
    fn drop(&mut self) {
        let _ = self.0.set_state(gst::State::Null);
    }
}

/// Outcome of parsebin exposing its first video pad, sent from the (GStreamer streaming
/// thread's) `pad-added` callback back to `demux_file`'s calling thread.
enum PadResult {
    Supported { width: i32, height: i32, fps_hint: f64 },
    Unsupported(String),
}

/// Scans byte-stream Annex-B data (one or more start-code-delimited NAL units) for an
/// H.264 SPS (`nal_unit_type` 7) and returns `(profile_idc, constraint_flags, level_idc)`
/// — exactly the three bytes a WebCodecs `avc1.PPCCLL` codec string encodes, read
/// straight off the bitstream rather than re-derived from h264parse's string-valued
/// `profile`/`level` caps fields (e.g. "high"/"4.1"), which would need a second,
/// error-prone name→numeric-code table for a value the SPS already carries verbatim.
fn find_h264_sps_profile_level(data: &[u8]) -> Option<(u8, u8, u8)> {
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            let nal_start = i + 3;
            if nal_start < data.len() {
                let nal_type = data[nal_start] & 0x1f;
                if nal_type == 7 && nal_start + 3 < data.len() {
                    return Some((data[nal_start + 1], data[nal_start + 2], data[nal_start + 3]));
                }
            }
            i = nal_start;
        } else {
            i += 1;
        }
    }
    None
}

/// Demuxes `path` (already a local disk path — caller resolves the media cache) into
/// a `DemuxedVideo`. Blocking — GStreamer preroll + a full parse-only pass over the
/// file; call off the Tauri IPC thread for anything but trivially short clips.
fn demux_file(path: &str) -> Result<DemuxedVideo, String> {
    let pipeline = gst::Pipeline::new();
    let src = make_el("filesrc")?;
    src.set_property("location", path);
    let parsebin = make_el("parsebin")?;
    let appsink_el = make_el("appsink")?;
    let sink = appsink_el.downcast_ref::<AppSink>().unwrap().clone();
    sink.set_sync(false);

    pipeline
        .add_many([&src, &parsebin, &appsink_el])
        .map_err(|e| format!("add_many: {e}"))?;
    src.link(&parsebin).map_err(|e| format!("filesrc->parsebin: {e}"))?;

    let _guard = PipelineGuard(pipeline.clone());

    let (tx, rx) = mpsc::channel::<PadResult>();
    let tx = Arc::new(Mutex::new(tx));
    let linked = Arc::new(AtomicBool::new(false));
    let pipeline_weak = pipeline.downgrade();
    let sink_for_pad = sink.clone();

    parsebin.connect_pad_added(move |_, pad| {
        if linked.swap(true, Ordering::SeqCst) {
            return; // only the first video pad is handled; later pads (e.g. audio) are ignored
        }
        let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
        let Some(s) = caps.structure(0) else {
            linked.store(false, Ordering::SeqCst);
            return;
        };
        let name = s.name().to_string();
        if !name.starts_with("video/") {
            linked.store(false, Ordering::SeqCst); // let a later video pad still be handled
            return;
        }

        if name != "video/x-h264" {
            let _ = tx.lock().unwrap().send(PadResult::Unsupported(format!(
                "unsupported codec for WebCodecs demux path: {name} (H.264 only in phase 1)"
            )));
            return;
        }

        let width = s.get::<i32>("width").unwrap_or(0);
        let height = s.get::<i32>("height").unwrap_or(0);
        let fps_hint = s
            .get::<gst::Fraction>("framerate")
            .ok()
            .filter(|f| f.denom() != 0)
            .map(|f| f.numer() as f64 / f.denom() as f64)
            .unwrap_or(0.0);

        let link_result = (|| -> Result<(), String> {
            let pipeline = pipeline_weak.upgrade().ok_or("pipeline dropped mid-negotiation")?;
            let h264parse = make_el("h264parse")?;
            // -1 = repeat SPS/PPS in-band before every keyframe, not just the first — our
            // own SPS scan (below) needs to find one at whichever keyframe a seek lands on.
            h264parse.set_property("config-interval", -1i32);
            let capsfilter = make_el("capsfilter")?;
            let filter_caps = gst::Caps::builder("video/x-h264")
                .field("stream-format", "byte-stream")
                .field("alignment", "au")
                .build();
            capsfilter.set_property("caps", &filter_caps);

            pipeline
                .add_many([&h264parse, &capsfilter])
                .map_err(|e| format!("add h264parse/capsfilter: {e}"))?;
            gst::Element::link_many([&h264parse, &capsfilter])
                .map_err(|e| format!("h264parse->capsfilter: {e}"))?;
            capsfilter
                .link(&sink_for_pad)
                .map_err(|e| format!("capsfilter->appsink: {e}"))?;
            h264parse.sync_state_with_parent().map_err(|e| format!("h264parse sync_state: {e}"))?;
            capsfilter.sync_state_with_parent().map_err(|e| format!("capsfilter sync_state: {e}"))?;

            let sink_pad = h264parse.static_pad("sink").ok_or("h264parse has no sink pad")?;
            pad.link(&sink_pad).map_err(|e| format!("parsebin->h264parse: {e}"))?;
            Ok(())
        })();

        let _ = tx.lock().unwrap().send(match link_result {
            Ok(()) => PadResult::Supported { width, height, fps_hint },
            Err(e) => PadResult::Unsupported(e),
        });
    });

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set_state(Playing): {e}"))?;

    let (coded_width, coded_height, fps_hint) =
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(PadResult::Supported { width, height, fps_hint }) => (width, height, fps_hint),
            Ok(PadResult::Unsupported(e)) => return Err(e),
            Err(_) => return Err("timed out waiting for parsebin to expose a video stream".into()),
        };

    let mut aus = Vec::new();
    let mut keyframes = Vec::new();
    let mut max_end_us = 0i64;
    let bus = pipeline.bus().ok_or("no pipeline bus")?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if Instant::now() > deadline {
            return Err("timed out pulling access units (pipeline stalled)".into());
        }
        match sink.try_pull_sample(gst::ClockTime::from_mseconds(500)) {
            Some(sample) => {
                let Some(buf) = sample.buffer() else { continue };
                let Ok(map) = buf.map_readable() else { continue };
                let pts_us = buf.pts().map(|t| t.useconds() as i64).unwrap_or(0);
                let dur_us = buf.duration().map(|t| t.useconds() as i64).unwrap_or(0);
                let key = !buf.flags().contains(gst::BufferFlags::DELTA_UNIT);
                if key {
                    keyframes.push(KeyframeEntry { au_index: aus.len() as u32, pts_us });
                }
                aus.push(Au { pts_us, dur_us, key, data: map.as_slice().to_vec() });
                max_end_us = max_end_us.max(pts_us + dur_us);
            }
            None => {
                if let Some(msg) = bus.pop_filtered(&[gst::MessageType::Eos, gst::MessageType::Error]) {
                    match msg.view() {
                        gst::MessageView::Error(e) => {
                            return Err(format!("gstreamer error: {} ({:?})", e.error(), e.debug()));
                        }
                        gst::MessageView::Eos(_) => break,
                        _ => {}
                    }
                }
                if sink.is_eos() {
                    break;
                }
            }
        }
    }

    if aus.is_empty() {
        return Err("no access units demuxed (empty or unreadable video stream)".into());
    }

    let codec = aus
        .iter()
        .filter(|au| au.key)
        .find_map(|au| find_h264_sps_profile_level(&au.data))
        .map(|(p, c, l)| format!("avc1.{p:02x}{c:02x}{l:02x}"))
        .ok_or_else(|| "could not locate an H.264 SPS to derive a WebCodecs codec string".to_string())?;

    log::info!(
        "[video_demux] {path}: codec={codec} {coded_width}x{coded_height}@{fps_hint:.2} \
         au_count={} keyframes={}",
        aus.len(),
        keyframes.len()
    );

    Ok(DemuxedVideo {
        codec,
        coded_width,
        coded_height,
        fps_hint,
        duration: max_end_us as f64 / 1_000_000.0,
        keyframes,
        aus,
    })
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Demuxes `file_path` (via the media cache — see `media_cache.rs`) into encoded H.264
/// access units for the frontend's WebCodecs debug probe / (phase 2+) `codecPlayer.ts`.
/// Async + `spawn_blocking`, same pattern as `audio::audio_analyze_file`: this can take
/// up to several hundred ms for a long file and must not block the Tauri IPC thread.
#[tauri::command]
pub async fn video_demux_load(
    cache: State<'_, Arc<MediaCache>>,
    registry: State<'_, Arc<VideoDemuxRegistry>>,
    deck_id: String,
    file_path: String,
) -> Result<DemuxResult, String> {
    let cache = cache.inner().clone();
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Waits out an in-progress ensure_cached() copy instead of a bare best-effort
        // lookup, same reasoning as audio_analyze_file — this can race audio_load's
        // cache copy for the same file on initial track load.
        let path = cache
            .lookup_wait(&file_path, Duration::from_secs(10))
            .unwrap_or(file_path);
        let video = demux_file(&path)?;
        let result = video.to_result();
        registry.insert(deck_id, video);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn video_demux_unload(registry: State<'_, Arc<VideoDemuxRegistry>>, deck_id: String) -> Result<(), String> {
    registry.remove(&deck_id);
    Ok(())
}
