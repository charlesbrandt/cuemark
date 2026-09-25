import { describe, it, expect } from 'vitest';
import type { IsfInput } from '../renderer/isf/parser';
import { describeInput, describeInputs, colorToHex, hexToColor } from './vizParamControls';

const inp = (o: Partial<IsfInput> & { NAME: string; TYPE: string }): IsfInput => o as IsfInput;

describe('describeInput', () => {
  it('float -> slider with MIN/MAX/DEFAULT', () => {
    const d = describeInput(inp({ NAME: 'speed', TYPE: 'float', MIN: 0, MAX: 10, DEFAULT: 2 }));
    expect(d).toMatchObject({ kind: 'slider', name: 'speed', axis: { min: 0, max: 10, default: 2, step: 0.05 } });
  });
  it('float without bounds uses 0..1', () => {
    const d = describeInput(inp({ NAME: 'x', TYPE: 'float' }));
    expect(d).toMatchObject({ kind: 'slider', axis: { min: 0, max: 1, default: 0 } });
  });
  it('bool -> toggle', () => {
    expect(describeInput(inp({ NAME: 'b', TYPE: 'bool', DEFAULT: true }))).toMatchObject({ kind: 'toggle', default: true });
  });
  it('long -> select with labels', () => {
    const d = describeInput(inp({ NAME: 'm', TYPE: 'long', VALUES: [0, 1], LABELS: ['A', 'B'], DEFAULT: 1 }));
    expect(d).toMatchObject({ kind: 'select', default: 1, options: [{ value: 0, label: 'A' }, { value: 1, label: 'B' }] });
  });
  it('long with no VALUES is skipped', () => {
    expect(describeInput(inp({ NAME: 'm', TYPE: 'long' }))).toBeNull();
  });
  it('color -> color with default', () => {
    expect(describeInput(inp({ NAME: 'c', TYPE: 'color', DEFAULT: [1, 0, 0, 0.5] }))).toMatchObject({ kind: 'color', default: [1, 0, 0, 0.5] });
  });
  it('point2D -> two axes, array bounds', () => {
    const d = describeInput(inp({ NAME: 'p', TYPE: 'point2D', MIN: [-1, 0], MAX: [1, 2], DEFAULT: [0, 1] }));
    expect(d).toMatchObject({ kind: 'point2d' });
    if (d?.kind === 'point2d') {
      expect(d.axes[0]).toMatchObject({ min: -1, max: 1, default: 0 });
      expect(d.axes[1]).toMatchObject({ min: 0, max: 2, default: 1 });
    }
  });
  it('point2D without bounds is 0..1', () => {
    const d = describeInput(inp({ NAME: 'p', TYPE: 'point2D' }));
    if (d?.kind === 'point2d') expect(d.axes[1]).toMatchObject({ min: 0, max: 1 });
    else throw new Error('wrong kind');
  });
  it('event -> button', () => {
    expect(describeInput(inp({ NAME: 'e', TYPE: 'event' }))).toMatchObject({ kind: 'button' });
  });
  it('hides CUEMARK_BIND inputs and skips unsupported types', () => {
    const list = describeInputs([
      inp({ NAME: 'bass', TYPE: 'float', CUEMARK_BIND: 'bass' }),
      inp({ NAME: 'img', TYPE: 'image' }),
      inp({ NAME: 'a', TYPE: 'audio' }),
      inp({ NAME: 'f', TYPE: 'audioFFT' }),
      inp({ NAME: 'keep', TYPE: 'float' }),
    ]);
    expect(list.map((d) => d.name)).toEqual(['keep']);
  });
});

describe('color conversion', () => {
  it('round trips through hex, keeping alpha', () => {
    const c = [1, 128 / 255, 0, 0.25];
    const back = hexToColor(colorToHex(c), c);
    expect(colorToHex(c)).toBe('#ff8000');
    expect(back[3]).toBe(0.25);
    back.slice(0, 3).forEach((v, i) => expect(v).toBeCloseTo(c[i], 5));
  });
  it('ignores malformed hex', () => {
    expect(hexToColor('nope', [0.1, 0.2, 0.3, 1])).toEqual([0.1, 0.2, 0.3, 1]);
  });
});
