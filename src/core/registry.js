// Registry of component *types*. A type describes how to compute pins/size for given
// params, how to evaluate the component, and (optionally) how to draw its body.
//
// type shape:
// {
//   type: 'AND', category: 'Gates', label: 'AND', color: '#...',
//   paramsSchema: [{ key, label, kind: 'int'|'select'|'bool'|'text', min, max, step, default, options }],
//   pins(params) -> [{ id, label, dir: 'in'|'out', width, side: 'left'|'right'|'top'|'bottom', order }],
//   size(params) -> { w, h }  // in grid cells
//   init(params) -> state,
//   evaluate({ inputs, state, params, dt, now }) -> { outputs, state },
//   draw(ctx, { params, state, w, h }) -> void   // optional, generic box+label used otherwise
// }

const registry = new Map();

export function registerComponentType(def) {
  if (!def.type) throw new Error('component type needs a `type` key');
  registry.set(def.type, def);
}

export function getComponentType(type) {
  return registry.get(type);
}

export function hasComponentType(type) {
  return registry.has(type);
}

export function unregisterComponentType(type) {
  registry.delete(type);
}

export function allComponentTypes() {
  return [...registry.values()];
}

export function categorized() {
  const cats = new Map();
  for (const def of registry.values()) {
    if (!cats.has(def.category)) cats.set(def.category, []);
    cats.get(def.category).push(def);
  }
  return cats;
}

export function defaultParams(def) {
  const p = {};
  for (const s of def.paramsSchema || []) p[s.key] = s.default;
  return p;
}
