import { registerComponentType } from '../core/registry.js';
import { FLOATING, CONFLICT, toInt, fromInt } from '../core/bits.js';

const selectSchema = () => [
  { key: 'selectBits', label: 'Select-Bits', kind: 'int', min: 1, max: 5, step: 1, default: 2 },
  { key: 'width', label: 'Datenbreite', kind: 'int', min: 1, max: 32, step: 1, default: 1 },
];

registerComponentType({
  type: 'MUX',
  category: 'Multiplexer',
  label: 'Multiplexer',
  color: '#5ec6f0',
  paramsSchema: selectSchema(),
  pins: (params) => {
    const sel = params.selectBits ?? 2;
    const width = params.width ?? 1;
    const n = 2 ** sel;
    const pins = [];
    for (let i = 0; i < n; i++) pins.push({ id: `in${i}`, label: String(i), dir: 'in', width, side: 'left', order: i });
    pins.push({ id: 'sel', label: 'SEL', dir: 'in', width: sel, side: 'bottom', order: 0 });
    pins.push({ id: 'out', label: 'Y', dir: 'out', width, side: 'right', order: 0 });
    return pins;
  },
  size: (params) => ({ w: 4, h: Math.max(3, 2 ** (params.selectBits ?? 2)) }),
  init: () => ({}),
  evaluate: ({ inputs, params }) => {
    const sel = params.selectBits ?? 2;
    const width = params.width ?? 1;
    const n = 2 ** sel;
    const selBits = inputs.sel || new Array(sel).fill(FLOATING);
    if (selBits.includes(CONFLICT)) return { outputs: { out: new Array(width).fill(CONFLICT) }, state: {} };
    const idx = toInt(selBits);
    if (idx === null || idx >= n) return { outputs: { out: new Array(width).fill(FLOATING) }, state: {} };
    const val = inputs[`in${idx}`] || new Array(width).fill(FLOATING);
    return { outputs: { out: val.slice() }, state: {} };
  },
});

registerComponentType({
  type: 'DEMUX',
  category: 'Multiplexer',
  label: 'Demultiplexer',
  color: '#5ec6f0',
  paramsSchema: selectSchema(),
  pins: (params) => {
    const sel = params.selectBits ?? 2;
    const width = params.width ?? 1;
    const n = 2 ** sel;
    const pins = [{ id: 'd', label: 'D', dir: 'in', width, side: 'left', order: 0 }];
    pins.push({ id: 'sel', label: 'SEL', dir: 'in', width: sel, side: 'bottom', order: 0 });
    for (let i = 0; i < n; i++) pins.push({ id: `out${i}`, label: String(i), dir: 'out', width, side: 'right', order: i });
    return pins;
  },
  size: (params) => ({ w: 4, h: Math.max(3, 2 ** (params.selectBits ?? 2)) }),
  init: () => ({}),
  evaluate: ({ inputs, params }) => {
    const sel = params.selectBits ?? 2;
    const width = params.width ?? 1;
    const n = 2 ** sel;
    const d = inputs.d || new Array(width).fill(FLOATING);
    const selBits = inputs.sel || new Array(sel).fill(FLOATING);
    const outputs = {};
    const conflict = selBits.includes(CONFLICT);
    const idx = conflict ? null : toInt(selBits);
    for (let i = 0; i < n; i++) {
      if (conflict) outputs[`out${i}`] = new Array(width).fill(CONFLICT);
      else if (idx === null) outputs[`out${i}`] = new Array(width).fill(FLOATING);
      else outputs[`out${i}`] = i === idx ? d.slice() : new Array(width).fill(0);
    }
    return { outputs, state: {} };
  },
});

registerComponentType({
  type: 'ENCODER',
  category: 'Multiplexer',
  label: 'Prioritäts-Encoder',
  color: '#5ec6f0',
  paramsSchema: [{ key: 'selectBits', label: 'Select-Bits', kind: 'int', min: 1, max: 5, step: 1, default: 2 }],
  pins: (params) => {
    const sel = params.selectBits ?? 2;
    const n = 2 ** sel;
    const pins = [];
    for (let i = 0; i < n; i++) pins.push({ id: `in${i}`, label: String(i), dir: 'in', width: 1, side: 'left', order: i });
    pins.push({ id: 'sel', label: 'SEL', dir: 'out', width: sel, side: 'right', order: 0 });
    pins.push({ id: 'valid', label: 'V', dir: 'out', width: 1, side: 'right', order: 1 });
    return pins;
  },
  size: (params) => ({ w: 4, h: Math.max(3, 2 ** (params.selectBits ?? 2)) }),
  init: () => ({}),
  evaluate: ({ inputs, params }) => {
    const sel = params.selectBits ?? 2;
    const n = 2 ** sel;
    let conflict = false, idx = -1;
    for (let i = n - 1; i >= 0; i--) {
      const b = inputs[`in${i}`]?.[0];
      if (b === CONFLICT) conflict = true;
      if (b === 1 && idx === -1) idx = i;
    }
    if (conflict) return { outputs: { sel: new Array(sel).fill(CONFLICT), valid: [CONFLICT] }, state: {} };
    if (idx === -1) return { outputs: { sel: new Array(sel).fill(0), valid: [0] }, state: {} };
    return { outputs: { sel: fromInt(idx, sel), valid: [1] }, state: {} };
  },
});

registerComponentType({
  type: 'DECODER',
  category: 'Multiplexer',
  label: 'Decoder',
  color: '#5ec6f0',
  paramsSchema: [{ key: 'selectBits', label: 'Select-Bits', kind: 'int', min: 1, max: 5, step: 1, default: 2 }],
  pins: (params) => {
    const sel = params.selectBits ?? 2;
    const n = 2 ** sel;
    const pins = [
      { id: 'sel', label: 'SEL', dir: 'in', width: sel, side: 'left', order: 0 },
      { id: 'en', label: 'EN', dir: 'in', width: 1, side: 'left', order: 1 },
    ];
    for (let i = 0; i < n; i++) pins.push({ id: `out${i}`, label: String(i), dir: 'out', width: 1, side: 'right', order: i });
    return pins;
  },
  size: (params) => ({ w: 4, h: Math.max(3, 2 ** (params.selectBits ?? 2)) }),
  init: () => ({}),
  evaluate: ({ inputs, params }) => {
    const sel = params.selectBits ?? 2;
    const n = 2 ** sel;
    const en = inputs.en?.[0] === 0 ? 0 : 1;
    const selBits = inputs.sel || new Array(sel).fill(FLOATING);
    const outputs = {};
    if (selBits.includes(CONFLICT)) {
      for (let i = 0; i < n; i++) outputs[`out${i}`] = [CONFLICT];
      return { outputs, state: {} };
    }
    const idx = en === 1 ? toInt(selBits) : null;
    for (let i = 0; i < n; i++) outputs[`out${i}`] = [idx === i ? 1 : 0];
    return { outputs, state: {} };
  },
});
