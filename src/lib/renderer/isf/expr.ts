/**
 * Tiny evaluator for ISF pass `WIDTH`/`HEIGHT` expressions ("$WIDTH/2",
 * "floor($WIDTH*$scale)"). Numbers, `$names`, `+ - * /`, unary minus,
 * parentheses and floor/ceil/round/abs/max/min. Hand-written on purpose:
 * plugins are data, so nothing here may reach `eval`/`new Function`.
 */
import { IsfError } from "./parser";

export type Expr =
  | { k: "num"; v: number }
  | { k: "var"; name: string }
  | { k: "neg"; a: Expr }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; a: Expr; b: Expr }
  | { k: "call"; fn: string; args: Expr[] };

const FUNCS: Record<string, (...a: number[]) => number> = {
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  abs: Math.abs,
  max: Math.max,
  min: Math.min,
};

export function parseExpr(src: string | number): Expr {
  if (typeof src === "number") return { k: "num", v: src };
  const text = String(src);
  let pos = 0;

  const fail = (msg: string): never => {
    throw new IsfError("parse", `pass size expression "${text}": ${msg}`);
  };
  const ws = () => {
    while (pos < text.length && /\s/.test(text[pos])) pos++;
  };
  const eat = (ch: string): boolean => {
    ws();
    if (text[pos] === ch) {
      pos++;
      return true;
    }
    return false;
  };

  function primary(): Expr {
    ws();
    const c = text[pos];
    if (c === undefined) return fail("unexpected end");
    if (c === "(") {
      pos++;
      const e = sum();
      if (!eat(")")) fail("missing ')'");
      return e;
    }
    if (c === "-") {
      pos++;
      return { k: "neg", a: primary() };
    }
    if (c === "+") {
      pos++;
      return primary();
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(text.slice(pos));
    if (num) {
      pos += num[0].length;
      return { k: "num", v: Number(num[0]) };
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_]\w*)/.exec(text.slice(pos));
      if (!m) return fail("bad $name");
      pos += m[0].length;
      return { k: "var", name: m[1] };
    }
    const id = /^[A-Za-z_]\w*/.exec(text.slice(pos));
    if (id) {
      pos += id[0].length;
      if (!(id[0] in FUNCS)) return fail(`unknown function '${id[0]}' (variables need a '$')`);
      if (!eat("(")) return fail(`'${id[0]}' needs arguments`);
      const args: Expr[] = [];
      if (!eat(")")) {
        do args.push(sum());
        while (eat(","));
        if (!eat(")")) fail("missing ')'");
      }
      if (args.length === 0) fail(`'${id[0]}' needs arguments`);
      return { k: "call", fn: id[0], args };
    }
    return fail(`unexpected '${c}'`);
  }

  function product(): Expr {
    let a = primary();
    for (;;) {
      ws();
      const op = text[pos];
      if (op !== "*" && op !== "/") return a;
      pos++;
      a = { k: "bin", op, a, b: primary() };
    }
  }

  function sum(): Expr {
    let a = product();
    for (;;) {
      ws();
      const op = text[pos];
      if (op !== "+" && op !== "-") return a;
      pos++;
      a = { k: "bin", op, a, b: product() };
    }
  }

  const e = sum();
  ws();
  if (pos < text.length) fail(`unexpected '${text[pos]}'`);
  return e;
}

export function exprNames(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.k) {
    case "var":
      out.add(e.name);
      break;
    case "neg":
      exprNames(e.a, out);
      break;
    case "bin":
      exprNames(e.a, out);
      exprNames(e.b, out);
      break;
    case "call":
      for (const a of e.args) exprNames(a, out);
      break;
  }
  return out;
}

/** Unknown names evaluate to 0; the caller validates names up front via `exprNames`. */
export function evalExpr(e: Expr, vars: Record<string, number>): number {
  switch (e.k) {
    case "num":
      return e.v;
    case "var":
      return vars[e.name] ?? 0;
    case "neg":
      return -evalExpr(e.a, vars);
    case "bin": {
      const a = evalExpr(e.a, vars);
      const b = evalExpr(e.b, vars);
      return e.op === "+" ? a + b : e.op === "-" ? a - b : e.op === "*" ? a * b : a / b;
    }
    case "call":
      return FUNCS[e.fn](...e.args.map((a) => evalExpr(a, vars)));
  }
}
