import { describe, it, expect } from "vitest";
import { decodePcm, pluginWantsPcm, PCM_FRAME_BYTES } from "./vizPcm";
import { packPcmRows, PCM_LEN, PCM_ROWS } from "../renderer/isf/instance";
import { parseIsf } from "../renderer/isf/parser";
import waveSrc from "../renderer/isf/testplugins/waveform.fs?raw";
import fftSrc from "../renderer/isf/testplugins/fft-bars.fs?raw";

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

describe("decodePcm", () => {
  it("round-trips a frame", () => {
    const f = new Uint8Array(PCM_FRAME_BYTES).map((_, i) => i % 251);
    expect(Array.from(decodePcm(b64(f))!)).toEqual(Array.from(f));
  });
  it("rejects wrong sizes and garbage", () => {
    expect(decodePcm(b64(new Uint8Array(10)))).toBeNull();
    expect(decodePcm("!!!not base64!!!")).toBeNull();
  });
});

describe("pluginWantsPcm", () => {
  const plugin = (source: string) => ({ id: "x", format: "isf" as const, source, assets: {} });
  it("is true only for an `audio` input, not audioFFT", () => {
    expect(pluginWantsPcm(plugin(waveSrc))).toBe(true);
    expect(pluginWantsPcm(plugin(fftSrc))).toBe(false);
    expect(pluginWantsPcm(null)).toBe(false);
  });
});

describe("packPcmRows", () => {
  it("takes the left and right blocks and leaves the mono block out", () => {
    const f = new Uint8Array(PCM_LEN * 3);
    f.fill(10, 0, PCM_LEN); // mono
    f.fill(20, PCM_LEN, PCM_LEN * 2); // left
    f.fill(30, PCM_LEN * 2); // right
    const rows = packPcmRows(f);
    expect(rows.length).toBe(PCM_LEN * PCM_ROWS);
    expect(rows[0]).toBe(20);
    expect(rows[PCM_LEN - 1]).toBe(20);
    expect(rows[PCM_LEN]).toBe(30);
    expect(rows[PCM_LEN * 2 - 1]).toBe(30);
  });
  it("is a flat centred waveform without data", () => {
    expect(new Set(packPcmRows(undefined))).toEqual(new Set([128]));
    expect(new Set(packPcmRows(new Uint8Array(5)))).toEqual(new Set([128]));
  });
});

describe("waveform sample plugin", () => {
  it("parses and declares the audio input as a sampler2D", () => {
    const parsed = parseIsf(waveSrc);
    expect(parsed.inputs.map((i) => [i.NAME, i.TYPE])).toEqual([["wave", "audio"]]);
    expect(parsed.fragmentShader).toMatch(/uniform sampler2D wave;/);
  });
});
