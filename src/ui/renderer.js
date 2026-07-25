import { GRID, computeLayout, effectiveSize, wirePath, getDef, pointToSegDist } from './layout.js';
import { FLOATING, CONFLICT, toInt } from '../core/bits.js';

export const COLORS = {
  bg: '#0a0e14',
  gridDot: '#1b2430',
  gridDotMajor: '#242f3d',
  wireLow: '#3a4b5c',
  wireHigh: '#ffb454',
  wireHighGlow: 'rgba(255,180,84,0.35)',
  wireFloat: '#3a4250',
  wireConflict: '#ff4d6d',
  compFill: '#141b24',
  compFillHover: '#182130',
  compBorder: '#2b3542',
  compBorderSelected: '#5eead4',
  text: '#dbe4ec',
  textDim: '#7d8b99',
  pinLow: '#5b6b7c',
  pinHigh: '#ffb454',
  pinFloat: '#4a5566',
  marquee: 'rgba(94,234,212,0.12)',
  marqueeBorder: '#5eead4',
};

export function worldToScreen(camera, x, y) {
  return { x: x * GRID * camera.zoom + camera.panX, y: y * GRID * camera.zoom + camera.panY };
}
export function screenToWorld(camera, x, y) {
  return { x: (x - camera.panX) / (GRID * camera.zoom), y: (y - camera.panY) / (GRID * camera.zoom) };
}

function bitsState(bits) {
  if (!bits || bits.length === 0) return 'float';
  if (bits.some((b) => b === CONFLICT)) return 'conflict';
  if (bits.every((b) => b === FLOATING)) return 'float';
  if (bits.some((b) => b === 1)) return 'high';
  return 'low';
}

function wireColor(state) {
  if (state === 'conflict') return COLORS.wireConflict;
  if (state === 'float') return COLORS.wireFloat;
  if (state === 'high') return COLORS.wireHigh;
  return COLORS.wireLow;
}

export function render(ctx, w, h, S) {
  const { camera, circuit, selection, wireValues, hover, wireDraft, marquee, time, invalidWires } = S;
  ctx.save();
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);

  drawGrid(ctx, camera, w, h);

  // Pre-compute wire paths for junction detection
  const wirePaths = new Map();
  for (const wire of circuit.wires) {
    const path = wirePath(circuit, wire);
    if (path) wirePaths.set(wire.id, path);
  }

  // wires (draw before components so pins sit on top)
  for (const wire of circuit.wires) {
    const path = wirePaths.get(wire.id);
    if (!path) continue;
    const bits = wireValues?.get(wire.id);
    const state = bitsState(bits);
    const selected = selection?.has(wire.id);
    const width = bits && bits.length > 1 ? 3 : 2;
    drawWire(ctx, camera, path, state, selected, time, width, invalidWires?.has(wire.id));
  }

  // Junction dots: wherever a source pin drives ≥2 wires (fan-out),
  // and wherever a wire endpoint lands on another wire's interior (T-junction)
  const junctions = computeJunctions(circuit, circuit.wires, wirePaths, wireValues);
  for (const j of junctions) drawJunctionDot(ctx, camera, j);

  if (wireDraft) {
    drawWire(ctx, camera, wireDraft.points, wireDraft.valid ? 'low' : 'conflict', false, time, 2, false, true);
  }

  for (const inst of circuit.components) {
    drawComponent(ctx, camera, inst, {
      selected: selection?.has(inst.id),
      hover: hover?.type === 'component' && hover.id === inst.id,
      outputs: S.instanceOutputs?.get(inst.id),
      wireValues,
      circuit,
      time,
    });
  }

  // pin hover tooltip
  if (hover?.type === 'pin') {
    drawPinTooltip(ctx, camera, hover);
  }

  if (marquee) {
    const a = worldToScreen(camera, marquee.x0, marquee.y0);
    const b = worldToScreen(camera, marquee.x1, marquee.y1);
    ctx.fillStyle = COLORS.marquee;
    ctx.strokeStyle = COLORS.marqueeBorder;
    ctx.lineWidth = 1;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const ww = Math.abs(b.x - a.x), hh = Math.abs(b.y - a.y);
    ctx.fillRect(x, y, ww, hh);
    ctx.strokeRect(x, y, ww, hh);
  }

  ctx.restore();
}

function drawGrid(ctx, camera, w, h) {
  const step = GRID * camera.zoom;
  if (step < 4) return;
  const ox = camera.panX % step;
  const oy = camera.panY % step;
  ctx.fillStyle = COLORS.gridDot;
  const majorEvery = 5;
  const startCol = Math.floor(-camera.panX / step);
  const startRow = Math.floor(-camera.panY / step);
  for (let x = ox, col = startCol; x < w; x += step, col++) {
    for (let y = oy, row = startRow; y < h; y += step, row++) {
      const major = col % majorEvery === 0 && row % majorEvery === 0;
      ctx.fillStyle = major ? COLORS.gridDotMajor : COLORS.gridDot;
      const r = major ? 1.6 : 1;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawWire(ctx, camera, points, state, selected, time, lineWidth, invalid, isDraft) {
  const pts = points.map((p) => worldToScreen(camera, p.x, p.y));
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (state === 'high' && !isDraft) {
    ctx.strokeStyle = COLORS.wireHighGlow;
    ctx.lineWidth = (lineWidth + 5) * camera.zoom;
    tracePath(ctx, pts);
    ctx.stroke();
  }
  ctx.strokeStyle = invalid ? COLORS.wireConflict : wireColor(state);
  ctx.lineWidth = (selected ? lineWidth + 1.5 : lineWidth) * camera.zoom;
  if (state === 'float' || isDraft) ctx.setLineDash([5 * camera.zoom, 4 * camera.zoom]);
  else if (state === 'high') { ctx.setLineDash([8 * camera.zoom, 6 * camera.zoom]); ctx.lineDashOffset = -(time / 40) % 14; }
  else ctx.setLineDash([]);
  tracePath(ctx, pts);
  ctx.stroke();
  if (selected) {
    ctx.setLineDash([]);
    ctx.strokeStyle = COLORS.compBorderSelected;
    ctx.lineWidth = 1;
    tracePath(ctx, pts);
    ctx.stroke();
  }
  ctx.restore();
}

// ---- junction dots ----

function computeJunctions(circuit, wires, wirePaths, wireValues) {
  // Fan-out: source pins with ≥2 wires leaving them get a dot
  const fromCount = new Map();
  for (const wire of wires) {
    const key = `${wire.from.compId}|${wire.from.pinId}`;
    if (!fromCount.has(key)) {
      const path = wirePaths.get(wire.id);
      fromCount.set(key, { pos: path ? path[0] : null, count: 0, wireId: wire.id });
    }
    fromCount.get(key).count++;
  }
  const junctions = [];
  for (const { pos, count, wireId } of fromCount.values()) {
    if (count >= 2 && pos) {
      const bits = wireValues?.get(wireId);
      junctions.push({ pos, bits });
    }
  }

  // T-junction: a wire endpoint lies on the interior of another wire's segment
  for (const wireA of wires) {
    const pathA = wirePaths.get(wireA.id);
    if (!pathA) continue;
    const endPt = pathA[pathA.length - 1]; // target pin position
    for (const wireB of wires) {
      if (wireA.id === wireB.id) continue;
      const pathB = wirePaths.get(wireB.id);
      if (!pathB) continue;
      for (let k = 0; k < pathB.length - 1; k++) {
        const a = pathB[k], b = pathB[k + 1];
        // Skip if endPt is at one of the segment's own endpoints
        if (Math.hypot(endPt.x - a.x, endPt.y - a.y) < 0.05) continue;
        if (Math.hypot(endPt.x - b.x, endPt.y - b.y) < 0.05) continue;
        if (pointToSegDist(endPt.x, endPt.y, a.x, a.y, b.x, b.y) < 0.05) {
          const bits = wireValues?.get(wireA.id);
          junctions.push({ pos: endPt, bits });
          break;
        }
      }
    }
  }

  return junctions;
}

function drawJunctionDot(ctx, camera, { pos, bits }) {
  const sp = worldToScreen(camera, pos.x, pos.y);
  const state = bitsState(bits);
  ctx.save();
  ctx.beginPath();
  ctx.arc(sp.x, sp.y, 4 * camera.zoom, 0, Math.PI * 2);
  ctx.fillStyle = wireColor(state);
  ctx.fill();
  ctx.restore();
}

function tracePath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
}

function drawComponent(ctx, camera, inst, opts) {
  const def = getDef(inst);
  if (!def) { drawMissingType(ctx, camera, inst); return; }
  const layout = computeLayout(inst);
  const { w: effW, h: effH } = effectiveSize(def, inst);
  const { w: origW, h: origH } = def.size(inst.params || {});
  const centerWorld = { x: inst.x + effW / 2, y: inst.y + effH / 2 };
  const c = worldToScreen(camera, centerWorld.x, centerWorld.y);
  const zoom = camera.zoom;

  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate((inst.rot % 4) * Math.PI / 2);
  ctx.scale(zoom, zoom);
  const pw = origW * GRID, ph = origH * GRID;

  drawBody(ctx, def, inst, pw, ph, opts);

  ctx.restore();

  // pins + labels drawn in world space (not rotated) so text/pin dots stay legible
  for (const pin of layout.pins) {
    const pos = layout.positions.get(pin.id);
    const world = { x: inst.x + pos.x, y: inst.y + pos.y };
    const sp = worldToScreen(camera, world.x, world.y);
    const bits = pin.dir === 'out' ? opts.outputs?.[pin.id] : wireValueInto(opts.circuit, opts.wireValues, inst.id, pin.id);
    drawPin(ctx, sp, bits, opts.hover, camera.zoom);
  }

  // selection outline (axis-aligned effective bbox, easier to read than rotated one)
  if (opts.selected || opts.hover) {
    const topLeft = worldToScreen(camera, inst.x, inst.y);
    const size = { x: effW * GRID * zoom, y: effH * GRID * zoom };
    ctx.save();
    ctx.strokeStyle = opts.selected ? COLORS.compBorderSelected : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = opts.selected ? 1.5 : 1;
    ctx.setLineDash(opts.selected ? [] : [3, 3]);
    ctx.strokeRect(topLeft.x - 3, topLeft.y - 3, size.x + 6, size.y + 6);
    ctx.restore();
  }

  // label under the component
  if (inst.label || def.label) {
    const topLeft = worldToScreen(camera, inst.x, inst.y + effH);
    ctx.save();
    ctx.fillStyle = COLORS.textDim;
    ctx.font = `${11 * Math.min(1.4, camera.zoom)}px "JetBrains Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(inst.label || '', topLeft.x + (effW * GRID * camera.zoom) / 2, topLeft.y + 2);
    ctx.restore();
  }
}

function wireValueInto(circuit, wireValues, compId, pinId) {
  const w = circuit.wireInto(compId, pinId);
  if (!w) return null;
  return wireValues?.get(w.id) || null;
}

function drawMissingType(ctx, camera, inst) {
  const sp = worldToScreen(camera, inst.x, inst.y);
  ctx.save();
  ctx.strokeStyle = COLORS.wireConflict;
  ctx.strokeRect(sp.x, sp.y, 2 * GRID * camera.zoom, 2 * GRID * camera.zoom);
  ctx.fillStyle = COLORS.wireConflict;
  ctx.font = '10px monospace';
  ctx.fillText('?' + inst.type, sp.x, sp.y - 4);
  ctx.restore();
}

function drawPin(ctx, sp, bits, hover, zoom) {
  const state = bitsState(bits);
  const isHover = hover?.type === 'pin' && hover.sp && Math.hypot(hover.sp.x - sp.x, hover.sp.y - sp.y) < 1;
  ctx.save();
  ctx.beginPath();
  ctx.arc(sp.x, sp.y, (isHover ? 4.5 : 3) * Math.min(1.3, zoom), 0, Math.PI * 2);
  ctx.fillStyle = state === 'high' ? COLORS.pinHigh : state === 'conflict' ? COLORS.wireConflict : state === 'float' ? COLORS.pinFloat : COLORS.pinLow;
  ctx.fill();
  ctx.restore();
}

function drawPinTooltip(ctx, camera, hover) {
  const { sp, bits, label } = hover;
  const lines = [];
  if (label) lines.push(label);
  if (bits) {
    const v = toInt(bits);
    lines.push(bits.length > 1
      ? `bin ${bits.map((b) => (b === 1 ? '1' : b === 0 ? '0' : b === CONFLICT ? 'X' : '?')).reverse().join('')}`
      : (bits[0] === 1 ? '1 (HIGH)' : bits[0] === 0 ? '0 (LOW)' : bits[0] === CONFLICT ? 'Konflikt' : 'offen'));
    if (bits.length > 1 && v !== null) lines.push(`dec ${v}  hex ${v.toString(16).toUpperCase()}`);
  }
  ctx.save();
  ctx.font = '11px "JetBrains Mono", monospace';
  const padding = 6;
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padding * 2;
  const height = lines.length * 14 + padding * 2 - 2;
  let x = sp.x + 10, y = sp.y - height - 10;
  ctx.fillStyle = 'rgba(16,22,29,0.95)';
  ctx.strokeStyle = COLORS.compBorder;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, width, height, 4) : ctx.rect(x, y, width, height);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = COLORS.text;
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, x + padding, y + padding + i * 14));
  ctx.restore();
}

// ---- component body drawing (local coords: origin at center, x right, y down) ----

function boxRect(ctx, pw, ph, fill, stroke, hover) {
  ctx.beginPath();
  const r = 6;
  const x = -pw / 2, y = -ph / 2;
  if (ctx.roundRect) ctx.roundRect(x, y, pw, ph, r); else ctx.rect(x, y, pw, ph);
  ctx.fillStyle = hover ? COLORS.compFillHover : fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function label(ctx, text, color = COLORS.text, size = 13) {
  ctx.fillStyle = color;
  ctx.font = `bold ${size}px "JetBrains Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
}

const GATE_DRAWERS = {
  AND: (ctx, pw, ph, color) => gateAndShape(ctx, pw, ph, color, false),
  NAND: (ctx, pw, ph, color) => gateAndShape(ctx, pw, ph, color, true),
  OR: (ctx, pw, ph, color) => gateOrShape(ctx, pw, ph, color, false, false),
  NOR: (ctx, pw, ph, color) => gateOrShape(ctx, pw, ph, color, true, false),
  XOR: (ctx, pw, ph, color) => gateOrShape(ctx, pw, ph, color, false, true),
  XNOR: (ctx, pw, ph, color) => gateOrShape(ctx, pw, ph, color, true, true),
  NOT: (ctx, pw, ph, color) => gateTriShape(ctx, pw, ph, color, true),
  BUFFER: (ctx, pw, ph, color) => gateTriShape(ctx, pw, ph, color, false),
};

function gateAndShape(ctx, pw, ph, color, bubble) {
  const x0 = -pw / 2, x1 = pw / 2 - (bubble ? 6 : 0);
  const y0 = -ph / 2, y1 = ph / 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(0, y0);
  ctx.arc(0, 0, ph / 2, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x0, y1);
  ctx.closePath();
  ctx.fillStyle = COLORS.compFill;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  if (bubble) drawBubble(ctx, x1 + 6, 0, color);
}

function gateOrShape(ctx, pw, ph, color, bubble, xor) {
  const x0 = -pw / 2, x1 = pw / 2 - (bubble ? 6 : 0);
  const y0 = -ph / 2, y1 = ph / 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(x0 + pw * 0.55, y0, x1, 0);   // obere Kante: nach außen wölben
  ctx.quadraticCurveTo(x0 + pw * 0.55, y1, x0, y1);  // untere Kante: nach außen wölben
  ctx.quadraticCurveTo(x0 + pw * 0.18, 0, x0, y0);   // Rückseite: konkav (bleibt wie gehabt)
  ctx.closePath();
  ctx.fillStyle = COLORS.compFill;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  if (xor) {
    ctx.beginPath();
    ctx.moveTo(x0 - 4, y0);
    ctx.quadraticCurveTo(x0 - 4 + pw * 0.18, 0, x0 - 4, y1);
    ctx.stroke();
  }
  if (bubble) drawBubble(ctx, x1 + 6, 0, color);
}

function gateTriShape(ctx, pw, ph, color, bubble) {
  const x0 = -pw / 2, x1 = pw / 2 - (bubble ? 6 : 0);
  ctx.beginPath();
  ctx.moveTo(x0, -ph / 2);
  ctx.lineTo(x0, ph / 2);
  ctx.lineTo(x1, 0);
  ctx.closePath();
  ctx.fillStyle = COLORS.compFill;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  if (bubble) drawBubble(ctx, x1 + 6, 0, color);
}

function drawBubble(ctx, x, y, color) {
  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.compFill;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

function drawBody(ctx, def, inst, pw, ph, opts) {
  const type = inst.type;
  if (GATE_DRAWERS[type]) { GATE_DRAWERS[type](ctx, pw, ph, def.color); return; }

  if (type === 'SWITCH') return drawSwitch(ctx, pw, ph, inst, opts);
  if (type === 'BUTTON') return drawButton(ctx, pw, ph, inst, opts);
  if (type === 'CLOCK') return drawClock(ctx, pw, ph, inst, opts);
  if (type === 'CONST0' || type === 'CONST1') return drawConst(ctx, pw, ph, type === 'CONST1', def.color);
  if (type === 'LAMP') return drawLamp(ctx, pw, ph, inst, opts);
  if (type === 'DISPLAY') return drawDisplay(ctx, pw, ph, inst, opts, def);
  if (type === 'PROBE') return drawProbe(ctx, pw, ph, inst, opts);
  if (type === 'PIN_IN' || type === 'PIN_OUT') return drawInterfacePin(ctx, pw, ph, inst, opts, type);
  if (type === 'TUNNEL_IN' || type === 'TUNNEL_OUT') return drawTunnel(ctx, pw, ph, inst, type);
  if (type === 'SPLITTER' || type === 'MERGER') return drawSplitMerge(ctx, pw, ph, inst, type);

  // generic box (registers, RAM, DFF, custom composite/code components...)
  boxRect(ctx, pw, ph, COLORS.compFill, opts.selected ? COLORS.compBorderSelected : def.color || COLORS.compBorder, opts.hover);
  label(ctx, def.label, def.color || COLORS.text, Math.min(13, pw / Math.max(4, def.label.length * 0.62)));
  if (def.isComposite || def.isCode) {
    ctx.save();
    ctx.fillStyle = COLORS.textDim;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillText(def.isCode ? '</>' : 'IC', 0, ph / 2 - 10);
    ctx.restore();
  }
}

function drawSwitch(ctx, pw, ph, inst, opts) {
  const on = !!inst.state?.value;
  boxRect(ctx, pw, ph, COLORS.compFill, on ? COLORS.pinHigh : COLORS.compBorder, opts.hover);
  const trackW = pw * 0.6, trackH = ph * 0.32;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-trackW / 2, -trackH / 2, trackW, trackH, trackH / 2); else ctx.rect(-trackW / 2, -trackH / 2, trackW, trackH);
  ctx.fillStyle = on ? 'rgba(255,180,84,0.25)' : '#1c242e';
  ctx.fill();
  ctx.strokeStyle = on ? COLORS.pinHigh : COLORS.textDim;
  ctx.stroke();
  const knobX = on ? trackW / 2 - trackH / 2 : -trackW / 2 + trackH / 2;
  ctx.beginPath();
  ctx.arc(knobX, 0, trackH / 2 - 2, 0, Math.PI * 2);
  ctx.fillStyle = on ? COLORS.pinHigh : COLORS.textDim;
  ctx.fill();
}

function drawButton(ctx, pw, ph, inst, opts) {
  const pressed = !!inst.state?.pressed;
  boxRect(ctx, pw, ph, pressed ? '#2a2015' : COLORS.compFill, pressed ? COLORS.pinHigh : COLORS.compBorder, opts.hover);
  ctx.beginPath();
  ctx.arc(0, 0, Math.min(pw, ph) * 0.28, 0, Math.PI * 2);
  ctx.fillStyle = pressed ? COLORS.pinHigh : '#2b3542';
  ctx.fill();
}

function drawClock(ctx, pw, ph, inst, opts) {
  const on = !!inst.state?.value;
  boxRect(ctx, pw, ph, COLORS.compFill, on ? COLORS.pinHigh : COLORS.compBorder, opts.hover);
  ctx.strokeStyle = COLORS.textDim;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  const s = Math.min(pw, ph) * 0.22;
  ctx.moveTo(-s, s * 0.6); ctx.lineTo(-s, -s); ctx.lineTo(0, -s); ctx.lineTo(0, s); ctx.lineTo(s, s); ctx.lineTo(s, -s * 0.6);
  ctx.stroke();
}

function drawConst(ctx, pw, ph, high, color) {
  ctx.beginPath();
  ctx.moveTo(-pw / 2, 0);
  ctx.lineTo(pw / 2, 0);
  ctx.strokeStyle = high ? COLORS.pinHigh : COLORS.textDim;
  ctx.lineWidth = 2;
  ctx.stroke();
  label(ctx, high ? '1' : '0', high ? COLORS.pinHigh : COLORS.textDim, 12);
}

function drawLamp(ctx, pw, ph, inst, opts) {
  const bits = inst.state?.last;
  const on = bits && bits.some((b) => b === 1);
  const r = Math.min(pw, ph) * 0.36;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  if (on) {
    const grad = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 1.8);
    grad.addColorStop(0, 'rgba(255,200,120,0.9)');
    grad.addColorStop(1, 'rgba(255,180,84,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(-r * 2, -r * 2, r * 4, r * 4);
  }
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = on ? COLORS.pinHigh : '#232c38';
  ctx.fill();
  ctx.strokeStyle = opts.selected ? COLORS.compBorderSelected : COLORS.compBorder;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawDisplay(ctx, pw, ph, inst, opts, def) {
  boxRect(ctx, pw, ph, '#0d1712', opts.selected ? COLORS.compBorderSelected : '#274a2e', opts.hover);
  const bits = inst.state?.last;
  const text = bits ? def.formatValue(bits, inst.params?.mode || 'hex') : '--';
  ctx.fillStyle = '#7cff9e';
  ctx.font = `bold ${Math.min(15, pw / Math.max(3, text.length * 0.62))}px "JetBrains Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#7cff9e';
  ctx.shadowBlur = 6;
  ctx.fillText(text, 0, 0);
  ctx.shadowBlur = 0;
}

function drawProbe(ctx, pw, ph, inst, opts) {
  boxRect(ctx, pw, ph, COLORS.compFill, opts.selected ? COLORS.compBorderSelected : COLORS.compBorder, opts.hover);
  const bits = inst.state?.last;
  const v = bits ? toInt(bits) : null;
  label(ctx, v === null ? (bits && bits.some((b) => b === CONFLICT) ? 'ERR' : '?') : String(v), COLORS.text, 11);
}

function drawInterfacePin(ctx, pw, ph, inst, opts, type) {
  const isIn = type === 'PIN_IN';
  boxRect(ctx, pw, ph, COLORS.compFill, '#5eead4', opts.hover);
  label(ctx, inst.params?.name || (isIn ? 'IN' : 'OUT'), '#5eead4', 11);
}

function drawTunnel(ctx, pw, ph, inst, type) {
  ctx.beginPath();
  const dir = type === 'TUNNEL_IN' ? 1 : -1;
  ctx.moveTo(-pw / 2 * dir, -ph / 2);
  ctx.lineTo(pw / 2 * dir, 0);
  ctx.lineTo(-pw / 2 * dir, ph / 2);
  ctx.closePath();
  ctx.fillStyle = COLORS.compFill;
  ctx.fill();
  ctx.strokeStyle = '#6f7d8c';
  ctx.stroke();
  ctx.fillStyle = COLORS.textDim;
  ctx.font = '8px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(inst.params?.net || '', 0, ph / 2 + 10);
}

function drawSplitMerge(ctx, pw, ph, inst) {
  boxRect(ctx, pw, ph, COLORS.compFill, '#6f7d8c', false);
  ctx.strokeStyle = '#6f7d8c';
  ctx.lineWidth = 1;
  const n = inst.params?.width ?? 8;
  for (let i = 0; i < n; i++) {
    const y = -ph / 2 + ((i + 1) / (n + 1)) * ph;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(pw / 2 - 4, 0);
    ctx.stroke();
  }
}
