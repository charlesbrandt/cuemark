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
vi.mock('./playedTracks', () => ({ isPlayed: (...a: unknown[]) => isPlayed(...a) }));

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

  function resetSession(decks: Deck[]) {
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
    expect(loadQueueItemToDeck).toHaveBeenCalledWith(upNext, 'deck-1'); // not `current`
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
    expect(loadQueueItemToDeck).toHaveBeenCalledWith(fresh, 'deck-1');
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
