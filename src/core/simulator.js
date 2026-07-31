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

  // Snapshot of every component's state as it was BEFORE this settle() call, passed to
  // evaluate() alongside the (per-iteration, live-mutating) `state`. Edge-triggered
  // components (DFF/Register/RAM/Counter/...) must compare their clock edge against THIS
  // frozen value, not against `state.prevClk`, which changes on every iteration below.
  //
  // Reason: this loop calls evaluate() on every component once per iteration, in array
  // order, and commits `inst.state` immediately - it does not wait for the whole circuit to
  // settle first. If an edge-triggered component's clk input resolves to its new value in
  // iteration N (because its driving component happens to run earlier in `circuit.components`
  // this iteration), it would - if compared against its own live `state.prevClk` - detect and
  // "consume" the rising edge in that same iteration N, even though other inputs (e.g. D
  // coming from an ENCODER/MUX that hasn't been evaluated yet this iteration) haven't
  // propagated through `wireValues` yet. The edge is then gone for the rest of this call, and
  // the component silently latches a stale/floating value - it never gets a second chance,
  // even though later iterations would have produced the correct, fully-settled D.
  //
  // By comparing against callStartState.prevClk (fixed for the whole call) instead, a
  // component keeps re-latching on every iteration for as long as the clock genuinely
  // transitioned since the last settle() call - always using the most current (best
  // available) data inputs - so by the time wireValues actually stabilizes (or maxIters is
  // reached), the last iteration's result reflects the fully-settled inputs. Only that final
  // result gets committed as the new `state.prevClk`, so the NEXT call correctly sees the
  // edge as consumed.
  const callStartState = new Map(circuit.components.map((inst) => [inst.id, inst.state]));

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
      const result = def.evaluate({
        inputs,
        state: inst.state,
        params: inst.params || {},
        now,
        injected,
        callStartState: callStartState.get(inst.id),
      });
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
