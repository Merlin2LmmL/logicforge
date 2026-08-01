// Core data model. Deliberately plain JS objects + small classes so the whole
// thing serializes to/from JSON trivially (see fileFormat.js).

let idCounter = 1;
export function nextId(prefix = 'id') {
  return `${prefix}_${(idCounter++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// Component state (e.g. RAM/ROM contents) sometimes uses a Map for sparse storage.
// Map instances do not survive a plain JSON.stringify/parse round-trip (they turn into
// `{}`), which then crashes the next evaluate() call with things like
// "mem.has is not a function". Every place that JSON-round-trips instance/circuit state
// (undo/redo history, copy/paste, autosave, .lgf save/load) must use these so Maps
// (and Sets, same problem) survive intact.
export function stateReplacer(key, value) {
  if (value instanceof Map) return { __type: 'Map', entries: [...value.entries()] };
  if (value instanceof Set) return { __type: 'Set', values: [...value.values()] };
  return value;
}
export function stateReviver(key, value) {
  if (value && typeof value === 'object') {
    if (value.__type === 'Map' && Array.isArray(value.entries)) return new Map(value.entries);
    if (value.__type === 'Set' && Array.isArray(value.values)) return new Set(value.values);
  }
  return value;
}
export function cloneState(state) {
  return JSON.parse(JSON.stringify(state, stateReplacer), stateReviver);
}

export class ComponentInstance {
  constructor({ id, type, x, y, rot = 0, params = {}, state = {}, label = '' } = {}) {
    this.id = id || nextId('c');
    this.type = type;          // key into the component registry
    this.x = x ?? 0;
    this.y = y ?? 0;
    this.rot = rot % 4;        // 0..3, quarter turns clockwise
    this.params = { ...params };
    this.state = { ...state }; // mutable runtime state (flip-flop contents, clock phase, ...)
    this.label = label;
  }

  clone() {
    return new ComponentInstance({
      id: this.id, type: this.type, x: this.x, y: this.y, rot: this.rot,
      params: JSON.parse(JSON.stringify(this.params)),
      state: cloneState(this.state),
      label: this.label,
    });
  }
}

// A Wire connects exactly one source (an output pin) to exactly one target (an input pin).
// Fan-out is achieved by drawing several wires from the same source pin.
export class Wire {
  constructor({ id, from, to, points = [] } = {}) {
    this.id = id || nextId('w');
    this.from = from; // { compId, pinId }
    this.to = to;     // { compId, pinId }
    this.points = points; // intermediate routing waypoints [{x,y}, ...]
  }

  clone() {
    return new Wire({ id: this.id, from: { ...this.from }, to: { ...this.to }, points: this.points.map((p) => ({ ...p })) });
  }
}

// A Circuit is either a standalone top-level circuit, or the internal definition of a
// reusable Component (in which case it should contain PIN_IN / PIN_OUT instances that
// define the component's external interface).
export class Circuit {
  constructor({ components = [], wires = [] } = {}) {
    this.components = components;
    this.wires = wires;
    this._wireIntoIndex = new Map();
    this._wiresFromIndex = new Map();
    this._indexedWiresRef = null;
  }

  _ensureWireIndex() {
    if (this._indexedWiresRef === this.wires) return;
    this._wireIntoIndex.clear();
    this._wiresFromIndex.clear();
    for (const w of this.wires) {
      this._wireIntoIndex.set(w.to.compId + ':' + w.to.pinId, w);
      const key = w.from.compId + ':' + w.from.pinId;
      let arr = this._wiresFromIndex.get(key);
      if (!arr) { arr = []; this._wiresFromIndex.set(key, arr); }
      arr.push(w);
    }
    this._indexedWiresRef = this.wires;
  }

  addComponent(inst) { this.components.push(inst); return inst; }
  removeComponent(id) {
    this.components = this.components.filter((c) => c.id !== id);
    this.wires = this.wires.filter((w) => w.from.compId !== id && w.to.compId !== id);
  }
  getComponent(id) { return this.components.find((c) => c.id === id); }

  addWire(w) { this.wires = [...this.wires, w]; return w; }
  removeWire(id) { this.wires = this.wires.filter((w) => w.id !== id); }

  wireInto(compId, pinId) {
    this._ensureWireIndex();
    return this._wireIntoIndex.get(compId + ':' + pinId);
  }
  wiresFrom(compId, pinId) {
    this._ensureWireIndex();
    return this._wiresFromIndex.get(compId + ':' + pinId) || [];
  }

  clone() {
    return new Circuit({
      components: this.components.map((c) => c.clone()),
      wires: this.wires.map((w) => w.clone()),
    });
  }

  static fromPlain(plain) {
    const c = new Circuit();
    for (const cp of plain.components || []) c.addComponent(new ComponentInstance(cp));
    for (const wp of plain.wires || []) c.addWire(new Wire(wp));
    return c;
  }

  toPlain() {
    return {
      components: this.components.map((c) => ({ id: c.id, type: c.type, x: c.x, y: c.y, rot: c.rot, params: c.params, state: c.state, label: c.label })),
      wires: this.wires.map((w) => ({ id: w.id, from: w.from, to: w.to, points: w.points })),
    };
  }
}
