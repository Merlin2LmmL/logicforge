import { getComponentType } from './registry.js';
import { makeFloating, combineBits } from './bits.js';

// ---------------------------------------------------------------------------
// Scheduling model
// ---------------------------------------------------------------------------
// Old design: evaluate every component, in flat declaration order, up to
// `maxIters` times, and declare "stable" once nothing changed between two
// full sweeps. That has no notion of dependency order, so a component whose
// producer runs later in the array sees a stale/floating input on the pass
// where it actually matters (e.g. a clock edge), and clocked components in
// memory.js had to reconstruct "has my input actually settled yet" via
// heuristics (hold-open / confirm-twice). Those heuristics are fragile (see
// memory.js history) and the repeated full sweeps are also the whole
// performance ceiling: O(components * maxIters) work every simulated tick
// regardless of circuit depth.
//
// New design: build a dependency graph from the wires, evaluate combinational
// logic in topological order (once each, since by construction every input a
// node reads has already been produced), then evaluate clocked components
// exactly once against those now-final values. This mirrors how real
// synchronous-circuit simulators schedule delta cycles: combinational logic
// settles first, sequential elements commit at the end of the cycle.
//
// Sequential components (def.isSequential === true) are NOT producers in the
// combinational graph - their Q is treated as fixed for the whole
// combinational phase (seeded from what they output on the *previous*
// settleCircuit() call), which is also what makes feedback loops that pass
// through a register resolve without any special-casing: real synchronous
// feedback always goes through a clocked element, and clocked elements are
// exactly the nodes we exclude from the dependency graph.
//
// Tunnels are wireless by design, so a TUNNEL_IN -> TUNNEL_OUT dependency is
// invisible to the wire graph unless we add it explicitly. We add a synthetic
// edge for every (TUNNEL_IN, TUNNEL_OUT) pair sharing a net name, so
// tunnel-mediated combinational paths are ordered correctly too instead of
// being resolved by chance over repeated sweeps like before.
//
// Whatever can't be topologically ordered (a genuine combinational cycle -
// cross-coupled gates, latches built from raw NAND/NOR, etc.) is a small
// "remainder" set. That remainder gets bounded local iteration, scoped to
// just those nodes, not the whole circuit - the old blind-200-iterations cost
// now only applies to the handful of components actually inside a cyclic
// knot.
// ---------------------------------------------------------------------------

const REMAINDER_MAX_ITERS = 64; // local bound for genuine combinational cycles

function buildPlan(circuit) {
  const nodes = [];
  const nodeIndex = new Map();

  for (const inst of circuit.components) {
    const def = getComponentType(inst.type);
    if (!def) continue;
    const pins = def.pins(inst.params || {});
    const inPins = [];
    const outPins = [];
    for (const p of pins) {
      if (p.dir === 'in') {
        const w = circuit.wireInto(inst.id, p.id);
        inPins.push({ id: p.id, width: p.width, wireId: w ? w.id : null, fromCompId: w ? w.from.compId : null });
      } else {
        const targetWires = circuit.wiresFrom(inst.id, p.id).map((w) => w.id);
        outPins.push({ id: p.id, targetWires });
      }
    }
    const node = {
      inst, def, inPins, outPins,
      isSequential: !!def.isSequential,
      isTunnelIn: def.isTunnel === 'in',
      isTunnelOut: def.isTunnel === 'out',
      netKey: def.isTunnel ? (inst.params?.net || '') : null,
      injected: def.isInterface === 'in',
    };
    nodes.push(node);
    nodeIndex.set(inst.id, node);
  }

  const sequentialNodes = nodes.filter((n) => n.isSequential);
  const graphNodes = nodes.filter((n) => !n.isSequential);

  const adjacency = new Map(graphNodes.map((n) => [n, []]));
  for (const node of graphNodes) {
    for (const p of node.inPins) {
      if (!p.fromCompId) continue;
      const producer = nodeIndex.get(p.fromCompId);
      if (!producer || producer.isSequential) continue; // seeded, not an ordering dependency
      adjacency.get(producer).push(node);
    }
  }

  const tunnelsByNet = new Map();
  for (const node of graphNodes) {
    if (!node.isTunnelIn && !node.isTunnelOut) continue;
    let bucket = tunnelsByNet.get(node.netKey);
    if (!bucket) { bucket = { ins: [], outs: [] }; tunnelsByNet.set(node.netKey, bucket); }
    (node.isTunnelIn ? bucket.ins : bucket.outs).push(node);
  }
  for (const { ins, outs } of tunnelsByNet.values()) {
    for (const a of ins) for (const b of outs) adjacency.get(a).push(b);
  }

  const { order, remainder } = topoOrderWithRemainder(graphNodes, adjacency);

  return { nodes, nodeIndex, order, remainder, sequentialNodes };
}

// Kahn's algorithm. Anything left over (nonzero in-degree once the queue runs
// dry) is part of one or more cycles and returned separately.
function topoOrderWithRemainder(nodes, adjacency) {
  const indeg = new Map(nodes.map((n) => [n, 0]));
  for (const n of nodes) {
    for (const m of adjacency.get(n)) indeg.set(m, (indeg.get(m) || 0) + 1);
  }
  const queue = nodes.filter((n) => indeg.get(n) === 0);
  const order = [];
  const seen = new Set();
  let qi = 0;
  while (qi < queue.length) {
    const n = queue[qi++];
    if (seen.has(n)) continue;
    seen.add(n);
    order.push(n);
    for (const m of adjacency.get(n)) {
      const d = indeg.get(m) - 1;
      indeg.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  const remainder = nodes.filter((n) => !seen.has(n));
  return { order, remainder };
}

function getPlan(circuit) {
  if (circuit._lfPlan && circuit._lfPlanComponentsRef === circuit.components && circuit._lfPlanWiresRef === circuit.wires) {
    return circuit._lfPlan;
  }
  const plan = buildPlan(circuit);
  circuit._lfPlan = plan;
  circuit._lfPlanComponentsRef = circuit.components;
  circuit._lfPlanWiresRef = circuit.wires;
  return plan;
}

function readInputs(node, wireValues) {
  const inputs = {};
  for (const p of node.inPins) {
    inputs[p.id] = p.wireId && wireValues.has(p.wireId) ? wireValues.get(p.wireId) : makeFloating(p.width);
  }
  return inputs;
}

function writeOutputs(node, outputs, wireValues) {
  for (const p of node.outPins) {
    const val = outputs && outputs[p.id];
    if (!val) continue;
    for (const wireId of p.targetWires) wireValues.set(wireId, val);
  }
}

function netValueForTunnelOut(node, plan) {
  // Combine every TUNNEL_IN sharing this net's currently-settled value. TUNNEL_IN
  // nodes are ordinary combinational nodes and, thanks to the synthetic edges
  // built into the graph, are guaranteed to appear earlier in `plan.order` than
  // this node - so `inst.state.last` is already this tick's value, not stale.
  let combined = null;
  for (const n of plan.nodes) {
    if (!n.isTunnelIn || n.netKey !== node.netKey) continue;
    const val = n.inst.state?.last;
    if (!val) continue;
    combined = combined ? combineBits(combined, val) : val;
  }
  return combined;
}

function evaluateNode(node, plan, wireValues, { forcedInputs, now }) {
  const inputs = readInputs(node, wireValues);
  const injected = node.injected && Object.prototype.hasOwnProperty.call(forcedInputs, node.inst.id)
    ? forcedInputs[node.inst.id]
    : undefined;
  if (node.isTunnelOut) {
    const net = netValueForTunnelOut(node, plan);
    if (net) node.inst.state = { ...node.inst.state, injected: net };
  }
  const result = node.def.evaluate({ inputs, state: node.inst.state, params: node.inst.params || {}, now, injected });
  node.inst.state = result.state ?? node.inst.state;
  writeOutputs(node, result.outputs, wireValues);
  return result.outputs || {};
}

function wireValuesEqualOn(wireIds, a, b) {
  for (const id of wireIds) {
    const av = a.get(id);
    const bv = b.get(id);
    if (!av || !bv || av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
  }
  return true;
}

export function settleCircuit(circuit, { forcedInputs = {}, now = 0, maxIters = REMAINDER_MAX_ITERS } = {}) {
  const plan = getPlan(circuit);
  const wireValues = new Map();
  const instanceOutputs = new Map();

  // Seed wires driven by sequential components with what they output on the
  // *previous* settleCircuit() call. Nothing in this call's combinational phase
  // re-evaluates them - by design, a register's Q only changes at Phase B.
  for (const node of plan.sequentialNodes) {
    const cached = node.inst._lfLastOutputs;
    if (cached) writeOutputs(node, cached, wireValues);
  }

  // Phase A: combinational logic, in dependency order - each node evaluated
  // exactly once, since every input it reads was produced earlier in `order`.
  for (const node of plan.order) {
    const outputs = evaluateNode(node, plan, wireValues, { forcedInputs, now });
    instanceOutputs.set(node.inst.id, outputs);
  }

  // Phase A, remainder: a genuine combinational cycle (cross-coupled gates,
  // raw NAND/NOR latches, ...). Bounded local iteration, scoped to just these
  // nodes instead of the whole circuit.
  let stable = true;
  if (plan.remainder.length) {
    const remainderWireIds = new Set();
    for (const node of plan.remainder) for (const p of node.outPins) for (const id of p.targetWires) remainderWireIds.add(id);

    let prev = null;
    stable = false;
    const iters = Math.max(maxIters, REMAINDER_MAX_ITERS);
    for (let iter = 0; iter < iters; iter++) {
      for (const node of plan.remainder) {
        const outputs = evaluateNode(node, plan, wireValues, { forcedInputs, now });
        instanceOutputs.set(node.inst.id, outputs);
      }
      if (prev && wireValuesEqualOn(remainderWireIds, prev, wireValues)) { stable = true; break; }
      prev = new Map(wireValues);
    }
  }

  // Phase B: clocked components, once each, against fully-settled Phase-A
  // values. No provisional reads, no "is this stale" heuristics - inputs are
  // guaranteed final by construction, so edge detection in memory.js can be
  // the textbook one-liner.
  for (const node of plan.sequentialNodes) {
    const outputs = evaluateNode(node, plan, wireValues, { forcedInputs, now });
    instanceOutputs.set(node.inst.id, outputs);
    node.inst._lfLastOutputs = outputs; // seeds the *next* call's Phase-A reads
  }

  return { wireValues, instanceOutputs, stable };
}

export function resetCircuitState(circuit) {
  for (const inst of circuit.components) {
    const def = getComponentType(inst.type);
    if (!def) continue;
    inst.state = def.init ? def.init(inst.params || {}) : {};
    delete inst._lfLastOutputs;
  }
  delete circuit._lfPlan;
  delete circuit._lfPlanComponentsRef;
  delete circuit._lfPlanWiresRef;
}
