import { registerComponentType } from '../core/registry.js';
import { FLOATING } from '../core/bits.js';

registerComponentType({
  type: 'SPLITTER',
  category: 'Verdrahtung',
  label: 'Splitter',
  color: '#8a94a0',
  paramsSchema: [{ key: 'width', label: 'Busbreite', kind: 'int', min: 2, max: 32, step: 1, default: 8 }],
  pins: (params) => {
    const width = params.width ?? 8;
    const pins = [{ id: 'bus', label: 'BUS', dir: 'in', width, side: 'left', order: 0 }];
    for (let i = 0; i < width; i++) pins.push({ id: `b${i}`, label: `${i}`, dir: 'out', width: 1, side: 'right', order: i });
    return pins;
  },
  size: (params) => ({ w: 3, h: Math.max(2, params.width ?? 8) }),
  init: () => ({}),
  evaluate: ({ inputs, params }) => {
    const width = params.width ?? 8;
    const bus = inputs.bus || new Array(width).fill(FLOATING);
    const outputs = {};
    for (let i = 0; i < width; i++) outputs[`b${i}`] = [bus[i] ?? FLOATING];
    return { outputs, state: {} };
  },
});

registerComponentType({
  type: 'MERGER',
  category: 'Verdrahtung',
  label: 'Merger',
  color: '#8a94a0',
  paramsSchema: [{ key: 'width', label: 'Busbreite', kind: 'int', min: 2, max: 32, step: 1, default: 8 }],
  pins: (params) => {
    const width = params.width ?? 8;
    const pins = [];
    for (let i = 0; i < width; i++) pins.push({ id: `b${i}`, label: `${i}`, dir: 'in', width: 1, side: 'left', order: i });
    pins.push({ id: 'bus', label: 'BUS', dir: 'out', width, side: 'right', order: 0 });
    return pins;
  },
  size: (params) => ({ w: 3, h: Math.max(2, params.width ?? 8) }),
  init: () => ({}),
  evaluate: ({ inputs, params }) => {
    const width = params.width ?? 8;
    const bus = new Array(width);
    for (let i = 0; i < width; i++) bus[i] = (inputs[`b${i}`] || [FLOATING])[0];
    return { outputs: { bus }, state: {} };
  },
});

registerComponentType({
  type: 'TUNNEL_IN',
  category: 'Verdrahtung',
  label: 'Tunnel (Ein)',
  color: '#6f7d8c',
  paramsSchema: [
    { key: 'net', label: 'Netzname', kind: 'text', default: 'NET' },
    { key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 1 },
  ],
  pins: (params) => [{ id: 'in0', label: '', dir: 'in', width: params.width ?? 1, side: 'left', order: 0 }],
  size: () => ({ w: 2, h: 2 }),
  init: () => ({}),
  isTunnel: 'in',
  evaluate: ({ inputs, params }) => ({ outputs: {}, state: { last: inputs.in0 || new Array(params.width ?? 1).fill(FLOATING) } }),
});

registerComponentType({
  type: 'TUNNEL_OUT',
  category: 'Verdrahtung',
  label: 'Tunnel (Aus)',
  color: '#6f7d8c',
  paramsSchema: [
    { key: 'net', label: 'Netzname', kind: 'text', default: 'NET' },
    { key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 1 },
  ],
  pins: (params) => [{ id: 'out', label: '', dir: 'out', width: params.width ?? 1, side: 'right', order: 0 }],
  size: () => ({ w: 2, h: 2 }),
  init: () => ({}),
  isTunnel: 'out',
  // outputs are injected by the simulator (value comes from matching TUNNEL_IN nodes)
  evaluate: ({ state, params }) => ({ outputs: { out: state.injected || new Array(params.width ?? 1).fill(FLOATING) }, state }),
});
