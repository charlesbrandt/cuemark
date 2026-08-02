/**
 * Covers the main-beat auto-promotion / live-tracking / sync-lock logic in session.ts:
 * reconcileMaster (auto-promote solo player, follow the solo survivor when master stops),
 * refreshMasterBpm (session.bpm stays live instead of a frozen snapshot), and
 * applyLockedRates (syncLocked decks continuously follow session.bpm).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { session, updateDeck, setMasterDeck, setMasterBpm, removeDeck, getDeck } from './session';
import type { Session } from './types';

function baseDeck(id: string, overrides: Partial<Session['decks'][number]> = {}) {
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
    cueEnabled: false,
    syncLocked: false,
    ...overrides,
  };
}

function resetSession(decks: ReturnType<typeof baseDeck>[]) {
  session.set({
    decks,
    masterVolume: 1.0,
    bpm: null,
    masterDeckId: null,
    crossfaderMapping: { left: 'deck-0', right: 'deck-1' },
    midiMapping: { left: 'deck-0', right: 'deck-1' },
    crossfaderValue: 0.5,
    crossfaderTargets: ['opacity', 'volume'],
    audioCurve: 'equal-power',
    visualCurve: 'linear',
    snapToBeat: false,
    effects: [],
    visualization: null,
    visualizationOpacity: 0.5,
  });
}

beforeEach(() => {
  resetSession([baseDeck('deck-0'), baseDeck('deck-1')]);
});

describe('reconcileMaster (auto-promotion)', () => {
  it('promotes the only playing deck to main beat once its bpm is known', () => {
    updateDeck('deck-0', { bpm: 120, playing: true });
    const s = get(session);
    expect(s.masterDeckId).toBe('deck-0');
    expect(s.bpm).toBe(120);
  });

  it('does not promote a deck with no bpm yet, then promotes once bpm arrives', () => {
    updateDeck('deck-0', { playing: true });
    expect(get(session).masterDeckId).toBeNull();

    updateDeck('deck-0', { bpm: 128 });
    expect(get(session).masterDeckId).toBe('deck-0');
    expect(get(session).bpm).toBe(128);
  });

  it('leaves the reference untouched while two decks are playing', () => {
    updateDeck('deck-0', { bpm: 120, playing: true });
    updateDeck('deck-1', { bpm: 128, playing: true });
    expect(get(session).masterDeckId).toBe('deck-0');
  });

  it('reassigns to the solo survivor when the master stops', () => {
    updateDeck('deck-0', { bpm: 120, playing: true });
    updateDeck('deck-1', { bpm: 128, playing: true });
    expect(get(session).masterDeckId).toBe('deck-0'); // unchanged while both play

    updateDeck('deck-0', { playing: false });
    expect(get(session).masterDeckId).toBe('deck-1');
    expect(get(session).bpm).toBe(128);
  });

  it('stays sticky when the last deck stops (zero playing)', () => {
    updateDeck('deck-0', { bpm: 120, playing: true });
    updateDeck('deck-0', { playing: false });
    expect(get(session).masterDeckId).toBe('deck-0');
    expect(get(session).bpm).toBe(120);
  });
});

describe('refreshMasterBpm (live tracking)', () => {
  it('keeps session.bpm derived from the master deck as its rate changes', () => {
    setMasterDeck(null); // no-op guard
    updateDeck('deck-0', { bpm: 120 });
    setMasterDeck('deck-0');
    expect(get(session).bpm).toBe(120);

    updateDeck('deck-0', { playbackRate: 1.05 });
    expect(get(session).bpm).toBeCloseTo(126, 5);
  });

  it('does not touch bpm for patches to a non-master deck', () => {
    updateDeck('deck-0', { bpm: 120 });
    setMasterDeck('deck-0');
    updateDeck('deck-1', { bpm: 140, playbackRate: 1.1 });
    expect(get(session).bpm).toBe(120);
  });
});

describe('setMasterDeck / setMasterBpm', () => {
  it('is a no-op when the deck has no bpm', () => {
    setMasterDeck('deck-0');
    expect(get(session).masterDeckId).toBeNull();
  });

  it('tap tempo clears masterDeckId (independent manual reference)', () => {
    updateDeck('deck-0', { bpm: 120 });
    setMasterDeck('deck-0');
    expect(get(session).masterDeckId).toBe('deck-0');

    setMasterBpm(140);
    expect(get(session).masterDeckId).toBeNull();
    expect(get(session).bpm).toBe(140);
  });
});

describe('applyLockedRates (sync lock)', () => {
  it('recomputes a locked deck rate when the master reassigns', () => {
    updateDeck('deck-0', { bpm: 120 });
    updateDeck('deck-1', { bpm: 130, syncLocked: true });
    setMasterDeck('deck-0');
    expect(getDeck('deck-1')?.playbackRate).toBeCloseTo(120 / 130, 5);

    // Master's own rate moves — locked deck should follow live.
    updateDeck('deck-0', { playbackRate: 1.1 });
    expect(getDeck('deck-1')?.playbackRate).toBeCloseTo((120 * 1.1) / 130, 5);
  });

  it('never rewrites the master deck itself even if flagged syncLocked', () => {
    updateDeck('deck-0', { bpm: 120, syncLocked: true });
    setMasterDeck('deck-0');
    expect(getDeck('deck-0')?.playbackRate).toBe(1.0);
  });

  it('follows a master reassignment away from the deck it was locked to', () => {
    updateDeck('deck-0', { bpm: 120 });
    updateDeck('deck-1', { bpm: 100 });
    updateDeck('deck-1', { syncLocked: true });
    setMasterDeck('deck-0');
    expect(getDeck('deck-1')?.playbackRate).toBeCloseTo(1.2, 5);

    const deck2 = baseDeck('deck-2', { bpm: 150 });
    resetSession([...get(session).decks, deck2]);
    updateDeck('deck-2', { bpm: 150 });
    setMasterDeck('deck-2');
    expect(getDeck('deck-1')?.playbackRate).toBeCloseTo(150 / 100, 5);
  });
});

describe('removeDeck', () => {
  it('clears masterDeckId when the master deck is removed', () => {
    updateDeck('deck-0', { bpm: 120 });
    setMasterDeck('deck-0');
    removeDeck('deck-0');
    expect(get(session).masterDeckId).toBeNull();
  });

  it('promotes the solo survivor after the master is removed', () => {
    updateDeck('deck-0', { bpm: 120, playing: true });
    updateDeck('deck-1', { bpm: 130, playing: true });
    removeDeck('deck-0');
    expect(get(session).masterDeckId).toBe('deck-1');
    expect(get(session).bpm).toBe(130);
  });
});
