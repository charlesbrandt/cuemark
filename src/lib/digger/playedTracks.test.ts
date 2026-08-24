/**
 * "Played this session" tracking — a deck must be both playing AND audible on
 * the main output (volume above the dead-zone threshold) for a sustained
 * stretch before its track is marked played. A headphone-only preview (deck
 * playing but faded/cued out, volume ~0) must never mark a track played.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { updateDeck } from "../state/session";
import { playedTrackIds, isPlayed, clearPlayed, clearAllPlayed } from "./playedTracks";

const DECK = "deck-0";
const TRACK = 101;
const PLAYED_THRESHOLD_MS = 15_000;

function resetDeck() {
  updateDeck(DECK, {
    diggerTrackId: null,
    playing: false,
    volume: 1.0,
  });
}

// Forces the module's session-store subscriber to re-run its threshold check without
// changing anything real — stands in for the ordinary deck-state churn (gain nudges,
// EQ tweaks, etc.) that keeps a long-playing deck's check current in the real app.
// The module's own setInterval() fallback can't be exercised here: it's registered
// against real timers at import time, before any test's vi.useFakeTimers() runs.
function tick() {
  updateDeck(DECK, {});
}

beforeEach(() => {
  vi.useFakeTimers();
  clearAllPlayed();
  resetDeck();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("played-track tracking", () => {
  it("marks a track played once audible playback crosses the threshold", () => {
    updateDeck(DECK, { diggerTrackId: TRACK, playing: true, volume: 0.8 });
    expect(isPlayed(TRACK)).toBe(false);

    vi.advanceTimersByTime(PLAYED_THRESHOLD_MS + 1000);
    tick();

    expect(isPlayed(TRACK)).toBe(true);
  });

  it("never marks a track played while faded out (headphone-only preview)", () => {
    updateDeck(DECK, { diggerTrackId: TRACK, playing: true, volume: 0 });

    vi.advanceTimersByTime(60_000);
    tick();

    expect(isPlayed(TRACK)).toBe(false);
  });

  it("does not accumulate time while paused, even if volume is up", () => {
    updateDeck(DECK, { diggerTrackId: TRACK, playing: false, volume: 1.0 });

    vi.advanceTimersByTime(60_000);
    tick();

    expect(isPlayed(TRACK)).toBe(false);
  });

  it("resets accumulation when a different track loads before the threshold", () => {
    updateDeck(DECK, { diggerTrackId: TRACK, playing: true, volume: 1.0 });
    vi.advanceTimersByTime(10_000); // short preview, under threshold

    updateDeck(DECK, { diggerTrackId: 202, playing: true, volume: 1.0 });
    vi.advanceTimersByTime(10_000); // second track also under threshold on its own
    tick();

    expect(isPlayed(TRACK)).toBe(false);
    expect(isPlayed(202)).toBe(false);
  });

  it("clearPlayed removes just that track's marker", () => {
    updateDeck(DECK, { diggerTrackId: TRACK, playing: true, volume: 1.0 });
    vi.advanceTimersByTime(PLAYED_THRESHOLD_MS + 1000);
    tick();
    expect(isPlayed(TRACK)).toBe(true);

    clearPlayed(TRACK);

    expect(isPlayed(TRACK)).toBe(false);
  });

  it("clearAllPlayed empties the whole set", () => {
    updateDeck(DECK, { diggerTrackId: TRACK, playing: true, volume: 1.0 });
    vi.advanceTimersByTime(PLAYED_THRESHOLD_MS + 1000);
    tick();
    expect(playedTrackIds).toBeDefined();
    expect(isPlayed(TRACK)).toBe(true);

    clearAllPlayed();

    expect(isPlayed(TRACK)).toBe(false);
  });
});
