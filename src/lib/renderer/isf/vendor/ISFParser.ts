/*
  ISFParser.ts

  Vendored from `interactive-shader-format@2.8.1` (npm, ISC) /
  msfeldstein/interactive-shader-format-js (GitHub, relicensed MIT
  2025-12-31), `src/ISFParser.js`. See ../NOTICE for the full upstream
  licence text and attribution. Last upstream release: 2020-03-02 —
  effectively unmaintained, hence vendoring rather than depending on it.

  Only the parser is vendored, not `ISFRenderer.js`/`ISFBuffer.js`/
  `ISFGLProgram.js`/`ISFTexture.js` (the upstream renderer, unused here —
  `IsfInstance` in `../instance.ts` does pass/FBO orchestration itself) and
  not `ISFUpgrader.js` (converts legacy `vv_`-prefixed ISF 1.0 shaders;
  `ISFParser.parse()` never imports or calls it).

  Converted from the upstream `function ISFParser(){}` +
  `ISFParser.prototype.foo = function(){...}` pattern to an ES class, so
  `this`-typing satisfies this project's `strict`/`noImplicitThis` tsconfig
  without scattering `any`. The algorithm and control flow are otherwise
  unchanged method-for-method from upstream.

  Local patches (cuemark, 2026-09), both marked "PATCH" at their call site:

  1. `typeUniformMap` had no `audio`/`audioFFT` entries, so `parse()` throws
     `Unknown input type [audioFFT]` (`inputToType()`) on any audio-reactive
     ISF shader — verified by running the unpatched parser on a test shader
     declaring an `audioFFT` input. The ISF spec exposes both `audio` and
     `audioFFT` inputs as 2D textures (one row per channel / one row of
     spectrum bins), same as `image`, so both are added as `sampler2D`.
     `addUniform()` already branches generically on
     `type === 'sampler2D'` (not on the literal string `'image'`) to emit the
     `_<name>_imgRect` / `_<name>_imgSize` / `_<name>_flip` /
     `_<name>_normTexCoord` / `_<name>_texCoord` helper uniforms/varyings —
     so audio/audioFFT get those automatically once mapped to `sampler2D`,
     no separate change needed there. Likewise `IMG_SIZE(name)` and
     `IMG_NORM_PIXEL(...)` are plain regex substitutions in
     `replaceSpecialFunctions()` keyed only on the sampler's `NAME`, not its
     declared `TYPE` — already generic, confirmed by reading the code (no
     patch needed for those macros).

  2. `buildVertexShader()`'s `texCoordFunctions()` loop DID branch on the
     literal `input.TYPE === 'image'` — it only emits the
     `_<name>_texCoord`/`_<name>_normTexCoord` assignment statements for
     `image` inputs, leaving those varyings declared-but-never-written for
     `audio`/`audioFFT` (dead-but-harmless unless a shader body reads
     `_<name>_normTexCoord` directly instead of going through the
     `IMG_NORM_PIXEL` macro — a real, if uncommon, ISF authoring style).
     Patched to loop over `SAMPLER_INPUT_TYPES` (image, audio, audioFFT)
     instead of the single literal, so audio/audioFFT follow the exact same
     vertex-shader code path as image.

  3. Known/checked issue — the `isf_FragCoord` / `isf_fragCoord` case
     mismatch: `fragmentShaderSkeleton` declares
     `varying vec2 isf_FragCoord;` (capital F, capital C — matching the ISF
     name for it), but the *unpatched* `vertexShaderSkeleton` only computes a
     plain (non-varying) global `vec2 isf_fragCoord;` (lowercase f) and never
     writes anything to a varying of the other name. These are two different
     identifiers in GLSL (case-sensitive), so the fragment shader's
     `isf_FragCoord` varying has no counterpart in the vertex shader at all.
     Whether this breaks anything depends on whether `isf_FragCoord` is
     *statically used* by the fragment main: GLSL ES 1.00 dead-varying
     elimination means an unused varying with no vertex-shader counterpart
     compiles and links fine on typical drivers, and neither the ISF spec
     nor `replaceSpecialFunctions()`'s macros (`IMG_PIXEL`/`IMG_NORM_PIXEL`/
     `IMG_THIS_PIXEL`/`IMG_SIZE`) ever emit a reference to `isf_FragCoord` —
     only to `isf_FragNormCoord`, which *is* correctly declared and written
     in both stages. So in practice this is dead code for any shader that
     sticks to the documented ISF macros. However: (a) some hand-written ISF
     shaders in the wild reference `isf_FragCoord` directly as an
     undocumented-but-suggestively-named pixel-space coordinate, and (b) at
     least some strict GLSL ES 1.00 linkers (this matters especially here —
     see CLAUDE.md's running catalogue of WebKitGTK/Mesa quirks that fail
     *silently* rather than erroring loudly) reject a fragment `varying`
     with no matching vertex-shader declaration regardless of static use.
     Given the fix is one extra varying declaration plus one assignment,
     with zero behavior change for shaders that never touch
     `isf_FragCoord`, patched defensively: `vertexShaderSkeleton` now also
     declares `varying vec2 isf_FragCoord;` and `isf_vertShaderInit()`
     assigns it from `isf_fragCoord` (so both names carry the same,
     correctly-computed pixel-space value). Not re-verified end to end with
     `glslangValidator` against the unpatched skeleton first (no reference
     build to diff against) — see the phase-1 report for what was actually
     checked.
*/

import MetadataExtractor from "./MetadataExtractor";

export interface IsfPassDef {
  target?: string;
  persistent: boolean;
  width: string;
  height: string;
  float: boolean;
}

export interface IsfInputHeader {
  NAME: string;
  TYPE: string;
  // ISF headers carry many other optional keys (DEFAULT, MIN, MAX, VALUES,
  // LABELS, IDENTITY, ...) plus cuemark's own CUEMARK_BIND. They all pass
  // through untouched since `this.inputs = metadata.INPUTS` keeps the raw
  // parsed JSON objects rather than re-building typed records.
  [key: string]: unknown;
}

const typeUniformMap: Record<string, string> = {
  float: "float",
  image: "sampler2D",
  // PATCH 1: audio-reactive inputs, see file header.
  audio: "sampler2D",
  audioFFT: "sampler2D",
  bool: "bool",
  event: "bool",
  long: "int",
  color: "vec4",
  point2D: "vec2",
};

// PATCH 2: sampler2D-typed ISF input kinds that need the vertex-shader
// texCoord helper *functions* generated for them (not just the uniform
// declarations, which are already generic — see file header).
const SAMPLER_INPUT_TYPES = new Set(["image", "audio", "audioFFT"]);

export class ISFParser {
  valid = false;
  error: unknown = null;
  errorLine?: number;
  rawFragmentShader = "";
  rawVertexShader = "";
  rawFragmentMain = "";
  metadata: Record<string, any> = {};
  credit = "";
  categories: string[] = [];
  inputs: IsfInputHeader[] = [];
  imports: Record<string, unknown> = {};
  description?: string;
  passes: IsfPassDef[] = [];
  uniformDefs = "";
  fragmentShader = "";
  vertexShader = "";
  type: "filter" | "transition" | "generator" = "generator";
  isfVersion = 2;

  parse(rawFragmentShader: string, rawVertexShader?: string): void {
    try {
      this.valid = true;
      this.rawFragmentShader = rawFragmentShader;
      this.rawVertexShader = rawVertexShader || ISFParser.vertexShaderDefault;
      this.error = null;
      const metadataInfo = MetadataExtractor(this.rawFragmentShader);
      const metadata = metadataInfo.objectValue;
      const metadataString = metadataInfo.stringValue;
      this.metadata = metadata;
      this.credit = metadata.CREDIT;
      this.categories = metadata.CATEGORIES;
      this.inputs = metadata.INPUTS;
      this.imports = metadata.IMPORTED || {};
      this.description = metadata.DESCRIPTION;

      const passesArray = metadata.PASSES || [{}];
      this.passes = this.parsePasses(passesArray);
      const endOfMetadata =
        this.rawFragmentShader.indexOf(metadataString) + metadataString.length + 2;
      this.rawFragmentMain = this.rawFragmentShader.substring(endOfMetadata);
      this.generateShaders();
      this.inferFilterType();
      this.isfVersion = this.inferISFVersion();
    } catch (e: any) {
      this.valid = false;
      this.error = e;
      this.inputs = [];
      this.categories = [];
      this.credit = "";
      this.errorLine = e?.lineNumber;
    }
  }

  private parsePasses(passesArray: Array<Record<string, any>>): IsfPassDef[] {
    const passes: IsfPassDef[] = [];
    for (let i = 0; i < passesArray.length; ++i) {
      const passDefinition = passesArray[i];
      const pass: IsfPassDef = {
        persistent: !!passDefinition.PERSISTENT,
        width: passDefinition.WIDTH || "$WIDTH",
        height: passDefinition.HEIGHT || "$HEIGHT",
        float: !!passDefinition.FLOAT,
      };
      if (passDefinition.TARGET) pass.target = passDefinition.TARGET;
      passes.push(pass);
    }
    return passes;
  }

  private generateShaders(): void {
    this.uniformDefs = "";
    for (let i = 0; i < this.inputs.length; ++i) {
      this.addUniform(this.inputs[i]);
    }

    for (let i = 0; i < this.passes.length; ++i) {
      const target = this.passes[i].target;
      if (target) {
        this.addUniform({ NAME: target, TYPE: "image" });
      }
    }

    for (const k in this.imports) {
      if ({}.hasOwnProperty.call(this.imports, k)) {
        this.addUniform({ NAME: k, TYPE: "image" });
      }
    }

    this.fragmentShader = this.buildFragmentShader();
    this.vertexShader = this.buildVertexShader();
  }

  private addUniform(input: IsfInputHeader): void {
    const type = this.inputToType(input.TYPE);
    this.addUniformLine(`uniform ${type} ${input.NAME};`);
    if (type === "sampler2D") {
      this.addUniformLine(this.samplerUniforms(input));
    }
  }

  private addUniformLine(line: string): void {
    this.uniformDefs += `${line}\n`;
  }

  private samplerUniforms(input: IsfInputHeader): string {
    const name = input.NAME;
    let lines = "";
    lines += `uniform vec4 _${name}_imgRect;\n`;
    lines += `uniform vec2 _${name}_imgSize;\n`;
    lines += `uniform bool _${name}_flip;\n`;
    lines += `varying vec2 _${name}_normTexCoord;\n`;
    lines += `varying vec2 _${name}_texCoord;\n`;
    lines += "\n";
    return lines;
  }

  private buildFragmentShader(): string {
    const main = this.replaceSpecialFunctions(this.rawFragmentMain);
    return ISFParser.fragmentShaderSkeleton
      .replace("[[uniforms]]", this.uniformDefs)
      .replace("[[main]]", main);
  }

  private replaceSpecialFunctions(source: string): string {
    let regex: RegExp;

    // IMG_THIS_PIXEL
    regex = /IMG_THIS_PIXEL\((.+?)\)/g;
    source = source.replace(
      regex,
      (_fullMatch, innerMatch) => `texture2D(${innerMatch}, isf_FragNormCoord)`,
    );

    // IMG_THIS_NORM_PIXEL
    regex = /IMG_THIS_NORM_PIXEL\((.+?)\)/g;
    source = source.replace(
      regex,
      (_fullMatch, innerMatch) => `texture2D(${innerMatch}, isf_FragNormCoord)`,
    );

    // IMG_PIXEL
    regex = /IMG_PIXEL\((.+?)\)/g;
    source = source.replace(regex, (_fullMatch, innerMatch) => {
      const results = innerMatch.split(",");
      const sampler = results[0];
      const coord = results[1];
      return `texture2D(${sampler}, (${coord}) / RENDERSIZE)`;
    });

    // IMG_NORM_PIXEL
    regex = /IMG_NORM_PIXEL\((.+?)\)/g;
    source = source.replace(regex, (_fullMatch, innerMatch) => {
      const results = innerMatch.split(",");
      const sampler = results[0];
      const coord = results[1];
      return `VVSAMPLER_2DBYNORM(${sampler}, _${sampler}_imgRect, _${sampler}_imgSize, _${sampler}_flip, ${coord})`;
    });

    // IMG_SIZE
    regex = /IMG_SIZE\((.+?)\)/g;
    source = source.replace(regex, (_fullMatch, imgName) => {
      return `_${imgName}_imgSize`;
    });
    return source;
  }

  private buildVertexShader(): string {
    let functionLines = "\n";
    for (let i = 0; i < this.inputs.length; ++i) {
      const input = this.inputs[i];
      // PATCH 2: was `input.TYPE === 'image'` — see file header.
      if (SAMPLER_INPUT_TYPES.has(input.TYPE)) {
        functionLines += `${this.texCoordFunctions(input)}\n`;
      }
    }
    return ISFParser.vertexShaderSkeleton
      .replace("[[functions]]", functionLines)
      .replace("[[uniforms]]", this.uniformDefs)
      .replace("[[main]]", this.rawVertexShader);
  }

  private texCoordFunctions(input: IsfInputHeader): string {
    const name = input.NAME;
    return [
      "_[[name]]_texCoord =",
      "    vec2(((isf_fragCoord.x / _[[name]]_imgSize.x * _[[name]]_imgRect.z) + _[[name]]_imgRect.x), ",
      "          (isf_fragCoord.y / _[[name]]_imgSize.y * _[[name]]_imgRect.w) + _[[name]]_imgRect.y);",
      "",
      "_[[name]]_normTexCoord =",
      "  vec2((((isf_FragNormCoord.x * _[[name]]_imgSize.x) / _[[name]]_imgSize.x * _[[name]]_imgRect.z) + _[[name]]_imgRect.x),",
      "          ((isf_FragNormCoord.y * _[[name]]_imgSize.y) / _[[name]]_imgSize.y * _[[name]]_imgRect.w) + _[[name]]_imgRect.y);",
    ]
      .join("\n")
      .replace(/\[\[name\]\]/g, name);
  }

  private inferFilterType(): void {
    const any = (arr: IsfInputHeader[], test: (input: IsfInputHeader) => boolean) =>
      arr.filter(test).length > 0;
    const isFilter = any(this.inputs, (input) => input.TYPE === "image" && input.NAME === "inputImage");
    const isTransition =
      any(this.inputs, (input) => input.TYPE === "image" && input.NAME === "startImage") &&
      any(this.inputs, (input) => input.TYPE === "image" && input.NAME === "endImage") &&
      any(this.inputs, (input) => input.TYPE === "float" && input.NAME === "progress");
    if (isFilter) {
      this.type = "filter";
    } else if (isTransition) {
      this.type = "transition";
    } else {
      this.type = "generator";
    }
  }

  private inferISFVersion(): number {
    let v = 2;
    if (
      this.metadata.PERSISTENT_BUFFERS ||
      this.rawFragmentShader.indexOf("vv_FragNormCoord") !== -1 ||
      this.rawVertexShader.indexOf("vv_vertShaderInit") !== -1 ||
      this.rawVertexShader.indexOf("vv_FragNormCoord") !== -1
    ) {
      v = 1;
    }
    return v;
  }

  private inputToType(inputType: string): string {
    const type = typeUniformMap[inputType];
    if (!type) throw new Error(`Unknown input type [${inputType}]`);
    return type;
  }

  static readonly fragmentShaderSkeleton = `
precision highp float;
precision highp int;

uniform int PASSINDEX;
uniform vec2 RENDERSIZE;
varying vec2 isf_FragNormCoord;
varying vec2 isf_FragCoord;
uniform float TIME;
uniform float TIMEDELTA;
uniform int FRAMEINDEX;
uniform vec4 DATE;

[[uniforms]]

// We don't need 2DRect functions since we control all inputs.  Don't need flip either, but leaving
// for consistency sake.
vec4 VVSAMPLER_2DBYPIXEL(sampler2D sampler, vec4 samplerImgRect, vec2 samplerImgSize, bool samplerFlip, vec2 loc) {
  return (samplerFlip)
    ? texture2D   (sampler,vec2(((loc.x/samplerImgSize.x*samplerImgRect.z)+samplerImgRect.x), (samplerImgRect.w-(loc.y/samplerImgSize.y*samplerImgRect.w)+samplerImgRect.y)))
    : texture2D   (sampler,vec2(((loc.x/samplerImgSize.x*samplerImgRect.z)+samplerImgRect.x), ((loc.y/samplerImgSize.y*samplerImgRect.w)+samplerImgRect.y)));
}
vec4 VVSAMPLER_2DBYNORM(sampler2D sampler, vec4 samplerImgRect, vec2 samplerImgSize, bool samplerFlip, vec2 normLoc)  {
  vec4    returnMe = VVSAMPLER_2DBYPIXEL(   sampler,samplerImgRect,samplerImgSize,samplerFlip,vec2(normLoc.x*samplerImgSize.x, normLoc.y*samplerImgSize.y));
  return returnMe;
}

[[main]]

`;

  static readonly vertexShaderDefault = `
void main() {
  isf_vertShaderInit();
}
`;

  // PATCH 3: added the `varying vec2 isf_FragCoord;` declaration and its
  // assignment in isf_vertShaderInit() — see file header.
  static readonly vertexShaderSkeleton = `
precision highp float;
precision highp int;
void isf_vertShaderInit();

attribute vec2 isf_position; // -1..1

uniform int     PASSINDEX;
uniform vec2    RENDERSIZE;
varying vec2    isf_FragNormCoord; // 0..1
varying vec2    isf_FragCoord; // Pixel space (patched in — see ISFParser.ts header, patch 3)
vec2    isf_fragCoord; // Pixel Space

[[uniforms]]

[[main]]
void isf_vertShaderInit(void)  {
gl_Position = vec4( isf_position, 0.0, 1.0 );
  isf_FragNormCoord = vec2((gl_Position.x+1.0)/2.0, (gl_Position.y+1.0)/2.0);
  isf_fragCoord = floor(isf_FragNormCoord * RENDERSIZE);
  isf_FragCoord = isf_fragCoord;
  [[functions]]
}
`;
}

export default ISFParser;
