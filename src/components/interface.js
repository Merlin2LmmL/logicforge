import { registerComponentType } from '../core/registry.js';
import { FLOATING, fromInt } from '../core/bits.js';

// PIN_IN / PIN_OUT mark the boundary of a circuit that is used as a component definition.
// When the circuit they live in is simulated *standalone* (e.g. while editing/testing a
// component before it's used anywhere), PIN_IN behaves like a switch and PIN_OUT like a
// probe. When the circuit is simulated *as a nested component definition*, the Simulator
// injects/reads values on these directly instead of calling evaluate() normally.

registerComponentType({
  type: 'PIN_IN',
  category: 'Schnittstelle',
  label: 'Eingangs-Pin',
  color: '#5eead4',
  paramsSchema: [
    { key: 'name', label: 'Name', kind: 'text', default: 'IN' },
    { key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 1 },
  ],
  pins: (params) => [{ id: 'out', label: params.name || 'IN', dir: 'out', width: params.width ?? 1, side: 'right', order: 0 }],
  size: () => ({ w: 3, h: 2 }),
  init: () => ({ value: 0 }),
  interactive: true,
  isInterface: 'in',
  onActivate: (state, params) => {
    const width = params.width ?? 1;
    return { ...state, value: width === 1 ? (state.value ? 0 : 1) : state.value };
  },
  evaluate: ({ state, params, injected }) => {
    const width = params.width ?? 1;
    const out = injected !== undefined ? injected : fromInt(state.value ?? 0, width);
    return { outputs: { out }, state };
  },
});

registerComponentType({
  type: 'PIN_OUT',
  category: 'Schnittstelle',
  label: 'Ausgangs-Pin',
  color: '#5eead4',
  paramsSchema: [
    { key: 'name', label: 'Name', kind: 'text', default: 'OUT' },
    { key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 1 },
  ],
  pins: (params) => [{ id: 'in0', label: params.name || 'OUT', dir: 'in', width: params.width ?? 1, side: 'left', order: 0 }],
  size: () => ({ w: 3, h: 2 }),
  init: () => ({}),
  isInterface: 'out',
  evaluate: ({ inputs, params }) => ({ outputs: {}, state: { last: inputs.in0 || new Array(params.width ?? 1).fill(FLOATING) } }),
});
