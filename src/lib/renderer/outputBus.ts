const channel = new BroadcastChannel('cuemark-output');

// One in-flight capture at a time. createImageBitmap + the cross-process postMessage
// clone aren't free, especially with multiple decks compositing — without this guard,
// a rAF tick that outpaces the previous capture/send queues up an unbounded backlog of
// pending bitmaps, saturating the main thread until the whole UI stalls.
let inFlight = false;

// Capture the compositor canvas and send to the output window.
// Fire-and-forget; misses are fine — the next frame will arrive shortly.
export function postFrame(canvas: HTMLCanvasElement): void {
  if (inFlight) return;
  inFlight = true;
  createImageBitmap(canvas).then((bitmap) => {
    channel.postMessage({ frame: bitmap });
    bitmap.close();
  }).finally(() => {
    inFlight = false;
  });
}
