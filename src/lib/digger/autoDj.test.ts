/**
 * Auto DJ toggle — regression coverage for handleDeckEos()'s branching (queue-first,
 * queueNext()-fallback, off-by-default no-op), isolated from the network/DOM/dialog
 * side effects loadQueueItemToDeck and the Digger API calls actually carry. See
 * autoDj.ts's doc comment for why the queue is fetched fresh rather than read off
 * the diggerQueue store.
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

import { autoDjEnabled, handleDeckEos } from './autoDj';
import { currentDj } from './djSelector';

beforeEach(() => {
  vi.clearAllMocks();
  getDeck.mockReturnValue(undefined);
  wasAutoMixTriggered.mockReturnValue(false);
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

  it('loads and consumes the front of the queue when non-empty', async () => {
    autoDjEnabled.set(true);
    const item = { id: 42, track_id: 7, title: 'Track', artist: 'Artist' };
    getQueue.mockResolvedValue([item]);

    await handleDeckEos('deck-0');

    expect(getQueue).toHaveBeenCalledWith(null);
    expect(loadQueueItemToDeck).toHaveBeenCalledWith(item, 'deck-0');
    expect(removeFromQueue).toHaveBeenCalledWith(42, null);
    expect(queueNext).not.toHaveBeenCalled();
    expect(updateDeck).toHaveBeenCalledWith('deck-0', { playing: true });
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
