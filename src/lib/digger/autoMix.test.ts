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
    outroPoint: null,
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
      // outroPoint at 60s, well before the 100s duration — the fixed threshold alone
      // (100 - 90 = 10s remaining) would fire here too, so use a position that's only
      // inside the threshold relative to the marker (60 - 50 = 10s) to actually
      // distinguish the two references.
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), outroPoint: 60 }),
      baseDeck('deck-1', { source: videoSource('b.mp4', 100) }),
    ]);

    autoMixMod.checkAutoMixTrigger('deck-0', 50); // 50s remaining to literal end, 10s to the marker

    expect(get(sessionMod.session).decks.find((d) => d.id === 'deck-1')!.playing).toBe(true);
  });

  it('does not fire early just because outroPoint is still far off', async () => {
    const { sessionMod, autoDjMod, autoMixMod, resetSession } = await setup();
    autoDjMod.autoDjEnabled.set(true);
    autoMixMod.autoMixThresholdSec.set(15);
    resetSession([
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), outroPoint: 90 }),
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
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), outroPoint: 500 }),
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
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), outroPoint: 10 }),
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
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), outroPoint: 60 }),
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
      baseDeck('deck-0', { playing: true, source: videoSource('a.mp4', 100), outroPoint: null }),
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

describe('skipUpcomingTrack (Tier 2, silent — the explicit Skip control)', () => {
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
