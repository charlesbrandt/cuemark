import { describe, it, expect } from 'vitest';
import { buildVizOptionGroups } from './vizPicker';

const builtins = [
  { id: 'builtin:plasma', name: 'Plasma' },
  { id: 'builtin:tunnel', name: 'Tunnel' },
];

describe('buildVizOptionGroups', () => {
  it('always includes Built-in, omits empty Plugins/Milkdrop groups', () => {
    const groups = buildVizOptionGroups(builtins, [], [], {});
    expect(groups).toEqual([
      { label: 'Built-in', options: [
        { id: 'builtin:plasma', label: 'Plasma' },
        { id: 'builtin:tunnel', label: 'Tunnel' },
      ] },
    ]);
  });

  it('includes non-empty Plugins and Milkdrop groups in order', () => {
    const isf = [{ id: 'starfield.fs', name: 'Starfield' }];
    const milk = [{ id: 'milkdrop/foo.json', name: 'Foo' }];
    const groups = buildVizOptionGroups(builtins, isf, milk, {});
    expect(groups.map((g) => g.label)).toEqual(['Built-in', 'Plugins', 'Milkdrop']);
    expect(groups[1].options).toEqual([{ id: 'starfield.fs', label: 'Starfield' }]);
    expect(groups[2].options).toEqual([{ id: 'milkdrop/foo.json', label: 'Foo' }]);
  });

  it('marks a plugin broken via live vizErrors with a trailing warning and error tooltip', () => {
    const isf = [{ id: 'broken.fs', name: 'Broken' }];
    const groups = buildVizOptionGroups(builtins, isf, [], { 'broken.fs': 'compile: bad' });
    expect(groups[1].options).toEqual([{ id: 'broken.fs', label: 'Broken ⚠', title: 'compile: bad' }]);
  });

  it('marks a plugin broken via a discovery-time .error even with no live vizErrors entry', () => {
    const isf = [{ id: 'bad-header.fs', name: 'BadHeader', error: 'could not parse header' }];
    const groups = buildVizOptionGroups(builtins, isf, [], {});
    expect(groups[1].options).toEqual([{ id: 'bad-header.fs', label: 'BadHeader ⚠', title: 'could not parse header' }]);
  });

  it('prefers live vizErrors over a stale discovery-time .error for the broken check and tooltip', () => {
    const isf = [{ id: 'x.fs', name: 'X', error: 'stale' }];
    const groups = buildVizOptionGroups(builtins, isf, [], { 'x.fs': 'live' });
    expect(groups[1].options).toEqual([{ id: 'x.fs', label: 'X ⚠', title: 'live' }]);
  });

  it('marks Milkdrop presets broken the same way as ISF plugins', () => {
    const milk = [{ id: 'milkdrop/broken.json', name: 'BrokenPreset', error: 'bad json' }];
    const groups = buildVizOptionGroups(builtins, [], milk, {});
    expect(groups[1]).toEqual({
      label: 'Milkdrop',
      options: [{ id: 'milkdrop/broken.json', label: 'BrokenPreset ⚠', title: 'bad json' }],
    });
  });

  it('shows description/credit as the tooltip for a healthy plugin', () => {
    const isf = [{ id: 'ok.fs', name: 'OK', description: 'a nice shader', credit: 'by someone' }];
    const groups = buildVizOptionGroups(builtins, isf, [], {});
    expect(groups[1].options).toEqual([{ id: 'ok.fs', label: 'OK', title: 'a nice shader — by someone' }]);
  });

  it('has no tooltip for a healthy plugin with no description or credit', () => {
    const isf = [{ id: 'ok.fs', name: 'OK' }];
    const groups = buildVizOptionGroups(builtins, isf, [], {});
    expect(groups[1].options[0].title).toBeUndefined();
  });
});
