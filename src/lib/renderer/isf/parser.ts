/**
 * Typed wrapper around the vendored ISF parser (`./vendor/ISFParser.ts`).
 * Nothing outside `src/lib/renderer/isf/` should import from `./vendor/`
 * directly — this file and `IsfError` are the public surface.
 *
 * See `docs/design/visualization-plugins.md` ("Rendering architecture → ISF
 * renderer") for the design this implements.
 */
import { ISFParser, type IsfInputHeader, type IsfPassDef } from "./vendor/ISFParser";

export type IsfErrorStage = "parse" | "compile" | "link" | "unsupported" | "runtime";

export class IsfError extends Error {
  readonly stage: IsfErrorStage;

  constructor(stage: IsfErrorStage, message: string) {
    super(message);
    this.name = "IsfError";
    this.stage = stage;
  }
}

/**
 * One ISF `INPUTS[]` header entry. Keeps every key the raw JSON header
 * declared (`this.inputs = metadata.INPUTS` in the vendored parser passes
 * the parsed objects through untouched — verified by reading `ISFParser.ts`
 * and covered by `isf.test.ts`'s CUEMARK_BIND-preservation case), plus
 * cuemark's own `CUEMARK_BIND` extension key (see the design doc's
 * "Cuemark bindings" section) typed explicitly since every consumer needs it.
 */
export interface IsfInput extends IsfInputHeader {
  NAME: string;
  TYPE: string;
  DEFAULT?: unknown;
  MIN?: unknown;
  MAX?: unknown;
  VALUES?: unknown[];
  LABELS?: string[];
  IDENTITY?: unknown;
  CUEMARK_BIND?: string;
}

export type IsfPass = IsfPassDef;

export interface ParsedIsf {
  fragmentShader: string;
  vertexShader: string;
  inputs: IsfInput[];
  passes: IsfPass[];
  type: "filter" | "transition" | "generator";
  metadata: {
    description?: string;
    credit?: string;
    categories?: string[];
    isfvsn?: number;
  };
}

/**
 * Parses an ISF fragment shader (with the JSON header comment) plus an
 * optional companion vertex shader. Throws `IsfError` with `stage: 'parse'`
 * on any failure — malformed JSON header, unknown INPUTS TYPE, or a shader
 * with no header comment at all.
 */
export function parseIsf(fragSrc: string, vertSrc?: string): ParsedIsf {
  const parser = new ISFParser();
  parser.parse(fragSrc, vertSrc);

  if (!parser.valid) {
    throw new IsfError("parse", describeParseError(parser.error));
  }

  return {
    fragmentShader: parser.fragmentShader,
    vertexShader: parser.vertexShader,
    inputs: parser.inputs as IsfInput[],
    passes: parser.passes,
    type: parser.type,
    metadata: {
      description: parser.description || undefined,
      credit: parser.credit || undefined,
      categories: parser.categories?.length ? parser.categories : undefined,
      isfvsn: parser.isfVersion,
    },
  };
}

function describeParseError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Failed to parse ISF shader";
}
