/**
 * Auto DJ toggle — regression coverage for handleDeckEos()'s branching (queue-order
 * sourcing anchored on the current track, played-track skipping, queueNext()-fallback,
 * off-by-default no-op), isolated from the network/DOM/dialog side effects
 * loadQueueItemToDeck and the Digger API calls actually carry. See autoDj.ts's doc
 * comment for why the queue is fetched fresh rather than read off the diggerQueue store,
 * and pickNextTrack's own comment for why entries are no longer deleted as they're picked
 * (2026-08-24 — the queue is a set list a DJ wants to stay visible, not a work stack).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getQueue = vi.fn();
const queueNext = vi.fn();
const removeFromQueue = vi.fn().mockResolvedValue(undefined);
vi.mock('./api', () => ({ getQueue: (...a: unknown[]) => getQueue(...a), queueNext: (...a: unknown[]) => queueNext(...a), removeFromQueue: (...a: unknown[]) => removeFromQueue(...a) }));

const loadQueueItemToDeck = vi.fn().mockResolvedValue(undefined);
vi.mock('./queueStore', () => ({ loadQueueItemToDeck: (...a: unknown[]) => loadQueueItemToDeck(...a) }));

const updateDeck = vi.fn();
const getDeck = vi.fn().mockReturnValue(undefined);
vi.mock('../state/session', () => ({
  updateDeck: (...a: unknown[]) => updateDeck(...a),
  getDeck: (...a: unknown[]) => getDeck(...a),
}));

const wasAutoMixTriggered = vi.fn().mockReturnValue(false);
vi.mock('./autoMix', () => ({ wasAutoMixTriggered: (...a: unknown[]) => wasAutoMixTriggered(...a) }));

const isPlayed = vi.fn().mockReturnValue(false);
vi.mock('./playedTracks', () => ({ isPlayed: (...a: unknown[]) => isPlayed(...a) }));

import { autoDjEnabled, handleDeckEos } from './autoDj';
import { currentDj } from './djSelector';

beforeEach(() => {
  vi.clearAllMocks();
  getDeck.mockReturnValue(undefined);
  wasAutoMixTriggered.mockReturnValue(false);
  isPlayed.mockReturnValue(false);
  autoDjEnabled.set(false);
  currentDj.set('');
});

describe('handleDeckEos', () => {
  it('does nothing when Auto DJ is off', async () => {
    await handleDeckEos('deck-0');
    expect(getQueue).not.toHaveBeenCalled();
    expect(loadQueueItemToDeck).not.toHaveBeenCalled();
    expect(updateDeck).not.toHaveBeenCalled();
  });

  it('loads the front of the queue when non-empty, without removing it', async () => {
    autoDjEnabled.set(true);
    const item = { id: 42, track_id: 7, title: 'Track', artist: 'Artist' };
    getQueue.mockResolvedValue([item]);

    await handleDeckEos('deck-0');

    expect(getQueue).toHaveBeenCalledWith(null);
    expect(loadQueueItemToDeck).toHaveBeenCalledWith(item, 'deck-0');
    expect(removeFromQueue).not.toHaveBeenCalled(); // stays in the queue
    expect(queueNext).not.toHaveBeenCalled();
    expect(updateDeck).toHaveBeenCalledWith('deck-0', { playing: true });
  });

  it('skips entries already marked played and picks the first unplayed one', async () => {
    autoDjEnabled.set(true);
    const played = { id: 1, track_id: 7, title: 'Played', artist: 'A' };
    const fresh = { id: 2, track_id: 8, title: 'Fresh', artist: 'B' };
    getQueue.mockResolvedValue([played, fresh]);
    isPlayed.mockImplementation((id: number) => id === 7);

    await handleDeckEos('deck-0');

    expect(loadQueueItemToDeck).toHaveBeenCalledWith(fresh, 'deck-0');
  });

  it('anchors on the outgoing deck\'s current track and picks the next unplayed entry after it', async () => {
    autoDjEnabled.set(true);
    getDeck.mockReturnValue({ source: null, diggerTrackId: 7 }); // deck-0 was just playing track 7
    const current = { id: 1, track_id: 7, title: 'Current', artist: 'A' };
    const upNext = { id: 2, track_id: 8, title: 'Next', artist: 'B' };
    const laterStill = { id: 3, track_id: 9, title: 'Later', artist: 'C' };
    getQueue.mockResolvedValue([current, upNext, laterStill]);

    await handleDeckEos('deck-0');

    // Not the front of the queue (current) — the entry after it in queue order.
    expect(loadQueueItemToDeck).toHaveBeenCalledWith(upNext, 'deck-0');
  });

  it('falls back to the front of the queue when the current track has no anchor position', async () => {
    autoDjEnabled.set(true);
    getDeck.mockReturnValue({ source: null, diggerTrackId: 999 }); // not a queue entry (manual/search load)
    const item = { id: 1, track_id: 7, title: 'Track', artist: 'Artist' };
    getQueue.mockResolvedValue([item]);

    await handleDeckEos('deck-0');

    expect(loadQueueItemToDeck).toHaveBeenCalledWith(item, 'deck-0');
  });

  it('falls back to queueNext() when the queue is empty', async () => {
    autoDjEnabled.set(true);
    getQueue.mockResolvedValue([]);
    queueNext.mockResolvedValue({ id: 9, title: 'Suggested', artist: 'Someone' });

    await handleDeckEos('deck-1');

    expect(queueNext).toHaveBeenCalledWith(null);
    expect(loadQueueItemToDeck).toHaveBeenCalledWith(
      { track_id: 9, title: 'Suggested', artist: 'Someone' },
      'deck-1',
    );
    expect(removeFromQueue).not.toHaveBeenCalled();
    expect(updateDeck).toHaveBeenCalledWith('deck-1', { playing: true });
  });

  it('falls back to queueNext() when everything in the queue is already played', async () => {
    autoDjEnabled.set(true);
    getQueue.mockResolvedValue([{ id: 1, track_id: 7, title: 'Played', artist: 'A' }]);
    isPlayed.mockReturnValue(true);
    queueNext.mockResolvedValue({ id: 9, title: 'Suggested', artist: 'Someone' });

    await handleDeckEos('deck-1');

    expect(loadQueueItemToDeck).toHaveBeenCalledWith(
      { track_id: 9, title: 'Suggested', artist: 'Someone' },
      'deck-1',
    );
  });

  it('scopes the queue fetch to the current DJ', async () => {
    autoDjEnabled.set(true);
    currentDj.set('Guest');
    getQueue.mockResolvedValue([]);
    queueNext.mockResolvedValue({ id: 1, title: 'T', artist: 'A' });

    await handleDeckEos('deck-0');

    expect(getQueue).toHaveBeenCalledWith('Guest');
    expect(queueNext).toHaveBeenCalledWith('Guest');
  });

  it('logs and does not throw when Digger is unreachable', async () => {
    autoDjEnabled.set(true);
    getQueue.mockRejectedValue(new Error('network error'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleDeckEos('deck-0')).resolves.toBeUndefined();
    expect(updateDeck).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });
});
