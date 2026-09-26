/**
 * `IsfInstance` — compiles one ISF plugin into its own WebGL2 program and
 * renders it into its own `DeckFBO`. `PASSES` with a `TARGET` render into named
 * offscreen buffers (`PassTarget`); `PERSISTENT` ones ping-pong so a pass reads
 * last frame's result while writing this frame's. The last pass is the output.
 *
 * Not wired into `Compositor` yet — that integration (replacing
 * `vizFbo`/`vizProgram` with an `IsfInstance`) is the lead's job per the
 * task split; this file is usable standalone once that wiring lands.
 */
import { DeckFBO } from "../fbo";
import { debugLog } from "../../debugLog";
import { IsfError, type IsfInput, type IsfPass, type ParsedIsf } from "./parser";
import { evalExpr, exprNames, parseExpr, type Expr } from "./expr";

export interface IsfFrameInputs {
  time: number;
  timeDelta: number;
  frameIndex: number;
  /** [year, month, day, secondsOfDay] — ISF's DATE vec4, per spec. */
  date: [number, number, number, number];
  /** Values for every non-`CUEMARK_BIND` input, keyed by ISF `NAME`. */
  params: Record<string, number | number[] | boolean>;
  /** Every `CUEMARK_BIND` value cuemark currently knows, keyed by bind name. */
  bindings: Record<string, number>;
  /** Routed spectrum, up to FFT_MAX_BINS floats in 0-1; absent = silence. Feeds `audioFFT` inputs. */
  fft?: number[];
  /**
   * Phase 5a PCM tap, `mono[1024] | left[1024] | right[1024]`, bytes with 128 = silence.
   * Feeds `audio` inputs (row 0 = left, row 1 = right); absent = a flat silent waveform.
   */
  pcm?: Uint8Array;
}

/** Samples per channel in the PCM tap frame (matches `PCM_LEN` in `audio/pcm_tap.rs`). */
export const PCM_LEN = 1024;
/** Rows in an `audio` input texture: one per channel, left then right. */
export const PCM_ROWS = 2;

/**
 * Packs the tap frame into the `audio` texture's bytes: row 0 = left, row 1 = right, R8.
 * Absent or malformed input gives a flat waveform at 128 (0.5 = zero crossing).
 */
export function packPcmRows(pcm: Uint8Array | undefined, out?: Uint8Array): Uint8Array {
  const bytes = out ?? new Uint8Array(PCM_LEN * PCM_ROWS);
  if (pcm && pcm.length >= PCM_LEN * 3) {
    bytes.set(pcm.subarray(PCM_LEN, PCM_LEN * 3));
  } else {
    bytes.fill(128);
  }
  return bytes;
}

/** Widest `audioFFT` texture: the 32 bands the analysis produces. */
export const FFT_MAX_BINS = 32;

/** Texture width for an `audioFFT` input: min(32, MAX) when MAX is a positive number. */
export function fftTextureWidth(input: { MAX?: unknown }): number {
  const max =
    typeof input.MAX === "number" && Number.isFinite(input.MAX)
      ? Math.floor(input.MAX)
      : FFT_MAX_BINS;
  return Math.max(1, Math.min(FFT_MAX_BINS, max));
}

/** Packs 0-1 floats into `width` R8 bytes (clamped, NaN -> 0, missing -> 0). */
export function packFft(fft: number[] | undefined, width: number, out?: Uint8Array): Uint8Array {
  const bytes = out ?? new Uint8Array(width);
  for (let i = 0; i < width; i++) {
    const v = fft?.[i];
    bytes[i] = typeof v === "number" && v > 0 ? Math.round(Math.min(1, v) * 255) : 0;
  }
  return bytes;
}

// The only ISF input TYPEs the vendored parser maps to `sampler2D` (see
// `vendor/ISFParser.ts`'s `typeUniformMap`). Used here to decide which
// inputs need a texture bound rather than a plain value uniform.
const SAMPLER_TYPES = new Set(["image", "audio", "audioFFT"]);

// Standard ISF uniforms every generated shader declares (fragmentShaderSkeleton
// in vendor/ISFParser.ts), independent of the plugin's own INPUTS.
const STANDARD_UNIFORMS = ["TIME", "TIMEDELTA", "FRAMEINDEX", "DATE", "RENDERSIZE", "PASSINDEX"];

/**
 * Pulls the `IMPORTED` map out of an ISF header. The vendored parser consumes
 * it (declaring one sampler uniform per key) but `ParsedIsf` doesn't expose
 * it, so read the header JSON again here. Returns uniform name -> file path.
 * ISF allows `{"name": {"PATH": "x.png"}}` or `{"name": "x.png"}`.
 */
export function extractImported(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = /\/\*([\s\S]*?)\*\//.exec(source);
  if (!m) return out;
  let header: unknown;
  try {
    header = JSON.parse(m[1]);
  } catch {
    return out;
  }
  const imp = (header as { IMPORTED?: unknown } | null)?.IMPORTED;
  if (!imp || typeof imp !== "object") return out;
  for (const [name, v] of Object.entries(imp as Record<string, unknown>)) {
    const path = typeof v === "string" ? v : (v as { PATH?: unknown } | null)?.PATH;
    if (typeof path === "string") out[name] = path;
  }
  return out;
}

/**
 * Resolves an IMPORTED path against the payload's `assets` (file name -> URL).
 * Tries the exact path, then its basename (assets are keyed by bare file name).
 */
export function resolveAssetUrl(path: string, assets: Record<string, string>): string | undefined {
  if (assets[path]) return assets[path];
  const base = path.split(/[\\/]/).pop() ?? path;
  return assets[base];
}

/** Uniform name -> URL for every IMPORTED image that has a matching asset. */
export function resolveImportedImages(
  source: string,
  assets: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, path] of Object.entries(extractImported(source))) {
    const url = resolveAssetUrl(path, assets);
    if (url) out[name] = url;
  }
  return out;
}

export const TEST_PATTERN_SIZE = 256;

/**
 * Deterministic RGBA test image for non-imported `image` inputs (filter
 * shaders' `inputImage`): a 32px checker tinted by an x/y colour gradient, so a
 * filter visibly does something. Opaque.
 */
export function generateTestPattern(size = TEST_PATTERN_SIZE): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const checker = ((x >> 5) + (y >> 5)) & 1 ? 1 : 0.55;
      data[i] = Math.round((x / (size - 1)) * 255 * checker);
      data[i + 1] = Math.round((y / (size - 1)) * 255 * checker);
      data[i + 2] = Math.round((1 - x / (size - 1)) * 200 * checker + 40);
      data[i + 3] = 255;
    }
  }
  return data;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
  stage: "vertex" | "fragment",
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new IsfError("compile", `Failed to create ${stage} shader object`);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? `${stage} shader compile error`;
    gl.deleteShader(shader);
    throw new IsfError("compile", `${stage} shader: ${log}`);
  }
  return shader;
}

function toNumber(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return typeof v[0] === "number" ? v[0] : 0;
  return 0;
}

function toNumberArray(v: unknown, length: number): number[] {
  if (Array.isArray(v)) {
    const out: number[] = [];
    for (let i = 0; i < length; i++) out.push(typeof v[i] === "number" ? v[i] : 0);
    return out;
  }
  if (typeof v === "number") return new Array(length).fill(v);
  return new Array(length).fill(0);
}

function typeZero(type: string): number | number[] {
  switch (type) {
    case "color":
      return [0, 0, 0, 0];
    case "point2D":
      return [0, 0];
    default:
      return 0;
  }
}

/** Largest pass-buffer edge we will allocate, whatever a WIDTH/HEIGHT expression evaluates to. */
const MAX_PASS_EDGE = 4096;

/**
 * One named offscreen buffer for a `TARGET` pass. Persistent buffers hold two
 * textures and ping-pong: `cur` is the one being written, the other holds the
 * previous result. `swap()` after each writing pass makes the fresh result the
 * readable one for later passes and for the next frame.
 */
class PassTarget {
  width = 0;
  height = 0;
  private tex: WebGLTexture[] = [];
  private fbo: WebGLFramebuffer[] = [];
  private cur = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly name: string,
    readonly persistent: boolean,
    readonly float: boolean,
  ) {}

  /** (Re)allocates when the size changed; contents are cleared to transparent black. */
  resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    this.free();
    const { gl } = this;
    const n = this.persistent ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const tex = gl.createTexture();
      const fbo = gl.createFramebuffer();
      if (!tex || !fbo) throw new IsfError("runtime", `Failed to allocate pass buffer '${this.name}'`);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (this.float) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      // texImage2D(null) leaves contents undefined; a persistent buffer is read before it is written.
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.tex.push(tex);
      this.fbo.push(fbo);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.width = w;
    this.height = h;
    this.cur = 0;
  }

  /** Binds the write side as the render target and clears it if it is not persistent. */
  bindWrite(): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]);
    gl.viewport(0, 0, this.width, this.height);
    if (!this.persistent) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  /** The latest finished result (persistent: last write). */
  get readTexture(): WebGLTexture {
    return this.persistent ? this.tex[1 - this.cur] : this.tex[0];
  }

  /** What the writing pass itself may sample: persistent -> previous frame; else nothing (feedback loop). */
  get selfReadTexture(): WebGLTexture | null {
    return this.persistent ? this.tex[1 - this.cur] : null;
  }

  swap(): void {
    if (this.persistent) this.cur = 1 - this.cur;
  }

  private free(): void {
    const { gl } = this;
    for (const t of this.tex) gl.deleteTexture(t);
    for (const f of this.fbo) gl.deleteFramebuffer(f);
    this.tex = [];
    this.fbo = [];
    this.width = this.height = 0;
  }

  dispose(): void {
    this.free();
  }
}

export class IsfInstance {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vertShader: WebGLShader;
  private readonly fragShader: WebGLShader;
  private readonly fbo: DeckFBO;
  private readonly blankTexture: WebGLTexture;
  /** Built-in checker/gradient for image inputs that aren't IMPORTED. */
  private readonly testTexture: WebGLTexture;
  /** IMPORTED image uniform name -> its (async-loaded) texture state. */
  private readonly imported = new Map<
    string,
    { url: string; texture: WebGLTexture | null; width: number; height: number }
  >();
  private readonly inputs: IsfInput[];
  private readonly uniformLocs = new Map<string, WebGLUniformLocation | null>();
  private readonly loggedUnfed = new Set<string>();
  // One R8 Nx1 texture per audioFFT input, created lazily; empty for shaders without one.
  private readonly fftTextures = new Map<
    string,
    { tex: WebGLTexture; width: number; bytes: Uint8Array }
  >();
  // One R8 1024x2 texture per `audio` input (row 0 = left, row 1 = right), created lazily.
  private readonly pcmTextures = new Map<string, { tex: WebGLTexture; bytes: Uint8Array }>();
  private readonly passes: IsfPass[];
  private readonly passSizeExprs: Array<{ w: Expr; h: Expr }>;
  /** TARGET name -> buffer, created for every non-final pass that names one. */
  private readonly targets = new Map<string, PassTarget>();
  private disposed = false;

  readonly label: string;

  constructor(
    gl: WebGL2RenderingContext,
    parsed: ParsedIsf,
    width: number,
    height: number,
    label: string,
    /** IMPORTED image uniform name -> URL (see `resolveImportedImages`). */
    importedImages: Record<string, string> = {},
  ) {
    this.gl = gl;
    this.label = label;
    this.inputs = parsed.inputs;
    this.passes = parsed.passes;
    this.passSizeExprs = this.compilePassSizes(parsed);

    const vertShader = compileShader(gl, gl.VERTEX_SHADER, parsed.vertexShader, "vertex");
    let fragShader: WebGLShader;
    try {
      fragShader = compileShader(gl, gl.FRAGMENT_SHADER, parsed.fragmentShader, "fragment");
    } catch (e) {
      gl.deleteShader(vertShader);
      throw e;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertShader);
      gl.deleteShader(fragShader);
      throw new IsfError("link", "Failed to create program object");
    }
    gl.attachShader(program, vertShader);
    gl.attachShader(program, fragShader);
    // The shared full-screen quad VAO (see compositor.ts's QUAD_VERTS/buildQuad)
    // feeds attribute location 0 to every program that renders it, ISF plugins
    // included — so isf_position must bind to that same location, and it must
    // happen before link() for the binding to take effect.
    gl.bindAttribLocation(program, 0, "isf_position");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? "program link error";
      gl.deleteProgram(program);
      gl.deleteShader(vertShader);
      gl.deleteShader(fragShader);
      throw new IsfError("link", log);
    }

    this.program = program;
    this.vertShader = vertShader;
    this.fragShader = fragShader;
    this.fbo = new DeckFBO(gl, width, height);
    this.createTargets();
    this.blankTexture = this.createBlankTexture();
    this.testTexture = this.createTestTexture();
    for (const [name, url] of Object.entries(importedImages)) {
      this.imported.set(name, { url, texture: null, width: 1, height: 1 });
      this.loadImported(name);
    }
    this.cacheUniformLocations();
    if (this.inputs.some((i) => i.TYPE === "audioFFT")) {
      debugLog(`[isf/${label}] plugin declares audioFFT input(s); fed from the routed spectrum (vizFft)`);
    }
  }

  // A single 1x1 transparent-black texture, shared across every image/audio/
  // audioFFT input on this instance that isn't fed real data yet (phase 1
  // has none — image assets, the audioFFT texture and the audio/PCM texture
  // all arrive in later phases per the design doc). One tiny texture per
  // instance rather than per input: there's no per-input state to keep
  // distinct since they're all identically blank.
  private createBlankTexture(): WebGLTexture {
    const { gl } = this;
    const tex = gl.createTexture();
    if (!tex) throw new IsfError("runtime", "Failed to create blank input texture");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  // 256x256 generated checker/gradient (`generateTestPattern`). Non-imported
  // `image` inputs get this rather than transparent black so filter shaders
  // (`inputImage`) visibly do something. Uploaded from a typed array: no
  // readback, no pixel-store flags.
  private createTestTexture(): WebGLTexture {
    const { gl } = this;
    const tex = gl.createTexture();
    if (!tex) throw new IsfError("runtime", "Failed to create test input texture");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TEST_PATTERN_SIZE, TEST_PATTERN_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, generateTestPattern());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  // Async, never blocks render: the sampler stays blank until the image lands.
  // The image is flipped on a 2D canvas (ISF images are bottom-up) and the
  // canvas uploaded with no UNPACK_FLIP_Y, because WebKitGTK's flip handling
  // is unreliable for some sources (CLAUDE.md "Orientation"). No GL readback.
  private loadImported(name: string): void {
    const entry = this.imported.get(name);
    if (!entry) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (this.disposed) return;
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (!ctx) throw new Error("no 2D context");
        ctx.translate(0, h);
        ctx.scale(1, -1);
        ctx.drawImage(img, 0, 0);
        const { gl } = this;
        const tex = gl.createTexture();
        if (!tex) throw new Error("createTexture failed");
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        entry.texture = tex;
        entry.width = w;
        entry.height = h;
        debugLog(`[isf/${this.label}] imported image '${name}' loaded (${w}x${h})`);
      } catch (e) {
        debugLog(`[isf/${this.label}] imported image '${name}' upload failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    img.onerror = () => {
      debugLog(`[isf/${this.label}] imported image '${name}' failed to load from ${entry.url} (missing file or CORS?) - staying blank`);
    };
    img.src = entry.url;
  }

  /** Parses every pass's WIDTH/HEIGHT and rejects names that are neither $WIDTH/$HEIGHT nor a float input. */
  private compilePassSizes(parsed: ParsedIsf): Array<{ w: Expr; h: Expr }> {
    const known = new Set(["WIDTH", "HEIGHT"]);
    for (const i of parsed.inputs) if (i.TYPE === "float") known.add(i.NAME);
    return parsed.passes.map((p) => {
      const w = parseExpr(p.width);
      const h = parseExpr(p.height);
      for (const n of [...exprNames(w), ...exprNames(h)]) {
        if (!known.has(n)) {
          throw new IsfError("parse", `pass size expression uses unknown $${n} (only $WIDTH, $HEIGHT and float inputs)`);
        }
      }
      return { w, h };
    });
  }

  private createTargets(): void {
    const { gl } = this;
    const wantsFloat = this.passes.some((p, i) => p.float && i < this.passes.length - 1 && p.target);
    const floatOk = wantsFloat && !!gl.getExtension("EXT_color_buffer_float");
    if (wantsFloat && !floatOk) {
      debugLog(`[isf/${this.label}] FLOAT pass buffers need EXT_color_buffer_float, which is unavailable - using 8-bit`);
    }
    this.passes.forEach((p, i) => {
      // The final pass is the output; its TARGET (if any) is not a separate buffer.
      if (!p.target || i === this.passes.length - 1 || this.targets.has(p.target)) return;
      this.targets.set(p.target, new PassTarget(gl, p.target, p.persistent, p.float && floatOk));
    });
    const persistent = [...this.targets.values()].filter((t) => t.persistent).length;
    debugLog(`[isf/${this.label}] passes=${this.passes.length} buffers=${this.targets.size} persistent=${persistent}${floatOk ? " float" : ""}`);
  }

  private cacheUniformLocations(): void {
    const { gl, program } = this;
    const names = [...STANDARD_UNIFORMS];
    for (const input of this.inputs) {
      names.push(input.NAME);
      if (SAMPLER_TYPES.has(input.TYPE)) {
        names.push(`_${input.NAME}_imgRect`, `_${input.NAME}_imgSize`, `_${input.NAME}_flip`);
      }
    }
    for (const name of this.imported.keys()) {
      names.push(name, `_${name}_imgRect`, `_${name}_imgSize`, `_${name}_flip`);
    }
    for (const p of this.passes) {
      if (p.target) names.push(p.target, `_${p.target}_imgRect`, `_${p.target}_imgSize`, `_${p.target}_flip`);
    }
    for (const name of names) {
      this.uniformLocs.set(name, gl.getUniformLocation(program, name));
    }
  }

  private loc(name: string): WebGLUniformLocation | null {
    return this.uniformLocs.get(name) ?? null;
  }

  /** Renders one frame into this instance's FBO and returns its texture. */
  render(frame: IsfFrameInputs, vao: WebGLVertexArrayObject): WebGLTexture {
    if (this.disposed) {
      throw new IsfError("runtime", `IsfInstance [${this.label}] used after dispose()`);
    }
    const { gl } = this;

    gl.useProgram(this.program);
    gl.bindVertexArray(vao);

    gl.uniform1f(this.loc("TIME"), frame.time);
    gl.uniform1f(this.loc("TIMEDELTA"), frame.timeDelta);
    gl.uniform1i(this.loc("FRAMEINDEX"), frame.frameIndex);
    gl.uniform4f(
      this.loc("DATE"),
      frame.date[0],
      frame.date[1],
      frame.date[2],
      frame.date[3],
    );

    let textureUnit = 0;
    for (const input of this.inputs) {
      if (SAMPLER_TYPES.has(input.TYPE)) {
        this.bindSamplerInput(input, textureUnit, frame);
        textureUnit += 1;
      } else {
        this.setValueInput(input, frame);
      }
    }

    for (const [name, entry] of this.imported) {
      gl.activeTexture(gl.TEXTURE0 + textureUnit);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture ?? this.blankTexture);
      gl.uniform1i(this.loc(name), textureUnit);
      gl.uniform2f(this.loc(`_${name}_imgSize`), entry.width, entry.height);
      gl.uniform4f(this.loc(`_${name}_imgRect`), 0, 0, 1, 1);
      gl.uniform1i(this.loc(`_${name}_flip`), 0);
      textureUnit += 1;
    }

    // Size every buffer up front so a pass may read a target that a later pass writes.
    const last = this.passes.length - 1;
    const sizeVars: Record<string, number> = { WIDTH: this.fbo.width, HEIGHT: this.fbo.height };
    for (const input of this.inputs) {
      if (input.TYPE === "float") sizeVars[input.NAME] = toNumber(this.effectiveValue(input, frame));
    }
    const sizes = this.passes.map((p, i) => {
      if (i === last || !p.target) return { w: this.fbo.width, h: this.fbo.height };
      const ex = this.passSizeExprs[i];
      const clamp = (v: number) => Math.min(MAX_PASS_EDGE, Math.max(1, Math.floor(Number.isFinite(v) ? v : 1)));
      return { w: clamp(evalExpr(ex.w, sizeVars)), h: clamp(evalExpr(ex.h, sizeVars)) };
    });
    this.passes.forEach((p, i) => {
      if (i !== last && p.target) this.targets.get(p.target)!.resize(sizes[i].w, sizes[i].h);
    });

    const targetBase = textureUnit;
    for (let i = 0; i <= last; i++) {
      const p = this.passes[i];
      const writing = i !== last && p.target ? this.targets.get(p.target)! : null;
      if (writing) {
        writing.bindWrite();
      } else {
        this.fbo.bind();
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.uniform2f(this.loc("RENDERSIZE"), sizes[i].w, sizes[i].h);
      gl.uniform1i(this.loc("PASSINDEX"), i);

      let unit = targetBase;
      for (const [name, t] of this.targets) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        const tex = t === writing ? t.selfReadTexture : t.readTexture;
        gl.bindTexture(gl.TEXTURE_2D, tex ?? this.blankTexture);
        gl.uniform1i(this.loc(name), unit);
        gl.uniform2f(this.loc(`_${name}_imgSize`), t.width, t.height);
        gl.uniform4f(this.loc(`_${name}_imgRect`), 0, 0, 1, 1);
        gl.uniform1i(this.loc(`_${name}_flip`), 0);
        unit += 1;
      }
      // A TARGET the final pass names has no buffer; keep its sampler on a valid texture.
      const lastTarget = this.passes[last].target;
      if (lastTarget && !this.targets.has(lastTarget)) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, this.blankTexture);
        gl.uniform1i(this.loc(lastTarget), unit);
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      writing?.swap();
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return this.fbo.texture;
  }

  // R8 (not R32F): filterable with no extension, and 8 bits is ample for a display spectrum.
  // Sampled as `.r` in 0-1 by the shader.
  private bindFftInput(input: IsfInput, textureUnit: number, frame: IsfFrameInputs): void {
    const { gl } = this;
    let entry = this.fftTextures.get(input.NAME);
    if (!entry) {
      const tex = gl.createTexture();
      if (!tex) throw new IsfError("runtime", "Failed to create audioFFT texture");
      const width = fftTextureWidth(input);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(width));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      entry = { tex, width, bytes: new Uint8Array(width) };
      this.fftTextures.set(input.NAME, entry);
    }
    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    packFft(frame.fft, entry.width, entry.bytes);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, entry.width, 1, gl.RED, gl.UNSIGNED_BYTE, entry.bytes);
    gl.uniform1i(this.loc(input.NAME), textureUnit);
    gl.uniform2f(this.loc(`_${input.NAME}_imgSize`), entry.width, 1);
    gl.uniform4f(this.loc(`_${input.NAME}_imgRect`), 0, 0, 1, 1);
    gl.uniform1i(this.loc(`_${input.NAME}_flip`), 0);
  }

  // Waveform: R8, 1024 wide, one row per channel. Linear filtering, so a shader sampling
  // between texels gets a smooth line; centred on 0.5.
  private bindPcmInput(input: IsfInput, textureUnit: number, frame: IsfFrameInputs): void {
    const { gl } = this;
    let entry = this.pcmTextures.get(input.NAME);
    if (!entry) {
      const tex = gl.createTexture();
      if (!tex) throw new IsfError("runtime", "Failed to create audio texture");
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const bytes = packPcmRows(undefined);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, PCM_LEN, PCM_ROWS, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      entry = { tex, bytes };
      this.pcmTextures.set(input.NAME, entry);
      debugLog(`[isf/${this.label}] audio input '${input.NAME}' fed from the PCM tap (${PCM_LEN}x${PCM_ROWS}, L/R rows)`);
    }
    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    packPcmRows(frame.pcm, entry.bytes);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PCM_LEN, PCM_ROWS, gl.RED, gl.UNSIGNED_BYTE, entry.bytes);
    gl.uniform1i(this.loc(input.NAME), textureUnit);
    gl.uniform2f(this.loc(`_${input.NAME}_imgSize`), PCM_LEN, PCM_ROWS);
    gl.uniform4f(this.loc(`_${input.NAME}_imgRect`), 0, 0, 1, 1);
    gl.uniform1i(this.loc(`_${input.NAME}_flip`), 0);
  }

  private bindSamplerInput(input: IsfInput, textureUnit: number, frame: IsfFrameInputs): void {
    if (input.TYPE === "audioFFT") {
      this.bindFftInput(input, textureUnit, frame);
      return;
    }
    if (input.TYPE === "audio") {
      this.bindPcmInput(input, textureUnit, frame);
      return;
    }
    const { gl } = this;
    const isImage = input.TYPE === "image";
    if (!this.loggedUnfed.has(input.NAME)) {
      this.loggedUnfed.add(input.NAME);
      const reason =
        "bound to the built-in 256x256 test pattern";
      debugLog(`[isf/${this.label}] input '${input.NAME}' (${input.TYPE}) not fed by the host - ${reason}`);
    }

    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, isImage ? this.testTexture : this.blankTexture);
    const size = isImage ? TEST_PATTERN_SIZE : 1;
    gl.uniform1i(this.loc(input.NAME), textureUnit);
    gl.uniform2f(this.loc(`_${input.NAME}_imgSize`), size, size);
    gl.uniform4f(this.loc(`_${input.NAME}_imgRect`), 0, 0, 1, 1);
    gl.uniform1i(this.loc(`_${input.NAME}_flip`), 0);
  }

  private effectiveValue(input: IsfInput, frame: IsfFrameInputs): unknown {
    const bind = input.CUEMARK_BIND;
    return bind
      ? (frame.bindings[bind] ?? input.DEFAULT ?? 0)
      : (frame.params[input.NAME] ?? input.DEFAULT ?? typeZero(input.TYPE));
  }

  private setValueInput(input: IsfInput, frame: IsfFrameInputs): void {
    const { gl } = this;
    const loc = this.loc(input.NAME);
    const raw = this.effectiveValue(input, frame);

    switch (input.TYPE) {
      case "float":
        gl.uniform1f(loc, toNumber(raw));
        break;
      case "bool":
      case "event":
        gl.uniform1i(loc, toNumber(raw) ? 1 : 0);
        break;
      case "long":
        gl.uniform1i(loc, Math.trunc(toNumber(raw)));
        break;
      case "color": {
        const c = toNumberArray(raw, 4);
        gl.uniform4f(loc, c[0], c[1], c[2], c[3]);
        break;
      }
      case "point2D": {
        const p = toNumberArray(raw, 2);
        gl.uniform2f(loc, p[0], p[1]);
        break;
      }
      default:
        // The parser already throws on a TYPE it doesn't recognize
        // (`inputToType` in vendor/ISFParser.ts), so this is unreachable in
        // practice — left as a no-op rather than a thrown error so a future
        // ISF spec addition degrades to "input ignored" instead of a crash.
        break;
    }
  }

  /** Deletes the program, shaders, FBO, pass buffers and textures. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    const { gl } = this;
    gl.deleteProgram(this.program);
    gl.deleteShader(this.vertShader);
    gl.deleteShader(this.fragShader);
    gl.deleteTexture(this.blankTexture);
    gl.deleteTexture(this.testTexture);
    for (const entry of this.imported.values()) {
      if (entry.texture) gl.deleteTexture(entry.texture);
      entry.texture = null;
    }
    for (const t of this.targets.values()) t.dispose();
    this.targets.clear();
    for (const e of this.fftTextures.values()) gl.deleteTexture(e.tex);
    this.fftTextures.clear();
    this.fbo.destroy();
    this.uniformLocs.clear();
    this.disposed = true;
  }
}
