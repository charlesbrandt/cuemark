#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // DMA-BUF surfaces from VA-API video decoding don't transfer to 2D canvas
    // pixel reads in WebKitGTK — drawImage(video) produces colorful noise.
    // Disabling the DMABuf renderer forces a CPU-side path that works correctly.
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

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
