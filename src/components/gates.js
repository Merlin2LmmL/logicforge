import { registerComponentType } from '../core/registry.js';
import { FLOATING, CONFLICT, equalBits } from '../core/bits.js';

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

function makeGate({ type, label, color, op, identity, invert, helpText }) {
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
    help: {
      summary: helpText,
      usage: 'Anzahl der Eingänge und Bitbreite über die Parameter einstellen. Verknüpft alle Eingänge bitweise; bei mehreren Eingängen wird die Operation der Reihe nach auf alle angewendet (z.B. A AND B AND C ...).',
      pins: { out: 'Ergebnis der Verknüpfung, gleiche Bitbreite wie die Eingänge.' },
    },
  });
}

makeGate({ type: 'AND', label: 'AND', color: '#e8b34c', op: (a, b) => a & b, identity: 1, invert: false, helpText: 'Logisches UND: Ausgang ist 1, wenn ALLE Eingänge 1 sind.' });
makeGate({ type: 'OR', label: 'OR', color: '#5eb0f0', op: (a, b) => a | b, identity: 0, invert: false, helpText: 'Logisches ODER: Ausgang ist 1, wenn MINDESTENS EIN Eingang 1 ist.' });
makeGate({ type: 'NAND', label: 'NAND', color: '#e8b34c', op: (a, b) => a & b, identity: 1, invert: true, helpText: 'Negiertes UND: Ausgang ist 0 nur dann, wenn ALLE Eingänge 1 sind, sonst 1.' });
makeGate({ type: 'NOR', label: 'NOR', color: '#5eb0f0', op: (a, b) => a | b, identity: 0, invert: true, helpText: 'Negiertes ODER: Ausgang ist 1 nur dann, wenn ALLE Eingänge 0 sind, sonst 0.' });
makeGate({ type: 'XOR', label: 'XOR', color: '#a984e8', op: (a, b) => a ^ b, identity: 0, invert: false, helpText: 'Exklusiv-ODER: Ausgang ist 1, wenn eine ungerade Anzahl Eingänge 1 ist (bei 2 Eingängen: genau einer).' });
makeGate({ type: 'XNOR', label: 'XNOR', color: '#a984e8', op: (a, b) => a ^ b, identity: 0, invert: true, helpText: 'Negiertes XOR: Ausgang ist 1, wenn eine gerade Anzahl Eingänge 1 ist (bei 2 Eingängen: beide gleich).' });

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
  help: {
    summary: 'Inverter: kehrt jedes Bit um (0→1, 1→0).',
    usage: 'Bitbreite über den Parameter einstellen. Einfach zwischen zwei Punkte schalten, an denen das invertierte Signal gebraucht wird.',
    pins: { in0: 'Eingangssignal.', out: 'Invertiertes Eingangssignal.' },
  },
});

registerComponentType({
  type: 'BUFFER',
  category: 'Gatter',
  label: 'Buffer',
  color: '#7fd67f',
  paramsSchema: [
    { key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 1 },
    { key: 'delayMs', label: 'Verzögerung (ms)', kind: 'int', min: 0, max: 60000, step: 1, default: 0 },
  ],
  pins: (params) => [
    { id: 'in0', label: 'A', dir: 'in', width: params.width ?? 1, side: 'left', order: 0 },
    { id: 'out', label: 'Y', dir: 'out', width: params.width ?? 1, side: 'right', order: 0 },
  ],
  size: () => ({ w: 3, h: 2 }),
  init: () => ({ queue: [] }),
  evaluate: ({ inputs, params, state, now }) => {
  const width = params.width ?? 1;
  const delayMs = params.delayMs ?? 0;
  const a = inputs.in0 || new Array(width).fill(FLOATING);

  if (delayMs <= 0) {
    return { outputs: { out: a.slice() }, state: { queue: [] } };
  }

  const queue = state?.queue || [];
  const last = queue[queue.length - 1];
  // Only append when the value differs from what's already queued, or the queue
  // is empty. Prevents growing by up to maxIters entries within a single
  // settleCircuit() call, where `now` is constant across all iterations.
  const newQueue = (!last || !equalBits(last.value, a))
    ? queue.concat([{ t: now, value: a.slice() }])
    : queue;

  let outValue = new Array(width).fill(FLOATING);
  let cutoffIndex = -1;
  for (let i = 0; i < newQueue.length; i++) {
    if (newQueue[i].t <= now - delayMs) {
      outValue = newQueue[i].value;
      cutoffIndex = i;
    } else break;
  }
  const trimmed = cutoffIndex > 0 ? newQueue.slice(cutoffIndex) : newQueue;
  return { outputs: { out: outValue.slice() }, state: { queue: trimmed } };
},
  help: {
    summary: 'Signalpuffer: gibt den Eingang unverändert weiter, optional zeitlich verzögert.',
    usage: 'Nützlich, um Signale sauber umzuleiten/aufzuteilen, als Platzhalter für spätere Logik, oder um eine reale Signallaufzeit (ms) zu simulieren.',
    pins: { in0: 'Eingangssignal.', out: 'Signal wie in0, um delayMs (ms) verzögert.' },
  },
});

registerComponentType({
  type: 'TRISTATE',
  category: 'Gatter',
  label: 'Tri-State-Buffer',
  color: '#7fd67f',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 1 }],
  pins: (params) => [
    { id: 'in0', label: 'A', dir: 'in', width: params.width ?? 1, side: 'left', order: 0 },
    { id: 'en', label: 'EN', dir: 'in', width: 1, side: 'bottom', order: 0 },
    { id: 'out', label: 'Y', dir: 'out', width: params.width ?? 1, side: 'right', order: 0 },
  ],
  size: () => ({ w: 3, h: 2 }),
  init: () => ({}),
  evaluate: ({ inputs, params }) => {
    const width = params.width ?? 1;
    const en = inputs.en?.[0] === 1;
    if (!en) return { outputs: { out: new Array(width).fill(FLOATING) }, state: {} };
    const a = inputs.in0 || new Array(width).fill(FLOATING);
    return { outputs: { out: a.slice() }, state: {} };
  },
  help: {
    summary: 'Tri-State-Puffer: reicht A nur durch, wenn EN=1 ist. Bei EN=0 ist der Ausgang hochohmig (offen/floating), nicht 0 - so können mehrere Treiber denselben Bus teilen, ohne Kurzschluss.',
    usage: 'EN mit einem Auswahlsignal (z.B. Chip-Select/Adressdecoder) verbinden, damit immer nur ein Tri-State-Treiber gleichzeitig aktiv auf einen gemeinsamen Bus schreibt.',
    pins: { in0: 'Zu schaltendes Signal.', en: 'Enable: 1 = A wird auf OUT durchgereicht, 0 = OUT ist hochohmig.', out: 'A bei EN=1, sonst offen (floating).' },
  },
});
