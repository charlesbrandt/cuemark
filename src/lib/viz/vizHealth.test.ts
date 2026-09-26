import { describe, expect, it } from "vitest";
import { missingImports, importedWarning, chooseFallback, fallbackNote } from "./vizHealth";

const withImport = `/*{ "ISFVSN": "2", "IMPORTED": { "noise": { "PATH": "noise.png" } }, "INPUTS": [] }*/
void main(){}`;
const plain = `/*{ "ISFVSN": "2", "INPUTS": [] }*/ void main(){}`;

describe("missingImports", () => {
  it("is empty without IMPORTED", () => expect(missingImports(plain, {})).toEqual([]));
  it("reports everything for a bare file (no assets)", () =>
    expect(missingImports(withImport, {})).toEqual(["noise.png"]));
  it("is satisfied by a folder asset, case-insensitively", () =>
    expect(missingImports(withImport, { "Noise.PNG": "/x/Noise.PNG" })).toEqual([]));
  it("handles the string form and unparsable headers", () => {
    expect(missingImports(`/*{ "IMPORTED": { "a": "tex/a.png" } }*/`, {})).toEqual(["tex/a.png"]);
    expect(missingImports(`/* {oops */`, {})).toEqual([]);
  });
});

describe("importedWarning", () => {
  it("names the bare-file cause", () =>
    expect(importedWarning("x.fs", withImport, {})).toMatch(/single \.fs file/));
  it("names the folder cause", () =>
    expect(importedWarning("f/x.fs", withImport, {})).toMatch(/not in its folder/));
  it("is null when fine", () => expect(importedWarning("x.fs", plain, {})).toBeNull());
});

describe("fallback", () => {
  it("never falls back for built-ins", () =>
    expect(chooseFallback("builtin:plasma", "boom", "builtin:plasma")).toBeNull());
  it("falls back for disk plugins and keeps the requested id", () => {
    const f = chooseFallback("gone.fs", "read: nope", "builtin:plasma")!;
    expect(f).toMatchObject({ requestedId: "gone.fs", usingId: "builtin:plasma" });
    expect(fallbackNote(f, () => "Plasma")).toContain("Showing Plasma instead");
  });
});
