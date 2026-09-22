import { describe, it, expect } from "vitest";
import { setDeckAudioTime, getDeckTime } from "../renderer/seekBus";
import { resetPositionTracking } from "./positionPoll";

describe("resetPositionTracking", () => {
  // Live-hit 2026-09-22: an Auto DJ transition landed "Fasme - Carte Sim" 221s into its
  // 355s runtime instead of near the start. Root cause was this exact gap — a codec-path
  // deck's `audioTimes` entry (seekBus.ts) survived its own teardown+reload because the
  // only other thing that clears it, `unregisterVideoEl`, is reached solely through
  // `destroyLegacyVideoEl`, a documented no-op for decks with no `<video>` element.
  // `nudgePhaseToMaster`'s paused-seek branch then read the *previous* track's last polled
  // position via `getDeckTime()` and seeked the freshly loaded track there.
  it("clears seekBus's cached audio-clock position for the deck, not just contentPosTracker", () => {
    setDeckAudioTime("deck-0", 221.653);
    expect(getDeckTime("deck-0")).toBe(221.653);

    resetPositionTracking("deck-0");

    // No <video> el, no pending seek, no scrub target registered for this deck in the
    // test environment, so a properly cleared cache reports "unknown", not the stale value.
    expect(getDeckTime("deck-0")).toBeNull();
  });

  it("does not leak one deck's cleared position into another deck's cache", () => {
    setDeckAudioTime("deck-0", 221.653);
    setDeckAudioTime("deck-1", 42.0);

    resetPositionTracking("deck-0");

    expect(getDeckTime("deck-0")).toBeNull();
    expect(getDeckTime("deck-1")).toBe(42.0);
  });
});
