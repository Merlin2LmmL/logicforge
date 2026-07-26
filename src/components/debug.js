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
  help: {
    summary: 'Lampe: leuchtet je nach anliegendem Bit (0/1) und zeigt Konflikte/offene Leitungen farblich an.',
    usage: 'Zum schnellen visuellen Prüfen einzelner Bits oder kleiner Busse an eine Leitung anschließen.',
    pins: { in0: 'Anzuzeigendes Signal.' },
  },
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
  help: {
    summary: 'Zeigt einen Mehrbit-Wert als Zahl an (hex, dezimal oder binär).',
    usage: 'Bitbreite und Anzeigeformat im Eigenschaften-Panel wählen; nützlich zum Ablesen von Bus-/Registerwerten.',
    pins: { in0: 'Anzuzeigender Wert.' },
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
  help: {
    summary: 'Messpunkt: zeigt beim Hover die aktuellen Bitwerte einer Leitung an, ohne die Schaltung zu beeinflussen.',
    usage: 'An eine beliebige Stelle anschließen und mit der Maus über den Pin fahren, um den Wert im Tooltip zu sehen.',
    pins: { in0: 'Zu messendes Signal.' },
  },
});

registerComponentType({
  type: 'SEVENSEG',
  category: 'Debug',
  label: '7-Segment',
  color: '#7cff9e',
  paramsSchema: [],
  pins: () => ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'].map((id, i) => ({
    id, label: id.toUpperCase(), dir: 'in', width: 1, side: 'left', order: i,
  })),
  size: () => ({ w: 3, h: 5 }),
  init: () => ({}),
  evaluate: ({ inputs }) => {
    const segs = {};
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp']) segs[id] = inputs[id]?.[0] === 1 ? 1 : 0;
    return { outputs: {}, state: { segs } };
  },
  help: {
    summary: '7-Segment-Anzeige für Ziffern: jedes Segment (a-g) und der Dezimalpunkt (dp) wird einzeln über je 1 Bit angesteuert.',
    usage: 'Meist über einen BCD/7-Segment-Dekoder (z.B. eine ROM-Tabelle oder Code-Komponente) ansteuern, der aus einer Ziffer die passenden Segmentmuster erzeugt.',
    pins: { a: 'oberes Segment.', b: 'oben rechts.', c: 'unten rechts.', d: 'unteres Segment.', e: 'unten links.', f: 'oben links.', g: 'Mittelsegment.', dp: 'Dezimalpunkt.' },
  },
});

// 16-Segment-Anzeige: erweitert das 7-Segment-Prinzip um geteilte Ober-/Unterkante
// und vier Diagonalen/Vertikalen zum Bildmittelpunkt, damit auch Buchstaben
// darstellbar sind (nicht nur Ziffern). Segment-Namen folgen der üblichen
// "Starburst"-Konvention: a1/a2 und d1/d2 geteilte Ober-/Unterkante, g1/g2
// geteilte Mittellinie, h/i/j/k/l/m die sechs Speichen zum Zentrum.
registerComponentType({
  type: 'SEG16',
  category: 'Debug',
  label: '16-Segment',
  color: '#7cff9e',
  paramsSchema: [],
  pins: () => ['a1', 'a2', 'b', 'c', 'd1', 'd2', 'e', 'f', 'g1', 'g2', 'h', 'i', 'j', 'k', 'l', 'm', 'dp']
    .map((id, i) => ({ id, label: id.toUpperCase(), dir: 'in', width: 1, side: 'left', order: i })),
  size: () => ({ w: 4, h: 7 }),
  init: () => ({}),
  evaluate: ({ inputs }) => {
    const segs = {};
    for (const id of ['a1', 'a2', 'b', 'c', 'd1', 'd2', 'e', 'f', 'g1', 'g2', 'h', 'i', 'j', 'k', 'l', 'm', 'dp']) {
      segs[id] = inputs[id]?.[0] === 1 ? 1 : 0;
    }
    return { outputs: {}, state: { segs } };
  },
  help: {
    summary: '16-Segment-Anzeige: erweiterte 7-Segment-Anzeige mit geteilter Ober-/Unterkante und Diagonalen, damit auch Buchstaben darstellbar sind, nicht nur Ziffern.',
    usage: 'Jedes der 16 Segmente einzeln mit 1 Bit ansteuern, üblicherweise über eine ROM-Zeichensatztabelle o.ä.',
    pins: { dp: 'Dezimalpunkt.' },
  },
});

registerComponentType({
  type: 'BUSWATCH',
  category: 'Debug',
  label: 'Bus-Watch',
  color: '#e0e6ec',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 }],
  pins: (params) => [{ id: 'in0', label: '', dir: 'in', width: params.width ?? 8, side: 'left', order: 0 }],
  size: () => ({ w: 5, h: 3 }),
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
  help: {
    summary: 'Größere Bus-Anzeige, ähnlich Display, für breitere Busse mit mehr Platz zum Ablesen.',
    usage: 'An einen breiten Bus anschließen; Anzeigeformat im Eigenschaften-Panel wählen.',
    pins: { in0: 'Anzuzeigender Bus.' },
  },
});
