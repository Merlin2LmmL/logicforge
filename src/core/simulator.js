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
// a component runs after every component that feeds one of its inputs, wherever that's
// actually possible. This is what makes combinational chains (incrementer -> mux ->
// register D, etc.) converge in O(depth) iterations instead of O(2*depth) or worse:
// evaluating in raw circuit.components order lets a consumer run before its producer in
// the *same* pass, forcing it to see a floating/stale input and burn a whole extra
// iteration (or two, with the memory.js two-read staleness guard) to pick up the real
// value.
//
// Real dependency cycles can't be linearized. Two kinds show up in practice:
//   - A genuine combinational feedback loop (rare, usually a design error) - nothing
//     can be done about this at the ordering level; it's left to the outer
//     iterate-to-fixed-point loop in settleCircuit.
//   - A *structural* cycle through a clocked component - e.g. a register file where
//     every register's Q feeds a shared bus mux, which feeds every register's D,
//     including that register's own, regardless of which register is currently
//     selected as the source (Rn.Q -> mux -> Rn.D), or a program counter feeding its
//     own D through an incrementer (PC.Q -> INC -> PC.D). This isn't a real
//     combinational loop: a clocked component's Q for a given pass comes from state
//     captured at the last clock edge, not from this pass's D, so it doesn't need to
//     wait on D at all - memory.js's holdEdgeOpen/stableAcrossIterations retry
//     machinery already tolerates D settling on a later iteration.
//
// The important part is that this only cuts the specific edge(s) actually closing a
// cycle, and only once the algorithm is genuinely stuck - not every incoming edge of
// every clocked component. Cutting indiscriminately (an earlier version of this
// function did that) throws away real, non-cyclic ordering info too - e.g. a
// register's EN coming from a decoder that isn't part of any cycle - and forces every
// clocked component to always run first regardless of its actual dependencies. That
// in turn desyncs settleCircuit's wire-value-based stability check from what's
// actually happening inside the component (whose write decision depends on internal
// pending-value state the wire snapshot can't see), and the loop can terminate one
// iteration before the write it was building up to actually happens - silently
// dropping the write entirely.
function computeEvalOrder(plan) {
  const n = plan.length;
  const producerOf = new Map(); // wireId -> index into `plan`
  plan.forEach((p, i) => {
    for (const op of p.outPins) {
      for (const wireId of op.targetWires) producerOf.set(wireId, i);
    }
  });

  // deps[i] = set of plan-indices that must be evaluated before component i.
  const deps = plan.map(() => new Set());
  plan.forEach((p, i) => {
    for (const ip of p.inPins) {
      if (ip.wireId == null) continue;
      const srcIdx = producerOf.get(ip.wireId);
      if (srcIdx == null || srcIdx === i) continue; // no producer, or self-loop: ignore
      deps[i].add(srcIdx);
    }
  });

  const done = new Array(n).fill(false);
  const order = [];
  let remainingCount = n;

  while (remainingCount > 0) {
    let progressed = false;
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      let ready = true;
      for (const d of deps[i]) { if (!done[d]) { ready = false; break; } }
      if (ready) { done[i] = true; order.push(i); remainingCount--; progressed = true; }
    }
    if (progressed) continue; // more nodes may now be ready; rescan before giving up

    // Stuck: every remaining component is waiting on something that's waiting on it
    // (a cycle). Prefer to break at a clocked component - drop just its still-pending
    // incoming edges (the ones actually closing the cycle) so it can proceed without
    // this pass's data; a later iteration of the outer settle loop supplies it once
    // upstream has genuinely settled. Only fall back to breaking at an arbitrary
    // (original-array-order) component if nothing remaining is clocked, i.e. it's a
    // true combinational loop.
    let breakAt = -1;
    for (let i = 0; i < n; i++) {
      if (!done[i] && isClocked(plan[i].def, plan[i].inst.params)) { breakAt = i; break; }
    }
    if (breakAt === -1) {
      for (let i = 0; i < n; i++) { if (!done[i]) { breakAt = i; break; } }
    }
    deps[breakAt].clear();
    done[breakAt] = true; order.push(breakAt); remainingCount--;
  }

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
