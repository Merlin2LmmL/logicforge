import { registerComponentType, unregisterComponentType, getComponentType } from './registry.js';
import { Circuit, nextId, stateReplacer, stateReviver } from './model.js';
import { settleCircuit } from './simulator.js';
import { FLOATING, makeFloating } from './bits.js';

// definition shape:
// {
//   id: 'CUSTOM:xyz', name, category, color,
//   kind: 'composite' | 'code',
//   pins: [{ id, label, dir, width, order, side }],     // outer interface, cached
//   circuit: Circuit-JSON,     // composite only (contains PIN_IN / PIN_OUT instances)
//   code: 'js source',        // code only
// }

const definitions = new Map();
const LS_KEY = 'logicforge:library:v1';

export function listDefinitions() {
  return [...definitions.values()];
}
export function getDefinition(id) {
  return definitions.get(id);
}

export function deriveInterfacePins(circuit) {
  const pins = [];
  for (const inst of circuit.components) {
    const def = getComponentType(inst.type);
    if (def?.isInterface === 'in') {
      pins.push({ id: inst.id, label: inst.params.name || 'IN', dir: 'in', width: inst.params.width ?? 1, order: inst.y, side: 'left' });
    } else if (def?.isInterface === 'out') {
      pins.push({ id: inst.id, label: inst.params.name || 'OUT', dir: 'out', width: inst.params.width ?? 1, order: inst.y, side: 'right' });
    }
  }
  pins.sort((a, b) => a.order - b.order);
  return pins;
}

function compositeBoxSize(pins) {
  const nIn = pins.filter((p) => p.dir === 'in').length;
  const nOut = pins.filter((p) => p.dir === 'out').length;
  return { w: 5, h: Math.max(3, Math.max(nIn, nOut) + 1) };
}

function pinInputsKey(def, forcedInputs) {
  let s = '';
  for (const p of def.pins) {
    if (p.dir !== 'in') continue;
    s += p.id + '=' + forcedInputs[p.id].join(',') + ';';
  }
  return s;
}

function buildCompositeType(def) {
  return {
    type: def.id,
    category: def.category || 'Meine Komponenten',
    label: def.name,
    color: def.color || '#5eead4',
    paramsSchema: [],
    isComposite: true,
    pins: () => def.pins.map((p) => ({ ...p })),
    size: () => compositeBoxSize(def.pins),
    init: () => ({}),
    evaluate: ({ inputs, state, now }) => {
      let sub = state.sub;
      if (!sub || !(sub instanceof Circuit)) {
        sub = Circuit.fromPlain(sub && sub.components ? sub : def.circuit);
      }
      if (sub._lfHasActiveClock === undefined) {
        sub._lfHasActiveClock = sub.components.some((inst) => {
          const d = getComponentType(inst.type);
          return d?.isClock && (inst.params?.hz ?? 0) > 0;
        });
      }

      const forcedInputs = {};
      for (const p of def.pins) {
        if (p.dir === 'in') forcedInputs[p.id] = inputs[p.id] || makeFloating(p.width);
      }

      const key = pinInputsKey(def, forcedInputs);
      const canMemoize = !sub._lfHasActiveClock;
      if (canMemoize && sub._lfLastKey === key && sub._lfLastOutputs) {
        return { outputs: sub._lfLastOutputs, state: { sub } };
      }

      settleCircuit(sub, { forcedInputs, now });
      const outputs = {};
      for (const p of def.pins) {
        if (p.dir !== 'out') continue;
        const inst = sub.getComponent(p.id);
        outputs[p.id] = (inst && inst.state && inst.state.last) || makeFloating(p.width);
      }
      if (canMemoize) { sub._lfLastKey = key; sub._lfLastOutputs = outputs; }
      return { outputs, state: { sub } };
    },
  };
}

function buildCodeType(def) {
  let compiledFn = null;
  let compileError = null;
  try {
    // eslint-disable-next-line no-new-func
    compiledFn = new Function('inputs', 'state', 'params', 'helpers', def.code);
  } catch (e) {
    compileError = String(e.message || e);
  }
  return {
    type: def.id,
    category: def.category || 'Meine Komponenten (Code)',
    label: def.name,
    color: def.color || '#c084fc',
    paramsSchema: [],
    isCode: true,
    pins: () => def.pins.map((p) => ({ ...p })),
    size: () => compositeBoxSize(def.pins),
    init: () => ({}),
    evaluate: ({ inputs, state, params }) => {
      if (compileError) return { outputs: {}, state: { ...state, error: compileError } };
      try {
        const res = compiledFn(inputs, state.user || {}, params, {
          FLOATING,
          fromIntBits: (v, width) => {
            const out = new Array(width);
            for (let i = 0; i < width; i++) out[i] = (v >>> i) & 1;
            return out;
          },
          toInt: (bits) => {
            let v = 0;
            for (let i = bits.length - 1; i >= 0; i--) {
              if (bits[i] !== 0 && bits[i] !== 1) return null;
              v = (v << 1) | bits[i];
            }
            return v >>> 0;
          },
        });
        const outputs = (res && res.outputs) || {};
        for (const p of def.pins) {
          if (p.dir === 'out' && !outputs[p.id]) outputs[p.id] = makeFloating(p.width);
        }
        return { outputs, state: { user: (res && res.state) || state.user || {}, error: null } };
      } catch (e) {
        return { outputs: {}, state: { ...state, error: String(e.message || e) } };
      }
    },
  };
}

export function installDefinition(def) {
  definitions.set(def.id, def);
  unregisterComponentType(def.id);
  registerComponentType(def.kind === 'code' ? buildCodeType(def) : buildCompositeType(def));
  persist();
  return def;
}

export function removeDefinition(id) {
  definitions.delete(id);
  unregisterComponentType(id);
  persist();
}

export function createCompositeDefinition({ name, category, color, circuit }) {
  const pins = deriveInterfacePins(circuit);
  const def = {
    id: nextId('CUSTOM'),
    name: name || 'Komponente',
    category: category || 'Meine Komponenten',
    color: color || '#5eead4',
    kind: 'composite',
    pins,
    circuit: circuitToPlain(circuit),
  };
  return installDefinition(def);
}

export function updateCompositeDefinition(id, { name, category, color, circuit }) {
  const existing = definitions.get(id);
  if (!existing) throw new Error('unknown definition ' + id);
  const pins = deriveInterfacePins(circuit);
  const def = {
    ...existing,
    name: name ?? existing.name,
    category: category ?? existing.category,
    color: color ?? existing.color,
    pins,
    circuit: circuitToPlain(circuit),
  };
  return installDefinition(def);
}

export function createCodeDefinition({ name, category, color, code, pins }) {
  const def = {
    id: nextId('CUSTOM'),
    name: name || 'Code-Komponente',
    category: category || 'Meine Komponenten (Code)',
    color: color || '#c084fc',
    kind: 'code',
    pins: pins.map((p, i) => ({ ...p, side: p.dir === 'in' ? 'left' : 'right', order: p.order ?? i })),
    code,
  };
  return installDefinition(def);
}

export function updateCodeDefinition(id, { name, category, color, code, pins }) {
  const existing = definitions.get(id);
  if (!existing) throw new Error('unknown definition ' + id);
  const def = {
    ...existing,
    name: name ?? existing.name,
    category: category ?? existing.category,
    color: color ?? existing.color,
    code: code ?? existing.code,
    pins: pins ? pins.map((p, i) => ({ ...p, side: p.dir === 'in' ? 'left' : 'right', order: p.order ?? i })) : existing.pins,
  };
  return installDefinition(def);
}

// Recursively collect every custom definition a circuit (or a definition's own circuit)
// depends on, so a saved file is fully self-contained.
export function collectDependencies(circuit, out = new Map()) {
  for (const inst of circuit.components) {
    if (!inst.type.startsWith('CUSTOM')) continue;
    if (out.has(inst.type)) continue;
    const def = definitions.get(inst.type);
    if (!def) continue;
    out.set(inst.type, def);
    if (def.kind === 'composite') collectDependencies(Circuit.fromPlain(def.circuit), out);
  }
  return out;
}

export function circuitToPlain(circuit) {
  return circuit.toPlain();
}

export function persist() {
  try {
    const arr = [...definitions.values()];
    localStorage.setItem(LS_KEY, JSON.stringify(arr, stateReplacer));
  } catch (e) {
    console.warn('LogicForge: could not persist library', e);
  }
}

export function loadFromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw, stateReviver);
    for (const def of arr) installDefinition(def);
  } catch (e) {
    console.warn('LogicForge: could not load library', e);
  }
}

export function clearLibrary() {
  for (const id of [...definitions.keys()]) removeDefinition(id);
}
