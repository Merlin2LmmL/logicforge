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
  size: (params) => ({ w: 4, h: Math.max(2, params.width ?? 8) }),
  init: () => ({}),
  evaluate: ({ inputs, params }) => {
    const width = params.width ?? 8;
    const bus = inputs.bus || new Array(width).fill(FLOATING);
    const outputs = {};
    for (let i = 0; i < width; i++) outputs[`b${i}`] = [bus[i] ?? FLOATING];
    return { outputs, state: {} };
  },
  help: {
    summary: 'Splitter: zerlegt einen breiten Bus in einzelne 1-Bit-Leitungen.',
    usage: 'Busbreite einstellen, BUS anschließen; b0..bN liefern die einzelnen Bits (b0 = niederwertigstes Bit).',
    pins: { bus: 'Der aufzuteilende Bus.' },
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
  help: {
    summary: 'Merger: fügt einzelne 1-Bit-Leitungen zu einem breiten Bus zusammen (Gegenstück zum Splitter).',
    usage: 'Busbreite einstellen, b0..bN mit einzelnen Signalen verbinden (b0 = niederwertigstes Bit); BUS liefert den zusammengesetzten Wert.',
    pins: { bus: 'Der zusammengesetzte Bus.' },
  },
});

function makeReducer({ type, label, color, op, identity, helpText }) {
  registerComponentType({
    type,
    category: 'Verdrahtung',
    label,
    color,
    paramsSchema: [
      { key: 'width', label: 'Busbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 },
    ],
    pins: (params) => [
      { id: 'bus', label: 'BUS', dir: 'in', width: params.width ?? 8, side: 'left', order: 0 },
      { id: 'out', label: 'Y', dir: 'out', width: 1, side: 'right', order: 0 },
    ],
    size: () => ({ w: 3, h: 2 }),
    init: () => ({}),
    evaluate: ({ inputs, params }) => {
      const width = params.width ?? 8;
      const bus = inputs.bus || new Array(width).fill(FLOATING);

      let acc = identity;
      let hasFloating = false;

      for (let i = 0; i < width; i++) {
        const bit = bus[i] ?? FLOATING;

        if (bit === FLOATING) {
          hasFloating = true;
          continue;
        }

        if (bit === 'X') {
          return { outputs: { out: ['X'] }, state: {} };
        }

        acc = op(acc, bit);
      }

      if (hasFloating) acc = FLOATING;

      return { outputs: { out: [acc] }, state: {} };
    },
    help: {
      summary: helpText,
      usage: 'Reduziert alle Bits eines Busses zu einem einzelnen Bit.',
      pins: {
        bus: 'Eingangsbus.',
        out: '1-Bit-Ergebnis der Reduktion.',
      },
    },
  });
}

makeReducer({
  type: 'REDUCE_OR',
  label: 'OR-Reduktor',
  color: '#5eb0f0',
  op: (a, b) => a | b,
  identity: 0,
  helpText: 'Ausgang ist 1, sobald mindestens ein Bit des Busses 1 ist.',
});

makeReducer({
  type: 'REDUCE_AND',
  label: 'AND-Reduktor',
  color: '#e8b34c',
  op: (a, b) => a & b,
  identity: 1,
  helpText: 'Ausgang ist 1, wenn alle Bits des Busses 1 sind.',
});

makeReducer({
  type: 'REDUCE_XOR',
  label: 'XOR-Reduktor',
  color: '#a984e8',
  op: (a, b) => a ^ b,
  identity: 0,
  helpText: 'Ausgang ist 1, wenn eine ungerade Anzahl der Bus-Bits 1 ist (Parität).',
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
  help: {
    summary: 'Tunnel-Eingang: verbindet sich drahtlos mit allen Tunnel-Ausgängen gleichen Netznamens - erspart lange, kreuzende Kabel.',
    usage: 'Netzname im Parameter vergeben; jeder Tunnel-Ausgang mit demselben Namen empfängt dieses Signal, egal wo er in der Schaltung platziert ist.',
    pins: { in0: 'In den Tunnel einzuspeisendes Signal.' },
  },
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
  help: {
    summary: 'Tunnel-Ausgang: liefert das Signal des/der Tunnel-Eingänge mit gleichem Netznamen (Gegenstück zu Tunnel-Ein).',
    usage: 'Gleichen Netznamen wie am gewünschten Tunnel-Eingang vergeben; der Wert erscheint hier, ohne ein Kabel quer durch die Schaltung ziehen zu müssen.',
    pins: { out: 'Signal des zugehörigen Tunnel-Eingangs.' },
  },
});