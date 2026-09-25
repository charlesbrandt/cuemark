/**
 * `IsfInstance` — compiles one ISF plugin into its own WebGL2 program and
 * renders it into its own `DeckFBO`, single-pass only (Phase 1; multipass
 * arrives in Phase 4 per `docs/design/visualization-plugins.md`).
 *
 * Not wired into `Compositor` yet — that integration (replacing
 * `vizFbo`/`vizProgram` with an `IsfInstance`) is the lead's job per the
 * task split; this file is usable standalone once that wiring lands.
 */
import { DeckFBO } from "../fbo";
import { debugLog } from "../../debugLog";
import { IsfError, type IsfInput, type ParsedIsf } from "./parser";

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
}

// The only ISF input TYPEs the vendored parser maps to `sampler2D` (see
// `vendor/ISFParser.ts`'s `typeUniformMap`). Used here to decide which
// inputs need a texture bound rather than a plain value uniform.
const SAMPLER_TYPES = new Set(["image", "audio", "audioFFT"]);

// Standard ISF uniforms every generated shader declares (fragmentShaderSkeleton
// in vendor/ISFParser.ts), independent of the plugin's own INPUTS.
const STANDARD_UNIFORMS = ["TIME", "TIMEDELTA", "FRAMEINDEX", "DATE", "RENDERSIZE", "PASSINDEX"];

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

export class IsfInstance {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vertShader: WebGLShader;
  private readonly fragShader: WebGLShader;
  private readonly fbo: DeckFBO;
  private readonly blankTexture: WebGLTexture;
  private readonly inputs: IsfInput[];
  private readonly uniformLocs = new Map<string, WebGLUniformLocation | null>();
  private readonly loggedUnfed = new Set<string>();
  private disposed = false;

  readonly label: string;

  constructor(
    gl: WebGL2RenderingContext,
    parsed: ParsedIsf,
    width: number,
    height: number,
    label: string,
  ) {
    // Phase 1 is single-pass only. A plugin that declares more than one pass,
    // or a single pass with a TARGET (i.e. it wants a persistent/offscreen
    // buffer), needs pass orchestration that doesn't exist yet — see Phase 4
    // in the design doc. Fail loudly rather than silently rendering only
    // part of what the plugin asked for.
    if (parsed.passes.length > 1 || parsed.passes.some((p) => p.target)) {
      throw new IsfError("unsupported", "multipass arrives in phase 4");
    }

    this.gl = gl;
    this.label = label;
    this.inputs = parsed.inputs;

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
    this.blankTexture = this.createBlankTexture();
    this.cacheUniformLocations();
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

  private cacheUniformLocations(): void {
    const { gl, program } = this;
    const names = [...STANDARD_UNIFORMS];
    for (const input of this.inputs) {
      names.push(input.NAME);
      if (SAMPLER_TYPES.has(input.TYPE)) {
        names.push(`_${input.NAME}_imgRect`, `_${input.NAME}_imgSize`, `_${input.NAME}_flip`);
      }
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

    this.fbo.bind();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

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
    gl.uniform2f(this.loc("RENDERSIZE"), this.fbo.width, this.fbo.height);
    gl.uniform1i(this.loc("PASSINDEX"), 0);

    let textureUnit = 0;
    for (const input of this.inputs) {
      if (SAMPLER_TYPES.has(input.TYPE)) {
        this.bindSamplerInput(input, textureUnit);
        textureUnit += 1;
      } else {
        this.setValueInput(input, frame);
      }
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return this.fbo.texture;
  }

  private bindSamplerInput(input: IsfInput, textureUnit: number): void {
    const { gl } = this;
    if (!this.loggedUnfed.has(input.NAME)) {
      this.loggedUnfed.add(input.NAME);
      const reason =
        input.TYPE === "audioFFT"
          ? "audioFFT spectrum texture arrives in phase 3"
          : input.TYPE === "audio"
            ? "audio (PCM) texture arrives in phase 5"
            : "image asset loading arrives in a later step";
      debugLog(`[isf/${this.label}] input '${input.NAME}' (${input.TYPE}) not yet fed — ${reason}`);
    }

    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, this.blankTexture);
    gl.uniform1i(this.loc(input.NAME), textureUnit);
    gl.uniform2f(this.loc(`_${input.NAME}_imgSize`), 1, 1);
    gl.uniform4f(this.loc(`_${input.NAME}_imgRect`), 0, 0, 1, 1);
    gl.uniform1i(this.loc(`_${input.NAME}_flip`), 0);
  }

  private setValueInput(input: IsfInput, frame: IsfFrameInputs): void {
    const { gl } = this;
    const loc = this.loc(input.NAME);
    const bind = input.CUEMARK_BIND;
    const raw: unknown = bind
      ? (frame.bindings[bind] ?? input.DEFAULT ?? 0)
      : (frame.params[input.NAME] ?? input.DEFAULT ?? typeZero(input.TYPE));

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

  /** Deletes the program, shaders, FBO and blank texture. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    const { gl } = this;
    gl.deleteProgram(this.program);
    gl.deleteShader(this.vertShader);
    gl.deleteShader(this.fragShader);
    gl.deleteTexture(this.blankTexture);
    this.fbo.destroy();
    this.uniformLocs.clear();
    this.disposed = true;
  }
}
