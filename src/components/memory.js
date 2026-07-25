import { registerComponentType } from '../core/registry.js';
import { fromInt, toInt, FLOATING } from '../core/bits.js';

function bit1(v) { return v === 1 ? 1 : v === 0 ? 0 : FLOATING; }
// Control pins default to a sane value when left unconnected: enable=on, reset/clock=off.
function ctrl(v, fallback) { return v === 1 || v === 0 ? v : fallback; }

registerComponentType({
  type: 'DFF',
  category: 'Speicher',
  label: 'D-Flipflop',
  color: '#f0a35e',
  paramsSchema: [],
  pins: () => [
    { id: 'd', label: 'D', dir: 'in', width: 1, side: 'left', order: 0 },
    { id: 'clk', label: '>', dir: 'in', width: 1, side: 'left', order: 1 },
    { id: 'en', label: 'EN', dir: 'in', width: 1, side: 'left', order: 2 },
    { id: 'rst', label: 'R', dir: 'in', width: 1, side: 'left', order: 3 },
    { id: 'q', label: 'Q', dir: 'out', width: 1, side: 'right', order: 0 },
    { id: 'nq', label: 'Q̄', dir: 'out', width: 1, side: 'right', order: 1 },
  ],
  size: () => ({ w: 3, h: 4 }),
  init: () => ({ q: 0, prevClk: 0 }),
  evaluate: ({ inputs, state }) => {
    const d = bit1(inputs.d?.[0]);
    const clk = ctrl(inputs.clk?.[0], 0);
    const en = ctrl(inputs.en?.[0], 1);
    const rst = ctrl(inputs.rst?.[0], 0);
    let q = state.q ?? 0;
    if (rst === 1) {
      q = 0;
    } else if (en === 1) {
      const rising = state.prevClk === 0 && clk === 1;
      if (rising && (d === 0 || d === 1)) q = d;
    }
    return { outputs: { q: [q], nq: [q ? 0 : 1] }, state: { q, prevClk: clk } };
  },
});

registerComponentType({
  type: 'REGISTER',
  category: 'Speicher',
  label: 'Register',
  color: '#f0a35e',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 }],
  pins: (params) => [
    { id: 'd', label: 'D', dir: 'in', width: params.width ?? 8, side: 'left', order: 0 },
    { id: 'clk', label: '>', dir: 'in', width: 1, side: 'left', order: 1 },
    { id: 'en', label: 'EN', dir: 'in', width: 1, side: 'left', order: 2 },
    { id: 'rst', label: 'R', dir: 'in', width: 1, side: 'left', order: 3 },
    { id: 'q', label: 'Q', dir: 'out', width: params.width ?? 8, side: 'right', order: 0 },
  ],
  size: (params) => ({ w: 4, h: Math.max(4, Math.ceil((params.width ?? 8) / 4) + 2) }),
  init: (params) => ({ value: 0, prevClk: 0, width: params.width ?? 8 }),
  evaluate: ({ inputs, state, params }) => {
    const width = params.width ?? 8;
    const clk = ctrl(inputs.clk?.[0], 0);
    const en = ctrl(inputs.en?.[0], 1);
    const rst = ctrl(inputs.rst?.[0], 0);
    let value = state.value ?? 0;
    const rising = state.prevClk === 0 && clk === 1;
    if (rst === 1) {
      value = 0;
    } else if (en === 1 && rising) {
      const dBits = inputs.d || new Array(width).fill(FLOATING);
      const v = toInt(dBits);
      if (v !== null) value = v;
    }
    return { outputs: { q: fromInt(value, width) }, state: { value, prevClk: clk, width } };
  },
});

const MAX_ADDR_BITS = 10; // 1024 words - keeps the JSON file & UI snappy

registerComponentType({
  type: 'RAM',
  category: 'Speicher',
  label: 'RAM',
  color: '#f0a35e',
  paramsSchema: [
    { key: 'addrWidth', label: 'Adressbreite', kind: 'int', min: 1, max: MAX_ADDR_BITS, step: 1, default: 4 },
    { key: 'dataWidth', label: 'Datenbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 },
    { key: 'preset', label: 'Inhalt (hex, Leerzeichen-getrennt)', kind: 'text', default: '' },
  ],
  pins: (params) => [
    { id: 'addr', label: 'A', dir: 'in', width: params.addrWidth ?? 4, side: 'left', order: 0 },
    { id: 'din', label: 'DI', dir: 'in', width: params.dataWidth ?? 8, side: 'left', order: 1 },
    { id: 'we', label: 'WE', dir: 'in', width: 1, side: 'left', order: 2 },
    { id: 'clk', label: '>', dir: 'in', width: 1, side: 'left', order: 3 },
    { id: 'dout', label: 'DO', dir: 'out', width: params.dataWidth ?? 8, side: 'right', order: 0 },
  ],
  size: () => ({ w: 4, h: 6 }),
  init: (params) => ({ mem: presetToMem(params), prevClk: 0 }),
  evaluate: ({ inputs, state, params }) => {
    const addrWidth = Math.min(params.addrWidth ?? 4, MAX_ADDR_BITS);
    const dataWidth = params.dataWidth ?? 8;
    const size = 2 ** addrWidth;
    let mem = state.mem;
    if (!mem || mem.length !== size) mem = presetToMem(params);
    const addrBits = inputs.addr || new Array(addrWidth).fill(FLOATING);
    const addr = toInt(addrBits) ?? 0;
    const we = ctrl(inputs.we?.[0], 0);
    const clk = ctrl(inputs.clk?.[0], 0);
    const rising = state.prevClk === 0 && clk === 1;
    if (we === 1 && rising) {
      const dinBits = inputs.din || new Array(dataWidth).fill(FLOATING);
      const v = toInt(dinBits);
      if (v !== null) {
        mem = mem.slice();
        mem[addr % size] = v;
      }
    }
    const out = mem[addr % size] ?? 0;
    return { outputs: { dout: fromInt(out, dataWidth) }, state: { mem, prevClk: clk } };
  },
});

function presetToMem(params) {
  const addrWidth = Math.min(params.addrWidth ?? 4, MAX_ADDR_BITS);
  const size = 2 ** addrWidth;
  const mem = new Array(size).fill(0);
  const words = (params.preset || '').trim().split(/\s+/).filter(Boolean);
  words.forEach((w, i) => {
    if (i >= size) return;
    const v = parseInt(w, 16);
    mem[i] = Number.isFinite(v) ? v : 0;
  });
  return mem;
}
