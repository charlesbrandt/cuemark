const channel = new BroadcastChannel('cuemark-output');

// Capture the compositor canvas and send to the output window.
// Fire-and-forget; misses are fine — the next frame will arrive shortly.
export function postFrame(canvas: HTMLCanvasElement): void {
  createImageBitmap(canvas).then((bitmap) => {
    channel.postMessage({ frame: bitmap });
    bitmap.close();
  });
}
