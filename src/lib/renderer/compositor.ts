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
precision mediump float;
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
  }

  private buildQuad(): WebGLVertexArrayObject {
    const { gl, blitProgram } = this;
    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTS, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(blitProgram, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
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

  // Alpha-composite all deck FBOs back-to-front onto the output canvas.
  // Decks with opacity=0 are skipped. No deck count is hardcoded here.
  composite(decks: Array<{ id: string; opacity: number }>) {
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

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}
