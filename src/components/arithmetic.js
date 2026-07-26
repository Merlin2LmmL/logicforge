import { registerComponentType } from '../core/registry.js';
import { FLOATING, CONFLICT } from '../core/bits.js';

function coerce(b) { return b === 1 ? 1 : 0; } // FLOATING wird für die Rechnung als 0 behandelt
function ctrlBit(v, fallback) { return v === 1 || v === 0 ? v : fallback; }

registerComponentType({
  type: 'ADDSUB',
  category: 'Arithmetik',
  label: 'Addierer/Subtrahierer',
  color: '#f0785e',
  paramsSchema: [
    { key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 },
  ],
  pins: (params) => {
    const width = params.width ?? 8;
    return [
      { id: 'a', label: 'A', dir: 'in', width, side: 'left', order: 0 },
      { id: 'b', label: 'B', dir: 'in', width, side: 'left', order: 1 },
      { id: 'cin', label: 'CIN', dir: 'in', width: 1, side: 'left', order: 2 },
      { id: 'sub', label: 'SUB', dir: 'in', width: 1, side: 'left', order: 3 },
      { id: 'y', label: 'Σ', dir: 'out', width, side: 'right', order: 0 },
      { id: 'cout', label: 'COUT', dir: 'out', width: 1, side: 'right', order: 1 },
    ];
  },
  size: () => ({ w: 4, h: 5 }),
  init: () => ({}),
  // Reines Kombinatorikbauteil (kein eigener Zustand). SUB=1 -> A - B via
  // Zweierkomplement (B wird bitweise invertiert, Carry-in fest auf 1).
  // SUB=0/offen -> normale Addition, CIN dann als externer Carry-Eingang nutzbar
  // (z.B. zum Kaskadieren mehrerer Addierer für größere Breiten).
  evaluate: ({ inputs, params }) => {
    const width = params.width ?? 8;
    const a = inputs.a || new Array(width).fill(FLOATING);
    const b = inputs.b || new Array(width).fill(FLOATING);
    if (a.includes(CONFLICT) || b.includes(CONFLICT)) {
      return { outputs: { y: new Array(width).fill(CONFLICT), cout: [CONFLICT] }, state: {} };
    }
    const sub = ctrlBit(inputs.sub?.[0], 0) === 1;
    let carry = sub ? 1 : ctrlBit(inputs.cin?.[0], 0);
    const out = new Array(width);
    for (let i = 0; i < width; i++) {
      const av = coerce(a[i]);
      const bv = coerce(b[i]) ^ (sub ? 1 : 0);
      out[i] = av ^ bv ^ carry;
      carry = (av & bv) | (av & carry) | (bv & carry);
    }
    return { outputs: { y: out, cout: [carry] }, state: {} };
  },
});

registerComponentType({
  type: 'COMPARATOR',
  category: 'Arithmetik',
  label: 'Komparator',
  color: '#f0785e',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 }],
  pins: (params) => {
    const width = params.width ?? 8;
    return [
      { id: 'a', label: 'A', dir: 'in', width, side: 'left', order: 0 },
      { id: 'b', label: 'B', dir: 'in', width, side: 'left', order: 1 },
      { id: 'eq', label: 'A=B', dir: 'out', width: 1, side: 'right', order: 0 },
      { id: 'lt', label: 'A<B', dir: 'out', width: 1, side: 'right', order: 1 },
      { id: 'gt', label: 'A>B', dir: 'out', width: 1, side: 'right', order: 2 },
    ];
  },
  size: () => ({ w: 4, h: 4 }),
  init: () => ({}),
  evaluate: ({ inputs, params }) => {
    const width = params.width ?? 8;
    const a = inputs.a || new Array(width).fill(FLOATING);
    const b = inputs.b || new Array(width).fill(FLOATING);
    if (a.includes(CONFLICT) || b.includes(CONFLICT)) {
      return { outputs: { eq: [CONFLICT], lt: [CONFLICT], gt: [CONFLICT] }, state: {} };
    }
    const av = toInt(a), bv = toInt(b);
    if (av === null || bv === null) {
      return { outputs: { eq: [FLOATING], lt: [FLOATING], gt: [FLOATING] }, state: {} };
    }
    return { outputs: { eq: [av === bv ? 1 : 0], lt: [av < bv ? 1 : 0], gt: [av > bv ? 1 : 0] }, state: {} };
  },
});
