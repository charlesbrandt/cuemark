/*
  MetadataExtractor.ts

  Vendored from `interactive-shader-format@2.8.1` (npm, ISC) /
  msfeldstein/interactive-shader-format-js (GitHub, relicensed MIT
  2025-12-31), `src/MetadataExtractor.js`. See ../NOTICE for the full
  upstream licence text and attribution.

  Extracts and parses the leading `/*{ ... }*​/` JSON header of an ISF
  fragment shader.

  Local patches (cuemark, 2026-09):
  - Converted from CommonJS (`export default function(){...}`, which the
    original file actually already spelled as an ES `export default`, but the
    `require`-style `import jsonParse from '../vendor/json_parse'` pointed at
    a CommonJS file) to a plain ES module import of the local
    `./json_parse.ts` (see that file's own patch notes).
  - No other logic changes: this file is otherwise byte-for-byte the same
    algorithm as upstream (find the first balanced `/* ... *​/` comment via
    regex, parse its contents as JSON, throw a descriptive error with
    line/column on failure).
*/

import jsonParse from "./json_parse";

const METADATA_ERROR_PREFIX = "Something is wrong with your ISF metadata";

export interface MetadataExtractorResult {
  objectValue: Record<string, any>;
  stringValue: string;
  startIndex: number;
  endIndex: number;
}

export default function MetadataExtractor(rawFragmentShader: string): MetadataExtractorResult {
  // First pull out the comment JSON to get the metadata.
  // This regex (should) match quotes in the form /* */.
  const regex = /\*([^*]|[\r\n]|(\*+([^*/]|[\r\n])))*\*+/;
  const results = regex.exec(rawFragmentShader);

  if (!results) {
    throw new Error("There is no metadata here.");
  }

  let metadataString = results[0];
  metadataString = metadataString.substring(1, metadataString.length - 1);
  let metadata: Record<string, any>;
  try {
    metadata = jsonParse(metadataString);
  } catch (e: any) {
    const loc = e?.at;
    const message = e?.message || "Invalid JSON";
    if (loc) {
      const lines = (metadataString || "").substring(0, loc).split(/\r\n|\r|\n/);
      const lineNumber = lines.length;
      const position = lines[lineNumber - 1].length;
      const errorText = `${METADATA_ERROR_PREFIX}: ${message}\
        at line ${lineNumber} and position ${position}`;
      const enrichedError: any = new Error(errorText);
      enrichedError.lineNumber = lineNumber;
      enrichedError.position = position;
      throw enrichedError;
    }
    throw new Error(`${METADATA_ERROR_PREFIX}: ${message}`);
  }

  const startIndex = rawFragmentShader.indexOf("/*");
  const endIndex = rawFragmentShader.indexOf("*/");
  return {
    objectValue: metadata,
    stringValue: metadataString,
    startIndex,
    endIndex,
  };
}
