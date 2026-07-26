import { registerComponentType } from '../core/registry.js';
import { fromInt, toInt, FLOATING } from '../core/bits.js';

registerComponentType({
  type: 'SWITCH',
  category: 'Ein-/Ausgabe',
  label: 'Switch',
  color: '#e0e6ec',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 1 }],
  pins: (params) => [{ id: 'out', label: '', dir: 'out', width: params.width ?? 1, side: 'right', order: 0 }],
  size: () => ({ w: 2, h: 2 }),
  init: () => ({ value: 0 }),
  interactive: true,
  onActivate: (state, params) => {
    const width = params.width ?? 1;
    // 1-bit switches toggle on click; wider switches are set via the properties panel instead.
    return { ...state, value: width === 1 ? (state.value ? 0 : 1) : state.value };
  },
  evaluate: ({ state, params }) => ({ outputs: { out: fromInt(state.value ?? 0, params.width ?? 1) }, state }),
  help: {
    summary: 'Manueller Ein-/Ausgabe-Schalter: hält seinen Zustand, bis er wieder geändert wird.',
    usage: 'Bei 1 Bit Breite: anklicken zum Umschalten (0/1). Bei größerer Bitbreite den Wert stattdessen im Eigenschaften-Panel setzen.',
    pins: { out: 'Aktueller Schalterwert.' },
  },
});

registerComponentType({
  type: 'BUTTON',
  category: 'Ein-/Ausgabe',
  label: 'Button',
  color: '#e0e6ec',
  paramsSchema: [],
  pins: () => [{ id: 'out', label: '', dir: 'out', width: 1, side: 'right', order: 0 }],
  size: () => ({ w: 2, h: 2 }),
  init: () => ({ pressed: false }),
  interactive: true,
  onPointerDown: (state) => ({ ...state, pressed: true }),
  onPointerUp: (state) => ({ ...state, pressed: false }),
  evaluate: ({ state }) => ({ outputs: { out: [state.pressed ? 1 : 0] }, state }),
  help: {
    summary: 'Taster: liefert 1 nur solange die Maustaste gedrückt gehalten wird, sonst 0.',
    usage: 'Zum Auslösen einzelner Aktionen (Reset, manueller Takt-Impuls, Trigger) gedrückt halten.',
    pins: { out: '1 während gedrückt, sonst 0.' },
  },
});

registerComponentType({
  type: 'CLOCK',
  category: 'Ein-/Ausgabe',
  label: 'Clock',
  color: '#e0e6ec',
  // Marks this as a component whose OUTPUT can change over time on its own (i.e. without
  // any input/state change triggering it), which the editor's main loop (src/ui/editor.js,
  // `circuitHasActiveClock`) uses to decide whether a frame needs fine time-sliced
  // sub-stepping at all. Only relevant when hz > 0 - at hz === 0 a Clock is just a manual
  // toggle like a Switch and never changes on its own between clicks.
  isClock: true,
  paramsSchema: [
    { key: 'hz', label: 'Frequenz (Hz), 0 = manuell', kind: 'int', min: 0, max: 1_000_000, step: 1, default: 1 },
    { key: 'pulseMs', label: 'Impulsdauer (ms), 0 = 50% Tastgrad', kind: 'int', min: 0, max: 1_000_000, step: 1, default: 0 },
  ],
  pins: () => [{ id: 'out', label: '', dir: 'out', width: 1, side: 'right', order: 0 }],
  size: () => ({ w: 2, h: 2 }),
  init: () => ({ value: 0, cycleStart: 0 }),
  interactive: true,
  // Manueller Modus (hz=0): normaler Ein/Aus-Klick, kein Timing beteiligt.
  onActivate: (state, params) => {
    if ((params?.hz ?? 0) > 0) return state;
    return { ...state, value: state.value ? 0 : 1 };
  },
  // Phasenbasiert statt Toggle-mit-Delta: die Zykluslänge wird aus `now` direkt
  // hergeleitet (elapsed % period), statt bei jedem Tick zu toggeln. Das verhindert
  // Drift durch unregelmäßige Frame-Zeiten und erlaubt eine von der Frequenz
  // unabhängige Impulsdauer (Tastgrad ungleich 50%).
  evaluate: ({ state, params, now }) => {
    const hz = params.hz ?? 0;
    if (hz <= 0) {
      return { outputs: { out: [state.value ?? 0] }, state };
    }
    const period = 1000 / hz;
    const pulse = Math.min(params.pulseMs > 0 ? params.pulseMs : period / 2, period);
    let cycleStart = state.cycleStart || 0;
    let elapsed = now - cycleStart;
    if (elapsed < 0 || elapsed >= period) {
      // Zyklusstart neu ausrichten (z.B. nach Frequenzänderung oder Tab-Pause),
      // statt aufzusummieren und wegzudriften.
      cycleStart = now - (((elapsed % period) + period) % period);
      elapsed = now - cycleStart;
    }
    const value = elapsed < pulse ? 1 : 0;
    return { outputs: { out: [value] }, state: { value, cycleStart } };
  },
  help: {
    summary: 'Taktgeber: bei Frequenz 0 ein manueller Ein/Aus-Schalter, bei Frequenz >0 ein automatischer Rechteck-Oszillator.',
    usage: 'Frequenz (Hz) = 0 lässt sich per Klick manuell umschalten, ideal zum schrittweisen Debuggen von Flipflops/Registern. Frequenz >0 läuft automatisch; Impulsdauer=0 ergibt 50% Tastgrad, sonst feste Impulslänge in ms.',
    pins: { out: 'Taktsignal.' },
  },
});

function makeConstant(type, label, bit) {
  registerComponentType({
    type,
    category: 'Ein-/Ausgabe',
    label,
    color: '#8a94a0',
    paramsSchema: [],
    pins: () => [{ id: 'out', label: '', dir: 'out', width: 1, side: 'right', order: 0 }],
    size: () => ({ w: 2, h: 1 }),
    init: () => ({}),
    evaluate: () => ({ outputs: { out: [bit] }, state: {} }),
  });
}
registerComponentType({
  type: 'PULLUP',
  category: 'Ein-/Ausgabe',
  label: 'Pull-up',
  color: '#8a94a0',
  paramsSchema: [],
  // Pin unten -> Anschluss ans restliche Netz; Pfeil zeigt nach oben zur (gedachten) VCC-Schiene
  pins: () => [{ id: 'out', label: '', dir: 'out', width: 1, side: 'bottom', order: 0 }],
  size: () => ({ w: 2, h: 2 }),
  init: () => ({}),
  evaluate: () => ({ outputs: { out: [1] }, state: {} }),
  help: {
    summary: 'Fester Logikpegel 1 (wie ein Pull-up-Widerstand an VCC).',
    usage: 'An offene/unbeschaltete Eingänge hängen, damit diese statt zu floaten definiert auf 1 liegen.',
    pins: { out: 'Konstant 1.' },
  },
});

registerComponentType({
  type: 'PULLDOWN',
  category: 'Ein-/Ausgabe',
  label: 'Pull-down',
  color: '#8a94a0',
  paramsSchema: [],
  // Pin oben -> Anschluss ans restliche Netz; Pfeil zeigt nach unten zur (gedachten) GND-Schiene
  pins: () => [{ id: 'out', label: '', dir: 'out', width: 1, side: 'top', order: 0 }],
  size: () => ({ w: 2, h: 2 }),
  init: () => ({}),
  evaluate: () => ({ outputs: { out: [0] }, state: {} }),
  help: {
    summary: 'Fester Logikpegel 0 (wie ein Pull-down-Widerstand an GND).',
    usage: 'An offene/unbeschaltete Eingänge hängen, damit diese statt zu floaten definiert auf 0 liegen.',
    pins: { out: 'Konstant 0.' },
  },
});

registerComponentType({
  type: 'CONSTANT',
  category: 'Ein-/Ausgabe',
  label: 'Konstante',
  color: '#8a94a0',
  paramsSchema: [
    { key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 },
    { key: 'value', label: 'Wert (hex)', kind: 'text', default: '0' },
  ],
  pins: (params) => [{ id: 'out', label: '', dir: 'out', width: params.width ?? 8, side: 'right', order: 0 }],
  size: () => ({ w: 3, h: 2 }),
  init: () => ({}),
  evaluate: ({ params }) => {
    const width = params.width ?? 8;
    const v = parseInt(params.value ?? '0', 16);
    return { outputs: { out: fromInt(Number.isFinite(v) ? v : 0, width) }, state: {} };
  },
  help: {
    summary: 'Fester, im Eigenschaften-Panel einstellbarer Mehrbit-Wert (Hex).',
    usage: 'Bitbreite und Hex-Wert im Eigenschaften-Panel setzen - praktisch für feste Adressen, Opcodes oder Testwerte.',
    pins: { out: 'Der konfigurierte konstante Wert.' },
  },
});

registerComponentType({
  type: 'RGBLED',
  category: 'Ein-/Ausgabe',
  label: 'RGB-LED',
  color: '#e0e6ec',
  paramsSchema: [],
  pins: () => [
    { id: 'r', label: 'R', dir: 'in', width: 8, side: 'left', order: 0 },
    { id: 'g', label: 'G', dir: 'in', width: 8, side: 'left', order: 1 },
    { id: 'b', label: 'B', dir: 'in', width: 8, side: 'left', order: 2 },
  ],
  size: () => ({ w: 3, h: 3 }),
  init: () => ({}),
  evaluate: ({ inputs }) => ({
    outputs: {},
    state: {
      r: toInt(inputs.r || new Array(8).fill(FLOATING)) ?? 0,
      g: toInt(inputs.g || new Array(8).fill(FLOATING)) ?? 0,
      b: toInt(inputs.b || new Array(8).fill(FLOATING)) ?? 0,
    },
  }),
  help: {
    summary: 'RGB-LED: zeigt eine Farbe aus drei 8-Bit-Kanälen (Rot, Grün, Blau).',
    usage: 'An R/G/B jeweils einen 8-Bit-Wert (0-255) anlegen, z.B. aus Konstanten oder Registern.',
    pins: { r: 'Rot-Kanal (0-255).', g: 'Grün-Kanal (0-255).', b: 'Blau-Kanal (0-255).' },
  },
});

// Geometrie des Tracks in Bauteil-lokalen Weltkoordinaten. Wird sowohl vom
// Editor (Hit-Testing beim Ziehen) als auch vom Renderer (Zeichnen) genutzt,
// damit beide exakt übereinstimmen.
export function sliderTrackRect(inst) {
  const marginX = 0.72; // pw*0.12 in Grid-Einheiten (6*0.12)
  return { x0: inst.x + marginX, x1: inst.x + 6 - marginX, y: inst.y + 1.86 };
}

export function formatSliderValue(value, format) {
  const v = value >>> 0;
  if (format === 'hex') return '0x' + v.toString(16).toUpperCase();
  if (format === 'bin') return v.toString(2);
  return String(value);
}

function sliderRange(params) {
  const width = params.width ?? 8;
  const min = params.min ?? 0;
  const max = params.max ?? (2 ** width - 1);
  return min <= max ? { lo: min, hi: max } : { lo: max, hi: min };
}

registerComponentType({
  type: 'SLIDER',
  category: 'Ein-/Ausgabe',
  label: 'Slider',
  color: '#8a94a0',
  paramsSchema: [
    { key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 },
    { key: 'min', label: 'Minimum', kind: 'int', min: 0, max: 0xFFFFFFFF, step: 1, default: 0 },
    { key: 'max', label: 'Maximum', kind: 'int', min: 0, max: 0xFFFFFFFF, step: 1, default: 255 },
    { key: 'format', label: 'Darstellung', kind: 'select', options: ['dec', 'hex', 'bin'], default: 'dec' },
  ],
  pins: (params) => [{ id: 'out', label: '', dir: 'out', width: params.width ?? 8, side: 'right', order: 0 }],
  size: () => ({ w: 6, h: 3 }),
  init: (params) => ({ value: sliderRange(params ?? {}).lo }),
  interactive: true,
  // t: normierte Position 0..1 entlang des Tracks (0 = links = min, 1 = rechts = max)
  onSliderInput: (state, params, t) => {
    const { lo, hi } = sliderRange(params);
    const value = Math.max(lo, Math.min(hi, Math.round(lo + t * (hi - lo))));
    return { ...state, value };
  },
  evaluate: ({ state, params }) => {
    const { lo, hi } = sliderRange(params);
    const value = Math.max(lo, Math.min(hi, state.value ?? lo));
    return { outputs: { out: fromInt(value, params.width ?? 8) }, state: { ...state, value } };
  },
  help: {
    summary: 'Schieberegler für einen einstellbaren Zahlenwert zwischen Minimum und Maximum.',
    usage: 'Mit der Maus auf dem Regler ziehen. Min/Max/Bitbreite/Darstellung (dez/hex/bin) im Eigenschaften-Panel konfigurieren.',
    pins: { out: 'Aktueller Reglerwert.' },
  },
});
