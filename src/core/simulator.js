import { getComponentType } from './registry.js';
import { makeFloating, combineBits } from './bits.js';

let globalCallCounter = 0;

// A component is "clocked" (has its own storage, gated by a clk pin) if its pin list
// includes a pin literally named 'clk'. Matches every stateful type in memory.js:
// DFF, REGISTER, COUNTER, SHIFTREG, RAM, JKFF, SRFF.
function isClocked(def, params) {
  try {
    return def.pins(params || {}).some((p) => p.id === 'clk' && p.dir === 'in');
  } catch {
    return false;
  }
}

// Topologically sorts `plan` so that, within a single iteration of the settle loop,
// a component runs after every component that feeds one of its inputs (when that's
// possible - i.e. wherever the dependency graph isn't cyclic). This is what makes
// combinational chains (incrementer -> mux -> register D, etc.) converge in O(depth)
// iterations instead of O(2*depth) or worse: previously `plan` was evaluated in raw
// circuit.components order, so a consumer could easily run before its producer in the
// *same* pass, see a floating/stale input, and have to wait for a whole extra
// iteration (or two, with the memory.js two-read staleness guard) to pick up the real
// value.
//
// Clocked components are deliberately excluded from the "wait for my inputs" side of
// this graph: a register's Q for this iteration is derived from state captured at the
// last clock edge, not from this iteration's D, so nothing needs D to be scheduled
// before the register runs, and the register itself doesn't need to run late to see a
// correct D - memory.js's holdEdgeOpen/stableAcrossIterations retry machinery already
// tolerates D arriving on a later iteration. This matters because register-file style
// circuits are routinely cyclic on paper (Rn.Q feeds a shared bus mux, which feeds
// every register's D, including Rn's own, regardless of which register is currently
// selected as source) even though no real combinational loop exists at runtime. Without
// this exclusion, that structural cycle would drag every component on the bus (the mux,
// and all registers sharing it) into the unsortable "remaining" bucket below, falling
// back to raw array order and reintroducing the exact ordering-dependent floating/stale
// read problem this function exists to eliminate - for every register on that bus, not
// just the cyclic one.
//
// Any dependency edge that isn't broken this way and is still part of a genuine cycle
// (e.g. a real combinational feedback loop) can't be linearized; those components are
// appended in their original relative order and resolved by the outer iterate-to-
// fixed-point loop in settleCircuit, same as before.
function computeEvalOrder(plan) {
  const producerOf = new Map(); // wireId -> index into `plan`
  plan.forEach((p, i) => {
    for (const op of p.outPins) {
      for (const wireId of op.targetWires) producerOf.set(wireId, i);
    }
  });

  const indeg = new Array(plan.length).fill(0);
  const adj = Array.from({ length: plan.length }, () => []);
  plan.forEach((p, i) => {
    if (isClocked(p.def, p.inst.params)) return; // don't gate a clocked component on its own inputs
    for (const ip of p.inPins) {
      if (ip.wireId == null) continue;
      const srcIdx = producerOf.get(ip.wireId);
      if (srcIdx == null || srcIdx === i) continue; // no producer, or self-loop: skip
      adj[srcIdx].push(i);
      indeg[i]++;
    }
  });

  const order = [];
  const queue = [];
  indeg.forEach((d, i) => { if (d === 0) queue.push(i); });
  const remaining = new Set(plan.map((_, i) => i));
  let qi = 0;
  while (qi < queue.length) {
    const i = queue[qi++];
    order.push(i);
    remaining.delete(i);
    for (const j of adj[i]) { if (--indeg[j] === 0) queue.push(j); }
  }
  // Anything left over sits on a real cycle. Keep original relative order for those -
  // the outer iteration loop in settleCircuit resolves cycles across passes.
  for (const i of plan.keys()) { if (remaining.has(i)) order.push(i); }

  return order.map((i) => plan[i]);
}

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

  // Evaluate in dependency order within each iteration - see computeEvalOrder above.
  const orderedPlan = computeEvalOrder(plan);

  const tunnelInPlan = plan.filter((p) => p.def?.isTunnel === 'in');
  const tunnelOutPlan = plan.filter((p) => p.def?.isTunnel === 'out');
  let prevWireValues = null;
  for (let iter = 0; iter < maxIters; iter++) {
    for (const { inst, def, inPins, outPins, injected, callStartState: css } of orderedPlan) {
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
