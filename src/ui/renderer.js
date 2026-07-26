import { GRID, computeLayout, effectiveSize, wirePath, getDef, pointToSegDist } from './layout.js';
import { FLOATING, CONFLICT, toInt } from '../core/bits.js';
import { sliderTrackRect, formatSliderValue } from '../components/io.js';

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
  const majorEvery = 5;
  let cellStep = 1; // wie viele Gitterzellen zwischen gezeichneten Punkten liegen
  let step = GRID * camera.zoom;

  // Bei zu geringem Pixelabstand nicht abbrechen, sondern gröber rastern:
  // erst auf Major-Punkte (alle 5 Zellen), bei Bedarf noch weiter ausdünnen.
  while (step < 4 && cellStep < 1000) {
    cellStep *= majorEvery;
    step = GRID * camera.zoom * cellStep;
  }
  if (step < 2) return; // absolute Untergrenze, sonst reine Pixelsuppe

  ctx.fillStyle = COLORS.gridDot;
  const startCol = Math.floor(-camera.panX / step);
  const startRow = Math.floor(-camera.panY / step);
  const ox = (-camera.panX) - startCol * step;
  const oy = (-camera.panY) - startRow * step;

  for (let x = ox, col = startCol; x < w; x += step, col++) {
    for (let y = oy, row = startRow; y < h; y += step, row++) {
      // "major" nur sinnvoll, wenn wir noch auf Zellebene (cellStep===1) zeichnen
      const major = cellStep === 1 && col % majorEvery === 0 && row % majorEvery === 0;
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

// Prüft, ob zwei achsparallele, kollineare Segmente sich überlappen (nicht nur
// berühren). Gibt bei Überlappung Achse + Bereich zurück, sonst null.
function segmentsOverlap(a1, a2, b1, b2) {
  const aH = Math.abs(a1.y - a2.y) < 0.01, aV = Math.abs(a1.x - a2.x) < 0.01;
  const bH = Math.abs(b1.y - b2.y) < 0.01, bV = Math.abs(b1.x - b2.x) < 0.01;
  if (aH && bH && Math.abs(a1.y - b1.y) < 0.01) {
    const lo = Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x));
    const hi = Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x));
    if (hi - lo > 0.01) return { axis: 'x', y: a1.y, lo, hi };
  }
  if (aV && bV && Math.abs(a1.x - b1.x) < 0.01) {
    const lo = Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y));
    const hi = Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y));
    if (hi - lo > 0.01) return { axis: 'y', x: a1.x, lo, hi };
  }
  return null;
}

function computeJunctions(circuit, wires, wirePaths, wireValues) {
  // Fan-out: source pins with ≥2 wires leaving them get a dot
  const fromCount = new Map();
  const netGroups = new Map(); // gleicher Quellpin = gleiches Netz
  for (const wire of wires) {
    const key = `${wire.from.compId}|${wire.from.pinId}`;
    if (!fromCount.has(key)) {
      const path = wirePaths.get(wire.id);
      fromCount.set(key, { pos: path ? path[0] : null, count: 0, wireId: wire.id });
    }
    fromCount.get(key).count++;
    if (!netGroups.has(key)) netGroups.set(key, []);
    netGroups.get(key).push(wire.id);
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

  // Überlappende Segmente innerhalb desselben Netzes (gleicher Quellpin) ->
  // an den Rändern der Überlappung ebenfalls einen Verbindungspunkt setzen,
  // damit die Kabel optisch zu einer Leitung verschmelzen.
  for (const wireIds of netGroups.values()) {
    if (wireIds.length < 2) continue;
    for (let a = 0; a < wireIds.length; a++) {
      const pathA = wirePaths.get(wireIds[a]);
      if (!pathA) continue;
      for (let b = a + 1; b < wireIds.length; b++) {
        const pathB = wirePaths.get(wireIds[b]);
        if (!pathB) continue;
        for (let i = 0; i < pathA.length - 1; i++) {
          for (let j = 0; j < pathB.length - 1; j++) {
            const ov = segmentsOverlap(pathA[i], pathA[i + 1], pathB[j], pathB[j + 1]);
            if (!ov) continue;
            const bits = wireValues?.get(wireIds[a]);
            const p1 = ov.axis === 'x' ? { x: ov.lo, y: ov.y } : { x: ov.x, y: ov.lo };
            const p2 = ov.axis === 'x' ? { x: ov.hi, y: ov.y } : { x: ov.x, y: ov.hi };
            junctions.push({ pos: p1, bits });
            junctions.push({ pos: p2, bits });
          }
        }
      }
    }
  }

  // Duplikate an (fast) derselben Stelle entfernen
  const seen = new Set();
  const deduped = [];
  for (const j of junctions) {
    const key = `${j.pos.x.toFixed(2)}|${j.pos.y.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(j);
  }
  return deduped;
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
    if (camera.zoom > 0.55) {
      const connected = pin.dir === 'out'
        ? opts.circuit.wiresFrom(inst.id, pin.id).length > 0
        : !!opts.circuit.wireInto(inst.id, pin.id);
      drawPinLabel(ctx, sp, pin, pos.side, camera.zoom, connected);
    }
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

function drawPinLabel(ctx, sp, pin, side, zoom, connected) {
  const text = pin.label || pin.id;
  if (!text) return;
  ctx.save();
  const fontSize = 9 * Math.min(1.3, zoom);
  ctx.font = `${fontSize}px "JetBrains Mono", monospace`;
  ctx.fillStyle = COLORS.textDim;
  const offset = 6 * zoom;      // Abstand vom Pin entlang der Kabelachse
  const clear = connected ? 5 * zoom : 0; // Versatz quer zum Kabel nur bei belegtem Pin

  if (side === 'left') {
    ctx.textAlign = 'right';
    ctx.textBaseline = connected ? 'bottom' : 'middle';
    ctx.fillText(text, sp.x - offset, sp.y - clear);
  } else if (side === 'right') {
    ctx.textAlign = 'left';
    ctx.textBaseline = connected ? 'bottom' : 'middle';
    ctx.fillText(text, sp.x + offset, sp.y - clear);
  } else if (side === 'top') {
    ctx.textAlign = connected ? 'left' : 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, sp.x + clear, sp.y - offset);
  } else {
    ctx.textAlign = connected ? 'left' : 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(text, sp.x + clear, sp.y + offset);
  }
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
  ctx.quadraticCurveTo(x0 + pw * 0.8, y0, x1, 0);   // obere Kante: nach außen wölben
  ctx.quadraticCurveTo(x0 + pw * 0.8, y1, x0, y1);  // untere Kante: nach außen wölben
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
  if (type === 'PULLUP') return drawPullUpArrow(ctx, pw, ph, def.color);
  if (type === 'PULLDOWN') return drawPullDownArrow(ctx, pw, ph, def.color);
  if (type === 'LAMP') return drawLamp(ctx, pw, ph, inst, opts);
  if (type === 'DISPLAY') return drawDisplay(ctx, pw, ph, inst, opts, def);
  if (type === 'PROBE') return drawProbe(ctx, pw, ph, inst, opts);
  if (type === 'PIN_IN' || type === 'PIN_OUT') return drawInterfacePin(ctx, pw, ph, inst, opts, type);
  if (type === 'TUNNEL_IN' || type === 'TUNNEL_OUT') return drawTunnel(ctx, pw, ph, inst, type);
  if (type === 'SPLITTER' || type === 'MERGER') return drawSplitMerge(ctx, pw, ph, inst, type);
  if (type === 'ADDSUB') return drawAddSub(ctx, pw, ph, inst, opts, def);
  if (type === 'MUX') return drawMuxDemux(ctx, pw, ph, inst, opts, def, true);
  if (type === 'DEMUX') return drawMuxDemux(ctx, pw, ph, inst, opts, def, false);
  if (type === 'SEVENSEG') return drawSevenSeg(ctx, pw, ph, inst, opts);
  if (type === 'TRISTATE') return drawTriState(ctx, pw, ph, def, opts);
  if (type === 'RGBLED') return drawRgbLed(ctx, pw, ph, inst, opts);
  if (type === 'BUSWATCH') return drawBusWatch(ctx, pw, ph, inst, opts, def);
  if (type === 'SLIDER') return drawSliderTrack(ctx, pw, ph, inst, opts);

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

function drawPullUpArrow(ctx, pw, ph, color) {
  const headLen = Math.min(8, ph * 0.35);
  const shaftTop = -ph / 2 + headLen;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(0, ph / 2);
  ctx.lineTo(0, shaftTop);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -ph / 2);
  ctx.lineTo(-4, shaftTop);
  ctx.lineTo(4, shaftTop);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawPullDownArrow(ctx, pw, ph, color) {
  // Klassisches Pull-down-Symbol: Schaft + größerer, hohler Dreieckskopf unten
  const headLen = Math.min(12, ph * 0.5);
  const headW = Math.min(11, pw * 0.42);
  const shaftBottom = ph / 2 - headLen;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(0, -ph / 2);
  ctx.lineTo(0, shaftBottom);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, ph / 2);
  ctx.lineTo(-headW, shaftBottom);
  ctx.lineTo(headW, shaftBottom);
  ctx.closePath();
  ctx.fillStyle = COLORS.compFill; // hohl: mit Hintergrundfarbe statt Randfarbe füllen
  ctx.fill();
  ctx.stroke();
  ctx.restore();
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

function drawAddSub(ctx, pw, ph, inst, opts, def) {
  boxRect(ctx, pw, ph, COLORS.compFill, opts.selected ? COLORS.compBorderSelected : def.color, opts.hover);
  ctx.save();
  ctx.fillStyle = def.color;
  ctx.font = `bold ${Math.min(18, ph * 0.4)}px "JetBrains Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Σ', 0, -ph * 0.08);
  ctx.font = `${Math.min(10, ph * 0.18)}px "JetBrains Mono", monospace`;
  ctx.fillStyle = COLORS.textDim;
  ctx.fillText('±', 0, ph / 2 - 9);
  ctx.restore();
}

function drawMuxDemux(ctx, pw, ph, inst, opts, def, isMux) {
  const halfW = pw / 2, halfH = ph / 2;
  // Mux: breite Seite (viele Eingänge) links, schmale Seite (ein Ausgang) rechts. Demux umgekehrt.
  const leftH = isMux ? halfH : halfH * 0.6;
  const rightH = isMux ? halfH * 0.6 : halfH;
  ctx.beginPath();
  ctx.moveTo(-halfW, -leftH);
  ctx.lineTo(halfW, -rightH);
  ctx.lineTo(halfW, rightH);
  ctx.lineTo(-halfW, leftH);
  ctx.closePath();
  ctx.fillStyle = COLORS.compFill;
  ctx.fill();
  ctx.strokeStyle = opts.selected ? COLORS.compBorderSelected : def.color;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.save();
  ctx.fillStyle = def.color;
  ctx.font = `bold ${Math.min(12, ph * 0.22)}px "JetBrains Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(isMux ? 'MUX' : 'DMX', 0, 0);
  ctx.restore();
}

function drawSevenSeg(ctx, pw, ph, inst, opts) {
  boxRect(ctx, pw, ph, '#0d1712', opts.selected ? COLORS.compBorderSelected : '#274a2e', opts.hover);
  const segs = inst.state?.segs || {};
  const dw = pw * 0.42, dh = ph * 0.62;
  const left = -dw / 2, right = dw / 2, top = -dh / 2, mid = 0, bottom = dh / 2;
  const lines = {
    a: [[left, top], [right, top]],
    b: [[right, top], [right, mid]],
    c: [[right, mid], [right, bottom]],
    d: [[left, bottom], [right, bottom]],
    e: [[left, mid], [left, bottom]],
    f: [[left, top], [left, mid]],
    g: [[left, mid], [right, mid]],
  };
  ctx.save();
  ctx.lineCap = 'round';
  for (const [id, [[x0, y0], [x1, y1]]] of Object.entries(lines)) {
    const on = !!segs[id];
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = on ? '#7cff9e' : '#1c2e22';
    ctx.lineWidth = Math.max(2, ph * 0.09);
    ctx.shadowColor = on ? '#7cff9e' : 'transparent';
    ctx.shadowBlur = on ? 5 : 0;
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(right + 5, bottom, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = segs.dp ? '#7cff9e' : '#1c2e22';
  ctx.fill();
  ctx.restore();
}

function drawTriState(ctx, pw, ph, def, opts) {
  gateTriShape(ctx, pw, ph, opts.selected ? COLORS.compBorderSelected : def.color, false);
  // kleiner Stummel deutet den Enable-Eingang von unten an (Standard-Tristate-Symbol)
  ctx.save();
  ctx.strokeStyle = def.color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(0, ph / 2 - 3);
  ctx.lineTo(0, ph / 2 + 5);
  ctx.stroke();
  ctx.restore();
}

function drawRgbLed(ctx, pw, ph, inst, opts) {
  const { r = 0, g = 0, b = 0 } = inst.state || {};
  const col = `rgb(${r}, ${g}, ${b})`;
  const rad = Math.min(pw, ph) * 0.34;
  const bright = (r + g + b) > 0;
  if (bright) {
    const grad = ctx.createRadialGradient(0, 0, rad * 0.2, 0, 0, rad * 2);
    grad.addColorStop(0, col.replace('rgb', 'rgba').replace(')', ',0.55)'));
    grad.addColorStop(1, col.replace('rgb', 'rgba').replace(')', ',0)'));
    ctx.fillStyle = grad;
    ctx.fillRect(-rad * 2.2, -rad * 2.2, rad * 4.4, rad * 4.4);
  }
  ctx.beginPath();
  ctx.arc(0, 0, rad, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();
  ctx.strokeStyle = opts.selected ? COLORS.compBorderSelected : COLORS.compBorder;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawBusWatch(ctx, pw, ph, inst, opts, def) {
  boxRect(ctx, pw, ph, COLORS.compFill, opts.selected ? COLORS.compBorderSelected : def.color, opts.hover);
  const bits = inst.state?.last;
  const lines = bits
    ? [`h ${def.formatValue(bits, 'hex')}`, `d ${def.formatValue(bits, 'dec')}`, `b ${def.formatValue(bits, 'bin')}`]
    : ['h --', 'd --', 'b --'];
  ctx.save();
  ctx.fillStyle = COLORS.text;
  ctx.font = `${Math.min(10, ph / 5)}px "JetBrains Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineH = ph / (lines.length + 1);
  lines.forEach((l, i) => ctx.fillText(l, 0, -ph / 2 + lineH * (i + 1)));
  ctx.restore();
}

function drawSliderTrack(ctx, pw, ph, inst, opts) {
  boxRect(ctx, pw, ph, COLORS.compFill, opts.selected ? COLORS.compBorderSelected : COLORS.compBorder, opts.hover);

  const params = inst.params || {};
  const width = params.width ?? 8;
  const min = params.min ?? 0;
  const max = params.max ?? (2 ** width - 1);
  const lo = Math.min(min, max), hi = Math.max(min, max);
  const value = inst.state?.value ?? lo;
  const t = hi > lo ? (value - lo) / (hi - lo) : 0;

  const trackMargin = pw * 0.12;
  const x0 = -pw / 2 + trackMargin, x1 = pw / 2 - trackMargin;
  const trackY = ph * 0.12; // leicht unter der Mitte, Platz für den Wert oben

  ctx.save();
  ctx.strokeStyle = COLORS.textDim;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, trackY);
  ctx.lineTo(x1, trackY);
  ctx.stroke();

  const hx = x0 + (x1 - x0) * t;
  ctx.beginPath();
  ctx.arc(hx, trackY, 5, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.compBorderSelected;
  ctx.fill();

  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatSliderValue(value, params.format ?? 'dec'), 0, -ph * 0.2);
  ctx.restore();
}
