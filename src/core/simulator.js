import { getComponentType } from './registry.js';
import { makeFloating, combineBits } from './bits.js';

let globalCallCounter = 0;

// Best-effort serialization of a component's state, used only to detect whether
// anything actually changed between iterations. Handles Map specially (plain
// JSON.stringify collapses a Map to "{}", which would hide e.g. a RAM write to an
// address that isn't currently being read on dout - the same class of bug as the one
// this snapshot mechanism exists to close, just for RAM instead of registers).
function snapshotState(state) {
  try {
    return JSON.stringify(state, (key, value) => (value instanceof Map ? { __map: [...value.entries()] } : value));
  } catch {
    return String(state);
  }
}

export function settleCircuit(circuit, { forcedInputs = {}, now = 0, maxIters = 200 } = {}) {
  // Clamp to a safe floor regardless of what the caller passes. A caller-supplied
  // maxIters always overrides this function's default parameter in JS - so if some
  // call site still has an old, smaller value hardcoded (e.g. left over from before
  // deeper combinational chains like ALU -> MUX -> MUX -> register existed), that
  // value would silently starve convergence on any circuit deep enough to need more
  // iterations, with no error - just a write that never lands. Floor it here so
  // correctness doesn't depend on every caller staying in sync with how deep
  // circuits people actually build get.
  maxIters = Math.max(maxIters, 200);

  const callId = ++globalCallCounter;
  const wireValues = new Map();
  const instanceOutputs = new Map();
  let stable = false;
  const callStartState = new Map(circuit.components.map((inst) => [inst.id, inst.state]));

  // Precompute everything constant across iterations once, instead of every iteration.
  // Evaluated in plain circuit.components order - no topological sorting. This costs
  // extra iterations on deep combinational chains (a consumer can run before its
  // producer in the same pass and see a stale/floating input, needing another
  // iteration to pick up the real value), but it's simple and doesn't depend on any
  // assumptions about cycles, clocked components, or graph structure. maxIters is
  // raised accordingly to give plain repetition enough room to converge.
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
  let prevStateSnapshot = null;

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

    // Stability requires BOTH the wires AND every component's internal state to be
    // unchanged from the previous iteration. Wire-only comparison is not enough: a
    // clocked component can be mid-way through confirming a pending write (internal
    // state changing) while its *output* hasn't changed yet (because the write
    // hasn't committed), which would make wire-only comparison falsely declare
    // stability and stop the loop one iteration before the write actually happens -
    // silently dropping it. Comparing state snapshots too closes that gap.
    const stateSnapshot = plan.map(({ inst }) => snapshotState(inst.state)).join('|');
    if (prevWireValues && prevStateSnapshot === stateSnapshot && wireValuesEqual(prevWireValues, wireValues)) {
      stable = true;
      break;
    }
    prevWireValues = new Map(wireValues);
    prevStateSnapshot = stateSnapshot;
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
