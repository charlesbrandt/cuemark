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
/// Supported codecs (phase 7, 2026-08-05 — see `docs/design/webcodecs-video-path.md`):
///
/// - **H.264** (`video/x-h264` → `h264parse`, byte-stream/AU). The WebCodecs
///   `avc1.PPCCLL` codec string is read directly off the SPS NAL's
///   profile_idc/constraint_flags/level_idc bytes (present verbatim in every keyframe AU
///   once `config-interval=-1` forces in-band SPS/PPS), which is exact — no name-to-code
///   table for h264parse's string-valued `profile`/`level` caps fields (e.g. "high"/"4.1")
///   needed. The frontend re-muxes each AU Annex-B → avc and configures with a
///   `description` (required on this WebKitGTK, see `h264.ts`).
/// - **VP9** (`video/x-vp9` → `vp9parse`, `alignment=super-frame`). VP9 needs no
///   `description` and no per-AU re-muxing: the parser's super-frame-aligned buffers are
///   exactly what `VideoDecoder.decode()` wants. The `vp09.PP.LL.DD` string comes from
///   the negotiated caps' `profile` and `bit-depth-luma` plus a level derived from
///   resolution × frame rate (`vp9_level_code`), since GStreamer does not report a VP9
///   level. Verified end-to-end by `scripts/probes/webcodecs_vp9_av1_probe.py`:
///   120/120 real AUs decode to I420 at the right size.
///
/// **AV1 is deliberately NOT here.** `VideoDecoder.isConfigSupported({codec:'av01.…'})`
/// returns `true` on this WebKitGTK and then every `decode()` fails with
/// `EncodingError: Decode error` — 0 frames out of 120, in all four bitstream framings
/// (obu-stream/annexb × tu/frame/obu), with and without the AV1CodecConfigurationRecord
/// as `description`, and for a 320×240 stream GStreamer's own `av1enc` produced as a
/// control. `isConfigSupported` is lying; gating on it would ship a permanently black
/// deck. AV1 stays on the legacy `<video>` element, which does play it.
///
/// Any other codec returns an honest `Err` (see the design doc's explicit allowance) —
/// the frontend already has the legacy `<video>` fallback for a deck whose source fails
/// this path.
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
    // `width`/`height`/`fps_hint` are deliberately NOT captured here — at pad-added
    // time parsebin's exposed pad frequently only has template (unfixed) caps, since
    // our own downstream `h264parse` hasn't parsed a real SPS out of the byte stream
    // yet (that requires buffers to actually flow, which only happens once the
    // pipeline reaches PLAYING and pulls resume in the appsink loop below). Reading
    // width/height here silently produced 0×0 for streams where the pad's initial
    // caps weren't fixed — see docs/design/webcodecs-video-not-rendering.md. The real
    // dimensions are read per-`gst::Sample` in the AU-pull loop instead, which carries
    // the actual negotiated caps for that buffer.
    Supported(CodecKind),
    Unsupported(String),
}

/// Which of the demux path's supported codecs this file turned out to be. Decides the
/// parser/capsfilter pair linked in `pad-added` *and* how the WebCodecs codec string is
/// derived after the AU-pull loop (the SPS bytes for H.264, the negotiated caps for VP9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodecKind {
    H264,
    Vp9,
}

/// VP9 Annex-A level table: `(level_code, max_luma_sample_rate, max_luma_picture_size)`,
/// level_code being the two digits WebCodecs' `vp09.PP.LL.DD` wants (10 = level 1.0).
const VP9_LEVELS: [(u32, u64, u64); 14] = [
    (10, 829_440, 36_864),
    (11, 2_764_800, 73_728),
    (20, 4_608_000, 122_880),
    (21, 9_216_000, 245_760),
    (30, 20_736_000, 552_960),
    (31, 36_864_000, 983_040),
    (40, 83_558_400, 2_228_224),
    (41, 160_432_128, 2_228_224),
    (50, 311_951_360, 8_912_896),
    (51, 588_251_136, 8_912_896),
    (52, 1_176_502_272, 8_912_896),
    (60, 1_176_502_272, 35_651_584),
    (61, 2_353_004_544, 35_651_584),
    (62, 4_706_009_088, 35_651_584),
];

/// Smallest VP9 level that admits `width×height` at `fps`. GStreamer's `vp9parse` does
/// not put a level in its caps (unlike `av1parse`), and the VP9 bitstream itself does not
/// carry one either, so it has to be derived — this is the same rule libvpx and ffmpeg
/// use to *stamp* a level, applied in reverse. Decoders here do not enforce the level, but
/// the WebCodecs codec string is required to be well-formed, so it must be plausible.
fn vp9_level_code(width: i32, height: i32, fps: f64) -> u32 {
    let pic = (width.max(1) as u64) * (height.max(1) as u64);
    let fps = if fps > 0.0 { fps } else { 30.0 };
    let rate = (pic as f64 * fps) as u64;
    for (code, max_rate, max_pic) in VP9_LEVELS {
        if pic <= max_pic && rate <= max_rate {
            return code;
        }
    }
    62
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

        let kind = match name.as_str() {
            "video/x-h264" => CodecKind::H264,
            "video/x-vp9" => CodecKind::Vp9,
            // AV1 is excluded deliberately, not for lack of a parser — see the module
            // doc comment: WebCodecs decodes zero AV1 frames on this WebKitGTK while
            // isConfigSupported() reports true.
            _ => {
                let _ = tx.lock().unwrap().send(PadResult::Unsupported(format!(
                    "unsupported codec for WebCodecs demux path: {name} (H.264 and VP9 only)"
                )));
                return;
            }
        };

        let link_result = (|| -> Result<(), String> {
            let pipeline = pipeline_weak.upgrade().ok_or("pipeline dropped mid-negotiation")?;
            let (parser, filter_caps) = match kind {
                CodecKind::H264 => {
                    let p = make_el("h264parse")?;
                    // -1 = repeat SPS/PPS in-band before every keyframe, not just the first
                    // — our own SPS scan (below) needs to find one at whichever keyframe a
                    // seek lands on.
                    p.set_property("config-interval", -1i32);
                    let caps = gst::Caps::builder("video/x-h264")
                        .field("stream-format", "byte-stream")
                        .field("alignment", "au")
                        .build();
                    (p, caps)
                }
                CodecKind::Vp9 => {
                    let p = make_el("vp9parse")?;
                    // `super-frame`, NOT `frame`: a VP9 super-frame is the container's
                    // unit and yields exactly one *displayed* frame, which is the 1:1
                    // AU↔pts↔output-frame relationship the whole keyframe-index / seek /
                    // decode-ahead design in codecWorker.ts assumes. `alignment=frame`
                    // splits super-frames into their hidden ALTREF sub-frames too, so AU
                    // count would stop matching decoded-frame count and pts would repeat.
                    let caps = gst::Caps::builder("video/x-vp9").field("alignment", "super-frame").build();
                    (p, caps)
                }
            };
            let capsfilter = make_el("capsfilter")?;
            capsfilter.set_property("caps", &filter_caps);

            pipeline
                .add_many([&parser, &capsfilter])
                .map_err(|e| format!("add parser/capsfilter: {e}"))?;
            gst::Element::link_many([&parser, &capsfilter])
                .map_err(|e| format!("parser->capsfilter: {e}"))?;
            capsfilter
                .link(&sink_for_pad)
                .map_err(|e| format!("capsfilter->appsink: {e}"))?;
            parser.sync_state_with_parent().map_err(|e| format!("parser sync_state: {e}"))?;
            capsfilter.sync_state_with_parent().map_err(|e| format!("capsfilter sync_state: {e}"))?;

            let sink_pad = parser.static_pad("sink").ok_or("parser has no sink pad")?;
            pad.link(&sink_pad).map_err(|e| format!("parsebin->parser: {e}"))?;
            Ok(())
        })();

        let _ = tx.lock().unwrap().send(match link_result {
            Ok(()) => PadResult::Supported(kind),
            Err(e) => PadResult::Unsupported(e),
        });
    });

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set_state(Playing): {e}"))?;

    let kind = match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(PadResult::Supported(k)) => k,
        Ok(PadResult::Unsupported(e)) => return Err(e),
        Err(_) => return Err("timed out waiting for parsebin to expose a video stream".into()),
    };

    let mut coded_width = 0i32;
    let mut coded_height = 0i32;
    let mut fps_hint = 0.0f64;
    // VP9 only — read off the same first fixed caps as width/height (see below).
    let mut vp9_profile = 0u32;
    let mut bit_depth = 8u32;
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
                if coded_width == 0 || coded_height == 0 {
                    // Read dimensions off this sample's own negotiated caps, not the
                    // pad's caps at pad-added time (see the `PadResult::Supported`
                    // comment above) — this is the first point they're guaranteed fixed.
                    if let Some(s) = sample.caps().and_then(|c| c.structure(0).map(|s| s.to_owned())) {
                        coded_width = s.get::<i32>("width").unwrap_or(0);
                        coded_height = s.get::<i32>("height").unwrap_or(0);
                        fps_hint = s
                            .get::<gst::Fraction>("framerate")
                            .ok()
                            .filter(|f| f.denom() != 0)
                            .map(|f| f.numer() as f64 / f.denom() as f64)
                            .unwrap_or(0.0);
                        // vp9parse reports `profile` as a string ("0".."3") and
                        // `bit-depth-luma` as a uint; both are absent on the H.264 caps,
                        // so the defaults stand there and are never used.
                        vp9_profile = s.get::<String>("profile").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
                        bit_depth = s.get::<u32>("bit-depth-luma").unwrap_or(8);
                    }
                }
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

    if coded_width == 0 || coded_height == 0 {
        return Err(format!(
            "demuxed {} access units but never negotiated real dimensions \
             ({coded_width}x{coded_height}) — refusing to hand WebCodecs a 0x0 configure()",
            aus.len()
        ));
    }

    let codec = match kind {
        CodecKind::H264 => aus
            .iter()
            .filter(|au| au.key)
            .find_map(|au| find_h264_sps_profile_level(&au.data))
            .map(|(p, c, l)| format!("avc1.{p:02x}{c:02x}{l:02x}"))
            .ok_or_else(|| "could not locate an H.264 SPS to derive a WebCodecs codec string".to_string())?,
        // vp09.PP.LL.DD — profile and bit depth straight from the caps, level derived
        // (GStreamer reports none for VP9). Decimal fields, unlike avc1's hex.
        CodecKind::Vp9 => format!(
            "vp09.{:02}.{:02}.{:02}",
            vp9_profile,
            vp9_level_code(coded_width, coded_height, fps_hint),
            bit_depth
        ),
    };

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
    fallback_url: Option<String>,
) -> Result<DemuxResult, String> {
    let cache = cache.inner().clone();
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Calls ensure_cached() directly instead of a passive lookup_wait() — this can
        // race audio_load's own ensure_cached() call for the same file on initial track
        // load, and lookup_wait() only waits out a copy that's already InProgress; if
        // this call arrives first there's no entry yet to wait on and it would fall
        // straight back to the original (possibly unreachable) path. See the identical
        // fix + incident note on audio_analyze_file in audio/mod.rs (2026-08-01).
        let path = cache.ensure_cached(&file_path, fallback_url.as_deref())?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for docs/design/webcodecs-video-not-rendering.md: `demux_file` used
    /// to read width/height off `parsebin`'s pad at `pad-added` time, which frequently only
    /// has template (unfixed) caps before any buffer has flowed — silently yielding 0x0 via
    /// `.unwrap_or(0)`. Synthesizes a real H.264-in-MP4 file (same shape as the field repro:
    /// libx264 producing an mp4 container) and asserts `demux_file` recovers the real,
    /// non-zero dimensions instead.
    #[test]
    fn demux_file_recovers_real_dimensions() {
        gst::init().expect("gstreamer init");
        let mp4_path = std::env::temp_dir().join("cuemark-video-demux-test.mp4");
        let mp4_str = mp4_path.to_str().unwrap();

        let launch = format!(
            "videotestsrc num-buffers=50 ! video/x-raw,width=640,height=480,framerate=25/1 \
             ! x264enc ! h264parse ! mp4mux ! filesink location={mp4_str}"
        );
        let pipeline = gst::parse::launch(&launch).expect("parse_launch");
        pipeline.set_state(gst::State::Playing).expect("play");
        let bus = pipeline.bus().unwrap();
        bus.timed_pop_filtered(
            gst::ClockTime::from_seconds(30),
            &[gst::MessageType::Eos, gst::MessageType::Error],
        );
        pipeline.set_state(gst::State::Null).expect("null");

        let video = demux_file(mp4_str).expect("demux_file");
        assert_eq!(video.coded_width, 640);
        assert_eq!(video.coded_height, 480);
        assert!(!video.aus.is_empty());
        assert!(!video.codec.is_empty());

        let _ = std::fs::remove_file(mp4_path);
    }

    #[test]
    fn vp9_level_codes_match_the_annex_a_table() {
        // 640x480@25 = 307200 samples > level 2.1's 245760 max picture size -> 3.0.
        assert_eq!(vp9_level_code(640, 480, 25.0), 30);
        // 1920x1080@30 = 2073600 samples, 62.2M samples/s -> 4.0.
        assert_eq!(vp9_level_code(1920, 1080, 30.0), 40);
        // Same picture size at 60fps exceeds 4.0's sample rate -> 4.1.
        assert_eq!(vp9_level_code(1920, 1080, 60.0), 41);
        // Degenerate inputs must still yield a well-formed two-digit level.
        assert_eq!(vp9_level_code(0, 0, 0.0), 10);
    }

    /// Phase 7 (docs/design/webcodecs-video-path.md): VP9 must come back with a
    /// well-formed `vp09.PP.LL.DD` string, real dimensions and non-empty AUs — the same
    /// contract the H.264 test above asserts. `vp9enc` (libvpx) rather than the media
    /// cache so the test needs no fixture file.
    #[test]
    fn demux_file_supports_vp9() {
        gst::init().expect("gstreamer init");
        if gst::ElementFactory::find("vp9enc").is_none() {
            eprintln!("skipping: no vp9enc (gstreamer1.0-plugins-good/vpx) on this machine");
            return;
        }
        let webm_path = std::env::temp_dir().join("cuemark-video-demux-test-vp9.webm");
        let webm_str = webm_path.to_str().unwrap();

        let launch = format!(
            // format=I420 is load-bearing: left to negotiate, vp9enc here picks a 12-bit
            // format and emits VP9 profile 3, which the codec string then correctly
            // reports as `vp09.03.20.12` — a fine result, but not the 8-bit profile-0
            // case the library actually contains.
            "videotestsrc num-buffers=25 ! video/x-raw,width=320,height=240,framerate=25/1,format=I420 \
             ! vp9enc deadline=1 cpu-used=8 ! webmmux ! filesink location={webm_str}"
        );
        let pipeline = gst::parse::launch(&launch).expect("parse_launch");
        pipeline.set_state(gst::State::Playing).expect("play");
        let bus = pipeline.bus().unwrap();
        bus.timed_pop_filtered(
            gst::ClockTime::from_seconds(60),
            &[gst::MessageType::Eos, gst::MessageType::Error],
        );
        pipeline.set_state(gst::State::Null).expect("null");

        let video = demux_file(webm_str).expect("demux_file");
        assert_eq!(video.coded_width, 320);
        assert_eq!(video.coded_height, 240);
        assert!(!video.aus.is_empty());
        assert!(!video.keyframes.is_empty());
        // 320x240 = 76800 samples at 25fps -> level 2.0; profile 0 / 8-bit from the caps.
        assert_eq!(video.codec, "vp09.00.20.08", "codec string: {}", video.codec);

        let _ = std::fs::remove_file(webm_path);
    }
}
