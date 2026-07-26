import { registerComponentType } from '../core/registry.js';
import { fromInt, toInt } from '../core/bits.js';

registerComponentType({
  type: 'SWITCH',
  category: 'Ein-/Ausgabe',
  label: 'Switch',
  color: '#e0e6ec',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 1 }],
  pins: (params) => [{ id: 'out', label: '', dir: 'out', width: params.width ?? 1, side: 'right', order: 0 }],
  size: () => ({ w: 2, h: 2 }),
  init: () => ({ value: 0 }),
  interactive: true,
  onActivate: (state, params) => {
    const width = params.width ?? 1;
    // 1-bit switches toggle on click; wider switches are set via the properties panel instead.
    return { ...state, value: width === 1 ? (state.value ? 0 : 1) : state.value };
  },
  evaluate: ({ state, params }) => ({ outputs: { out: fromInt(state.value ?? 0, params.width ?? 1) }, state }),
});

registerComponentType({
  type: 'BUTTON',
  category: 'Ein-/Ausgabe',
  label: 'Button',
  color: '#e0e6ec',
  paramsSchema: [],
  pins: () => [{ id: 'out', label: '', dir: 'out', width: 1, side: 'right', order: 0 }],
  size: () => ({ w: 2, h: 2 }),
  init: () => ({ pressed: false }),
  interactive: true,
  onPointerDown: (state) => ({ ...state, pressed: true }),
  onPointerUp: (state) => ({ ...state, pressed: false }),
  evaluate: ({ state }) => ({ outputs: { out: [state.pressed ? 1 : 0] }, state }),
});

registerComponentType({
  type: 'CLOCK',
  category: 'Ein-/Ausgabe',
  label: 'Clock',
  color: '#e0e6ec',
  paramsSchema: [
    { key: 'hz', label: 'Frequenz (Hz), 0 = manuell', kind: 'int', min: 0, max: 1_000_000, step: 1, default: 1 },
  ],
  pins: () => [{ id: 'out', label: '', dir: 'out', width: 1, side: 'right', order: 0 }],
  size: () => ({ w: 2, h: 2 }),
  init: () => ({ value: 0, lastToggle: 0 }),
  interactive: true,
  onActivate: (state) => ({ ...state, value: state.value ? 0 : 1, lastToggle: performance.now() }),
  evaluate: ({ state, params, now }) => {
    const hz = params.hz ?? 0;
    let { value, lastToggle } = state;
    if (hz > 0) {
      const periodMs = 1000 / (2 * hz); // half period: one toggle per half period
      if (now - (lastToggle || 0) >= periodMs) {
        value = value ? 0 : 1;
        lastToggle = now;
      }
    }
    return { outputs: { out: [value] }, state: { value, lastToggle } };
  },
});

function makeConstant(type, label, bit) {
  registerComponentType({
    type,
    category: 'Ein-/Ausgabe',
    label,
    color: '#8a94a0',
    paramsSchema: [],
    pins: () => [{ id: 'out', label: '', dir: 'out', width: 1, side: 'right', order: 0 }],
    size: () => ({ w: 2, h: 1 }),
    init: () => ({}),
    evaluate: () => ({ outputs: { out: [bit] }, state: {} }),
  });
}
registerComponentType({
  type: 'PULLUP',
  category: 'Ein-/Ausgabe',
  label: 'Pull-up',
  color: '#8a94a0',
  paramsSchema: [],
  // Pin unten -> Anschluss ans restliche Netz; Pfeil zeigt nach oben zur (gedachten) VCC-Schiene
  pins: () => [{ id: 'out', label: '', dir: 'out', width: 1, side: 'bottom', order: 0 }],
  size: () => ({ w: 2, h: 2 }),
  init: () => ({}),
  evaluate: () => ({ outputs: { out: [1] }, state: {} }),
});

registerComponentType({
  type: 'PULLDOWN',
  category: 'Ein-/Ausgabe',
  label: 'Pull-down',
  color: '#8a94a0',
  paramsSchema: [],
  // Pin oben -> Anschluss ans restliche Netz; Pfeil zeigt nach unten zur (gedachten) GND-Schiene
  pins: () => [{ id: 'out', label: '', dir: 'out', width: 1, side: 'top', order: 0 }],
  size: () => ({ w: 2, h: 2 }),
  init: () => ({}),
  evaluate: () => ({ outputs: { out: [0] }, state: {} }),
});

registerComponentType({
  type: 'CONSTANT',
  category: 'Ein-/Ausgabe',
  label: 'Konstante',
  color: '#8a94a0',
  paramsSchema: [
    { key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 },
    { key: 'value', label: 'Wert (hex)', kind: 'text', default: '0' },
  ],
  pins: (params) => [{ id: 'out', label: '', dir: 'out', width: params.width ?? 8, side: 'right', order: 0 }],
  size: () => ({ w: 3, h: 2 }),
  init: () => ({}),
  evaluate: ({ params }) => {
    const width = params.width ?? 8;
    const v = parseInt(params.value ?? '0', 16);
    return { outputs: { out: fromInt(Number.isFinite(v) ? v : 0, width) }, state: {} };
  },
});

registerComponentType({
  type: 'RGBLED',
  category: 'Ein-/Ausgabe',
  label: 'RGB-LED',
  color: '#e0e6ec',
  paramsSchema: [],
  pins: () => [
    { id: 'r', label: 'R', dir: 'in', width: 8, side: 'left', order: 0 },
    { id: 'g', label: 'G', dir: 'in', width: 8, side: 'left', order: 1 },
    { id: 'b', label: 'B', dir: 'in', width: 8, side: 'left', order: 2 },
  ],
  size: () => ({ w: 3, h: 3 }),
  init: () => ({}),
  evaluate: ({ inputs }) => ({
    outputs: {},
    state: {
      r: toInt(inputs.r || new Array(8).fill(FLOATING)) ?? 0,
      g: toInt(inputs.g || new Array(8).fill(FLOATING)) ?? 0,
      b: toInt(inputs.b || new Array(8).fill(FLOATING)) ?? 0,
    },
  }),
});

// Geometrie des Tracks in Bauteil-lokalen Weltkoordinaten. Wird sowohl vom
// Editor (Hit-Testing beim Ziehen) als auch vom Renderer (Zeichnen) genutzt,
// damit beide exakt übereinstimmen.
export function sliderTrackRect(inst) {
  const marginX = 0.72; // pw*0.12 in Grid-Einheiten (6*0.12)
  return { x0: inst.x + marginX, x1: inst.x + 6 - marginX, y: inst.y + 1.86 };
}

export function formatSliderValue(value, format) {
  const v = value >>> 0;
  if (format === 'hex') return '0x' + v.toString(16).toUpperCase();
  if (format === 'bin') return v.toString(2);
  return String(value);
}

function sliderRange(params) {
  const width = params.width ?? 8;
  const min = params.min ?? 0;
  const max = params.max ?? (2 ** width - 1);
  return min <= max ? { lo: min, hi: max } : { lo: max, hi: min };
}

registerComponentType({
  type: 'SLIDER',
  category: 'Ein-/Ausgabe',
  label: 'Slider',
  color: '#8a94a0',
  paramsSchema: [
    { key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 },
    { key: 'min', label: 'Minimum', kind: 'int', min: 0, max: 0xFFFFFFFF, step: 1, default: 0 },
    { key: 'max', label: 'Maximum', kind: 'int', min: 0, max: 0xFFFFFFFF, step: 1, default: 255 },
    { key: 'format', label: 'Darstellung', kind: 'select', options: ['dec', 'hex', 'bin'], default: 'dec' },
  ],
  pins: (params) => [{ id: 'out', label: '', dir: 'out', width: params.width ?? 8, side: 'right', order: 0 }],
  size: () => ({ w: 6, h: 3 }),
  init: (params) => ({ value: sliderRange(params ?? {}).lo }),
  interactive: true,
  // t: normierte Position 0..1 entlang des Tracks (0 = links = min, 1 = rechts = max)
  onSliderInput: (state, params, t) => {
    const { lo, hi } = sliderRange(params);
    const value = Math.max(lo, Math.min(hi, Math.round(lo + t * (hi - lo))));
    return { ...state, value };
  },
  evaluate: ({ state, params }) => {
    const { lo, hi } = sliderRange(params);
    const value = Math.max(lo, Math.min(hi, state.value ?? lo));
    return { outputs: { out: fromInt(value, params.width ?? 8) }, state: { ...state, value } };
  },
});
