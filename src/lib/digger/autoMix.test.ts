/**
 * Auto DJ phase 1 (docs/design/auto-dj-transitions.md): the near-end trigger's gating logic,
 * and the crossfade ramp's progression/interruption behavior. requestAnimationFrame doesn't
 * exist under vitest's node environment, so each test stubs it (and performance.now) to a
 * manually-driven queue before importing a fresh copy of the module — mirrors perfArm.test.ts's
 * `loadSweep()` pattern, needed here because the ramp driver self-schedules its own frames
 * rather than being stepped by an external caller like perfArm's `advanceSweep` is.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import type { Session, Deck } from '../state/types';

// checkAutoPreloadTrigger's network/side-effect calls, isolated the same way
// autoDj.test.ts isolates handleDeckEos's — see that file's header comment.
const getQueue = vi.fn();
const queueNext = vi.fn();
const removeFromQueue = vi.fn().mockResolvedValue(undefined);
vi.mock('./api', () => ({ getQueue: (...a: unknown[]) => getQueue(...a), queueNext: (...a: unknown[]) => queueNext(...a), removeFromQueue: (...a: unknown[]) => removeFromQueue(...a) }));

const loadQueueItemToDeck = vi.fn().mockResolvedValue(undefined);
vi.mock('./queueStore', () => ({ loadQueueItemToDeck: (...a: unknown[]) => loadQueueItemToDeck(...a) }));

const isPlayed = vi.fn().mockReturnValue(false);
const isSkipped = vi.fn().mockReturnValue(false);
const markSkipped = vi.fn();
vi.mock('./playedTracks', () => ({
  isPlayed: (...a: unknown[]) => isPlayed(...a),
  isSkipped: (...a: unknown[]) => isSkipped(...a),
  markSkipped: (...a: unknown[]) => markSkipped(...a),
}));

const nudgePhaseToMaster = vi.fn();
vi.mock('../audio/phaseNudge', () => ({ nudgePhaseToMaster: (...a: unknown[]) => nudgePhaseToMaster(...a) }));

// previewTransition seeks both decks before running the real ramp; seekDeck reaches
// GStreamer over IPC, which doesn't exist here.
const seekDeck = vi.fn();
vi.mock('../renderer/seekBus', () => ({ seekDeck: (...a: unknown[]) => seekDeck(...a) }));

vi.mock('../debugLog', () => ({ debugLog: vi.fn() }));

function baseDeck(id: string, overrides: Partial<Deck> = {}): Deck {
  return {
    id,
    source: null,
    playing: false,
    playbackRate: 1.0,
    gain: 1.0,
    volume: 1.0,
    opacity: 1.0,
    loop: false,
    cuePoint: 0,
    hotCues: [],
    bpm: null,
    downbeat: null,
    mixOutStart: null,
    mixOutEnd: null,
    mixInStart: null,
    mixInEnd: null,
    diggerTrackId: null,
    diggerFileId: null,
    loopIn: null,
    loopOut: null,
    eq: { low: 0, mid: 0, high: 0 },
    filter: 0,
    cueEnabled: false,
    syncLocked: false,
    ...overrides,
  };
}

function videoSource(filePath: string, duration: number) {
  return { type: 'video' as const, filePath, duration };
}

type RafCb = (t: number) => void;

async function setup() {
  const rafQueue: RafCb[] = [];
  const now = { t: 0 };
  vi.resetModules();
  vi.stubGlobal('requestAnimationFrame', (cb: RafCb) => { rafQueue.push(cb); return rafQueue.length; });
  vi.stubGlobal('cancelAnimationFrame', (_id: number) => {});
  vi.spyOn(performance, 'now').mockImplementation(() => now.t);

  const sessionMod = await import('../state/session');
  const autoDjMod = await import('./autoDj');
  const autoMixMod = await import('./autoMix');

  function resetSession(decks: Deck[], overrides: Partial<Session> = {}) {
    const s: Session = {
      decks,
      masterVolume: 1.0,
      bpm: null,
      masterDeckId: null,
      crossfaderMapping: { left: 'deck-0', right: 'deck-1' },
      midiMapping: {},
      crossfaderValue: 0,
      crossfaderTargets: ['opacity', 'volume'],
      audioCurve: 'linear',
      visualCurve: 'linear',
      snapToBeat: false,
      compactControls: false,
      effects: [],
      visualization: null,
      visualizationOpacity: 0.5,
      ...overrides,
    };
    sessionMod.session.set(s);
  }

  /** Advance the fake clock and run exactly the frames already queued (not ones they queue next). */
  function driveFrame(deltaMs: number) {
    now.t += deltaMs;
    const batch = rafQueue.splice(0, rafQueue.length);
    for (const cb of batch) cb(now.t);
  }

  /** Drive frames until the ramp stops scheduling more (completed or aborted), bounded. */
  function runToCompletion(stepMs = 50, maxSteps = 200) {
    let i = 0;
    while (rafQueue.length > 0 && i < maxSteps) {
      driveFrame(stepMs);
      i++;
    }
  }

  return { sessionMod, autoDjMod, autoMixMod, resetSession, driveFrame, runToCompletion, now, rafQueue };
}

// vi.restoreAllMocks() below clears implementations (not just call history) off the plain
// vi.fn() mocks too, not just the raf/performance.now spies it was written for — re-arm the
// network mocks' resolved-value defaults before every test rather than relying on the
// module-level .mockResolvedValue() calls above surviving past the first test.
beforeEach(() => {
  getQueue.mockReset();
  queueNext.mockReset();
  removeFromQueue.mockReset().mockResolvedValue(undefined);
  loadQueueItemToDeck.mockReset().mockResolvedValue(undefined);
  isPlayed.mockReset().mockReturnValue(false);
  isSkipped.mockReset().mockReturnValue(false);
  markSkipped.mockReset();
  nudgePhaseToMaster.mockReset();
  seekDeck.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('checkAutoMixTrigger', () => {
  it('does nothing when Auto DJ is off', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(false);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 95);

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
  });

  it('ignores a deck not named in crossfaderMapping', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
      baseDeck('deck-2', { playing: true, source: videoSource('c.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-2', 95);

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
  });

  it('does nothing while the outgoing deck is not playing', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    resetSession([
      baseDeck('deck-0', { playing: false, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 95);

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
  });

  it('does nothing when the incoming deck is already playing (manual overlap in progress)', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { playing: true, source: videoSource('b.mp4', 100) }),
    ]);
    const before = get(sessionMod.session).crossfaderValue;

    autoMixMod.checkAutoMixTrigger('deck-0', 95);

    expect(get(sessionMod.session).crossfaderValue).toBe(before);
  });

  it('does nothing when the incoming deck has no loaded track (phase 1 has no auto-preload)', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: null }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 95);

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
  });

  it('does nothing while remaining time is above the threshold', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixThresholdSec.set(15);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 50); // 50s remaining, well above the 15s threshold

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
  });

  it('starts the incoming deck and marks the track handled once inside the threshold', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, rafQueue } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixThresholdSec.set(15);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 90); // 10s remaining

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
    expect(autoMixMod.wasAutoMixTriggered('deck-0', 'a.mp4')).toBe(true);
    expect(autoMixMod.wasAutoMixTriggered('deck-0', 'some-other.mp4')).toBe(false);
    expect(rafQueue.length).toBe(1); // ramp has scheduled its first frame
  });

  it('does not double-trigger while a ramp is already in flight', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 90);
    autoMixMod.checkAutoMixTrigger('deck-0', 90);
    autoMixMod.checkAutoMixTrigger('deck-0', 89);

    // updateDeck(incoming, {playing:true}) should only have fired once — verified indirectly:
    // crossfaderValue only moves once the ramp actually steps, so re-triggering wouldn't show
    // up here anyway; the real guard is activeRamp, covered end-to-end by the ramp-progress test.
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
  });
});

describe('checkAutoMixTrigger / checkAutoPreloadTrigger with outroPoint (Phase 4)', () => {
  it('measures the threshold from outroPoint, not track duration, when set', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixThresholdSec.set(15);
    resetSession([
      // outroPoint at 60s, well before the 100s duration. The blend runs OVER the outro
      // zone (2026-09-19), so it starts when the playhead reaches the marker — not 10s
      // before it, and not off the 100s track end.
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), mixOutStart: 60 }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 50); // 10s BEFORE the marker: the blend starts AT it
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);

    autoMixMod.checkAutoMixTrigger('deck-0', 60); // the playhead reaches the marker
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
  });

  it('does not fire early just because outroPoint is still far off', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixThresholdSec.set(15);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), mixOutStart: 90 }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 50); // 40s to the marker, above the 15s threshold

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
  });

  it('clamps an outroPoint past the actual duration instead of trusting it', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixThresholdSec.set(15);
    resetSession([
      // A stale/bad marker beyond duration must not push the trigger point past EOS.
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), mixOutStart: 500 }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 90); // 10s remaining to the clamped (=duration) end

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
  });

  it('ignores an outroPoint suspiciously close to the start, falling back to duration', async () => {
    // Regression: "Baddy On The Floor", 2026-08-26 — a bad Digger beat-grid fit put
    // outroPoint at ~18s into a 223s track, making the very next preload/crossfade
    // pair fire within 8s of the track being mixed in. A marker inside the first
    // third of the track is untrustworthy, same treatment as no marker at all.
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixThresholdSec.set(15);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), mixOutStart: 10 }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    // 10s remaining to the (untrustworthy, ignored) marker, but 80s remaining to the
    // real duration — must NOT fire.
    autoMixMod.checkAutoMixTrigger('deck-0', 0);

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
  });

  it('preload also measures its lead time from outroPoint when set', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoPreloadThresholdSec.set(45);
    getQueue.mockResolvedValue([]);
    queueNext.mockResolvedValue({ id: 1, track_id: 7, title: 'T', artist: 'A' });
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), mixOutStart: 60 }),
      baseDeck('deck-1', { source: null }),
    ]);

    autoMixMod.checkAutoPreloadTrigger('deck-0', 20); // 40s to the marker, inside the 45s preload threshold

    expect(getQueue).toHaveBeenCalled();
  });

  it('falls back to track duration when outroPoint is unset, exactly as before this field existed', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixThresholdSec.set(15);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), mixOutStart: null }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 90); // 10s remaining to the literal end

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
  });
});

describe('crossfade ramp', () => {
  it('drives the crossfader from the outgoing side to the incoming side and pauses the outgoing deck', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, runToCompletion } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }), // crossfaderMapping.left
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),                // crossfaderMapping.right
    ]);
    expect(get(sessionMod.session).crossfaderValue).toBe(0); // full left (deck-0) at start

    autoMixMod.checkAutoMixTrigger('deck-0', 90);
    runToCompletion(100);

    const s = get(sessionMod.session);
    expect(s.crossfaderValue).toBe(1); // fully faded to deck-1 (right)
    expect(s.decks.find((d) => d.id === 'deck-0')!.playing).toBe(false); // outgoing freed
    expect(s.decks.find((d) => d.id === 'deck-0')!.source).toBeNull(); // and unloaded, not left stale
    expect(s.decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
  });

  it('clears syncLocked on the outgoing deck once it unloads, so the Lock button/LED don\'t stay lit', async () => {
    // Regression: source: null used to leave syncLocked (and thus DeckCard's Lock button
    // `active` class + the controller sync LED, both driven off this flag) stuck on an
    // empty deck — found 2026-08-26.
    const { sessionMod, autoDjMod, autoMixMod, resetSession, runToCompletion } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), syncLocked: true }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 90);
    runToCompletion(100);

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-0')!.syncLocked).toBe(false);
  });

  it('clears diggerTrackId/diggerFileId on the outgoing deck once it unloads, so DiggerQueue\'s deck highlight doesn\'t stay lit', async () => {
    // Regression: source: null used to leave diggerTrackId/diggerFileId stuck on an empty
    // deck, so DiggerQueue.svelte's deck-btn `loaded` class (deck.diggerTrackId ===
    // item.track_id) kept highlighting a queue row for a track that had already finished
    // and been unloaded — found 2026-09-05.
    const { sessionMod, autoDjMod, autoMixMod, resetSession, runToCompletion } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), diggerTrackId: 7, diggerFileId: 70 }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 90);
    runToCompletion(100);

    const deck0 = get(sessionMod.session).decks.find((d) => d.id === 'deck-0')!;
    expect(deck0.diggerTrackId).toBeNull();
    expect(deck0.diggerFileId).toBeNull();
  });

  it('frees the outgoing deck for a fresh preload after it fades out, even if it was manually loaded', async () => {
    // Regression for the live-session report (2026-08-24): a DJ manually loaded a track
    // several queue slots ahead onto deck-0; Auto DJ correctly auto-picked+crossfaded deck-1
    // in, but deck-0 then never got a new track for the *next* cycle, because it kept its
    // now-fully-played source instead of being freed — which made checkAutoPreloadTrigger's
    // "already loaded (by anyone) — don't clobber" guard treat it as permanently occupied.
    const { sessionMod, autoDjMod, autoMixMod, resetSession, runToCompletion } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.crossfadeDurationMs.set(1000);
    autoMixMod.autoPreloadThresholdSec.set(45);
    getQueue.mockResolvedValue([{ id: 1, track_id: 7, title: 'T', artist: 'A' }]);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('manual.mp4', 100) }), // DJ's manual load
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),                     // already-preloaded next track
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 90); // near-end: fade deck-0 -> deck-1
    runToCompletion(100);
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-0')!.source).toBeNull();

    // Next cycle: deck-1 is now playing and approaching its own end; deck-0 must look idle.
    autoMixMod.checkAutoPreloadTrigger('deck-1', 60); // 40s remaining, inside the 45s threshold

    await vi.waitFor(() => expect(loadQueueItemToDeck).toHaveBeenCalledWith(
      { id: 1, track_id: 7, title: 'T', artist: 'A' },
      'deck-0',
      'auto',
    ));
  });

  it('fades the other direction when the right-mapped deck is the one ending', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, runToCompletion } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession([
      baseDeck('deck-0', { source: videoSource('b.mp4', 100) }),                // left, incoming
      baseDeck('deck-1', { playing: true, source: videoSource('a.mp4', 100) }), // right, outgoing
    ]);
    sessionMod.setCrossfader(1); // start fully favoring deck-1 (right)

    autoMixMod.checkAutoMixTrigger('deck-1', 90);
    runToCompletion(100);

    expect(get(sessionMod.session).crossfaderValue).toBe(0);
  });

  it('hands control back immediately on a manual crossfader touch, without finishing the fade', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, driveFrame, rafQueue } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 90);
    driveFrame(300); // 30% through the fade
    const midValue = get(sessionMod.session).crossfaderValue;
    expect(midValue).toBeGreaterThan(0);
    expect(midValue).toBeLessThan(1);

    autoMixMod.notifyManualCrossfaderTouch(); // the DJ grabs the fader
    driveFrame(50); // the next queued step should see the touch and abort in place

    expect(get(sessionMod.session).crossfaderValue).toBe(midValue); // untouched by the aborted step
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-0')!.playing).toBe(true); // not force-paused
    expect(rafQueue.length).toBe(0); // no further automation scheduled
  });

  it('abandons the ramp cleanly if a deck is removed mid-fade', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, driveFrame, rafQueue } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 90);
    driveFrame(300);

    sessionMod.removeDeck('deck-1'); // incoming deck yanked mid-fade
    driveFrame(50);

    expect(rafQueue.length).toBe(0); // loop stopped, nothing left dangling
  });
});

describe('checkAutoMixTrigger with autoMixSyncEnabled', () => {
  it('rate-locks and phase-nudges the incoming deck before the crossfade starts, when a bpm reference exists', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, runToCompletion } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixSyncEnabled.set(true);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession(
      [
        baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), bpm: 120, downbeat: 0 }),
        baseDeck('deck-1', { source: videoSource('b.mp4', 100), bpm: 128, downbeat: 0 }),
      ],
      { bpm: 120, masterDeckId: 'deck-0' },
    );

    autoMixMod.checkAutoMixTrigger('deck-0', 90);

    // Rate lock applies immediately, synchronously — before the 200ms settle.
    const locked = get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!;
    expect(locked.syncLocked).toBe(true);
    expect(locked.playbackRate).toBeCloseTo(120 / 128);
    expect(locked.playing).toBe(false); // not yet — waiting out the settle window
    expect(nudgePhaseToMaster).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 250)); // past the first 200ms (rate) settle
    expect(nudgePhaseToMaster).toHaveBeenCalledWith('deck-1');
    // Nudging seeks the still-paused deck via a fire-and-forget IPC call that hasn't landed
    // yet — playback must wait out a second settle window before starting, or it audibly
    // starts from the pre-nudge position (the bug reported live 2026-08-24).
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);

    await new Promise((r) => setTimeout(r, 250)); // past the second (seek) settle
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);

    runToCompletion(100);
    expect(get(sessionMod.session).crossfaderValue).toBe(1); // the ramp still ran to completion
  });

  it('abandons the sync+crossfade if the DJ touches the fader during the post-nudge seek settle', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, rafQueue } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixSyncEnabled.set(true);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession(
      [
        baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), bpm: 120, downbeat: 0 }),
        baseDeck('deck-1', { source: videoSource('b.mp4', 100), bpm: 128, downbeat: 0 }),
      ],
      { bpm: 120, masterDeckId: 'deck-0' },
    );

    autoMixMod.checkAutoMixTrigger('deck-0', 90);

    await new Promise((r) => setTimeout(r, 250)); // past the rate settle, nudge has fired
    expect(nudgePhaseToMaster).toHaveBeenCalledWith('deck-1');
    autoMixMod.notifyManualCrossfaderTouch(); // DJ grabs the fader during the seek settle

    await new Promise((r) => setTimeout(r, 250));
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
    expect(rafQueue.length).toBe(0); // no ramp was ever scheduled
  });

  it('skips the sync step and mixes at native tempo when the incoming deck has no bpm', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, runToCompletion } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixSyncEnabled.set(true);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession(
      [
        baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), bpm: 120, downbeat: 0 }),
        baseDeck('deck-1', { source: videoSource('b.mp4', 100) }), // no bpm detected/set
      ],
      { bpm: 120, masterDeckId: 'deck-0' },
    );

    autoMixMod.checkAutoMixTrigger('deck-0', 90);

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true); // starts right away
    expect(nudgePhaseToMaster).not.toHaveBeenCalled();
    runToCompletion(100);
    expect(get(sessionMod.session).crossfaderValue).toBe(1);
  });

  it('abandons the deferred sync+crossfade if the DJ touches the fader during the settle window', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, rafQueue } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixSyncEnabled.set(true);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession(
      [
        baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), bpm: 120, downbeat: 0 }),
        baseDeck('deck-1', { source: videoSource('b.mp4', 100), bpm: 128, downbeat: 0 }),
      ],
      { bpm: 120, masterDeckId: 'deck-0' },
    );

    autoMixMod.checkAutoMixTrigger('deck-0', 90);
    autoMixMod.notifyManualCrossfaderTouch(); // DJ grabs the fader during the settle window

    await new Promise((r) => setTimeout(r, 250));
    expect(nudgePhaseToMaster).not.toHaveBeenCalled();
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
    expect(rafQueue.length).toBe(0); // no ramp was ever scheduled
  });
});

describe('checkAutoPreloadTrigger', () => {
  it('does nothing when Auto DJ is off', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(false);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: null }),
    ]);

    autoMixMod.checkAutoPreloadTrigger('deck-0', 60); // well inside any reasonable threshold

    expect(getQueue).not.toHaveBeenCalled();
  });

  it('ignores a deck not named in crossfaderMapping', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: null }),
      baseDeck('deck-2', { playing: true, source: videoSource('c.mp4', 100) }),
    ]);

    autoMixMod.checkAutoPreloadTrigger('deck-2', 95);

    expect(getQueue).not.toHaveBeenCalled();
  });

  it('never clobbers a deck that already has a source loaded', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 50) }), // DJ (or a prior preload) already loaded this
    ]);

    autoMixMod.checkAutoPreloadTrigger('deck-0', 90); // 10s remaining

    expect(getQueue).not.toHaveBeenCalled();
  });

  it('does nothing while remaining time is above the preload threshold', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoPreloadThresholdSec.set(45);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: null }),
    ]);

    autoMixMod.checkAutoPreloadTrigger('deck-0', 10); // 90s remaining, above the 45s threshold

    expect(getQueue).not.toHaveBeenCalled();
  });

  it('loads the front of the queue onto the idle deck once inside the threshold, without removing it', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoPreloadThresholdSec.set(45);
    getQueue.mockResolvedValue([{ id: 1, track_id: 7, title: 'T', artist: 'A' }]);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: null }),
    ]);

    autoMixMod.checkAutoPreloadTrigger('deck-0', 60); // 40s remaining, inside the 45s threshold

    await vi.waitFor(() => expect(loadQueueItemToDeck).toHaveBeenCalled());
    expect(loadQueueItemToDeck).toHaveBeenCalledWith(
      { id: 1, track_id: 7, title: 'T', artist: 'A' },
      'deck-1',
      'auto',
    );
    expect(removeFromQueue).not.toHaveBeenCalled(); // stays in the queue (changed 2026-08-24)
    expect(queueNext).not.toHaveBeenCalled();
  });

  it('anchors on the outgoing deck\'s diggerTrackId and preloads the next unplayed queue entry after it', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoPreloadThresholdSec.set(45);
    const current = { id: 1, track_id: 7, title: 'Current', artist: 'A' };
    const upNext = { id: 2, track_id: 8, title: 'Next', artist: 'B' };
    getQueue.mockResolvedValue([current, upNext]);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), diggerTrackId: 7 }),
      baseDeck('deck-1', { source: null }),
    ]);

    autoMixMod.checkAutoPreloadTrigger('deck-0', 60);

    await vi.waitFor(() => expect(loadQueueItemToDeck).toHaveBeenCalled());
    expect(loadQueueItemToDeck).toHaveBeenCalledWith(upNext, 'deck-1', 'auto'); // not `current`
  });

  it('skips a queue entry already marked played', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoPreloadThresholdSec.set(45);
    const played = { id: 1, track_id: 7, title: 'Played', artist: 'A' };
    const fresh = { id: 2, track_id: 8, title: 'Fresh', artist: 'B' };
    getQueue.mockResolvedValue([played, fresh]);
    isPlayed.mockImplementation((id: number) => id === 7);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: null }),
    ]);

    autoMixMod.checkAutoPreloadTrigger('deck-0', 60);

    await vi.waitFor(() => expect(loadQueueItemToDeck).toHaveBeenCalled());
    expect(loadQueueItemToDeck).toHaveBeenCalledWith(fresh, 'deck-1', 'auto');
  });

  it('falls back to queueNext() when the queue is empty', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoPreloadThresholdSec.set(45);
    getQueue.mockResolvedValue([]);
    queueNext.mockResolvedValue({ id: 9, title: 'Suggested', artist: 'Someone' });
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: null }),
    ]);

    autoMixMod.checkAutoPreloadTrigger('deck-0', 60);

    await vi.waitFor(() => expect(loadQueueItemToDeck).toHaveBeenCalled());
    expect(loadQueueItemToDeck).toHaveBeenCalledWith(
      { track_id: 9, title: 'Suggested', artist: 'Someone' },
      'deck-1',
      'auto',
    );
    expect(removeFromQueue).not.toHaveBeenCalled();
  });

  it('only fetches once while still inside the threshold for the same track', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoPreloadThresholdSec.set(45);
    getQueue.mockResolvedValue([{ id: 1, track_id: 7, title: 'T', artist: 'A' }]);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: null }),
    ]);

    autoMixMod.checkAutoPreloadTrigger('deck-0', 60);
    autoMixMod.checkAutoPreloadTrigger('deck-0', 61);
    autoMixMod.checkAutoPreloadTrigger('deck-0', 62);

    await vi.waitFor(() => expect(loadQueueItemToDeck).toHaveBeenCalledTimes(1));
    expect(getQueue).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a deck the DJ loaded manually while the fetch was in flight', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoPreloadThresholdSec.set(45);
    let resolveGetQueue!: (v: unknown) => void;
    getQueue.mockImplementation(() => new Promise((res) => { resolveGetQueue = res; }));
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: null }),
    ]);

    autoMixMod.checkAutoPreloadTrigger('deck-0', 60);
    sessionMod.updateDeck('deck-1', { source: videoSource('manual.mp4', 30) }); // DJ beats the fetch
    resolveGetQueue([{ id: 1, track_id: 7, title: 'T', artist: 'A' }]);

    await vi.waitFor(() => expect(getQueue).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0)); // let the .then chain settle
    expect(loadQueueItemToDeck).not.toHaveBeenCalled();
  });
});

// docs/design/auto-dj-transitions.md "Manual/auto interaction" — see autoMix.ts's own
// comment above notifyManualPlay/skipUpcomingTrack for the live-session bug (2026-08-26)
// this closes: a manual play on a mapped deck while its counterpart already plays left
// the transition permanently unhandled, and the deck's later real EOS re-picked a track
// that was still (inaudibly) playing on the other deck.
describe('notifyManualPlay (Tier 2, silent)', () => {
  it('marks both decks in the pair handled once a manual play overlaps the other playing deck', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('manual.mp4', 100) }),
      baseDeck('deck-1', { playing: true, source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.notifyManualPlay('deck-0');

    // Both filePaths are now "handled" — a real EOS on either deck must not re-pick.
    expect(autoMixMod.wasAutoMixTriggered('deck-0', 'manual.mp4')).toBe(true);
    expect(autoMixMod.wasAutoMixTriggered('deck-1', 'b.mp4')).toBe(true);
  });

  it('does nothing when the other mapped deck is not playing (no overlap to park)', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('manual.mp4', 100) }),
      baseDeck('deck-1', { playing: false, source: null }),
    ]);

    autoMixMod.notifyManualPlay('deck-0');

    expect(autoMixMod.wasAutoMixTriggered('deck-0', 'manual.mp4')).toBe(false);
  });

  it('does nothing when Auto DJ is off', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(false);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('manual.mp4', 100) }),
      baseDeck('deck-1', { playing: true, source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.notifyManualPlay('deck-0');

    expect(autoMixMod.wasAutoMixTriggered('deck-0', 'manual.mp4')).toBe(false);
  });
});

// ── Phase 5 (2026-08-30) ─────────────────────────────────────────────────────────────
// docs/design/auto-dj-transitions.md "Phase 5". computeTransitionDurationMs is pure, so
// it's tested directly rather than only through the trigger — the trigger tests below
// then cover the one thing the pure function can't: that a derived duration also moves
// the trigger point, so a long blend isn't truncated by the track ending under it.
describe('computeTransitionDurationMs (Phase 5, four-point since Phase 8)', () => {
  // Every literal below is a full TransitionZones: two [start, end] pairs. The outro
  // side's `mixOutEnd: null` is not laziness — null there means "the track's own end",
  // which is the value that was implicit before the field existed, so these cases are
  // byte-identical to their Phase 5 versions. The intro side has no such fallback, which
  // is why its cases had to change shape rather than just be renamed.
  const noZones = { duration: 200, mixOutStart: null, mixOutEnd: null, mixInStart: null, mixInEnd: null };

  it('falls back to the flat setting when neither track carries usable markers', async () => {
    const { autoMixMod } = await setup();
    expect(autoMixMod.computeTransitionDurationMs(noZones, noZones, 6000))
      .toEqual({ ms: 6000, source: 'fallback' });
  });

  it('derives the duration from the outgoing track\'s outro zone alone', async () => {
    const { autoMixMod } = await setup();
    // 200s track, mix-out at 190, no explicit end -> a 10s outro tail to fade under.
    expect(autoMixMod.computeTransitionDurationMs(
      { ...noZones, mixOutStart: 190 },
      noZones,
      6000,
    )).toEqual({ ms: 10000, source: 'outro' });
  });

  it('honours an explicit mixOutEnd shorter than the track', async () => {
    // The thing the one-point model could not say at all: fade over [170, 182] and let
    // the last 18s of the track play out alone. Before Phase 8 this zone was always
    // "mix-out marker to EOS" by construction.
    const { autoMixMod } = await setup();
    expect(autoMixMod.computeTransitionDurationMs(
      { ...noZones, mixOutStart: 170, mixOutEnd: 182 },
      noZones,
      6000,
    )).toEqual({ ms: 12000, source: 'outro' });
  });

  it('derives the duration from the incoming track\'s intro zone alone', async () => {
    const { autoMixMod } = await setup();
    expect(autoMixMod.computeTransitionDurationMs(
      noZones,
      { ...noZones, mixInStart: 0, mixInEnd: 8 },
      6000,
    )).toEqual({ ms: 8000, source: 'intro' });
  });

  it('measures the intro zone from its start, not from zero', async () => {
    // The Phase 7b double-duty bug, as a test. A mix-in hand-placed at 18s used to mean
    // both "start the incoming track at 18s" AND "18s of blendable head" — so the engine
    // skipped 18s and then offered a blend as long as the part it had just skipped. The
    // zone here is [18, 24]: six seconds, which is what min() should see.
    const { autoMixMod } = await setup();
    expect(autoMixMod.computeTransitionDurationMs(
      noZones,
      { ...noZones, mixInStart: 18, mixInEnd: 24 },
      6000,
    )).toEqual({ ms: 6000, source: 'intro' });
  });

  it('contributes nothing from the intro side when only the start is marked', async () => {
    // An un-backfilled track: Digger gave it a mix_in_start but no mix_in_end. Deliberate
    // — see Deck.mixInEnd. The alternative (assume the end is the track's) is the old bug.
    const { autoMixMod } = await setup();
    expect(autoMixMod.computeTransitionDurationMs(
      { ...noZones, mixOutStart: 190 },
      { ...noZones, mixInStart: 18 },
      6000,
    )).toEqual({ ms: 10000, source: 'outro' });
  });

  it('takes the shorter of the two zones when both tracks support a blend', async () => {
    const { autoMixMod } = await setup();
    expect(autoMixMod.computeTransitionDurationMs(
      { ...noZones, mixOutStart: 188 },                    // 12s outro
      { ...noZones, mixInStart: 0, mixInEnd: 7 },          // 7s intro
      6000,
    )).toEqual({ ms: 7000, source: 'zones' });
  });

  it('ignores the sub-second mix_in Digger derives for most tracks', async () => {
    // _derive_mix_points() sets mix_in_start = beat_times[0], the first tracked beat —
    // usually well under a second. As a zone START that is harmless and even correct; it
    // just carries no LENGTH on its own, which is what this asserts. (Whether it is worth
    // *seeking* to is a separate question — see INTRO_SEEK_MIN_SEC.)
    const { autoMixMod } = await setup();
    expect(autoMixMod.computeTransitionDurationMs(
      { ...noZones, mixOutStart: 190 },
      { ...noZones, mixInStart: 0.43 },
      6000,
    )).toEqual({ ms: 10000, source: 'outro' });
  });

  it('ignores a mix-in start past the first third of the incoming track', async () => {
    const { autoMixMod } = await setup();
    expect(autoMixMod.computeTransitionDurationMs(
      noZones,
      { ...noZones, mixInStart: 120, mixInEnd: 140 },
      6000,
    )).toEqual({ ms: 6000, source: 'fallback' });
  });

  it('ignores an intro zone shorter than MIN_ZONE_SEC even with both ends placed', async () => {
    // The zone rule still applies to the zone — splitting the rules did not remove it.
    const { autoMixMod } = await setup();
    expect(autoMixMod.computeTransitionDurationMs(
      noZones,
      { ...noZones, mixInStart: 10, mixInEnd: 11.5 },
      6000,
    )).toEqual({ ms: 6000, source: 'fallback' });
  });

  it('ignores a mix-out start inside the first third, same as the trigger does', async () => {
    const { autoMixMod } = await setup();
    expect(autoMixMod.computeTransitionDurationMs(
      { ...noZones, mixOutStart: 18 }, // the "Baddy On The Floor" shape
      null,
      6000,
    )).toEqual({ ms: 6000, source: 'fallback' });
  });

  it('clamps a very long outro zone to the ceiling, and a very short one to the floor', async () => {
    const { autoMixMod } = await setup();
    expect(autoMixMod.computeTransitionDurationMs(
      { ...noZones, duration: 300, mixOutStart: 150 }, // 150s of "outro"
      null,
      6000,
    ).ms).toBe(20000);
    expect(autoMixMod.computeTransitionDurationMs(
      { ...noZones, mixOutStart: 197.5 }, // 2.5s outro
      null,
      6000,
    ).ms).toBe(2500);
    expect(autoMixMod.computeTransitionDurationMs(
      noZones,
      { ...noZones, mixInStart: 0, mixInEnd: 2 }, // exactly at MIN_ZONE_SEC
      6000,
    ).ms).toBe(2000);
  });
});

describe('checkAutoMixTrigger duration/lead derivation (Phase 5)', () => {
  it('starts at the outro marker and fades over the outro zone, whatever the lead setting', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, driveFrame, runToCompletion } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixThresholdSec.set(15);
    autoMixMod.crossfadeDurationMs.set(1000); // the flat fallback — must NOT be what runs
    resetSession([
      // 25s outro tail -> a 20s blend (the ceiling), running from the marker onwards.
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 200), mixOutStart: 175 }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 200) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 157); // 18s before the marker: too early
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
    autoMixMod.checkAutoMixTrigger('deck-0', 175); // the marker
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);

    driveFrame(10000); // half the derived 20s duration
    expect(get(sessionMod.session).crossfaderValue).toBeCloseTo(0.5, 2);
    runToCompletion(1000);
    expect(get(sessionMod.session).crossfaderValue).toBe(1);
  });

  it('a short outro zone still starts at the marker, not at the configured threshold', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, driveFrame } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixThresholdSec.set(15);
    autoMixMod.crossfadeDurationMs.set(6000);
    resetSession([
      // 5s outro tail -> a 5s blend from the marker. The "start mixing 15s out" setting only
      // governs tracks WITHOUT a usable marker; with one, the marker is the start.
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), mixOutStart: 95 }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 60); // 35s out — well outside both
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);

    autoMixMod.checkAutoMixTrigger('deck-0', 85); // 10s out — inside the 15s threshold, but not at the marker
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
    autoMixMod.checkAutoMixTrigger('deck-0', 95); // the marker
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);

    driveFrame(5000); // the derived 5s duration, not the 6s flat setting
    expect(get(sessionMod.session).crossfaderValue).toBe(1);
  });

  it('runs for the flat fallback duration when neither track has marker data', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, driveFrame } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixThresholdSec.set(15);
    autoMixMod.crossfadeDurationMs.set(4000);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 90);
    driveFrame(2000);
    expect(get(sessionMod.session).crossfaderValue).toBeCloseTo(0.5, 2);
    driveFrame(2000);
    expect(get(sessionMod.session).crossfaderValue).toBe(1);
  });
});

describe('skipCurrentTrack (Phase 5 — the "skip now" control)', () => {
  it('starts the incoming deck and runs the crossfade immediately, mid-track', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, runToCompletion } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 300), diggerTrackId: 7 }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 300), diggerTrackId: 8 }),
    ]);

    await autoMixMod.skipCurrentTrack();

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
    runToCompletion(100);
    const s = get(sessionMod.session);
    expect(s.crossfaderValue).toBe(1);
    expect(s.decks.find((d) => d.id === 'deck-0')!.source).toBeNull(); // outgoing freed
    // The outgoing track was deliberately cut short: its later EOS must not be treated as
    // an unhandled transition, and it must not be re-offered by pickNextTrack.
    expect(autoMixMod.wasAutoMixTriggered('deck-0', 'a.mp4')).toBe(true);
    expect(markSkipped).toHaveBeenCalledWith(7);
  });

  it('fetches and loads a track first when the other mapped deck is empty', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.crossfadeDurationMs.set(1000);
    getQueue.mockResolvedValue([{ id: 1, track_id: 9, title: 'Next', artist: 'B' }]);
    // Stand in for the real load: the deck only becomes transition-eligible once it
    // reports a real duration (`source.duration > 0`), which is what skipCurrentTrack waits on.
    loadQueueItemToDeck.mockImplementation(async (_item: unknown, deckId: string) => {
      sessionMod.updateDeck(deckId, { source: videoSource('fetched.mp4', 240), diggerTrackId: 9 });
    });
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 300), diggerTrackId: 7 }),
      baseDeck('deck-1', { source: null }),
    ]);

    await autoMixMod.skipCurrentTrack();

    expect(loadQueueItemToDeck).toHaveBeenCalledWith(
      { id: 1, track_id: 9, title: 'Next', artist: 'B' }, 'deck-1', 'auto',
    );
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
  });

  it('degrades to swapping the upcoming pick when no mapped deck is playing', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    const fresh = { id: 2, track_id: 8, title: 'Fresh', artist: 'B' };
    getQueue.mockResolvedValue([fresh]);
    resetSession([
      baseDeck('deck-0', { playing: false, source: null }),
      baseDeck('deck-1', { source: videoSource('preloaded.mp4', 200), diggerTrackId: 20 }),
    ]);

    await autoMixMod.skipCurrentTrack();

    // skipUpcomingTrack's behavior: swap what's queued, start nothing.
    expect(loadQueueItemToDeck).toHaveBeenCalledWith(fresh, 'deck-0', 'auto');
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
  });

  it('does nothing while an automated crossfade is already running', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, driveFrame } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 90); // ramp in flight
    driveFrame(300);
    const midValue = get(sessionMod.session).crossfaderValue;

    await autoMixMod.skipCurrentTrack();

    expect(get(sessionMod.session).crossfaderValue).toBe(midValue); // ramp untouched, not restarted
    expect(loadQueueItemToDeck).not.toHaveBeenCalled();
  });
});

describe('previewTransition (Phase 6 — audition the transition)', () => {
  it('seeks both decks to the transition point and runs the real ramp, keeping the outgoing deck loaded', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, runToCompletion } = await setup();
    autoDjMod.autoDjEnabled.set(false); // preview is a workshopping tool, not automation
    autoMixMod.autoMixThresholdSec.set(15);
    autoMixMod.crossfadeDurationMs.set(1000);
    autoMixMod.previewTailSec.set(0.2);
    resetSession([
      baseDeck('deck-0', { source: videoSource('a.mp4', 200), mixOutStart: 180 }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 200) }),
    ]);

    autoMixMod.previewTransition('deck-0');

    // 20s outro tail -> a 20s blend that runs from the marker: the trigger point is 180s.
    expect(seekDeck).toHaveBeenCalledWith('deck-0', 180, true);
    expect(seekDeck).toHaveBeenCalledWith('deck-1', 0, true);
    expect(get(sessionMod.session).crossfaderValue).toBe(0); // parked on the outgoing side
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-0')!.playing).toBe(true);

    await new Promise((r) => setTimeout(r, 250)); // seek settle
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
    runToCompletion(1000);

    const s = get(sessionMod.session);
    expect(s.crossfaderValue).toBe(1);
    // The whole point of preview: nothing is consumed. The outgoing deck keeps its track
    // (so the audition is repeatable, and the idle deck doesn't look empty to the preload
    // trigger), and no transition bookkeeping was recorded.
    expect(s.decks.find((d) => d.id === 'deck-0')!.source).not.toBeNull();
    expect(s.decks.find((d) => d.id === 'deck-0')!.playing).toBe(false);
    expect(autoMixMod.wasAutoMixTriggered('deck-0', 'a.mp4')).toBe(false);
    expect(markSkipped).not.toHaveBeenCalled();

    // After the tail the preview puts everything back, so pressing it again needs no manual
    // recovery: fader where the DJ left it, incoming deck paused at 0 and at its old rate.
    // The wait is derived from the tail setting this test pinned, not from a literal: the
    // tail became a user setting on 2026-09-20 and a hardcoded 3200 broke silently.
    await new Promise((r) => setTimeout(r, get(autoMixMod.previewTailSec) * 1000 + 200));
    const after = get(sessionMod.session);
    expect(after.crossfaderValue).toBe(0);
    expect(after.decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
    expect(after.decks.find((d) => d.id === 'deck-1')!.playbackRate).toBe(1);
    expect(seekDeck).toHaveBeenLastCalledWith('deck-1', 0, true);
  });

  it('holds the live trigger off during the seek-settle window, so Auto DJ cannot run a second transition (live-hit 2026-09-19)', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, runToCompletion } = await setup();
    autoDjMod.autoDjEnabled.set(true); // the case that raced: preview with Auto DJ ON
    autoMixMod.autoMixThresholdSec.set(15);
    autoMixMod.crossfadeDurationMs.set(1000);
    autoMixMod.previewTailSec.set(0.2);
    resetSession([
      baseDeck('deck-0', { source: videoSource('a.mp4', 200), mixOutStart: 180 }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 200) }),
    ]);

    autoMixMod.previewTransition('deck-0');
    // The position poll lands on the trigger point before the preview's ramp exists.
    autoMixMod.checkAutoMixTrigger('deck-0', 180.2);
    expect(autoMixMod.wasAutoMixTriggered('deck-0', 'a.mp4')).toBe(false);

    await new Promise((r) => setTimeout(r, 250));
    runToCompletion(1000);
    // The preview tail, after which the guard lifts — derived from the setting, not a literal.
    await new Promise((r) => setTimeout(r, get(autoMixMod.previewTailSec) * 1000 + 200));

    const deck0 = get(sessionMod.session).decks.find((d) => d.id === 'deck-0')!;
    expect(deck0.source).not.toBeNull(); // still loaded: only the preview ran
    expect(autoMixMod.wasAutoMixTriggered('deck-0', 'a.mp4')).toBe(false);

    // And the guard is released once the preview ends: the live trigger works again (the
    // preview left both decks paused, so put the outgoing one back in play first).
    sessionMod.updateDeck('deck-0', { playing: true });
    sessionMod.updateDeck('deck-1', { playing: false });
    autoMixMod.checkAutoMixTrigger('deck-0', 180.2);
    expect(autoMixMod.wasAutoMixTriggered('deck-0', 'a.mp4')).toBe(true);
  });

  it('honours the preview-tail setting, and the in-flight guard outlasts it (2026-09-20)', async () => {
    // The tail was a flat 3s constant until a live session asked for the preview to keep
    // playing the new track. Promoting it to a setting promotes the margin it silently
    // protected: `beginPreviewGuard`'s ceiling is `plan.ms + tail + slack`, so if the guard
    // ever stops tracking the tail, a long tail gets cut off mid-audition by its own guard.
    // Both halves are asserted here because neither fails visibly on its own.
    const { sessionMod, autoDjMod, autoMixMod, resetSession, runToCompletion } = await setup();
    autoDjMod.autoDjEnabled.set(false);
    autoMixMod.autoMixThresholdSec.set(15);
    autoMixMod.crossfadeDurationMs.set(1000);
    autoMixMod.previewTailSec.set(1.2);
    resetSession([
      baseDeck('deck-0', { source: videoSource('a.mp4', 200), mixOutStart: 180 }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 200) }),
    ]);

    autoMixMod.previewTransition('deck-0');
    await new Promise((r) => setTimeout(r, 250));
    runToCompletion(1000);

    // Well inside the tail: the new track is still playing and nothing has been put back.
    await new Promise((r) => setTimeout(r, 400));
    const during = get(sessionMod.session);
    expect(during.decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
    expect(during.crossfaderValue).toBe(1);

    // Past it: the restore runs, which also proves the guard did not expire early and
    // tear the audition down before the tail the DJ asked for had elapsed.
    await new Promise((r) => setTimeout(r, 1100));
    const after = get(sessionMod.session);
    expect(after.decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
    expect(after.crossfaderValue).toBe(0);
  });

  it('refuses when the other crossfader deck has nothing loaded', async () => {
    const { sessionMod, autoMixMod, resetSession } = await setup();
    resetSession([
      baseDeck('deck-0', { source: videoSource('a.mp4', 200), mixOutStart: 180 }),
      baseDeck('deck-1', { source: null }),
    ]);

    autoMixMod.previewTransition('deck-0');

    expect(seekDeck).not.toHaveBeenCalled();
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-0')!.playing).toBe(false);
  });
});

/**
 * Phase 7b (2026-09-19) — the incoming deck starts at its mix-in marker, on the live path
 * and in Preview alike (design-doc open decision #5). Before this nothing positioned the
 * incoming deck at all: it started wherever it was parked, so a track's dead-air head
 * played under the whole blend. The gate is `introZoneSec`, the same trustworthiness rule
 * the derived duration already uses — which is what keeps Digger's auto-derived `mix_in`
 * (`beat_times[0]`, typically well under a second) from moving anything.
 */
describe('incoming deck starts at its mix-in marker (Phase 7b)', () => {
  /** deck-0 plays out with no outro marker (so the old end-anchored lead applies); deck-1
   *  waits with whatever intro marker the test gives it. */
  async function armPair(env: Awaited<ReturnType<typeof setup>>, mixInStart: number | null, incomingOverrides: Partial<Deck> = {}) {
    const { autoDjMod, autoMixMod, resetSession } = env;
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixThresholdSec.set(15);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100), mixInStart, ...incomingOverrides }),
    ]);
  }

  it('seeks the incoming deck to its mix-in marker and settles that seek before starting it', async () => {
    const env = await setup();
    const { sessionMod, autoMixMod, runToCompletion, rafQueue } = env;
    await armPair(env, 10);

    autoMixMod.checkAutoMixTrigger('deck-0', 90);

    // The seek is issued synchronously, before anything starts the deck.
    expect(seekDeck).toHaveBeenCalledWith('deck-1', 10, true);
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
    expect(rafQueue.length).toBe(0); // and no ramp yet — the fade starts with the deck

    // seekDeck's audio_seek IPC is fire-and-forget; playing through it would start the
    // deck from its pre-seek position (the 2026-08-24 race), so it gets the same 200ms
    // settle window the sync path's rate/nudge seeks already use.
    await new Promise((r) => setTimeout(r, 250));
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
    runToCompletion(1000);
    expect(get(sessionMod.session).crossfaderValue).toBe(1);
  });

  it('starts the incoming deck where it is parked, immediately, when it has no marker', async () => {
    const env = await setup();
    const { sessionMod, autoMixMod, runToCompletion } = env;
    await armPair(env, null);

    autoMixMod.checkAutoMixTrigger('deck-0', 90);

    // Byte-identical to before phase 7b: no seek, no extra settle, the deck plays in the
    // same tick the trigger fires in.
    expect(seekDeck).not.toHaveBeenCalled();
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
    runToCompletion(100);
    expect(get(sessionMod.session).crossfaderValue).toBe(1);
  });

  it("ignores Digger's auto-derived sub-second mix_in rather than seeking to it", async () => {
    const env = await setup();
    const { sessionMod, autoMixMod } = env;
    // _derive_mix_points() writes mix_in = beat_times[0] — the first tracked beat. Seeking
    // 0.43s into the track would be a pointless IPC round trip and a needless 200ms delay
    // on every transition in the library.
    await armPair(env, 0.43);

    autoMixMod.checkAutoMixTrigger('deck-0', 90);

    expect(seekDeck).not.toHaveBeenCalled();
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
  });

  it('ignores a mix-in marker past the first third of the incoming track', async () => {
    const env = await setup();
    const { sessionMod, autoMixMod } = env;
    // Same ceiling introZoneSec applies to the duration: a "mix in" halfway through a track
    // is as untrustworthy as a "mix out" in its first third, and starting there would skip
    // half the track the DJ queued.
    await armPair(env, 50);

    autoMixMod.checkAutoMixTrigger('deck-0', 90);

    expect(seekDeck).not.toHaveBeenCalled();
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
  });

  it('seeks to the mix-in marker inside the rate settle, not before the rate write, on the beatmatched path', async () => {
    const env = await setup();
    const { sessionMod, autoDjMod, autoMixMod, resetSession, runToCompletion } = env;
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixSyncEnabled.set(true);
    autoMixMod.autoMixThresholdSec.set(15);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession(
      [
        baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), bpm: 120, downbeat: 0 }),
        baseDeck('deck-1', { source: videoSource('b.mp4', 100), bpm: 128, downbeat: 0, mixInStart: 10 }),
      ],
      { bpm: 120, masterDeckId: 'deck-0' },
    );

    autoMixMod.checkAutoMixTrigger('deck-0', 90);

    // The rate write lands in the trigger's own tick; the seek must NOT. On the legacy
    // <video> path the rate write rebuilds the WebKit pipeline, and that rebuild re-reads
    // GStreamer's still-pre-seek position over `v.currentTime` — a seek issued just before
    // it is silently undone (av-sync-architecture.md, "Rate-then-seek ordering").
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playbackRate).toBeCloseTo(120 / 128);
    expect(seekDeck).not.toHaveBeenCalled();
    expect(nudgePhaseToMaster).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 250)); // rate settle
    // It costs no extra stage: the seek happens here, and nudgePhaseToMaster — which
    // corrects *relative to the deck's current position*, synchronously visible through
    // seekBus — then refines this position instead of needing a window of its own.
    expect(seekDeck).toHaveBeenCalledWith('deck-1', 10, true);
    expect(nudgePhaseToMaster).toHaveBeenCalledWith('deck-1');
    expect(seekDeck.mock.invocationCallOrder[0]).toBeLessThan(nudgePhaseToMaster.mock.invocationCallOrder[0]);
    await new Promise((r) => setTimeout(r, 250)); // nudge-seek settle
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
    runToCompletion(1000);
    expect(get(sessionMod.session).crossfaderValue).toBe(1);
  });

  it('abandons the transition if the DJ touches the fader during the mix-in seek settle', async () => {
    const env = await setup();
    const { sessionMod, autoMixMod, rafQueue } = env;
    await armPair(env, 10);

    autoMixMod.checkAutoMixTrigger('deck-0', 90);
    autoMixMod.notifyManualCrossfaderTouch(); // DJ grabs the fader inside the new window

    await new Promise((r) => setTimeout(r, 250));
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(false);
    expect(rafQueue.length).toBe(0); // no ramp was ever scheduled
  });

  it('Preview positions the incoming deck exactly as the live path does', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(false); // preview is a workshopping tool, not automation
    autoMixMod.autoMixThresholdSec.set(15);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession([
      baseDeck('deck-0', { source: videoSource('a.mp4', 200), mixOutStart: 180 }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 200), mixInStart: 20 }),
    ]);

    autoMixMod.previewTransition('deck-0');

    // Preview still resets the incoming deck to 0 first, so a second press auditions the
    // same thing as the first...
    expect(seekDeck).toHaveBeenCalledWith('deck-1', 0, true);
    expect(seekDeck).not.toHaveBeenCalledWith('deck-1', 20, true);

    // ...and then the shared beginTransition puts it at its mix-in marker, which is the
    // asymmetry phase 6 deliberately shipped and phase 7b removes.
    await new Promise((r) => setTimeout(r, 250));
    expect(seekDeck).toHaveBeenCalledWith('deck-1', 20, true);
  });
});

describe('tempo drift-back after a beatmatched transition (Phase 5)', () => {
  /** deck-0 (120bpm, master) fades into deck-1 (128bpm) with beatmatch on — deck-1 gets
   *  locked to rate 120/128 = 0.9375, then the ramp runs to completion. */
  async function runSyncedTransition(env: Awaited<ReturnType<typeof setup>>, driftSec: number) {
    const { sessionMod, autoDjMod, autoMixMod, resetSession, runToCompletion } = env;
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixSyncEnabled.set(true);
    autoMixMod.autoMixDriftBackSec.set(driftSec);
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession(
      [
        baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), bpm: 120, downbeat: 0 }),
        baseDeck('deck-1', { source: videoSource('b.mp4', 100), bpm: 128, downbeat: 0 }),
      ],
      { bpm: 120, masterDeckId: 'deck-0' },
    );

    autoMixMod.checkAutoMixTrigger('deck-0', 90);
    await new Promise((r) => setTimeout(r, 250)); // rate settle
    await new Promise((r) => setTimeout(r, 250)); // seek settle
    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playbackRate).toBeCloseTo(0.9375);
    runToCompletion(100); // ramp, then the drift-back's own frames
  }

  it('eases the now-solo deck back to its native tempo and clears syncLocked', async () => {
    const env = await setup();
    await runSyncedTransition(env, 2);

    const deck1 = get(env.sessionMod.session).decks.find((d) => d.id === 'deck-1')!;
    expect(deck1.playbackRate).toBe(1);
    expect(deck1.syncLocked).toBe(false);
    // …and the main-beat reference walks back with it, which is the whole point: without
    // this, Session.bpm stays at deck-1's *adjusted* 120 and the next transition locks
    // deck C to that instead of to 128.
    expect(get(env.sessionMod.session).bpm).toBeCloseTo(128);
  });

  it('leaves the locked rate alone when the drift-back is off (pre-phase-5 behavior)', async () => {
    const env = await setup();
    await runSyncedTransition(env, 0);

    const deck1 = get(env.sessionMod.session).decks.find((d) => d.id === 'deck-1')!;
    expect(deck1.playbackRate).toBeCloseTo(0.9375);
    expect(deck1.syncLocked).toBe(true);
    expect(get(env.sessionMod.session).bpm).toBeCloseTo(120); // the compounding reference
  });

  it('is cancelled by a manual rate input, leaving the deck where the DJ put it', async () => {
    const env = await setup();
    const { sessionMod, autoDjMod, autoMixMod, resetSession, driveFrame } = env;
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixSyncEnabled.set(true);
    autoMixMod.autoMixDriftBackSec.set(20); // long enough to interrupt mid-ease
    autoMixMod.crossfadeDurationMs.set(1000);
    resetSession(
      [
        baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), bpm: 120, downbeat: 0 }),
        baseDeck('deck-1', { source: videoSource('b.mp4', 100), bpm: 128, downbeat: 0 }),
      ],
      { bpm: 120, masterDeckId: 'deck-0' },
    );

    autoMixMod.checkAutoMixTrigger('deck-0', 90);
    await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 250));
    driveFrame(1100); // ramp completes, drift-back starts
    driveFrame(4000); // ~20% of the way back
    const easing = get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playbackRate;
    expect(easing).toBeGreaterThan(0.9375);
    expect(easing).toBeLessThan(1);

    // The DJ grabs the tempo slider (DeckCard writes straight to the store).
    sessionMod.updateDeck('deck-1', { playbackRate: 0.97, syncLocked: false });
    driveFrame(4000);
    driveFrame(4000);

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playbackRate).toBe(0.97);
    expect(env.rafQueue.length).toBe(0); // the drift loop stopped, nothing dangling
  });

  it('gives the next transition a settled reference instead of a compounding one', async () => {
    const env = await setup();
    const { sessionMod, autoMixMod } = env;
    await runSyncedTransition(env, 2);
    expect(get(sessionMod.session).bpm).toBeCloseTo(128);

    // Second transition: deck-1 (now solo/master at native 128) into a fresh 100bpm track
    // on deck-0. The lock rate must derive from 128, not from the 120 the first transition
    // left behind.
    sessionMod.updateDeck('deck-0', { source: videoSource('c.mp4', 100), bpm: 100, downbeat: 0, playing: false });
    autoMixMod.checkAutoMixTrigger('deck-1', 90);

    const deck0 = get(sessionMod.session).decks.find((d) => d.id === 'deck-0')!;
    expect(deck0.syncLocked).toBe(true);
    expect(deck0.playbackRate).toBeCloseTo(128 / 100);
  });
});

describe('skipUpcomingTrack (Tier 2, silent — the "change what\'s next" control)', () => {
  it('marks the currently-preloaded track skipped and loads a fresh pick with origin "auto"', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    const fresh = { id: 2, track_id: 8, title: 'Fresh', artist: 'B' };
    getQueue.mockResolvedValue([{ id: 1, track_id: 7, title: 'Current', artist: 'A' }, fresh]);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), diggerTrackId: 7 }),
      baseDeck('deck-1', { source: videoSource('preloaded.mp4', 200), diggerTrackId: 20 }),
    ]);

    await autoMixMod.skipUpcomingTrack();

    expect(markSkipped).toHaveBeenCalledWith(20);
    expect(loadQueueItemToDeck).toHaveBeenCalledWith(fresh, 'deck-1', 'auto');
  });

  it('loads a fresh pick onto whichever mapped deck is genuinely empty, without marking anything skipped', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    const next = { id: 1, track_id: 7, title: 'T', artist: 'A' };
    getQueue.mockResolvedValue([next]);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), diggerTrackId: 5 }),
      baseDeck('deck-1', { source: null }),
    ]);

    await autoMixMod.skipUpcomingTrack();

    expect(markSkipped).not.toHaveBeenCalled();
    expect(loadQueueItemToDeck).toHaveBeenCalledWith(next, 'deck-1', 'auto');
  });

  it('does nothing when both mapped decks are already playing', async () => {
    const { autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { playing: true, source: videoSource('b.mp4', 100) }),
    ]);

    await autoMixMod.skipUpcomingTrack();

    expect(loadQueueItemToDeck).not.toHaveBeenCalled();
  });
});

describe('structural disengage (Tier 3, alert)', () => {
  it('disengages Auto DJ and alerts when a mapped deck is removed from the session', async () => {
    const { autoDjMod, sessionMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: null }),
    ]);
    expect(get(autoDjMod.autoDjEnabled)).toBe(true);

    sessionMod.removeDeck('deck-1');

    expect(get(autoDjMod.autoDjEnabled)).toBe(false);
  });

  it('leaves Auto DJ on when an unrelated (non-mapped) deck is removed', async () => {
    const { autoDjMod, sessionMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100) }),
      baseDeck('deck-1', { source: null }),
      baseDeck('deck-2', { source: null }),
    ]);

    sessionMod.removeDeck('deck-2');

    expect(get(autoDjMod.autoDjEnabled)).toBe(true);
  });
});

// ── Phase 8 (2026-09-20): one resolver, two rules ────────────────────────────────────
// `effectiveZones` replaced the exported `outroZoneSec`/`introZoneSec` pair so that the
// marker panel and the engine cannot disagree about which markers count (design review
// A4). The tests that matter most here are the two that the old one-rule-for-everything
// model got wrong: a point that is a fine START but a useless ZONE, and a zone measured
// from its own start rather than from the track's.
describe('effectiveZones (the one place every trust rule lives)', () => {
  const z = (o: Partial<{ duration: number; mixOutStart: number | null; mixOutEnd: number | null; mixInStart: number | null; mixInEnd: number | null }> = {}) =>
    ({ duration: 200, mixOutStart: null, mixOutEnd: null, mixInStart: null, mixInEnd: null, ...o });

  it('reports the usable length of each zone', async () => {
    const { autoMixMod } = await setup();
    const e = autoMixMod.effectiveZones(z({ mixOutStart: 180, mixInStart: 4, mixInEnd: 16 }));
    expect(e.outLenSec).toBe(20); // mixOutEnd null -> the track's own end
    expect(e.inLenSec).toBe(12);  // measured from 4, not from 0
    expect(e.outStart).toBe(180);
    expect(e.inStart).toBe(4);
    expect(e.nearEnd).toBe(180);
  });

  it('accepts a sub-MIN_ZONE_SEC mix-in as a START while rejecting it as a ZONE', async () => {
    // The rule split, stated as an assertion. A track with a hard first downbeat has a
    // perfectly good mix-in at 0.5s and no usable 0.5s blend zone; the single
    // `introZoneSec` gate rejected it as both, so Phase 7b could never start a deck there.
    const { autoMixMod } = await setup();
    const e = autoMixMod.effectiveZones(z({ mixInStart: 0.5 }));
    expect(e.inStart).toBe(0.5);
    expect(e.inLenSec).toBeNull();
  });

  it('rejects a mix-in start past the first third, as a start AND as a zone', async () => {
    const { autoMixMod } = await setup();
    const e = autoMixMod.effectiveZones(z({ mixInStart: 120, mixInEnd: 140 }));
    expect(e.inStart).toBeNull();
    expect(e.inLenSec).toBeNull();
    expect(e.inRejected).toMatch(/first third/);
  });

  it('rejects a mix-out inside the first third but still never reports past EOS', async () => {
    const { autoMixMod } = await setup();
    expect(autoMixMod.effectiveZones(z({ mixOutStart: 50 })).outStart).toBeNull();
    expect(autoMixMod.effectiveZones(z({ mixOutStart: 50 })).nearEnd).toBe(200);
    // A stale marker past the end is clamped rather than pushing the trigger past EOS.
    expect(autoMixMod.effectiveZones(z({ mixOutStart: 260 })).nearEnd).toBe(200);
  });

  it('reports a sub-2s zone as rejected rather than as a tiny zone', async () => {
    const { autoMixMod } = await setup();
    const e = autoMixMod.effectiveZones(z({ mixOutStart: 199 }));
    expect(e.outLenSec).toBeNull();
    expect(e.outStart).toBe(199); // still a valid point — the trigger still measures here
    expect(e.outRejected).toMatch(/under 2s/);
  });

  it('distinguishes a half-placed zone from a rejected one', async () => {
    // What the marker panel needs to say something useful: "you have not set the end yet"
    // is a different message from "your zone is too short to blend over".
    const { autoMixMod } = await setup();
    expect(autoMixMod.effectiveZones(z({ mixInStart: 10 })).inRejected).toBe('no end marker');
    expect(autoMixMod.effectiveZones(z({ mixInStart: 10, mixInEnd: 11 })).inRejected).toMatch(/under 2s/);
    expect(autoMixMod.effectiveZones(z()).inRejected).toBeNull(); // nothing placed, nothing to explain
  });

  it('returns a neutral result for a deck with no measured duration', async () => {
    const { autoMixMod } = await setup();
    const e = autoMixMod.effectiveZones(z({ duration: 0, mixOutStart: 180, mixInStart: 4, mixInEnd: 16 }));
    expect(e).toEqual({ inStart: null, inLenSec: null, outStart: null, outLenSec: null, nearEnd: 0, inRejected: null, outRejected: null });
  });
});
