import { DeckFBO } from "./fbo";

// Full-screen quad: two triangles covering clip space
const QUAD_VERTS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

const VERT_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Blits a single deck FBO onto the output with an opacity weight.
// Called once per deck in back-to-front order; blending accumulates.
const FRAG_BLIT = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_opacity;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  fragColor = texture(u_tex, v_uv) * u_opacity;
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) ?? "shader compile error");
  return s;
}

function linkProgram(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, frag));
  // Force a_pos to location 0 so all programs share the same quadVAO binding.
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p) ?? "program link error");
  return p;
}

export class Compositor {
  private gl: WebGL2RenderingContext;
  private blitProgram: WebGLProgram;
  private quadVAO: WebGLVertexArrayObject;
  // One FBO per deck; keyed by deck id. Created/destroyed as decks are added/removed.
  private fbos = new Map<string, DeckFBO>();
  // Single global visualization layer — composited above all decks, not tied to a deck id.
  private vizFbo: DeckFBO;
  private vizProgram: { program: WebGLProgram | null; src: string } | null = null;

  readonly width: number;
  readonly height: number;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.width = canvas.width;
    this.height = canvas.height;
    this.blitProgram = linkProgram(gl, VERT_SRC, FRAG_BLIT);
    this.quadVAO = this.buildQuad();
    this.vizFbo = new DeckFBO(gl, this.width, this.height);
  }

  private buildQuad(): WebGLVertexArrayObject {
    const { gl } = this;
    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTS, gl.STATIC_DRAW);
    // a_pos is bound to location 0 in linkProgram — use 0 directly so all programs share this VAO.
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  // Call whenever the deck list changes. Allocates FBOs for new decks,
  // frees FBOs for removed ones — works for any number of decks.
  syncDecks(deckIds: string[]) {
    for (const id of [...this.fbos.keys()]) {
      if (!deckIds.includes(id)) {
        this.fbos.get(id)!.destroy();
        this.fbos.delete(id);
      }
    }
    for (const id of deckIds) {
      if (!this.fbos.has(id)) {
        this.fbos.set(id, new DeckFBO(this.gl, this.width, this.height));
      }
    }
  }

  getFBO(deckId: string): DeckFBO | undefined {
    return this.fbos.get(deckId);
  }

  // Render the global visualization shader into its own FBO (not a deck's). Composited
  // above all decks in composite() — selecting a visualization never touches deck audio/video.
  renderVisualization(
    fragmentSrc: string,
    customUniforms: Record<string, number>,
    time: number,
    analysis: { bass: number; mid: number; high: number },
  ) {
    const { gl, quadVAO } = this;

    let cached = this.vizProgram;
    if (!cached || cached.src !== fragmentSrc) {
      if (cached?.program) gl.deleteProgram(cached.program);
      let program: WebGLProgram | null = null;
      try {
        program = linkProgram(gl, VERT_SRC, fragmentSrc);
      } catch (e) {
        console.error('[visualization] compile error:', e);
      }
      cached = { program, src: fragmentSrc };
      this.vizProgram = cached;
    }
    if (!cached.program) return;

    const fbo = this.vizFbo;
    fbo.bind();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(cached.program);
    gl.bindVertexArray(quadVAO);

    const p = cached.program;
    gl.uniform1f(gl.getUniformLocation(p, 'u_time'), time);
    gl.uniform2f(gl.getUniformLocation(p, 'u_resolution'), fbo.width, fbo.height);
    gl.uniform1f(gl.getUniformLocation(p, 'u_bass'), analysis.bass);
    gl.uniform1f(gl.getUniformLocation(p, 'u_mid'), analysis.mid);
    gl.uniform1f(gl.getUniformLocation(p, 'u_high'), analysis.high);
    for (const [name, value] of Object.entries(customUniforms)) {
      const loc = gl.getUniformLocation(p, name);
      if (loc !== null) gl.uniform1f(loc, value);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Alpha-composite all deck FBOs back-to-front onto the output canvas, then blend the
  // global visualization layer (if active) on top. Decks with opacity=0 are skipped.
  // No deck count is hardcoded here.
  composite(decks: Array<{ id: string; opacity: number }>, visualizationOpacity = 0) {
    const { gl, blitProgram, quadVAO } = this;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(blitProgram);
    gl.bindVertexArray(quadVAO);

    const uTex = gl.getUniformLocation(blitProgram, "u_tex");
    const uOpacity = gl.getUniformLocation(blitProgram, "u_opacity");

    for (const { id, opacity } of decks) {
      if (opacity <= 0) continue;
      const fbo = this.fbos.get(id);
      if (!fbo) continue;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fbo.texture);
      gl.uniform1i(uTex, 0);
      gl.uniform1f(uOpacity, opacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    if (visualizationOpacity > 0) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.vizFbo.texture);
      gl.uniform1i(uTex, 0);
      gl.uniform1f(uOpacity, visualizationOpacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}
