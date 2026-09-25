// Cuemark visualization bindings + audio routing (docs/design/visualization-plugins.md,
// "Cuemark bindings" and "Routing"). Pure functions; the caller supplies all state.
import { applyCurve } from "../state/session";
import type { CrossfaderCurve } from "../state/types";

export const FFT_BANDS = 32;

export interface DeckAudioSample {
  deckId: string;
  bands: number[]; // up to 32 values 0-1 (may be empty)
  bass: number;
  mid: number;
  high: number;
  gain: number; // effective audible gain, 0-1 (see effectiveDeckGain)
  cueEnabled: boolean;
  playing: boolean;
}

export interface RoutedAudio {
  bands: number[]; // always length FFT_BANDS
  bass: number;
  mid: number;
  high: number;
  level: number; // mean of bands
  dominantDeckId: string | null;
  dominantGain: number;
}

export interface RouteOpts {
  crossfaderPos: number; // 0..1
  crossfaderLeftId?: string;
  crossfaderRightId?: string;
}

/**
 * Effective audible gain of one deck: deck volume x crossfader audio gain x master.
 * Reuses session.ts's applyCurve (the same function setCrossfader uses).
 *
 * NOTE: setCrossfader() already writes the crossfader gain INTO deck.volume when
 * crossfaderTargets includes "volume", so pass crossfaderInVolume=true (default) in that
 * case and the curve is NOT applied a second time. Pass false only if deck.volume is a
 * pure channel fader with the crossfader applied separately.
 */
export function effectiveDeckGain(p: {
  deckId: string;
  volume: number;
  masterVolume: number;
  crossfaderPos: number;
  crossfaderLeftId?: string;
  crossfaderRightId?: string;
  audioCurve: CrossfaderCurve;
  crossfaderInVolume?: boolean;
}): number {
  let xf = 1;
  if (p.crossfaderInVolume === false) {
    const [l, r] = applyCurve(p.crossfaderPos, p.audioCurve);
    if (p.deckId === p.crossfaderLeftId) xf = l;
    else if (p.deckId === p.crossfaderRightId) xf = r;
  }
  return clamp01(p.volume * xf * p.masterVolume);
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function bandsOf(d: DeckAudioSample): number[] {
  const out = new Array<number>(FFT_BANDS).fill(0);
  for (let i = 0; i < FFT_BANDS && i < d.bands.length; i++) out[i] = clamp01(d.bands[i]);
  return out;
}

function pickDominant(audible: DeckAudioSample[], opts: RouteOpts): DeckAudioSample | null {
  const sideId = opts.crossfaderPos >= 0.5 ? opts.crossfaderRightId : opts.crossfaderLeftId;
  let best: DeckAudioSample | null = null;
  for (const d of audible) {
    if (
      best === null ||
      d.gain > best.gain ||
      (d.gain === best.gain && d.deckId === sideId && best.deckId !== sideId)
    ) {
      best = d;
    }
  }
  return best;
}

export function routeAudio(source: string, decks: DeckAudioSample[], opts: RouteOpts): RoutedAudio {
  const single = source.startsWith("deck:");
  let set: DeckAudioSample[];
  let weighted = false;
  if (single) {
    const id = source.slice(5);
    set = decks.filter((d) => d.deckId === id); // ignores gain and paused state
  } else if (source === "cue") {
    set = decks.filter((d) => d.playing && d.cueEnabled);
  } else {
    set = decks.filter((d) => d.playing);
    weighted = true;
  }

  const bands = new Array<number>(FFT_BANDS).fill(0);
  let bass = 0, mid = 0, high = 0;
  for (const d of set) {
    const w = weighted ? clamp01(d.gain) : 1;
    const b = bandsOf(d);
    for (let i = 0; i < FFT_BANDS; i++) bands[i] = Math.max(bands[i], b[i] * w);
    bass = Math.max(bass, clamp01(d.bass) * w);
    mid = Math.max(mid, clamp01(d.mid) * w);
    high = Math.max(high, clamp01(d.high) * w);
  }
  const level = bands.reduce((a, b) => a + b, 0) / FFT_BANDS;

  // Dominance among the routed decks ('deck:<id>' -> that deck).
  const dom = single ? (set[0] ?? null) : pickDominant(set, opts);
  return {
    bands, bass, mid, high, level,
    dominantDeckId: dom ? dom.deckId : null,
    dominantGain: dom ? dom.gain : 0,
  };
}

export const BINDING_NAMES: readonly string[] = [
  "bass", "mid", "high", "level", "beatPhase", "hasBeatGrid",
  "bpm", "trackProgress", "inMixOut", "crossfader", "liked",
];

/**
 * `bpm` meta: deck.bpm is the track's NATIVE bpm and does NOT include playbackRate
 * (session.ts computes the effective tempo as deck.bpm * deck.playbackRate), so the
 * caller must pass dominantDeck.bpm * dominantDeck.playbackRate (0 if unknown).
 */
export function computeBindings(
  routed: RoutedAudio,
  meta: {
    beatPhase: number | null; bpm: number; trackProgress: number;
    inMixOut: number; crossfader: number; liked: boolean;
  },
): Record<string, number> {
  return {
    bass: routed.bass,
    mid: routed.mid,
    high: routed.high,
    level: routed.level,
    beatPhase: meta.beatPhase === null ? 0 : meta.beatPhase,
    hasBeatGrid: meta.beatPhase !== null ? 1 : 0,
    bpm: meta.bpm,
    trackProgress: meta.trackProgress,
    inMixOut: meta.inMixOut,
    crossfader: meta.crossfader,
    liked: meta.liked ? 1 : 0,
  };
}
