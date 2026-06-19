#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // DMA-BUF surfaces from VA-API video decoding don't transfer to 2D canvas
    // pixel reads in WebKitGTK — drawImage(video) produces colorful noise.
    // Disabling the DMABuf renderer forces a CPU-side path that works correctly.
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    // This GPU/driver's VA-API DMA-BUF export is broken (confirmed via GST_DEBUG:
    // "driver bug: fd size (3670016) is bigger than object descriptor size
    // (3194880)", plus "Cannot map/copy External OES textures" in WebKit's GL
    // compositor). That breakage shows up two different ways depending on
    // WEBKIT_DISABLE_DMABUF_RENDERER:
    //   - unset: hardware VA-API decode succeeds, but the corrupted DMA-BUF frame
    //     renders as a solid garbage color (e.g. solid blue) in the <video> element
    //     and in drawImage() canvas reads.
    //   - set to 1 (as above): WebKit's decoder autoplugging for hardware-only
    //     codecs fails outright with no software fallback — `<video>` never fires
    //     loadedmetadata, MediaError code 4 (FormatError), preview stays black.
    // Demoting the VA-API decoder rank to 0 for each affected codec makes
    // decodebin fall through to the software decoder (av1dec/aom for AV1,
    // avdec_h264/libav for H.264), which avoids the broken DMA-BUF path entirely
    // and works correctly with WEBKIT_DISABLE_DMABUF_RENDERER=1 still set.
    // Confirmed via gst-launch-1.0 playbin and via loading real files in the app.
    // If other codecs (VP9, HEVC) show the same black-screen/FormatError or
    // solid-color symptom, add their va*dec/vaapi*dec factory names here too.
    std::env::set_var(
        "GST_PLUGIN_FEATURE_RANK",
        "vaav1dec:0,vaapiav1dec:0,vah264dec:0,vaapih264dec:0",
    );

    cuemark_lib::run()
}
