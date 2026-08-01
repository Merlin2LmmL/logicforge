import { getComponentType } from './registry.js';
import { makeFloating, combineBits } from './bits.js';

let globalCallCounter = 0;

export function settleCircuit(circuit, { forcedInputs = {}, now = 0, maxIters = 48 } = {}) {
  const callId = ++globalCallCounter;
  const wireValues = new Map();
  const instanceOutputs = new Map();
  let stable = false;

  const callStartState = new Map(circuit.components.map((inst) => [inst.id, inst.state]));

  // Precompute everything constant across iterations once, instead of every iteration.
  const plan = [];
  for (const inst of circuit.components) {
    const def = getComponentType(inst.type);
    if (!def) continue;
    const pins = def.pins(inst.params || {});
    const inPins = [];
    const outPins = [];
    for (const p of pins) {
      if (p.dir === 'in') {
        const w = circuit.wireInto(inst.id, p.id);
        inPins.push({ id: p.id, width: p.width, wireId: w ? w.id : null });
      } else {
        const targetWires = circuit.wiresFrom(inst.id, p.id).map((w) => w.id);
        outPins.push({ id: p.id, targetWires });
      }
    }
    plan.push({
      inst, def, inPins, outPins,
      injected: def.isInterface === 'in' && Object.prototype.hasOwnProperty.call(forcedInputs, inst.id)
        ? forcedInputs[inst.id]
        : undefined,
      callStartState: callStartState.get(inst.id),
    });
  }

  const tunnelInPlan = plan.filter((p) => p.def?.isTunnel === 'in');
  const tunnelOutPlan = plan.filter((p) => p.def?.isTunnel === 'out');

  let prevWireValues = null;

  for (let iter = 0; iter < maxIters; iter++) {
    for (const { inst, def, inPins, outPins, injected, callStartState: css } of plan) {
      const inputs = {};
      for (const p of inPins) {
        inputs[p.id] = p.wireId && wireValues.has(p.wireId) ? wireValues.get(p.wireId) : makeFloating(p.width);
      }
      const result = def.evaluate({
        inputs, state: inst.state, params: inst.params || {}, now,
        injected, callStartState: css, callId,
      });
      inst.state = result.state ?? inst.state;
      instanceOutputs.set(inst.id, result.outputs || {});
      for (const p of outPins) {
        const val = result.outputs && result.outputs[p.id];
        if (!val) continue;
        for (const wireId of p.targetWires) wireValues.set(wireId, val);
      }
    }

    const nets = new Map();
    for (const { inst } of tunnelInPlan) {
      const val = inst.state?.last;
      if (!val) continue;
      const key = inst.params?.net || '';
      nets.set(key, nets.has(key) ? combineBits(nets.get(key), val) : val);
    }
    for (const { inst } of tunnelOutPlan) {
      const key = inst.params?.net || '';
      const val = nets.get(key);
      if (!val) continue;
      inst.state = { ...inst.state, injected: val };
      for (const w of circuit.wiresFrom(inst.id, 'out')) wireValues.set(w.id, val);
    }

    if (prevWireValues && wireValuesEqual(prevWireValues, wireValues)) { stable = true; break; }
    prevWireValues = new Map(wireValues);
  }

  return { wireValues, instanceOutputs, stable };
}

function wireValuesEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [id, bits] of a) {
    const other = b.get(id);
    if (!other || bits.length !== other.length) return false;
    for (let i = 0; i < bits.length; i++) if (bits[i] !== other[i]) return false;
  }
  return true;
}

export function resetCircuitState(circuit) {
  for (const inst of circuit.components) {
    const def = getComponentType(inst.type);
    if (!def) continue;
    inst.state = def.init ? def.init(inst.params || {}) : {};
  }
}
