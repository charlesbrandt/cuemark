/**
 * Vendored-parser + typed-wrapper tests for the ISF renderer core.
 *
 * These run entirely in vitest/node — no WebGL context, so nothing here
 * exercises `IsfInstance.render()` (that needs a real GL context; see
 * `docs/design/visualization-plugins.md` Phase 1 step 2, which explicitly
 * calls out "compile the parser's output in the real output window" as the
 * one unverified assumption these tests can't cover).
 */
import { describe, expect, it } from "vitest";
import { parseIsf, IsfError } from "./parser";
import { BUILTIN_ISF } from "./builtins";

// GLSL ES 3.00-only tokens the vendored parser's output must never contain —
// its skeleton emits plain GLSL ES 1.00 (attribute/varying/gl_FragColor/
// texture2D), which is what lets it compile unmodified in a WebGL2 context
// alongside ES 3.00 programs (see vendor/ISFParser.ts's header comment).
function assertIsEs100(fragmentShader: string) {
  expect(fragmentShader).not.toMatch(/#version/);
  expect(fragmentShader).not.toMatch(/\btexture\(/);
  expect(fragmentShader).not.toMatch(/\bin\s+(vec[234]|float|int|bool)\b/);
  expect(fragmentShader).not.toMatch(/\bout\s+(vec[234]|float|int|bool)\b/);
}

describe("parseIsf — built-in shaders", () => {
  const expectedBinds: Record<string, string[]> = {
    "builtin:plasma": ["bass"],
    "builtin:tunnel": ["bass"],
    "builtin:particles": ["bass", "high"],
    "builtin:feedback": ["bass", "mid", "high"],
    "builtin:scope": ["bass", "mid", "high"],
  };

  for (const builtin of BUILTIN_ISF) {
    it(`parses ${builtin.id} (${builtin.name})`, () => {
      const parsed = parseIsf(builtin.source);
      expect(parsed.type).toBe("generator");
      expect(parsed.passes.length).toBe(1);

      const binds = parsed.inputs.map((input) => input.CUEMARK_BIND).filter(Boolean);
      expect(binds.sort()).toEqual([...expectedBinds[builtin.id]].sort());

      assertIsEs100(parsed.fragmentShader);
    });
  }
});

describe("parseIsf — input types", () => {
  it("parses a float input", () => {
    const src = `/*{
      "INPUTS": [
        { "NAME": "amount", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0.5 }
      ]
    }*/
    void main() { gl_FragColor = vec4(amount); }`;
    const parsed = parseIsf(src);
    expect(parsed.inputs).toHaveLength(1);
    expect(parsed.inputs[0]).toMatchObject({ NAME: "amount", TYPE: "float", DEFAULT: 0.5 });
    expect(parsed.fragmentShader).toContain("uniform float amount;");
  });

  it("parses an audioFFT input — the bug the vendored parser shipped with", () => {
    // Unpatched typeUniformMap has no 'audioFFT' entry, so parse() throws
    // "Unknown input type [audioFFT]" and this test fails with IsfError.
    const src = `/*{
      "INPUTS": [
        { "NAME": "spectrum", "TYPE": "audioFFT", "MAX": 32 }
      ]
    }*/
    void main() { gl_FragColor = IMG_NORM_PIXEL(spectrum, isf_FragNormCoord); }`;
    const parsed = parseIsf(src);
    expect(parsed.inputs).toHaveLength(1);
    expect(parsed.inputs[0]).toMatchObject({ NAME: "spectrum", TYPE: "audioFFT" });
    // Same helper uniforms/varyings image inputs get (addUniform branches on
    // the mapped-to sampler2D type, not the literal string 'image').
    expect(parsed.fragmentShader).toContain("uniform sampler2D spectrum;");
    expect(parsed.fragmentShader).toContain("uniform vec4 _spectrum_imgRect;");
    expect(parsed.fragmentShader).toContain("uniform vec2 _spectrum_imgSize;");
    expect(parsed.fragmentShader).toContain("uniform bool _spectrum_flip;");
    // And the vertex shader must actually assign the texCoord varyings for
    // it too (patch 2 — upstream only did this for TYPE === 'image').
    expect(parsed.vertexShader).toContain("_spectrum_texCoord");
    expect(parsed.vertexShader).toContain("_spectrum_normTexCoord");
  });

  it("parses an audio (PCM) input the same way", () => {
    const src = `/*{
      "INPUTS": [
        { "NAME": "waveform", "TYPE": "audio" }
      ]
    }*/
    void main() { gl_FragColor = IMG_NORM_PIXEL(waveform, isf_FragNormCoord); }`;
    const parsed = parseIsf(src);
    expect(parsed.inputs[0]).toMatchObject({ NAME: "waveform", TYPE: "audio" });
    expect(parsed.fragmentShader).toContain("uniform sampler2D waveform;");
  });

  it("parses bool, color, point2D and long inputs", () => {
    const src = `/*{
      "INPUTS": [
        { "NAME": "enabled", "TYPE": "bool", "DEFAULT": true },
        { "NAME": "tint", "TYPE": "color", "DEFAULT": [1, 0, 0, 1] },
        { "NAME": "center", "TYPE": "point2D", "DEFAULT": [0.5, 0.5] },
        { "NAME": "count", "TYPE": "long", "DEFAULT": 4, "VALUES": [1, 2, 4, 8], "LABELS": ["One", "Two", "Four", "Eight"] }
      ]
    }*/
    void main() { gl_FragColor = enabled ? tint : vec4(center, 0.0, float(count)); }`;
    const parsed = parseIsf(src);
    expect(parsed.inputs).toHaveLength(4);

    const byName = Object.fromEntries(parsed.inputs.map((i) => [i.NAME, i]));
    expect(byName.enabled).toMatchObject({ TYPE: "bool", DEFAULT: true });
    expect(byName.tint).toMatchObject({ TYPE: "color", DEFAULT: [1, 0, 0, 1] });
    expect(byName.center).toMatchObject({ TYPE: "point2D", DEFAULT: [0.5, 0.5] });
    expect(byName.count).toMatchObject({
      TYPE: "long",
      VALUES: [1, 2, 4, 8],
      LABELS: ["One", "Two", "Four", "Eight"],
    });

    expect(parsed.fragmentShader).toContain("uniform bool enabled;");
    expect(parsed.fragmentShader).toContain("uniform vec4 tint;");
    expect(parsed.fragmentShader).toContain("uniform vec2 center;");
    expect(parsed.fragmentShader).toContain("uniform int count;");
  });
});

describe("parseIsf — multipass", () => {
  it("parses a shader with two passes", () => {
    const src = `/*{
      "DESCRIPTION": "Buffers a frame",
      "CREDIT": "test",
      "CATEGORIES": ["test"],
      "INPUTS": [
        { "TYPE": "float", "NAME": "xPos", "MIN": 0, "MAX": 1 }
      ],
      "PASSES": [
        { "TARGET": "buffer1", "PERSISTENT": true },
        {}
      ]
    }*/
    void main() {
      if (PASSINDEX == 0) {
        float val = 1.0 - abs(xPos - isf_FragNormCoord.x) * 13.0;
        val = max(val, 0.0);
        gl_FragColor = vec4(val, val, val, val) + IMG_NORM_PIXEL(buffer1, isf_FragNormCoord.xy);
      } else {
        gl_FragColor = IMG_NORM_PIXEL(buffer1, isf_FragNormCoord.xy);
      }
    }`;
    const parsed = parseIsf(src);
    expect(parsed.passes).toHaveLength(2);
    expect(parsed.passes[0]).toMatchObject({ target: "buffer1", persistent: true });
    expect(parsed.passes[1]).toMatchObject({ persistent: false });
  });
});

describe("parseIsf — errors", () => {
  it("throws IsfError stage 'parse' on a broken header", () => {
    // Missing comma after the CATEGORIES array — invalid JSON.
    const src = `/*{
      "DESCRIPTION": "Error on line 6/7, missing comma",
      "CREDIT": "test",
      "CATEGORIES": [
        "Glitch"
      ]
      "INPUTS": [
        { "TYPE": "float", "NAME": "xPos", "MIN": 0, "MAX": 1 }
      ]
    }*/
    void main() { gl_FragColor = vec4(xPos); }`;

    let caught: unknown;
    try {
      parseIsf(src);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IsfError);
    expect((caught as IsfError).stage).toBe("parse");
  });

  it("throws IsfError stage 'parse' when there is no header comment at all", () => {
    let caught: unknown;
    try {
      parseIsf("void main() { gl_FragColor = vec4(0.0); }");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IsfError);
    expect((caught as IsfError).stage).toBe("parse");
  });
});

describe("parseIsf — CUEMARK_BIND preservation", () => {
  it("keeps the CUEMARK_BIND key on an input (not part of the ISF spec)", () => {
    const src = `/*{
      "INPUTS": [
        { "NAME": "beat", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0, "CUEMARK_BIND": "beatPhase" }
      ]
    }*/
    void main() { gl_FragColor = vec4(beat); }`;
    const parsed = parseIsf(src);
    expect(parsed.inputs[0].CUEMARK_BIND).toBe("beatPhase");
    // And it doesn't leak into the generated GLSL — it's host-side only.
    expect(parsed.fragmentShader).not.toContain("CUEMARK_BIND");
  });
});
