// Pure mapping from ISF `INPUTS` entries to UI control descriptors
// (docs/design/visualization-plugins.md, Phase 2). No DOM, no stores: the panel renders
// descriptors and writes values back through `setVisualizationParams`.

import type { IsfInput } from '../renderer/isf/parser';

export type ParamValue = number | number[] | boolean;

export interface SliderAxis {
  min: number;
  max: number;
  step: number;
  default: number;
}

export type ControlDescriptor =
  | { kind: 'slider'; name: string; label: string; axis: SliderAxis }
  | { kind: 'point2d'; name: string; label: string; axes: [SliderAxis, SliderAxis] }
  | { kind: 'toggle'; name: string; label: string; default: boolean }
  | {
      kind: 'select';
      name: string;
      label: string;
      options: { value: number; label: string }[];
      default: number;
    }
  | { kind: 'color'; name: string; label: string; default: number[] }
  | { kind: 'button'; name: string; label: string };

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

function axis(min: number, max: number, def: number): SliderAxis {
  const span = max - min;
  return { min, max, step: span > 0 ? span / 200 : 0.01, default: def };
}

function pairOf(v: unknown, fallback: [number, number]): [number, number] {
  if (Array.isArray(v) && v.length >= 2) return [num(v[0], fallback[0]), num(v[1], fallback[1])];
  return fallback;
}

/** Descriptor for one input, or null when it is hidden (bound) or unsupported. */
export function describeInput(input: IsfInput): ControlDescriptor | null {
  if (input.CUEMARK_BIND) return null;
  const name = input.NAME;
  const label = (input as { LABEL?: string }).LABEL || name;
  switch (input.TYPE) {
    case 'float': {
      const min = num(input.MIN, 0);
      const max = num(input.MAX, 1);
      return { kind: 'slider', name, label, axis: axis(min, max, num(input.DEFAULT, min)) };
    }
    case 'bool':
      return { kind: 'toggle', name, label, default: input.DEFAULT === true || input.DEFAULT === 1 };
    case 'long': {
      const values = (input.VALUES ?? []).filter((v): v is number => typeof v === 'number');
      if (values.length === 0) return null;
      const options = values.map((value, i) => ({ value, label: input.LABELS?.[i] ?? String(value) }));
      return { kind: 'select', name, label, options, default: num(input.DEFAULT, values[0]) };
    }
    case 'color': {
      const d = Array.isArray(input.DEFAULT) ? input.DEFAULT.map((x) => num(x, 0)) : [0, 0, 0, 1];
      while (d.length < 4) d.push(1);
      return { kind: 'color', name, label, default: d.slice(0, 4) };
    }
    case 'point2D': {
      const [minX, minY] = pairOf(input.MIN, [0, 0]);
      const [maxX, maxY] = pairOf(input.MAX, [1, 1]);
      const [dx, dy] = pairOf(input.DEFAULT, [minX, minY]);
      return { kind: 'point2d', name, label, axes: [axis(minX, maxX, dx), axis(minY, maxY, dy)] };
    }
    case 'event':
      return { kind: 'button', name, label };
    default:
      return null; // image / audio / audioFFT
  }
}

export function describeInputs(inputs: IsfInput[]): ControlDescriptor[] {
  const out: ControlDescriptor[] = [];
  for (const i of inputs) {
    const d = describeInput(i);
    if (d) out.push(d);
  }
  return out;
}

const to255 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);

/** RGBA 0..1 -> `#rrggbb` (alpha dropped; the picker has none). */
export function colorToHex(c: number[]): string {
  return '#' + [0, 1, 2].map((i) => to255(c[i] ?? 0).toString(16).padStart(2, '0')).join('');
}

/** `#rrggbb` -> RGBA 0..1, keeping the alpha of `prev`. */
export function hexToColor(hex: string, prev: number[] = [0, 0, 0, 1]): number[] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return prev.slice();
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255).concat(prev[3] ?? 1);
}
