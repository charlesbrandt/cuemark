import { describe, expect, it } from "vitest";
import { evalExpr, exprNames, parseExpr } from "./expr";
import { IsfError } from "./parser";

const ev = (s: string | number, vars: Record<string, number> = {}) => evalExpr(parseExpr(s), vars);

describe("pass size expressions", () => {
  it("handles numbers, precedence and parentheses", () => {
    expect(ev(64)).toBe(64);
    expect(ev("2+3*4")).toBe(14);
    expect(ev("(2+3)*4")).toBe(20);
    expect(ev("10-4-3")).toBe(3);
    expect(ev("-2*3")).toBe(-6);
    expect(ev("$WIDTH/2", { WIDTH: 1920 })).toBe(960);
  });
  it("evaluates the allowed functions with $names", () => {
    expect(ev("floor($WIDTH*$scale)", { WIDTH: 1920, scale: 0.3333 })).toBe(639);
    expect(ev("max(16, min($WIDTH/8, 100))", { WIDTH: 1920 })).toBe(100);
    expect(ev("ceil(1.2)")).toBe(2);
  });
  it("reports referenced names", () => {
    expect([...exprNames(parseExpr("floor($WIDTH*$scale)/$HEIGHT"))].sort()).toEqual(["HEIGHT", "WIDTH", "scale"]);
  });
  it("rejects anything that is not arithmetic", () => {
    for (const bad of ["", "1+", "(1", "alert(1)", "constructor", "$", "1 2", "WIDTH/2", "floor()"]) {
      expect(() => parseExpr(bad), bad).toThrow(IsfError);
    }
  });
});
