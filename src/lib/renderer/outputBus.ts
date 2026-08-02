const channel = new BroadcastChannel('cuemark-output');

// One in-flight capture at a time. createImageBitmap + the cross-process postMessage
// clone aren't free, especially with multiple decks compositing — without this guard,
// a rAF tick that outpaces the previous capture/send queues up an unbounded backlog of
// pending bitmaps, saturating the main thread until the whole UI stalls.
let inFlight = false;

// The bitmap sent on the previous postFrame(), still unclosed. See the close-deferral
// rationale in postFrame() below.
let previousBitmap: ImageBitmap | null = null;

// Capture the compositor canvas and send to the output window.
// Fire-and-forget; misses are fine — the next frame will arrive shortly.
export function postFrame(canvas: HTMLCanvasElement): void {
  if (inFlight) return;
  inFlight = true;
  createImageBitmap(canvas).then((bitmap) => {
    // Close the *previous* frame's bitmap rather than this one, one frame late.
    //
    // Closing immediately after postMessage() should be safe per spec (the structured
    // clone happens synchronously before postMessage returns), but WebKitGTK's
    // BroadcastChannel here is genuinely cross-*process* — each window is its own
    // WebKitWebProcess — and this codebase has a long history of WebKitGTK not honoring
    // spec guarantees at process boundaries (see CLAUDE.md: custom URI schemes, direct
    // video→texImage2D, VA-API DMA-BUF corruption). An immediate close was suspected of
    // racing the real IPC copy and was removed entirely during the 2026-08-02
    // investigation in docs/design/output-noise-and-track-reload-silence.md; that did
    // NOT fix the output-window noise it was aimed at (it only changed the corruption's
    // shape), so the race is unproven — but dropping close() altogether is not free
    // either. These are full-output-resolution bitmaps (1920x1080 ≈ 8MB) produced at up
    // to 60fps, so relying on GC to reclaim them puts hundreds of MB/s of external
    // allocation pressure on the same WebKitWebProcess the render loop runs in.
    //
    // NB: this was initially also suspected of contributing to choppy audio. It does
    // not — that was root-caused to the sink's buffer-time being ~1.17 graph quanta
    // (see sink_buffer_times() in audio/pipeline.rs), and a deck feeding two sinks from
    // one tee proved the audio fault was entirely downstream of the tee, so nothing in
    // this process could have caused it. The justification for deterministic release
    // here is ordinary memory hygiene, not audio.
    //
    // Deferring by one frame keeps deterministic release (at most two bitmaps live at
    // once, never a GC-timing question) while giving the cross-process copy a whole
    // frame of slack instead of zero. If the noise ever traces back here for real, the
    // next step is a receiver-side ack, not removing close() again.
    previousBitmap?.close();
    previousBitmap = bitmap;
    channel.postMessage({ frame: bitmap });
  }).finally(() => {
    inFlight = false;
  });
}
