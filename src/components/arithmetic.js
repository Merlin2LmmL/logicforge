import { registerComponentType } from '../core/registry.js';
import { FLOATING, CONFLICT, toInt, fromInt } from '../core/bits.js';

function coerce(b) { return b === 1 ? 1 : 0; } // FLOATING wird für die Rechnung als 0 behandelt
function ctrlBit(v, fallback) { return v === 1 || v === 0 ? v : fallback; }

// Multiplizierer/Dividierer können bei 32 Bit Breite ein bis zu 64 Bit breites
// Zwischenergebnis erzeugen - das sprengt den sicheren 32-Bit-Bereich normaler
// Bitoperatoren, daher wird hier mit BigInt gerechnet.
function bigFromBits(bits) {
  let v = 0n;
  for (let i = bits.length - 1; i >= 0; i--) {
    const b = bits[i];
    if (b !== 0 && b !== 1) return null;
    v = (v << 1n) | BigInt(b);
  }
  return v;
}
function bigToBits(v, width) {
  const out = new Array(width);
  for (let i = 0; i < width; i++) out[i] = Number((v >> BigInt(i)) & 1n);
  return out;
}

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
  help: {
    summary: 'Addierer/Subtrahierer: berechnet A+B (SUB=0) oder A−B per Zweierkomplement (SUB=1).',
    usage: 'Bei SUB=1 wird B invertiert und CIN intern auf 1 gesetzt (echte Subtraktion). Bei SUB=0/offen normale Addition, CIN dann frei als externer Übertrag nutzbar, z.B. um mehrere Addierer zu breiteren Addierern zu kaskadieren (COUT des einen an CIN des nächsten).',
    pins: {
      a: 'Erster Operand.',
      b: 'Zweiter Operand.',
      cin: 'Carry-In: externer Übertrag bei Addition (SUB=0); wird bei SUB=1 ignoriert/auf 1 erzwungen.',
      sub: '0/offen = Addition (A+B), 1 = Subtraktion (A−B).',
      y: 'Ergebnis (Summe bzw. Differenz).',
      cout: 'Carry-Out: Übertrag/Borrow, u.a. zum Kaskadieren.',
    },
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
  help: {
    summary: 'Vergleicht zwei vorzeichenlose Zahlen A und B und zeigt das Ergebnis auf drei getrennten Ausgängen.',
    usage: 'A und B anschließen; genau einer der drei Ausgänge ist 1, je nachdem ob A=B, A<B oder A>B gilt.',
    pins: { a: 'Erster Operand.', b: 'Zweiter Operand.', eq: '1, wenn A=B.', lt: '1, wenn A<B.', gt: '1, wenn A>B.' },
  },
});

registerComponentType({
  type: 'PRNG',
  category: 'Arithmetik',
  label: 'Pseudozufallsgenerator (LFSR)',
  color: '#f0785e',

  paramsSchema: [
    { key: 'width', label: 'Bitbreite', kind: 'int', min: 2, max: 32, step: 1, default: 8 },
    { key: 'seed', label: 'Startwert (Hex)', kind: 'text', default: '1' },
  ],

  pins: (params) => {
    const width = params.width ?? 8;

    return [
      { id: 'clk', label: 'CLK', dir: 'in', width: 1, side: 'left', order: 0 },
      { id: 'reset', label: 'RESET', dir: 'in', width: 1, side: 'left', order: 1 },
      { id: 'en', label: 'EN', dir: 'in', width: 1, side: 'left', order: 2 },

      { id: 'q', label: 'Q', dir: 'out', width, side: 'right', order: 0 },
    ];
  },

  size: () => ({ w: 5, h: 5 }),

  init: () => ({
    value: 1,
    lastClk: 0,
    initialized: false,
  }),

  evaluate: ({ inputs, params, state }) => {
    const width = params.width ?? 8;

    const mask = width >= 32
      ? 0xFFFFFFFF
      : (1 << width) - 1;

    let value = state.value ?? 1;

    // Seed laden
    if (!state.initialized) {
      let seed = parseInt(params.seed ?? '1', 16);

      if (!Number.isFinite(seed) || seed === 0)
        seed = 1;

      value = seed & mask;
    }

    const clk = inputs.clk?.[0] === 1 ? 1 : 0;
    const reset = inputs.reset?.[0] === 1;
    const en = inputs.en?.[0] === 1;

    if (reset) {
      let seed = parseInt(params.seed ?? '1', 16);

      if (!Number.isFinite(seed) || seed === 0)
        seed = 1;

      value = seed & mask;
    }
    else if (clk === 1 && state.lastClk === 0 && en) {
      // Feedback: x^8 + x^6 + x^5 + x^4 + 1
      const feedback =
        ((value >> (width - 1)) ^
        (value >> (width - 3)) ^
        (value >> (width - 4)) ^
        (value >> (width - 5))) & 1;

      value = ((value << 1) | feedback) & mask;
    }

    const output = [];
    for (let i = 0; i < width; i++) {
      output.push((value >> i) & 1);
    }

    return {
      outputs: {
        q: output,
      },
      state: {
        value,
        lastClk: clk,
        initialized: true,
      },
    };
  },

  help: {
    summary: 'Pseudozufallsgenerator mit LFSR.',
    usage: 'Erzeugt bei jeder steigenden CLK-Flanke einen neuen Wert. RESET setzt den Seed zurück.',
    pins: {
      clk: 'Takt-Eingang.',
      reset: 'Setzt den Generator auf den Startwert zurück.',
      en: 'Aktiviert die Generierung.',
      q: 'Pseudozufallswert.',
    },
  },
});

registerComponentType({
  type: 'MULTIPLIER',
  category: 'Arithmetik',
  label: 'Multiplizierer',
  color: '#f0785e',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 }],
  pins: (params) => {
    const width = params.width ?? 8;
    return [
      { id: 'a', label: 'A', dir: 'in', width, side: 'left', order: 0 },
      { id: 'b', label: 'B', dir: 'in', width, side: 'left', order: 1 },
      { id: 'lo', label: 'LO', dir: 'out', width, side: 'right', order: 0 },
      { id: 'hi', label: 'HI', dir: 'out', width, side: 'right', order: 1 },
      { id: 'ovf', label: 'OVF', dir: 'out', width: 1, side: 'right', order: 2 },
    ];
  },
  size: () => ({ w: 4, h: 4 }),
  init: () => ({}),
  // Volles Produkt (2×width Bit) über LO (untere Hälfte) und HI (obere Hälfte) verfügbar,
  // OVF zeigt an, ob das Ergebnis überhaupt in `width` Bit gepasst hätte (HI ≠ 0).
  evaluate: ({ inputs, params }) => {
    const width = params.width ?? 8;
    const a = inputs.a || new Array(width).fill(FLOATING);
    const b = inputs.b || new Array(width).fill(FLOATING);
    if (a.includes(CONFLICT) || b.includes(CONFLICT)) {
      return { outputs: { lo: new Array(width).fill(CONFLICT), hi: new Array(width).fill(CONFLICT), ovf: [CONFLICT] }, state: {} };
    }
    const av = bigFromBits(a), bv = bigFromBits(b);
    if (av === null || bv === null) {
      return { outputs: { lo: new Array(width).fill(FLOATING), hi: new Array(width).fill(FLOATING), ovf: [FLOATING] }, state: {} };
    }
    const product = av * bv;
    const mask = (1n << BigInt(width)) - 1n;
    const lo = product & mask;
    const hi = (product >> BigInt(width)) & mask;
    return { outputs: { lo: bigToBits(lo, width), hi: bigToBits(hi, width), ovf: [hi !== 0n ? 1 : 0] }, state: {} };
  },
  help: {
    summary: 'Multipliziert zwei vorzeichenlose Zahlen A und B. Das volle Produkt (bis zu 2×Bitbreite) liegt an LO/HI an.',
    usage: 'Für Ergebnisse, die in die Bitbreite passen, reicht LO. HI enthält die oberen Bits eines größeren Produkts; OVF ist 1, wenn HI ungleich 0 ist (Ergebnis passt nicht in `width` Bit).',
    pins: { a: 'Erster Faktor.', b: 'Zweiter Faktor.', lo: 'Untere Bits des Produkts.', hi: 'Obere Bits des Produkts (bei Überlauf über die Bitbreite hinaus).', ovf: '1, wenn das Produkt nicht in `width` Bit passt.' },
  },
});

registerComponentType({
  type: 'DIVIDER',
  category: 'Arithmetik',
  label: 'Dividierer',
  color: '#f0785e',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 }],
  pins: (params) => {
    const width = params.width ?? 8;
    return [
      { id: 'a', label: 'A', dir: 'in', width, side: 'left', order: 0 },
      { id: 'b', label: 'B', dir: 'in', width, side: 'left', order: 1 },
      { id: 'q', label: 'Q', dir: 'out', width, side: 'right', order: 0 },
      { id: 'r', label: 'R', dir: 'out', width, side: 'right', order: 1 },
      { id: 'err', label: 'ERR', dir: 'out', width: 1, side: 'right', order: 2 },
    ];
  },
  size: () => ({ w: 4, h: 4 }),
  init: () => ({}),
  // Ganzzahlige Division (vorzeichenlos): Q = A div B, R = A mod B. Division durch 0
  // liefert Q=R=0 und ERR=1, statt einer Endlosschleife/NaN im Simulator.
  evaluate: ({ inputs, params }) => {
    const width = params.width ?? 8;
    const a = inputs.a || new Array(width).fill(FLOATING);
    const b = inputs.b || new Array(width).fill(FLOATING);
    if (a.includes(CONFLICT) || b.includes(CONFLICT)) {
      return { outputs: { q: new Array(width).fill(CONFLICT), r: new Array(width).fill(CONFLICT), err: [CONFLICT] }, state: {} };
    }
    const av = bigFromBits(a), bv = bigFromBits(b);
    if (av === null || bv === null) {
      return { outputs: { q: new Array(width).fill(FLOATING), r: new Array(width).fill(FLOATING), err: [FLOATING] }, state: {} };
    }
    if (bv === 0n) {
      return { outputs: { q: new Array(width).fill(0), r: new Array(width).fill(0), err: [1] }, state: {} };
    }
    const mask = (1n << BigInt(width)) - 1n;
    return { outputs: { q: bigToBits(av / bv & mask, width), r: bigToBits(av % bv & mask, width), err: [0] }, state: {} };
  },
  help: {
    summary: 'Ganzzahlige Division (vorzeichenlos): Q = A div B (Quotient), R = A mod B (Rest).',
    usage: 'Division durch 0 (B=0) liefert Q=0, R=0 und setzt ERR auf 1, statt eines undefinierten Ergebnisses.',
    pins: { a: 'Dividend.', b: 'Divisor.', q: 'Quotient.', r: 'Rest.', err: '1, wenn B=0 (Division durch Null).' },
  },
});

const ALU_OPS = ['ADD', 'SUB', 'AND', 'OR', 'XOR', 'NOT A', 'SHL (A << B)', 'SHR (A >> B)'];

registerComponentType({
  type: 'ALU',
  category: 'Arithmetik',
  label: 'ALU',
  color: '#f0785e',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 }],
  pins: (params) => {
    const width = params.width ?? 8;
    return [
      { id: 'a', label: 'A', dir: 'in', width, side: 'left', order: 0 },
      { id: 'b', label: 'B', dir: 'in', width, side: 'left', order: 1 },
      { id: 'op', label: 'OP', dir: 'in', width: 3, side: 'left', order: 2 },
      { id: 'cin', label: 'CIN', dir: 'in', width: 1, side: 'left', order: 3 },
      { id: 'y', label: 'Y', dir: 'out', width, side: 'right', order: 0 },
      { id: 'cout', label: 'COUT', dir: 'out', width: 1, side: 'right', order: 1 },
      { id: 'zero', label: 'ZERO', dir: 'out', width: 1, side: 'right', order: 2 },
      { id: 'neg', label: 'NEG', dir: 'out', width: 1, side: 'right', order: 3 },
    ];
  },
  size: () => ({ w: 5, h: 6 }),
  init: () => ({}),
  // OP (3 Bit) wählt die Operation: 0=ADD 1=SUB 2=AND 3=OR 4=XOR 5=NOT A 6=SHL 7=SHR.
  // ZERO/NEG sind reine Flags über das aktuelle Ergebnis Y (kein eigener Zustand/Register -
  // eine klassische "Register + Flags"-CPU baut man, indem man Y extern in ein Register takt).
  evaluate: ({ inputs, params }) => {
    const width = params.width ?? 8;
    const a = inputs.a || new Array(width).fill(FLOATING);
    const b = inputs.b || new Array(width).fill(FLOATING);
    const opBits = inputs.op || [0, 0, 0];
    if (a.includes(CONFLICT) || b.includes(CONFLICT) || opBits.includes(CONFLICT)) {
      return { outputs: { y: new Array(width).fill(CONFLICT), cout: [CONFLICT], zero: [CONFLICT], neg: [CONFLICT] }, state: {} };
    }
    const av = toInt(a), bv = toInt(b);
    if (av === null || bv === null) {
      return { outputs: { y: new Array(width).fill(FLOATING), cout: [FLOATING], zero: [FLOATING], neg: [FLOATING] }, state: {} };
    }
    const op = opBits.reduce((acc, bit, i) => acc | ((bit === 1 ? 1 : 0) << i), 0);
    const cin = ctrlBit(inputs.cin?.[0], 0);
    const mask = width >= 32 ? 0xFFFFFFFF : (1 << width) - 1;
    let y = 0, cout = 0;
    switch (op) {
      case 0: { const sum = av + bv + cin; y = sum & mask; cout = sum > mask ? 1 : 0; break; }
      case 1: { const diff = av - bv - cin; y = diff & mask; cout = diff < 0 ? 1 : 0; break; } // COUT=1 -> Borrow
      case 2: y = av & bv; break;
      case 3: y = av | bv; break;
      case 4: y = av ^ bv; break;
      case 5: y = (~av) & mask; break;
      case 6: y = (av << (bv % width)) & mask; break;
      case 7: y = (av >>> (bv % width)) & mask; break;
      default: y = 0;
    }
    const out = fromInt(y, width);
    return { outputs: { y: out, cout: [cout], zero: [y === 0 ? 1 : 0], neg: [out[width - 1]] }, state: {} };
  },
  help: {
    summary: `Arithmetisch-logische Einheit: wählt per 3-Bit-OP-Code eine von 8 Operationen (${ALU_OPS.join(', ')}).`,
    usage: 'OP als 3-Bit-Wert anschließen (z.B. über Schalter oder ein Steuerwerk). COUT ist bei ADD der Übertrag, bei SUB das Borrow-Bit; bei den logischen Operationen und NOT A ist COUT immer 0. ZERO/NEG sind Flags über Y für bedingte Sprünge in einer selbstgebauten CPU.',
    pins: {
      a: 'Erster Operand.', b: 'Zweiter Operand (bei SHL/SHR die Schiebeweite, mod Bitbreite).',
      op: `Operationswahl (3 Bit): ${ALU_OPS.map((o, i) => `${i}=${o}`).join(', ')}.`,
      cin: 'Carry-In für ADD/SUB (bei den übrigen Operationen ignoriert).',
      y: 'Ergebnis.', cout: 'Carry/Borrow-Out (nur bei ADD/SUB aussagekräftig).',
      zero: '1, wenn Y=0.', neg: '1, wenn das oberste Bit von Y gesetzt ist (Vorzeichen bei Zweierkomplement-Interpretation).',
    },
  },
});
