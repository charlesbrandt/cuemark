/**
 * slotDeck() is the seam the whole profile refactor depends on: it resolves a
 * controller's (profile, slot) to a software deck id, defaulting to slot-i -> decks[i]
 * when a profile has no explicit routing yet — see docs/design/controller-mapping.md
 * §3.2/§4 and Session.midiMapping's doc comment in state/types.ts.
 */
import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { session, setMidiSlot } from '../state/session';
import { slotDeck } from './handler';
import type { Session } from '../state/types';

function baseDeck(id: string) {
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
  };
}

function resetSession(decks: ReturnType<typeof baseDeck>[], midiMapping: Session['midiMapping'] = {}) {
  session.set({
    decks,
    masterVolume: 1.0,
    bpm: null,
    masterDeckId: null,
    crossfaderMapping: { left: 'deck-0', right: 'deck-1' },
    midiMapping,
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

describe('slotDeck', () => {
  it('returns undefined when slot is undefined (global controls have no deck)', () => {
    resetSession([baseDeck('deck-0'), baseDeck('deck-1')]);
    expect(slotDeck('hercules-starlight', undefined)).toBeUndefined();
  });

  it('defaults to slot i -> decks[i] when the profile has no explicit routing', () => {
    resetSession([baseDeck('deck-0'), baseDeck('deck-1'), baseDeck('deck-2')]);
    expect(slotDeck('hercules-starlight', 0)).toBe('deck-0');
    expect(slotDeck('hercules-starlight', 1)).toBe('deck-1');
    expect(slotDeck('pioneer-ddj-flx4', 0)).toBe('deck-0');
  });

  it('honors an explicit per-profile routing over the default', () => {
    resetSession([baseDeck('deck-0'), baseDeck('deck-1'), baseDeck('deck-2')]);
    setMidiSlot('hercules-starlight', 0, 'deck-2');
    expect(slotDeck('hercules-starlight', 0)).toBe('deck-2');
    // Untouched slot on the same profile still defaults.
    expect(slotDeck('hercules-starlight', 1)).toBe('deck-1');
  });

  it('two profiles route independently — the whole point of slot-based routing', () => {
    resetSession([baseDeck('deck-0'), baseDeck('deck-1'), baseDeck('deck-2'), baseDeck('deck-3')]);
    setMidiSlot('hercules-starlight', 0, 'deck-0');
    setMidiSlot('hercules-starlight', 1, 'deck-1');
    setMidiSlot('pioneer-ddj-flx4', 0, 'deck-2');
    setMidiSlot('pioneer-ddj-flx4', 1, 'deck-3');
    expect(slotDeck('hercules-starlight', 0)).toBe('deck-0');
    expect(slotDeck('pioneer-ddj-flx4', 0)).toBe('deck-2');
    expect(get(session).midiMapping['hercules-starlight']).toEqual(['deck-0', 'deck-1']);
    expect(get(session).midiMapping['pioneer-ddj-flx4']).toEqual(['deck-2', 'deck-3']);
  });

  it('falls back to default when the routed array is shorter than the requested slot', () => {
    resetSession([baseDeck('deck-0'), baseDeck('deck-1')]);
    setMidiSlot('hercules-starlight', 0, 'deck-1'); // only slot 0 explicitly set
    expect(slotDeck('hercules-starlight', 1)).toBe('deck-1'); // falls back to decks[1]
  });
});
