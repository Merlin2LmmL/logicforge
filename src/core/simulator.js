import { getComponentType } from './registry.js';
import { makeFloating, combineBits } from './bits.js';

// Settle one circuit graph. Because feedback (latches built from gates, ring oscillators, ...)
// is allowed, we can't just do a single topological pass: we re-evaluate every component
// repeatedly, feeding each pass's outputs into the next, until two consecutive passes produce
// identical wire values (stable) or `maxIters` is reached (treated as "still changing" - e.g.
// an oscillator - which is fine, it'll simply be re-settled again next animation frame).
//
// forcedInputs: Map/object of { [PIN_IN instanceId]: bits }, used when this circuit is the
// internal definition of a component being evaluated from a parent circuit.
export function settleCircuit(circuit, { forcedInputs = {}, now = 0, maxIters = 48 } = {}) {
  const wireValues = new Map(); // wireId -> bits
  const instanceOutputs = new Map(); // compId -> { pinId: bits }
  let stable = false;
  let prevSnapshot = null;

  for (let iter = 0; iter < maxIters; iter++) {
    // 1) regular components
    for (const inst of circuit.components) {
      const def = getComponentType(inst.type);
      if (!def) continue;
      const pins = def.pins(inst.params || {});
      const inputs = {};
      for (const p of pins) {
        if (p.dir !== 'in') continue;
        const w = circuit.wireInto(inst.id, p.id);
        inputs[p.id] = w && wireValues.has(w.id) ? wireValues.get(w.id) : makeFloating(p.width);
      }
      const injected = def.isInterface === 'in' && Object.prototype.hasOwnProperty.call(forcedInputs, inst.id)
        ? forcedInputs[inst.id]
        : undefined;
      const result = def.evaluate({ inputs, state: inst.state, params: inst.params || {}, now, injected });
      inst.state = result.state ?? inst.state;
      instanceOutputs.set(inst.id, result.outputs || {});
      for (const p of pins) {
        if (p.dir !== 'out') continue;
        const val = result.outputs && result.outputs[p.id];
        if (!val) continue;
        for (const w of circuit.wiresFrom(inst.id, p.id)) wireValues.set(w.id, val);
      }
    }

    // 2) named tunnels: every TUNNEL_IN feeds every TUNNEL_OUT sharing the same net name
    const nets = new Map();
    for (const inst of circuit.components) {
      const def = getComponentType(inst.type);
      if (def?.isTunnel !== 'in') continue;
      const val = inst.state?.last;
      if (!val) continue;
      const key = inst.params?.net || '';
      nets.set(key, nets.has(key) ? combineBits(nets.get(key), val) : val);
    }
    for (const inst of circuit.components) {
      const def = getComponentType(inst.type);
      if (def?.isTunnel !== 'out') continue;
      const key = inst.params?.net || '';
      const val = nets.get(key);
      if (!val) continue;
      inst.state = { ...inst.state, injected: val };
      for (const w of circuit.wiresFrom(inst.id, 'out')) wireValues.set(w.id, val);
    }

    const snap = snapshotOf(wireValues);
    if (snap === prevSnapshot) { stable = true; break; }
    prevSnapshot = snap;
  }

  return { wireValues, instanceOutputs, stable };
}

function snapshotOf(wireValues) {
  let s = '';
  for (const [id, bits] of wireValues) s += id + ':' + bits.join(',') + ';';
  return s;
}

// Reset every component's runtime state back to its type's initial state (recursively for
// composite components, since their nested sub-circuit lives inside instance.state).
export function resetCircuitState(circuit) {
  for (const inst of circuit.components) {
    const def = getComponentType(inst.type);
    if (!def) continue;
    inst.state = def.init ? def.init(inst.params || {}) : {};
  }
}
