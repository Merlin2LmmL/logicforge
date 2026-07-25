import { registerComponentType } from '../core/registry.js';
import { FLOATING, CONFLICT } from '../core/bits.js';

function bitwiseGate(inputsArr, width, op, identity) {
  const out = new Array(width);
  for (let i = 0; i < width; i++) {
    let acc = identity;
    let floatingCount = 0;
    for (const v of inputsArr) {
      const b = v[i];
      if (b === CONFLICT) { acc = CONFLICT; break; }
      if (b === FLOATING) { floatingCount++; continue; }
      acc = op(acc, b);
    }
    if (acc !== CONFLICT && floatingCount > 0) acc = FLOATING;
    out[i] = acc;
  }
  return out;
}

function pinsForMultiInput(n, width) {
  const pins = [];
  for (let i = 0; i < n; i++) {
    pins.push({ id: `in${i}`, label: String.fromCharCode(65 + i), dir: 'in', width, side: 'left', order: i });
  }
  pins.push({ id: 'out', label: 'Y', dir: 'out', width, side: 'right', order: 0 });
  return pins;
}

const multiInputSchema = (defaultInputs = 2) => [
  { key: 'inputs', label: 'Eingänge', kind: 'int', min: 2, max: 8, step: 1, default: defaultInputs },
  { key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 1 },
];

function sizeForInputs(params) {
  const n = params.inputs ?? 2;
  return { w: 3, h: Math.max(2, n) };
}

function makeGate({ type, label, color, op, identity, invert }) {
  registerComponentType({
    type,
    category: 'Gatter',
    label,
    color,
    paramsSchema: multiInputSchema(2),
    pins: (params) => pinsForMultiInput(params.inputs ?? 2, params.width ?? 1),
    size: sizeForInputs,
    init: () => ({}),
    evaluate: ({ inputs, params }) => {
      const n = params.inputs ?? 2;
      const width = params.width ?? 1;
      const vals = [];
      for (let i = 0; i < n; i++) vals.push(inputs[`in${i}`] || new Array(width).fill(FLOATING));
      let out = bitwiseGate(vals, width, op, identity);
      if (invert) out = out.map((b) => (b === 0 ? 1 : b === 1 ? 0 : b));
      return { outputs: { out }, state: {} };
    },
  });
}

makeGate({ type: 'AND', label: 'AND', color: '#e8b34c', op: (a, b) => a & b, identity: 1, invert: false });
makeGate({ type: 'OR', label: 'OR', color: '#5eb0f0', op: (a, b) => a | b, identity: 0, invert: false });
makeGate({ type: 'NAND', label: 'NAND', color: '#e8b34c', op: (a, b) => a & b, identity: 1, invert: true });
makeGate({ type: 'NOR', label: 'NOR', color: '#5eb0f0', op: (a, b) => a | b, identity: 0, invert: true });
makeGate({ type: 'XOR', label: 'XOR', color: '#a984e8', op: (a, b) => a ^ b, identity: 0, invert: false });
makeGate({ type: 'XNOR', label: 'XNOR', color: '#a984e8', op: (a, b) => a ^ b, identity: 0, invert: true });

registerComponentType({
  type: 'NOT',
  category: 'Gatter',
  label: 'NOT',
  color: '#e8834c',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 1 }],
  pins: (params) => [
    { id: 'in0', label: 'A', dir: 'in', width: params.width ?? 1, side: 'left', order: 0 },
    { id: 'out', label: 'Y', dir: 'out', width: params.width ?? 1, side: 'right', order: 0 },
  ],
  size: () => ({ w: 3, h: 2 }),
  init: () => ({}),
  evaluate: ({ inputs, params }) => {
    const width = params.width ?? 1;
    const a = inputs.in0 || new Array(width).fill(FLOATING);
    const out = a.map((b) => (b === 0 ? 1 : b === 1 ? 0 : b));
    return { outputs: { out }, state: {} };
  },
});

registerComponentType({
  type: 'BUFFER',
  category: 'Gatter',
  label: 'Buffer',
  color: '#7fd67f',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 1 }],
  pins: (params) => [
    { id: 'in0', label: 'A', dir: 'in', width: params.width ?? 1, side: 'left', order: 0 },
    { id: 'out', label: 'Y', dir: 'out', width: params.width ?? 1, side: 'right', order: 0 },
  ],
  size: () => ({ w: 3, h: 2 }),
  init: () => ({}),
  evaluate: ({ inputs, params }) => {
    const width = params.width ?? 1;
    const a = inputs.in0 || new Array(width).fill(FLOATING);
    return { outputs: { out: a.slice() }, state: {} };
  },
});
