export class DeckFBO {
  readonly texture: WebGLTexture;
  readonly fbo: WebGLFramebuffer;
  // 2D canvas intermediary — drawImage(video) is always safe; avoids direct
  // video→texImage2D which triggers assertion failures in WebKitGTK.
  //
  // Created lazily: it is only needed by the two <video>/VideoFrame upload paths, and the
  // output window (which owns the real compositor since 2026-08-03) uploads exclusively via
  // uploadImageBitmap(). Allocating it eagerly cost a full output-resolution canvas — ~8MB
  // at 1920x1080 — per deck, in the process that can least afford it.
  private scratch: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;
  // Cached across all decks/instances (module-level, not per-FBO): whether
  // texImage2D(gl, VideoFrame) works directly on this GPU/driver, decided once by the
  // first real codec-path frame rather than a synthetic startup probe (see
  // uploadVideoFrameFromCodec). docs/design/webcodecs-video-path.md's spike found this
  // works with no SIGTRAP on a DOM-canvas GL context (unlike direct <video>→texImage2D,
  // which is why uploadVideoFrame above needs the scratch-canvas detour at all) — but
  // that was measured under Xvfb/llvmpipe software GL, so re-verify per real GPU here.
  private static codecUploadMode: "direct" | "scratch" | null = null;

  constructor(
    private gl: WebGL2RenderingContext,
    readonly width: number,
    readonly height: number,
  ) {
    const texture = gl.createTexture();
    if (!texture) throw new Error("Failed to create WebGL texture");
    this.texture = texture;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("Failed to create WebGL framebuffer");
    this.fbo = fbo;

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    // Clear to transparent black immediately. texImage2D(..., null) above *allocates* the
    // texture but leaves its contents undefined per the GL spec — i.e. whatever was in that
    // GPU memory. A deck that exists but has never received a frame (an empty deck, or one
    // whose first frame hasn't decoded yet) is still composited at its own opacity, so
    // without this the compositor blits uninitialised GPU memory straight to the projector.
    // That is the same "displaying memory nobody wrote" failure as the output window's
    // uninitialised 2D canvas in Bug A (docs/design/output-noise-and-track-reload-silence.md)
    // — worth fixing everywhere it can occur, not just where it was observed. Transparent is
    // also the semantically right value: an empty deck must contribute nothing to the blend.
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private getScratch(): CanvasRenderingContext2D {
    if (!this.scratchCtx) {
      this.scratch = document.createElement("canvas");
      this.scratch.width = this.width;
      this.scratch.height = this.height;
      this.scratchCtx = this.scratch.getContext("2d")!;
      this.scratchCtx.imageSmoothingEnabled = true;
      this.scratchCtx.imageSmoothingQuality = "high";
    }
    return this.scratchCtx;
  }

  bind() {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  uploadVideoFrame(video: HTMLVideoElement) {
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
    const ctx = this.getScratch();
    ctx.drawImage(video, 0, 0, this.width, this.height);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // Canvas Y=0 is top; WebGL texture Y=0 is bottom — flip on upload so video is right-side up.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.scratch!);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Uploads a decoded WebCodecs VideoFrame directly, no scratch-canvas detour needed on
   * this GPU (falls back to one if texImage2D throws). Needs the same UNPACK_FLIP_Y_WEBGL
   * flip as uploadVideoFrame() — a VideoFrame source uses the same top-left-origin row
   * layout as a <video>/canvas source, so both need the flip to land right-side-up in a
   * bottom-left-origin WebGL texture.
   *
   * Earlier comment here claimed the direct branch must NOT flip ("frames arrive already
   * right-side-up", "verified by screenshot compare") — that was only checked under
   * Xvfb/llvmpipe software GL during the webcodecs-video-path spike, exactly the caveat
   * the codecUploadMode doc comment above already flagged ("re-verify per real GPU").
   * On real hardware it renders upside-down: caught 2026-08-01 (deck-0 on the codec/direct
   * path was flipped in the Output window while deck-1, on the legacy path, was not; each
   * DeckCard's own 2D-canvas preview — a separate, flip-agnostic drawImage() — stayed
   * correct throughout, which is what pinned this down to the WebGL upload rather than the
   * decoded frame data itself).
   */
  uploadVideoFrameFromCodec(frame: VideoFrame) {
    const gl = this.gl;
    if (DeckFBO.codecUploadMode !== "scratch") {
      try {
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.bindTexture(gl.TEXTURE_2D, null);
        DeckFBO.codecUploadMode = "direct";
        return;
      } catch {
        DeckFBO.codecUploadMode = "scratch";
      }
    }
    const ctx = this.getScratch();
    ctx.drawImage(frame, 0, 0, this.width, this.height);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // Same canvas-intermediary path as uploadVideoFrame() above — needs the same flip.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.scratch!);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Uploads a frame received from the control window as an `ImageBitmap` — the output
   * window's only source of deck pixels (see `outputProtocol.ts`).
   *
   * ⚠️ **No `UNPACK_FLIP_Y_WEBGL` here, deliberately.** Both upload methods above set it,
   * because a canvas/VideoFrame row 0 is the top while a GL texture row 0 is the bottom.
   * For an **ImageBitmap source that flag is silently ignored on this WebKitGTK**: it
   * raises no GL error and yields unflipped pixels (measured,
   * `scripts/probes/imagebitmap_upload_probe.py`). The flip is therefore applied by the
   * sender via `createImageBitmap(..., { imageOrientation: 'flipY' })` — which only works
   * because `outputBus.ts` always passes a *canvas*; that option is silently ignored for a
   * `VideoFrame` source. Setting the flag here as well would not double-flip — it would do
   * nothing — but it would strongly imply to a reader that this path handles its own
   * orientation, which it does not. Every bitmap arriving here is already right-side-up.
   *
   * texImage2D with a source re-specifies the texture at the bitmap's own dimensions, so
   * the texture ends up at the deck's source resolution rather than the FBO's nominal
   * size. That is intended: the blit samples it over the full quad, giving the same
   * stretch-to-output behaviour the scratch-canvas path had, without resampling twice.
   */
  uploadImageBitmap(bitmap: ImageBitmap) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  destroy() {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteFramebuffer(this.fbo);
  }
}
