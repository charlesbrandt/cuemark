import { describe, it, expect } from 'vitest';
import { buildVizPickerItems, groupPickerItems, filterPickerItems, stepSelection, thumbGradient } from './vizPicker';

const builtins = [
  { id: 'builtin:plasma', name: 'Plasma' },
  { id: 'builtin:tunnel', name: 'Tunnel' },
];

describe('buildVizPickerItems', () => {
  it('puts everything into Milkdrop or Shaders (ISF), never a third group', () => {
    const items = buildVizPickerItems(builtins, [], [], {});
    expect(items.every((i) => i.group === 'Milkdrop' || i.group === 'Shaders (ISF)')).toBe(true);
  });

  it('tags built-ins builtin:true and lists disk ISF plugins ahead of them', () => {
    const isf = [{ id: 'starfield.fs', name: 'Starfield' }];
    const items = buildVizPickerItems(builtins, isf, [], {});
    const shaders = items.filter((i) => i.group === 'Shaders (ISF)');
    expect(shaders.map((i) => i.id)).toEqual(['starfield.fs', 'builtin:plasma', 'builtin:tunnel']);
    expect(shaders.find((i) => i.id === 'starfield.fs')?.builtin).toBe(false);
    expect(shaders.filter((i) => i.id.startsWith('builtin:')).every((i) => i.builtin)).toBe(true);
  });

  it('puts Milkdrop presets in the Milkdrop group, not builtin', () => {
    const milk = [{ id: 'milkdrop/foo.json', name: 'Foo' }];
    const items = buildVizPickerItems(builtins, [], milk, {});
    expect(items.find((i) => i.id === 'milkdrop/foo.json')).toEqual({
      id: 'milkdrop/foo.json', name: 'Foo', group: 'Milkdrop', builtin: false, broken: false, title: undefined, thumbnailPath: null,
    });
  });

  it('marks a plugin broken via live errors with the live message as the title', () => {
    const isf = [{ id: 'broken.fs', name: 'Broken' }];
    const items = buildVizPickerItems(builtins, isf, [], { 'broken.fs': 'compile: bad' });
    const it_ = items.find((i) => i.id === 'broken.fs')!;
    expect(it_.broken).toBe(true);
    expect(it_.title).toBe('compile: bad');
  });

  it('marks a plugin broken via a discovery-time .error even with no live errors entry', () => {
    const isf = [{ id: 'bad-header.fs', name: 'BadHeader', error: 'could not parse header' }];
    const items = buildVizPickerItems(builtins, isf, [], {});
    const it_ = items.find((i) => i.id === 'bad-header.fs')!;
    expect(it_.broken).toBe(true);
    expect(it_.title).toBe('could not parse header');
  });

  it('prefers live errors over a stale discovery-time .error', () => {
    const isf = [{ id: 'x.fs', name: 'X', error: 'stale' }];
    const items = buildVizPickerItems(builtins, isf, [], { 'x.fs': 'live' });
    expect(items.find((i) => i.id === 'x.fs')?.title).toBe('live');
  });

  it('shows description/credit as the tooltip for a healthy plugin, undefined with neither', () => {
    const isf = [
      { id: 'ok.fs', name: 'OK', description: 'a nice shader', credit: 'by someone' },
      { id: 'plain.fs', name: 'Plain' },
    ];
    const items = buildVizPickerItems(builtins, isf, [], {});
    expect(items.find((i) => i.id === 'ok.fs')?.title).toBe('a nice shader — by someone');
    expect(items.find((i) => i.id === 'plain.fs')?.title).toBeUndefined();
  });
});

describe('groupPickerItems', () => {
  it('orders Milkdrop before Shaders (ISF) and omits an empty group', () => {
    const items = buildVizPickerItems(builtins, [], [], {});
    const groups = groupPickerItems(items);
    expect(groups.map((g) => g.label)).toEqual(['Shaders (ISF)']);
  });

  it('includes both groups, in order, when both are non-empty', () => {
    const milk = [{ id: 'milkdrop/foo.json', name: 'Foo' }];
    const items = buildVizPickerItems(builtins, [], milk, {});
    const groups = groupPickerItems(items);
    expect(groups.map((g) => g.label)).toEqual(['Milkdrop', 'Shaders (ISF)']);
  });
});

describe('filterPickerItems', () => {
  const milk = [{ id: 'milkdrop/foo.json', name: 'Foo Preset' }];
  const isf = [{ id: 'starfield.fs', name: 'Starfield' }];
  const items = buildVizPickerItems(builtins, isf, milk, {});

  it('"all" with no query returns everything', () => {
    expect(filterPickerItems(items, 'all', new Set(), '')).toHaveLength(items.length);
  });

  it('filters to one group by label', () => {
    const shaders = filterPickerItems(items, 'Shaders (ISF)', new Set(), '');
    expect(shaders.every((i) => i.group === 'Shaders (ISF)')).toBe(true);
    expect(shaders).toHaveLength(3); // starfield + 2 builtins
  });

  it('filters to favorites by id, regardless of group', () => {
    const favs = filterPickerItems(items, 'favorites', new Set(['builtin:plasma', 'milkdrop/foo.json']), '');
    expect(favs.map((i) => i.id).sort()).toEqual(['builtin:plasma', 'milkdrop/foo.json']);
  });

  it('search matches the name case-insensitively', () => {
    const found = filterPickerItems(items, 'all', new Set(), 'STAR');
    expect(found.map((i) => i.id)).toEqual(['starfield.fs']);
  });

  it('combines a group filter with a search query', () => {
    const found = filterPickerItems(items, 'Milkdrop', new Set(), 'foo');
    expect(found.map((i) => i.id)).toEqual(['milkdrop/foo.json']);
    expect(filterPickerItems(items, 'Milkdrop', new Set(), 'star')).toHaveLength(0);
  });
});

describe('stepSelection', () => {
  const items = buildVizPickerItems(builtins, [], [], {}); // plasma, tunnel

  it('steps forward and wraps', () => {
    expect(stepSelection(items, 'builtin:plasma', 1)).toBe('builtin:tunnel');
    expect(stepSelection(items, 'builtin:tunnel', 1)).toBe('builtin:plasma');
  });

  it('steps backward and wraps', () => {
    expect(stepSelection(items, 'builtin:plasma', -1)).toBe('builtin:tunnel');
    expect(stepSelection(items, 'builtin:tunnel', -1)).toBe('builtin:plasma');
  });

  it('lands on the first item stepping forward when nothing is selected', () => {
    expect(stepSelection(items, null, 1)).toBe('builtin:plasma');
  });

  it('lands on the last item stepping backward when the current id is not in the list', () => {
    expect(stepSelection(items, 'not-here', -1)).toBe('builtin:tunnel');
  });

  it('returns null for an empty list', () => {
    expect(stepSelection([], 'anything', 1)).toBeNull();
  });
});

describe('thumbGradient', () => {
  it('is deterministic for the same id', () => {
    expect(thumbGradient('builtin:plasma')).toBe(thumbGradient('builtin:plasma'));
  });

  it('returns a CSS radial-gradient string', () => {
    expect(thumbGradient('builtin:plasma')).toContain('radial-gradient');
  });

  it('differs between two different ids (not a constant)', () => {
    expect(thumbGradient('builtin:plasma')).not.toBe(thumbGradient('builtin:tunnel'));
  });
});
