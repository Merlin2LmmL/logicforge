import { registerComponentType } from '../core/registry.js';
import { fromInt } from '../core/bits.js';

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
    { key: 'hz', label: 'Frequenz (Hz), 0 = manuell', kind: 'int', min: 0, max: 30, step: 1, default: 1 },
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
makeConstant('CONST0', 'GND (0)', 0);
makeConstant('CONST1', 'VCC (1)', 1);
