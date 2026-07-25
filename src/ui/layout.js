import { getComponentType } from '../core/registry.js';

export const GRID = 24; // px per grid cell at zoom 1

const SIDE_ORDER = ['left', 'top', 'right', 'bottom'];
function rotateSide(side, rot) {
  const i = SIDE_ORDER.indexOf(side);
  return SIDE_ORDER[(i + rot) % 4];
}

export function getDef(inst) {
  return getComponentType(inst.type);
}

// Bounding box size *as drawn on screen* (natural w/h swapped for 90/270deg rotation).
export function effectiveSize(def, inst) {
  const { w, h } = def.size(inst.params || {});
  return inst.rot % 2 === 1 ? { w: h, h: w } : { w, h };
}

// Returns { pins, w, h, positions: Map(pinId -> {x,y,side}) } - x/y are grid-unit offsets
// from the instance's (x,y) top-left corner.
export function computeLayout(inst) {
  const def = getDef(inst);
  if (!def) return { pins: [], w: 2, h: 2, positions: new Map() };
  const pins = def.pins(inst.params || {});
  const { w, h } = effectiveSize(def, inst);
  const bySide = { left: [], right: [], top: [], bottom: [] };
  for (const p of pins) bySide[rotateSide(p.side, inst.rot)].push(p);
  for (const k of Object.keys(bySide)) bySide[k].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const positions = new Map();
  for (const [side, list] of Object.entries(bySide)) {
    const n = list.length;
    list.forEach((p, idx) => {
      const t = (idx + 1) / (n + 1);
      let x, y;
      if (side === 'left') { x = 0; y = t * h; }
      else if (side === 'right') { x = w; y = t * h; }
      else if (side === 'top') { x = t * w; y = 0; }
      else { x = t * w; y = h; }
      positions.set(p.id, { x, y, side });
    });
  }
  return { pins, w, h, positions, def };
}

export function pinWorldPos(inst, pinId) {
  const { positions } = computeLayout(inst);
  const p = positions.get(pinId);
  if (!p) return null;
  return { x: inst.x + p.x, y: inst.y + p.y };
}

export function instanceBounds(inst) {
  const def = getDef(inst);
  if (!def) return { x: inst.x, y: inst.y, w: 2, h: 2 };
  const { w, h } = effectiveSize(def, inst);
  return { x: inst.x, y: inst.y, w, h };
}

export function pointInInstance(inst, gx, gy) {
  const b = instanceBounds(inst);
  return gx >= b.x && gx <= b.x + b.w && gy >= b.y && gy <= b.y + b.h;
}

// distance from point to a polyline segment, in grid units
export function pointToSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export function wirePath(circuit, wire) {
  const fromInst = circuit.getComponent(wire.from.compId);
  const toInst = circuit.getComponent(wire.to.compId);
  if (!fromInst || !toInst) return null;
  const start = pinWorldPos(fromInst, wire.from.pinId);
  const end = pinWorldPos(toInst, wire.to.pinId);
  if (!start || !end) return null;
  return [start, ...wire.points, end];
}
