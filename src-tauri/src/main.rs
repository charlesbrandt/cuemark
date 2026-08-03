#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // DMA-BUF surfaces from VA-API video decoding don't transfer to 2D canvas
    // pixel reads in WebKitGTK — drawImage(video) produces colorful noise.
    // Disabling the DMABuf renderer forces a CPU-side path that works correctly.
    //
    // ASSUMPTION THIS ENCODES (2026-06-19): video reaches the GPU as
    // `<video>` element -> drawImage() -> 2D canvas -> texImage2D, so a
    // VA-API DMA-BUF surface has to survive a CPU-side canvas pixel read.
    // That premise died in f6b94ea when the WebCodecs path became the
    // default: video now goes VideoDecoder -> texImage2D(VideoFrame)
    // directly, with no `<video>` element and no drawImage(video) anywhere
    // on the default path. Meanwhile the cost of this line is that WebKit
    // composites the *whole page* in software on the main thread — measured
    // 2026-08-02 at 55-59% of all main-thread samples in libwebkit2gtk's
    // software rasteriser (a 16-tap RGBA resampling kernel plus surface
    // fills), with the main thread pinned at ~100% during ordinary
    // playback and rAF starved for >1s at a time.
    // Set CUEMARK_ENABLE_DMABUF=1 to A/B that: it leaves the DMA-BUF
    // renderer enabled so compositing goes back to the GPU.
    // RETIRED AS THE DEFAULT 2026-08-02. Two independent condemnations, both measured on
    // the same binary with only this variable changed:
    //   1. Performance (Bug E): software compositing costs ~26 points of main-thread CPU
    //      (87% -> 62% for two decks) and every observed rAF stall (6 -> 0).
    //   2. Correctness (Bug A): it *corrupts the WebGL compositor canvas*. With this set,
    //      the compositor canvas renders horizontal bands of uninitialised memory that
    //      grow over time — the "output window noise" chased across three sessions, which
    //      was never an output-window bug at all; that window was faithfully mirroring an
    //      already-corrupt source. Unset, the same canvas is clean. User-confirmed live.
    // The premise died in f6b94ea: this guarded `drawImage(video)` on a VA-API surface, and
    // the default video path has been VideoDecoder -> texImage2D(VideoFrame) since then,
    // with no `<video>` element on it.
    //
    // Escape hatch kept because one path is genuinely untested: the legacy `<video>`
    // fallback (non-H.264 files, audio-only files) has never been checked with the DMA-BUF
    // renderer enabled. If VA-API canvas corruption reappears there, the correct fix is a
    // codec-specific GST_PLUGIN_FEATURE_RANK demotion, not re-killing the renderer
    // process-wide.
    if std::env::var_os("CUEMARK_DISABLE_DMABUF").is_some() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // This GPU/driver's VA-API DMA-BUF export was broken for both AV1 and H.264 as of
    // 2026-06-19 (confirmed via GST_DEBUG: "driver bug: fd size (3670016) is bigger than
    // object descriptor size (3194880)", plus "Cannot map/copy External OES textures" in
    // WebKit's GL compositor). Demoting the affected VA-API decoder's rank to 0 made
    // decodebin fall through to the software decoder instead (av1dec/aom for AV1,
    // avdec_h264/libav for H.264), avoiding the broken DMA-BUF path.
    //
    // Re-tested 2026-06-20 after a mesa/webkit2gtk update (mesa-va-drivers 25.2.8,
    // webkit2gtk 2.52.3): H.264 hardware decode now works correctly — real video, no
    // garbage-color corruption, lower CPU than dual software-decoded 1080p streams, no
    // freeze/crash across extended two-deck stress testing. AV1 stays demoted; it has
    // not been re-tested since the driver update. If AV1 hardware decode is ever
    // re-tested and found fixed too, this can shrink to nothing.
    // If a black screen / solid-color-garbage symptom returns for H.264, or shows up for
    // another codec (VP9, HEVC), add the codec's va*dec/vaapi*dec factory name here —
    // see journal.md 2026-06-19/2026-06-20 entries for the full debugging history.
    std::env::set_var("GST_PLUGIN_FEATURE_RANK", "vaav1dec:0,vaapiav1dec:0");

    cuemark_lib::run()
}
