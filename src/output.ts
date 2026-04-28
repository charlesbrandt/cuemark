const channel = new BroadcastChannel('cuemark-output');
const canvas = document.getElementById('output') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = 'high';

function resize() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}
resize();
window.addEventListener('resize', resize);

channel.onmessage = (e: MessageEvent<{ frame: ImageBitmap }>) => {
  const { frame } = e.data;
  ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  frame.close();
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
  // Esc to exit fullscreen is handled natively by browsers; this is a fallback.
  if (e.key === 'Escape' && document.fullscreenElement) {
    document.exitFullscreen();
  }
});
