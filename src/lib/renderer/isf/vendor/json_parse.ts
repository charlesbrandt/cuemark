/*
  json_parse.ts

  Vendored from `interactive-shader-format@2.8.1`'s `vendor/json_parse.js`
  (itself Douglas Crockford's public-domain `json_parse.js`, 2016-05-02,
  <https://github.com/douglascrockford/JSON-js>). Used by MetadataExtractor.ts
  to parse an ISF shader's leading `/*{ ... }*​/` JSON header.

  Local patches (cuemark, 2026-09):
  - Converted from a CommonJS `module.exports = (function(){...}())` wrapper to
    an ES module default export, so it loads under Vite and vitest without a
    CommonJS interop shim. No parsing logic was changed.
  - Added TypeScript types (`unknown`/`any` where the original was untyped
    vanilla JS); behavior is unchanged from upstream.
  - Added a handful of `(ch as string)` casts (see inline comments at each
    site) where this project's strict tsconfig narrows the shared `ch`
    variable to a literal type from an outer equality check and does not
    invalidate that narrowing across a call to a sibling nested function
    (`next()`) that reassigns it — a real TS control-flow-analysis gap for
    this exact closure shape, not a change to the parsing algorithm.

  No functional difference from `JSON.parse` for well-formed ISF headers,
  except this parser rejects an object with a duplicate key (upstream
  behavior, kept as-is) where `JSON.parse` would silently keep the last one.

  Public domain (per upstream header below) / used here under the same terms
  as the rest of this vendor directory — see ../NOTICE.
*/

/* eslint-disable */

type Reviver = (this: any, key: string, value: any) => any;

export default function jsonParse(source: string, reviver?: Reviver): any {
  "use strict";

  let at: number; // The index of the current character
  let ch: string; // The current character
  const escapee: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  };
  let text: string;

  function error(m: string): never {
    throw {
      name: "SyntaxError",
      message: m,
      at: at,
      text: text,
    };
  }

  function next(c?: string): string {
    if (c && c !== ch) {
      error("Expected '" + c + "' instead of '" + ch + "'");
    }
    ch = text.charAt(at);
    at += 1;
    return ch;
  }

  function number(): number {
    let value: number;
    let string = "";

    if (ch === "-") {
      string = "-";
      next("-");
    }
    while (ch >= "0" && ch <= "9") {
      string += ch;
      next();
    }
    if (ch === ".") {
      string += ".";
      while (next() && ch >= "0" && ch <= "9") {
        string += ch;
      }
    }
    if (ch === "e" || ch === "E") {
      string += ch;
      next();
      // TS narrows `ch` to `"e" | "E"` from the outer check above and does
      // not invalidate that narrowing across the `next()` call in between
      // (a known TS control-flow-analysis limitation for this exact
      // Crockford-parser shape: a sibling nested function reassigning a
      // closed-over `let`). The cast below is a type-level no-op — `ch` is
      // genuinely `string` again after `next()` reassigns it at runtime —
      // added only to satisfy `tsc`, not a behavior change.
      if ((ch as string) === "-" || (ch as string) === "+") {
        string += ch;
        next();
      }
      while (ch >= "0" && ch <= "9") {
        string += ch;
        next();
      }
    }
    value = +string;
    if (!isFinite(value)) {
      error("Bad number");
    }
    return value!;
  }

  function string(): string {
    let hex: number;
    let i: number;
    let value = "";
    let uffff: number;

    if (ch === '"') {
      while (next()) {
        if (ch === '"') {
          next();
          return value;
        }
        if (ch === "\\") {
          next();
          if (ch === "u") {
            uffff = 0;
            for (i = 0; i < 4; i += 1) {
              hex = parseInt(next(), 16);
              if (!isFinite(hex)) {
                break;
              }
              uffff = uffff * 16 + hex;
            }
            value += String.fromCharCode(uffff);
          } else if (typeof escapee[ch] === "string") {
            value += escapee[ch];
          } else {
            break;
          }
        } else {
          value += ch;
        }
      }
    }
    error("Bad string");
  }

  function white(): void {
    while (ch && ch <= " ") {
      next();
    }
  }

  function word(): boolean | null {
    switch (ch) {
      case "t":
        next("t");
        next("r");
        next("u");
        next("e");
        return true;
      case "f":
        next("f");
        next("a");
        next("l");
        next("s");
        next("e");
        return false;
      case "n":
        next("n");
        next("u");
        next("l");
        next("l");
        return null;
    }
    error("Unexpected '" + ch + "'");
  }

  function array(): any[] {
    const arr: any[] = [];

    if (ch === "[") {
      next("[");
      white();
      // See the `(ch as string)` note in number() above — same TS
      // control-flow-narrowing gap, same no-op cast.
      if ((ch as string) === "]") {
        next("]");
        return arr;
      }
      while (ch) {
        arr.push(value());
        white();
        if ((ch as string) === "]") {
          next("]");
          return arr;
        }
        next(",");
        white();
      }
    }
    error("Bad array");
  }

  function object(): Record<string, any> {
    let key: string;
    const obj: Record<string, any> = {};

    if (ch === "{") {
      next("{");
      white();
      // See the `(ch as string)` note in number() above — same TS
      // control-flow-narrowing gap, same no-op cast.
      if ((ch as string) === "}") {
        next("}");
        return obj;
      }
      while (ch) {
        key = string();
        white();
        next(":");
        if (Object.hasOwnProperty.call(obj, key)) {
          error("Duplicate key '" + key + "'");
        }
        obj[key] = value();
        white();
        if ((ch as string) === "}") {
          next("}");
          return obj;
        }
        next(",");
        white();
      }
    }
    error("Bad object");
  }

  function value(): any {
    white();
    switch (ch) {
      case "{":
        return object();
      case "[":
        return array();
      case '"':
        return string();
      case "-":
        return number();
      default:
        return ch >= "0" && ch <= "9" ? number() : word();
    }
  }

  text = source;
  at = 0;
  ch = " ";
  const result = value();
  white();
  if (ch) {
    error("Syntax error");
  }

  return typeof reviver === "function"
    ? (function walk(holder: any, key: string): any {
        let k: string;
        let v: any;
        const val = holder[key];
        if (val && typeof val === "object") {
          for (k in val) {
            if (Object.prototype.hasOwnProperty.call(val, k)) {
              v = walk(val, k);
              if (v !== undefined) {
                val[k] = v;
              } else {
                delete val[k];
              }
            }
          }
        }
        return reviver.call(holder, key, val);
      })({ "": result }, "")
    : result;
}
