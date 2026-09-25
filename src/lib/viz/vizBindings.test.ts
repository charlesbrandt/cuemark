import { describe, it, expect } from "vitest";
import {
  routeAudio, computeBindings, effectiveDeckGain, BINDING_NAMES, FFT_BANDS,
  type DeckAudioSample,
} from "./vizBindings";

const deck = (id: string, v: number, gain: number, o: Partial<DeckAudioSample> = {}): DeckAudioSample => ({
  deckId: id, bands: new Array(FFT_BANDS).fill(v), bass: v, mid: v, high: v,
  gain, cueEnabled: false, playing: true, ...o,
});
const opts = { crossfaderPos: 0.5, crossfaderLeftId: "a", crossfaderRightId: "b" };

describe("routeAudio", () => {
  it("mix weights by gain: hard left", () => {
    const g = (id: string) => effectiveDeckGain({ deckId: id, volume: 1, masterVolume: 1, crossfaderPos: 0,
      crossfaderLeftId: "a", crossfaderRightId: "b", audioCurve: "linear", crossfaderInVolume: false });
    const r = routeAudio("mix", [deck("a", 0.8, g("a")), deck("b", 1, g("b"))], { ...opts, crossfaderPos: 0 });
    expect(r.bass).toBeCloseTo(0.8);
    expect(r.dominantDeckId).toBe("a");
  });
  it("mix weights by gain: hard right", () => {
    const g = (id: string) => effectiveDeckGain({ deckId: id, volume: 1, masterVolume: 0.5, crossfaderPos: 1,
      crossfaderLeftId: "a", crossfaderRightId: "b", audioCurve: "equal-power", crossfaderInVolume: false });
    const r = routeAudio("mix", [deck("a", 1, g("a")), deck("b", 0.6, g("b"))], { ...opts, crossfaderPos: 1 });
    expect(r.bands[0]).toBeCloseTo(0.3);
    expect(r.dominantDeckId).toBe("b");
    expect(r.level).toBeCloseTo(0.3);
  });
  it("deck:<id> ignores gain and paused state", () => {
    const r = routeAudio("deck:a", [deck("a", 0.7, 0, { playing: false }), deck("b", 1, 1)], opts);
    expect(r.bass).toBeCloseTo(0.7);
    expect(r.dominantDeckId).toBe("a");
  });
  it("cue keeps only cueEnabled decks, unweighted", () => {
    const r = routeAudio("cue", [deck("a", 0.4, 0.1, { cueEnabled: true }), deck("b", 1, 1)], opts);
    expect(r.bass).toBeCloseTo(0.4);
  });
  it("paused decks are excluded from mix and dominance", () => {
    const r = routeAudio("mix", [deck("a", 1, 1, { playing: false }), deck("b", 0.5, 0.5)], opts);
    expect(r.bass).toBeCloseTo(0.25);
    expect(r.dominantDeckId).toBe("b");
    const none = routeAudio("mix", [deck("a", 1, 1, { playing: false })], opts);
    expect(none.dominantDeckId).toBeNull();
    expect(none.level).toBe(0);
  });
  it("dominance tie goes to the crossfader side", () => {
    const ds = [deck("a", 1, 0.5), deck("b", 1, 0.5)];
    expect(routeAudio("mix", ds, { ...opts, crossfaderPos: 0.2 }).dominantDeckId).toBe("a");
    expect(routeAudio("mix", ds, { ...opts, crossfaderPos: 0.8 }).dominantDeckId).toBe("b");
  });
  it("empty bands give zeros of length 32", () => {
    const r = routeAudio("mix", [deck("a", 0, 1, { bands: [] })], opts);
    expect(r.bands).toHaveLength(FFT_BANDS);
    expect(r.bands.every((x) => x === 0)).toBe(true);
  });
});

describe("computeBindings", () => {
  const routed = routeAudio("mix", [deck("a", 0.5, 1)], opts);
  it("null beatPhase -> 0 and hasBeatGrid 0", () => {
    const b = computeBindings(routed, { beatPhase: null, bpm: 120, trackProgress: 0.1, inMixOut: 0, crossfader: 0.5, liked: true });
    expect(b.beatPhase).toBe(0);
    expect(b.hasBeatGrid).toBe(0);
    expect(b.liked).toBe(1);
    expect(Object.keys(b).sort()).toEqual([...BINDING_NAMES].sort());
  });
  it("beatPhase present", () => {
    const b = computeBindings(routed, { beatPhase: 0.25, bpm: 0, trackProgress: 0, inMixOut: 0, crossfader: 0, liked: false });
    expect(b.beatPhase).toBe(0.25);
    expect(b.hasBeatGrid).toBe(1);
  });
});
