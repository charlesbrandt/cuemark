export class DeckFBO {
  readonly texture: WebGLTexture;
  readonly fbo: WebGLFramebuffer;
  // 2D canvas intermediary — drawImage(video) is always safe; avoids direct
  // video→texImage2D which triggers assertion failures in WebKitGTK.
  private scratch: HTMLCanvasElement;
  private scratchCtx: CanvasRenderingContext2D;
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.scratch = document.createElement("canvas");
    this.scratch.width = width;
    this.scratch.height = height;
    this.scratchCtx = this.scratch.getContext("2d")!;
    this.scratchCtx.imageSmoothingEnabled = true;
    this.scratchCtx.imageSmoothingQuality = "high";
  }

  bind() {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  uploadVideoFrame(video: HTMLVideoElement) {
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
    this.scratchCtx.drawImage(video, 0, 0, this.width, this.height);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // Canvas Y=0 is top; WebGL texture Y=0 is bottom — flip on upload so video is right-side up.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.scratch);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Uploads a decoded WebCodecs VideoFrame directly, no scratch-canvas detour needed on
   * this GPU (falls back to one if texImage2D throws). Every source frame from a
   * VideoDecoder is already right-side-up in WebKitGTK's pixel format — do NOT apply the
   * UNPACK_FLIP_Y_WEBGL flip uploadVideoFrame() uses for <video>/canvas sources (verified
   * by screenshot compare; getting this wrong renders codec-path video upside down).
   */
  uploadVideoFrameFromCodec(frame: VideoFrame) {
    const gl = this.gl;
    if (DeckFBO.codecUploadMode !== "scratch") {
      try {
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        gl.bindTexture(gl.TEXTURE_2D, null);
        DeckFBO.codecUploadMode = "direct";
        return;
      } catch {
        DeckFBO.codecUploadMode = "scratch";
      }
    }
    this.scratchCtx.drawImage(frame, 0, 0, this.width, this.height);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.scratch);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  destroy() {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteFramebuffer(this.fbo);
  }
}
