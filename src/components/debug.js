import { registerComponentType } from '../core/registry.js';
import { FLOATING, bitsToBinaryString, bitsToHexString, bitsToDecString } from '../core/bits.js';

registerComponentType({
  type: 'LAMP',
  category: 'Debug',
  label: 'Lampe',
  color: '#e0e6ec',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 8, step: 1, default: 1 }],
  pins: (params) => [{ id: 'in0', label: '', dir: 'in', width: params.width ?? 1, side: 'left', order: 0 }],
  size: (params) => ({ w: 2, h: Math.max(2, params.width ?? 1) }),
  init: () => ({}),
  evaluate: ({ inputs, params }) => {
    const width = params.width ?? 1;
    return { outputs: {}, state: { last: inputs.in0 || new Array(width).fill(FLOATING) } };
  },
  isLampLike: true,
});

registerComponentType({
  type: 'DISPLAY',
  category: 'Debug',
  label: 'Display',
  color: '#1c2b1c',
  paramsSchema: [
    { key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 },
    { key: 'mode', label: 'Format', kind: 'select', options: ['hex', 'dec', 'bin'], default: 'hex' },
  ],
  pins: (params) => [{ id: 'in0', label: '', dir: 'in', width: params.width ?? 8, side: 'left', order: 0 }],
  size: (params) => {
    const width = params.width ?? 8;
    const mode = params.mode ?? 'hex';
    const chars = mode === 'bin' ? width : mode === 'hex' ? Math.ceil(width / 4) : String(2 ** Math.min(width, 30)).length;
    return { w: Math.max(3, Math.ceil(chars * 0.6) + 2), h: 2 };
  },
  init: () => ({}),
  evaluate: ({ inputs, params }) => {
    const width = params.width ?? 8;
    return { outputs: {}, state: { last: inputs.in0 || new Array(width).fill(FLOATING) } };
  },
  formatValue(bits, mode) {
    if (mode === 'bin') return bitsToBinaryString(bits);
    if (mode === 'dec') return bitsToDecString(bits);
    return bitsToHexString(bits);
  },
});

registerComponentType({
  type: 'PROBE',
  category: 'Debug',
  label: 'Probe',
  color: '#e0e6ec',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 1 }],
  pins: (params) => [{ id: 'in0', label: '', dir: 'in', width: params.width ?? 1, side: 'left', order: 0 }],
  size: () => ({ w: 3, h: 2 }),
  init: () => ({}),
  evaluate: ({ inputs, params }) => {
    const width = params.width ?? 1;
    return { outputs: {}, state: { last: inputs.in0 || new Array(width).fill(FLOATING) } };
  },
});
