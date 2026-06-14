#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // DMA-BUF surfaces from VA-API video decoding don't transfer to 2D canvas
    // pixel reads in WebKitGTK — drawImage(video) produces colorful noise.
    // Disabling the DMABuf renderer forces a CPU-side path that works correctly.
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    cuemark_lib::run()
}
