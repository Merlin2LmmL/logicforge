import { Circuit, ComponentInstance, Wire, nextId, stateReplacer, stateReviver } from '../core/model.js';
import { getComponentType, categorized, defaultParams } from '../core/registry.js';
import { settleCircuit, resetCircuitState } from '../core/simulator.js';
import {
  listDefinitions, createCompositeDefinition, createCodeDefinition,
  removeDefinition, persist, getDefinition,
} from '../core/library.js';
import {
  serializeCircuit, deserializeCircuit, serializeComponent,
  importComponentFile, downloadTextFile, pickTextFile,
} from '../core/fileformat.js';
import { GRID, computeLayout, instanceBounds, pointInInstance, pointToSegDist, wirePath, pinWorldPos, simplifyPoints } from './layout.js';
import { render, COLORS, worldToScreen, screenToWorld } from './renderer.js';
import { showDialog, confirmDialog, toast } from './dialog.js';
import { CATEGORY_ORDER } from '../components/index.js';
import { sliderTrackRect } from '../components/io.js';

const AUTOSAVE_KEY = 'logicforge:autosave:v1';
const PIN_HIT_PX = 9;
const WIRE_HIT_PX = 6;
const MOVE_THRESHOLD_PX = 4;
const HISTORY_LIMIT = 100;
const MIN_ZOOM = 0.10;
const MAX_ZOOM = 8;

const DEFAULT_CODE_TEMPLATE = `// inputs.A / inputs.B sind Bit-Arrays (LSB zuerst): 0, 1, null (offen) oder 'X' (Konflikt)
// state ist dein eigener, dauerhafter Zustand (Startwert: {})
// Rückgabe: { outputs: { Y: [bit, ...] }, state }

const a = inputs.A ? inputs.A[0] : 0;
const b = inputs.B ? inputs.B[0] : 0;
return { outputs: { Y: [(a && b) ? 1 : 0] }, state };
`;

// Does this circuit contain any component whose output can change purely with the passage
// of time (currently: a CLOCK with hz > 0), recursing into composite components' nested
// sub-circuits? Used by Editor._frame to decide whether a frame needs fine time-sliced
// sub-stepping at all, or whether a single settle at real-time resolution is enough.
// Code components are deliberately not recursed into or treated as clock-like: their
// evaluate() never receives `now` (see core/library.js buildCodeType), so nothing in a
// code component's own behavior can depend on wall-clock/sim time.
function circuitHasActiveClock(components, seenTypes = new Set()) {
  for (const inst of components) {
    const def = getComponentType(inst.type);
    if (!def) continue;
    if (def.isClock) {
      if ((inst.params?.hz ?? 0) > 0) return true;
      continue;
    }
    if (def.isComposite) {
      if (seenTypes.has(inst.type)) continue; // guard against pathological self-referential defs
      seenTypes.add(inst.type);
      const libDef = getDefinition(inst.type);
      if (libDef?.kind === 'composite' && libDef.circuit?.components?.length) {
        if (circuitHasActiveClock(libDef.circuit.components, seenTypes)) return true;
      }
    }
  }
  return false;
}

// Sammelt Periode und Pulsdauer jeder aktiven (hz>0) Clock in der Schaltung (rekursiv wie
// circuitHasActiveClock), damit die Sub-Schritt-Auflösung sich an die tatsächlich
// vorhandenen Taktfrequenzen anpassen kann, statt immer eine feste, sehr feine Schrittweite
// zu erzwingen. Ohne das würde selbst eine einzelne 1-Hz-Clock mit derselben ~1µs-Auflösung
// simuliert wie ein 1-MHz-Takt: ~16000 volle settleCircuit()-Durchläufe (je mit bis zu 48
// internen Iterationen) PRO BILDSCHIRM-FRAME, obwohl ein 1-Hz-Takt pro Frame vielleicht 1-2
// Auswertungen bräuchte. Das sprengte routinemäßig das Zeitbudget in _frame(), wodurch die
// Simulation dauerhaft hinter der Wanduhr zurückblieb (eine 1-Hz-Clock blinkte dadurch z.B.
// nur alle paar Sekunden statt jede Sekunde) - UND weil dabei trotzdem in tausenden winzigen
// 1µs-Schritten durch ein einzelnes, sehr viel breiteres "sichtbares Blinken" (z.B. eine
// 1ms-Pulsdauer) hindurchgetreten wurde, bekamen nachgeschaltete Bauteile (Zähler etc.) für
// ein einziges Blinken tausende separate settleCircuit()-Aufrufe zu sehen statt einer
// einzelnen sauberen Flanke.
function collectActiveClockFeatures(components, seenTypes = new Set(), out = []) {
  for (const inst of components) {
    const def = getComponentType(inst.type);
    if (!def) continue;
    if (def.isClock) {
      const hz = inst.params?.hz ?? 0;
      if (hz > 0) {
        const period = 1000 / hz;
        const pulse = Math.min(inst.params?.pulseMs > 0 ? inst.params.pulseMs : period / 2, period);
        out.push(pulse, Math.max(period - pulse, 0.000001));
      }
      continue;
    }
    if (def.isComposite) {
      if (seenTypes.has(inst.type)) continue;
      seenTypes.add(inst.type);
      const libDef = getDefinition(inst.type);
      if (libDef?.kind === 'composite' && libDef.circuit?.components?.length) {
        collectActiveClockFeatures(libDef.circuit.components, seenTypes, out);
      }
    }
  }
  return out;
}

export class Editor {
  constructor(dom) {
    this.dom = dom;
    this.canvas = dom.canvas;
    this.ctx = this.canvas.getContext('2d');

    this.circuit = new Circuit();
    this.meta = { name: 'Unbenannte Schaltung', author: '', description: '' };

    this.camera = { panX: 60, panY: 60, zoom: 1.2 };
    this.selection = new Set();
    this.hover = null;
    this.wireDraft = null;
    this.marquee = null;
    this.placingType = null;
    this.clipboard = null;
    this.time = 0;
    this.wireValues = new Map();
    this.instanceOutputs = new Map();

    // ---- schnelle Taktsimulation ----
    // `simTime` ist eine eigene, virtuelle Simulationszeit (in ms) - komplett getrennt von
    // der echten Bildschirm-Zeit. Pro angezeigtem Frame wird sie NICHT nur um ein einziges
    // rAF-Delta erhöht, sondern in vielen kleinen Schritten (`simStepMs`), damit ein Takt,
    // der viel schneller als 60 Hz laufen soll (z.B. 1 MHz = 1000 Perioden pro ms), auch
    // wirklich so oft "tickt" und nicht nur einmal pro Bildschirm-Frame. Nur das Ergebnis
    // des LETZTEN Sub-Schritts wird gezeichnet - der Zustand aller Bauteile (Register,
    // Speicher, Bildschirm-Framebuffer, ...) akkumuliert aber über alle Sub-Schritte, das
    // Ergebnis verhält sich also wie ein "echter" schneller Taktgeber.
    this.simTime = 0;
    // Absolute Untergrenze der Sub-Schritt-Auflösung (Sicherheitsfloor) - der tatsächlich
    // verwendete Schritt wird pro Frame adaptiv aus den vorhandenen Clock-Frequenzen
    // bestimmt (siehe collectActiveClockFeatures/_frame), 0.00025ms (250ns) reicht, um auch
    // einen 1-MHz-Takt (Periode 1µs) mit ausreichend Samples pro Halbzyklus aufzulösen.
    this.simStepMs = 0.00025;
    // "virtuelle ms Simulationszeit" pro 1ms Echtzeit. 1 = Echtzeit, d.h. eine auf 1 Hz
    // konfigurierte Clock tickt auch wirklich 1x pro Sekunde Wanduhrzeit. War hier auf
    // 1000 (1000x) fest verdrahtet, wodurch JEDE Clock unabhängig von ihrem Hz-Parameter
    // permanent mit dem 1000-fachen ihrer eingestellten Frequenz lief. setSimSpeed() bleibt
    // für einen künftigen "Zeitraffer"-Regler nutzbar, der Default muss aber Echtzeit sein.
    this.simSpeed = 1;
    this.maxSubStepsPerFrame = 20000; // Deckel, damit ein extrem hoher Takt die UI nicht einfriert
    // Virtuelle Simulationszeit, die in einem Frame nicht mehr verarbeitet werden konnte
    // (Zeitbudget aufgebraucht), wird hierin für den nächsten Frame vorgemerkt statt
    // stillschweigend verworfen zu werden - sonst würde die Simulation unter Dauerlast
    // (z.B. eine sehr hochfrequente Clock in einer großen Schaltung) nie wieder zur
    // Echtzeit aufschließen, sondern dauerhaft mit einer beliebigen, last-abhängigen
    // Geschwindigkeit weiterlaufen. Nach oben gedeckelt, damit ein langer Tab-Hintergrund-
    // Stillstand nicht zu einem stundenlangen "Nachsimulieren" in Zeitraffer führt.
    this._simDebtMs = 0;
    this._maxSimDebtMs = 1000;
    this._lastFrameNow = null;

    this.history = [];
    this.historyIndex = -1;

    this.drag = null; // { kind: 'move'|'pan'|'wire-seg'|'marquee', ... }
    // Two-finger pinch/pan is driven ENTIRELY by native TouchEvents (see _onTouchStart/
    // _onTouchMove/_onTouchEnd below), not by Pointer Events. Reason: iOS Safari's
    // PointerEvent delivery for *simultaneous* multi-touch is flaky - each finger's
    // pointermove can arrive slightly late/out-of-order relative to the other, so reading
    // "current position of finger A" and "current position of finger B" from two
    // independently-updated map entries can combine stale + fresh data in the same
    // computation, which is exactly what made two-finger pan janky/dead while pinch-zoom
    // (which tolerates a bit of lag much better) looked like it worked. A TouchEvent's
    // `touches` list bundles every active finger's freshly-sampled coordinates into one
    // atomic event, so reading both fingers out of the SAME touchmove event guarantees
    // they're from the same instant.
    // Pointer Events are still used for single-finger interaction (drag/marquee/wire-draft)
    // - Safari's pointer events for a single touch are reliable, it's only the simultaneous
    // multi-touch case that's buggy. `_activeTouchIds` just counts fingers so pointerdown
    // can bail out of single-finger gestures the instant a second finger touches down.
    this._activeTouchIds = new Set(); // pointerId set, touch pointers only (counting only, no coords)
    this._pinch = null; // { id0, id1, startDist, startZoom, startTime, startMidScreen, compAtStart }
    this._longPressTimer = null;
    this.keys = { space: false };
    this.activeCategory = null;
    this.lastMouseWorld = { x: 0, y: 0 };
    this._buttonPressedId = null;
    this.orthoMode = localStorage.getItem('logicforge:orthoMode') === '1';

    this._bindEvents();
    this._resizeObserver = new ResizeObserver(() => this._resizeCanvas());
    this._resizeObserver.observe(dom.canvasWrap);
    this._resizeCanvas();

    this.pushHistory(); // initial empty state
    this._updateOrthoButton();
    requestAnimationFrame((t) => this._frame(t));
  }

  // ---------------------------------------------------------------- setup

  setCircuit(circuit, meta = {}) {
    this.circuit = circuit;
    this.meta = { name: meta.name || 'Unbenannte Schaltung', author: meta.author || '', description: meta.description || '' };
    this.selection = new Set();
    this.history = [];
    this.historyIndex = -1;
    this.pushHistory();
    this.refreshPanels();
  }

  _resizeCanvas() {
    // Verhindert, dass der Browser bei Touch-Eingaben selbst pannt/zoomt (Pinch-Zoom der
    // Seite, Doppeltipp-Zoom, Scroll-Bounce) - wir wollen Pinch/Pan komplett selbst
    // steuern (siehe _onPointerDown/_onPointerMove, Abschnitt "pointer-based pinch").
    this.canvas.style.touchAction = 'none';
    const rect = this.dom.canvasWrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this._dpr = dpr;
    this._cssW = rect.width;
    this._cssH = rect.height;
  }

  // ---------------------------------------------------------------- history

  pushHistory() {
    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
    }
    this.history.push(this.circuit.clone());
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.historyIndex = this.history.length - 1;
    this._autosave();
    this._updateHistoryButtons();
  }

  undo() {
    if (this.historyIndex <= 0) return;
    this.historyIndex--;
    this.circuit = this.history[this.historyIndex].clone();
    this.selection = new Set();
    this._updateHistoryButtons();
    this.refreshPanels();
  }

  redo() {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex++;
    this.circuit = this.history[this.historyIndex].clone();
    this.selection = new Set();
    this._updateHistoryButtons();
    this.refreshPanels();
  }

  _updateHistoryButtons() {
    this.dom.btnUndo.disabled = this.historyIndex <= 0;
    this.dom.btnRedo.disabled = this.historyIndex >= this.history.length - 1;
  }

  _autosave() {
    try {
      localStorage.setItem(AUTOSAVE_KEY, serializeCircuit(this.circuit, this.meta));
    } catch (e) { /* quota or private mode - ignore */ }
  }

  // ---------------------------------------------------------------- main loop

  _frame(now) {
    this.time = now;

    // Echte vergangene Zeit seit dem letzten Frame (robust gegen Tab-Wechsel/Drosselung:
    // ein sehr großes Delta - z.B. nach Minuten im Hintergrundtab - wird gekappt, damit wir
    // nicht Millionen Sub-Schritte in einem Frame nachholen müssen).
    const realDeltaMs = this._lastFrameNow != null ? Math.min(now - this._lastFrameNow, 250) : 16;
    this._lastFrameNow = now;

    let wireValues, instanceOutputs;

    if (!circuitHasActiveClock(this.circuit.components)) {
      // Keine aktive (hz>0) Clock irgendwo in der Schaltung, weder direkt platziert noch
      // in einer verschachtelten Komponente -> nichts hier hängt von feiner zeitlicher
      // Auflösung ab, ein einziger settleCircuit()-Aufruf pro Frame reicht vollkommen.
      //
      // Vorher wurde HIER BEDINGUNGSLOS IMMER mit der vollen 1000x-Zeitraffer-Maschinerie
      // simuliert (bis zu maxSubStepsPerFrame=20000 Sub-Schritte, jeder davon ein
      // vollständiger settleCircuit()-Durchlauf mit bis zu 48 internen Iterationen) - rein
      // vorsorglich, für den Fall, dass irgendwo ein hochfrequenter Takt stecken könnte.
      // Selbst eine Schaltung aus nur einem Schalter und einem Gatter (kein Takt weit und
      // breit) wurde dadurch JEDEN Frame bis zu ~20000 * 48 ≈ 960.000-mal ausgewertet - das
      // war die Hauptursache für das massive Ruckeln auch bei einfachen Schaltungen.
      this.simTime += realDeltaMs;
      ({ wireValues, instanceOutputs } = settleCircuit(this.circuit, { now: this.simTime }));
    } else {
      // Es gibt (mindestens) einen echten, laufenden Taktgeber - dessen Impulse dürfen
      // nicht "verschluckt" werden, auch wenn er viel schneller tickt als der Bildschirm
      // Frames liefert. Dafür weiterhin Sub-Schritte in virtueller Zeit, aber mit einer
      // an die tatsächlich vorhandenen Taktfrequenzen ANGEPASSTEN Schrittweite statt einer
      // fest verdrahteten 1µs-Auflösung: eine einzelne 1-Hz-Clock braucht pro Frame vielleicht
      // 1-2 Auswertungen, kein 1µs-Rasterung über die vollen ~16ms - genau das zwang vorher
      // JEDE aktive Clock (egal wie langsam) auf ~16000 volle settleCircuit()-Durchläufe pro
      // Frame, was das Zeitbudget unten sprengte und die Simulation dauerhaft hinter der
      // Wanduhr zurückfallen ließ (eine 1-Hz-Clock blinkte dadurch nur noch alle paar
      // Sekunden), UND weil dabei trotzdem in winzigen Schritten durch ein einzelnes,
      // deutlich breiteres Blinken (z.B. 1ms Pulsdauer) hindurchgetreten wurde, sah alles
      // Nachgeschaltete (Zähler etc.) für ein sichtbares Blinken tausende separate
      // settleCircuit()-Aufrufe statt einer einzelnen sauberen Flanke.
      const features = collectActiveClockFeatures(this.circuit.components);
      // Obergrenze für die Schrittweite: höchstens halb so breit wie das schmalste
      // vorhandene Feature (Puls oder Gegen-Puls), damit auch der schmalste Puls
      // garantiert mindestens einmal getroffen wird, egal wie niedrig die Grundfrequenz ist.
      const neededRes = features.length ? Math.min(...features) / 2 : this.simStepMs;
      // Untergrenze für die Schrittweite: genug, um den maxSubStepsPerFrame-Deckel
      // einzuhalten, falls neededRes bei hoher Taktfrequenz + großem simDeltaMs (z.B. nach
      // einer Zeitbudget-Unterbrechung im vorigen Frame) zu viele Schritte verlangen würde -
      // in dem Fall wird die Auflösung kontrolliert vergröbert (graceful degradation) statt
      // die Schleife beliebig lang laufen zu lassen.
      const simDeltaMs = realDeltaMs * this.simSpeed + this._simDebtMs;
      const capStep = simDeltaMs / this.maxSubStepsPerFrame;
      const stepMs = Math.max(this.simStepMs, neededRes, capStep);
      let remaining = simDeltaMs;
      wireValues = this.wireValues;
      instanceOutputs = this.instanceOutputs;

      // Zeitbudget als Sicherheitsnetz: auch mit einem echten (u.U. sehr hochfrequenten)
      // Takt darf ein einzelner Frame nicht beliebig lange rechnen, sonst friert bei einer
      // großen Schaltung + hoher Taktfrequenz trotzdem die UI ein. Wird das Budget
      // aufgebraucht, bricht die Schleife ab; die noch nicht verarbeitete virtuelle Zeit
      // wird als `_simDebtMs` für den nächsten Frame vorgemerkt statt verworfen, damit die
      // Simulation über mehrere Frames hinweg wieder zur Echtzeit aufschließt statt
      // dauerhaft mit reduzierter Geschwindigkeit weiterzulaufen.
      const budgetDeadline = performance.now() + 8;
      let iters = 0;
      while (remaining > 0) {
        // Der letzte Schritt eines Frames wird auf `remaining` gekappt: stepMs kann bei
        // einer niederfrequenten Clock (großes neededRes, z.B. 250ms bei einer 1-Hz-Clock
        // mit 50% Tastgrad) durchaus größer sein als das, was diesen Frame an virtueller
        // Zeit tatsächlich "zusteht" (simDeltaMs, typischerweise ~16ms) - ohne diese
        // Kappung würde simTime in einem einzigen Sprung weiter vorrücken, als seit dem
        // letzten Frame real Zeit vergangen ist, und die Clock liefe zu schnell statt zu
        // langsam.
        const s = Math.min(stepMs, remaining);
        this.simTime += s;
        remaining -= s;
        ({ wireValues, instanceOutputs } = settleCircuit(this.circuit, { now: this.simTime }));
        iters++;
        if ((iters & 63) === 0 && performance.now() > budgetDeadline) break;
      }
      this._simDebtMs = Math.min(Math.max(remaining, 0), this._maxSimDebtMs);
    }

    this.wireValues = wireValues;
    this.instanceOutputs = instanceOutputs;
    this._draw();
    this._updateStatusBar();
    requestAnimationFrame((t) => this._frame(t));
  }

  // Simulationsgeschwindigkeit einstellen: `speed` ist der Faktor "virtuelle ms
  // Simulationszeit pro 1 ms Echtzeit" (1 = Echtzeit, 1000 = 1000x schneller). Für einen
  // Taktgeber mit Periode P (in seiner eigenen Zeiteinheit passend zu `now`) heißt das
  // effektiv: die Taktfrequenz, die er "sieht", wird mit `speed` multipliziert.
  setSimSpeed(speed) {
    this.simSpeed = Math.max(1, speed);
  }

  _draw() {
    const ctx = this.ctx;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    render(ctx, this._cssW, this._cssH, {
      camera: this.camera,
      circuit: this.circuit,
      selection: this.selection,
      wireValues: this.wireValues,
      instanceOutputs: this.instanceOutputs,
      hover: this.hover,
      wireDraft: this.wireDraft,
      marquee: this.marquee,
      time: this.time,
    });
    if (this.placingType) this._drawGhost(ctx);
  }

  _drawGhost(ctx) {
    const def = getComponentType(this.placingType);
    if (!def) return;
    const { x: gx, y: gy } = this._snap(this.lastMouseWorld.x, this.lastMouseWorld.y);
    const { w, h } = def.size(defaultParams(def));
    const tl = worldToScreen(this.camera, gx, gy);
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = 'rgba(94,234,212,0.08)';
    ctx.strokeStyle = def.color || COLORS.teal;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.4;
    ctx.fillRect(tl.x, tl.y, w * GRID * this.camera.zoom, h * GRID * this.camera.zoom);
    ctx.strokeRect(tl.x, tl.y, w * GRID * this.camera.zoom, h * GRID * this.camera.zoom);
    ctx.restore();
  }

  _snap(x, y) { return { x: Math.round(x), y: Math.round(y) }; }

  // Rastet einen Weltpunkt fürs Kabelziehen ein: liegt er nah an einem der
  // übergebenen Pins, wird dessen EXAKTE (ggf. nicht-ganzzahlige) Position
  // übernommen. Sonst wird pro Achse einzeln entschieden: liegt die Achse nah
  // an einem Pin, wird dessen exakter Wert für diese Achse genommen (kein
  // Runden -> keine Schräglinie), sonst normal aufs Gitter gerundet.
  _snapForWire(wx, wy, refPins = []) {
    const pinTol = PIN_HIT_PX / (GRID * this.camera.zoom);
    for (const p of refPins) {
      if (p && Math.hypot(wx - p.x, wy - p.y) <= pinTol) return { x: p.x, y: p.y };
    }
    let sx = Math.round(wx), sy = Math.round(wy);
    for (const p of refPins) {
      if (!p) continue;
      if (Math.abs(wx - p.x) <= pinTol) sx = p.x;
      if (Math.abs(wy - p.y) <= pinTol) sy = p.y;
    }
    return { x: sx, y: sy };
  }

  // ---------------------------------------------------------------- hit testing

  _findPinAt(wx, wy) {
    const threshold = PIN_HIT_PX / (GRID * this.camera.zoom);
    for (let i = this.circuit.components.length - 1; i >= 0; i--) {
      const inst = this.circuit.components[i];
      const layout = computeLayout(inst);
      for (const pin of layout.pins) {
        const pos = layout.positions.get(pin.id);
        const px = inst.x + pos.x, py = inst.y + pos.y;
        if (Math.hypot(wx - px, wy - py) <= threshold) {
          return { inst, pin, x: px, y: py };
        }
      }
    }
    return null;
  }

  _findComponentAt(wx, wy) {
    for (let i = this.circuit.components.length - 1; i >= 0; i--) {
      const inst = this.circuit.components[i];
      if (pointInInstance(inst, wx, wy)) return inst;
    }
    return null;
  }

  _findWireAt(wx, wy) {
    const threshold = WIRE_HIT_PX / (GRID * this.camera.zoom);
    for (let i = this.circuit.wires.length - 1; i >= 0; i--) {
      const wire = this.circuit.wires[i];
      const path = wirePath(this.circuit, wire);
      if (!path) continue;
      for (let j = 0; j < path.length - 1; j++) {
        if (pointToSegDist(wx, wy, path[j].x, path[j].y, path[j + 1].x, path[j + 1].y) <= threshold) {
          const dx = path[j + 1].x - path[j].x;
          const dy = path[j + 1].y - path[j].y;
          const segDir = Math.abs(dy) <= Math.abs(dx) ? 'h' : 'v';
          return { wire, segIndex: j, segDir };
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- events

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    window.addEventListener('pointermove', (e) => this._onPointerMove(e));
    window.addEventListener('pointerup', (e) => this._onPointerUp(e));
    // iOS fires `pointercancel` instead of `pointerup` for some system gestures
    // (e.g. the fingers involved get reinterpreted by the OS) - treat it the same
    // as a pointer going up so pinch state / drags / long-press timers don't get stuck.
    window.addEventListener('pointercancel', (e) => this._onPointerUp(e, true));
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => this._onContextMenu(e));
    c.addEventListener('dblclick', (e) => this._onDblClick(e));

    // Pinch-Zoom + Zwei-Finger-Pan: komplett über native TouchEvents (siehe Kommentar beim
    // Konstruktor / _onTouchStart / _onTouchMove / _onTouchEnd) statt über Pointer-Events -
    // die liefern auf iOS Safari für gleichzeitige Multi-Touch-Gesten zuverlässigere,
    // synchron zueinander gültige Fingerpositionen.
    c.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: false });
    c.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
    c.addEventListener('touchend', (e) => this._onTouchEnd(e), { passive: false });
    c.addEventListener('touchcancel', (e) => this._onTouchEnd(e, true), { passive: false });

    window.addEventListener('keydown', (e) => this._onKeyDown(e));
    window.addEventListener('keyup', (e) => this._onKeyUp(e));
    window.addEventListener('beforeunload', () => this._autosave());
  }

  _screenPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _onContextMenu(e) {
    e.preventDefault();
    // Rechtsklick während des Kabelziehens bricht den Entwurf ab (kein loses Kabel möglich).
    if (this.wireDraft) {
      this.wireDraft = null;
      this.canvas.classList.remove('mode-wiring');
      return;
    }
    // Ansonsten: Rechtsklick auf ein Bauteil öffnet dessen Parameter (Desktop-Äquivalent
    // zum Lang-Drücken / Zwei-Finger-Tippen auf Touch-Geräten, siehe _openParamsAt).
    const sp = this._screenPos(e);
    const wp = screenToWorld(this.camera, sp.x, sp.y);
    this._openParamsAt(wp);
  }

  // ---------------------------------------------------------------- component parameters dialog

  // Öffnet die Parameter eines Bauteils in einem Dialog. `instMaybe` überspringt die
  // Trefferprüfung (z.B. wenn der Aufrufer das Bauteil bereits kennt, etwa bei
  // Lang-Drücken/Zwei-Finger-Tippen, wo der Fingerpunkt beim Öffnen ungenau sein kann).
  _openParamsAt(wp, instMaybe) {
    const inst = instMaybe || (wp && this._findComponentAt(wp.x, wp.y));
    if (!inst) return;
    const def = getComponentType(inst.type);
    if (!def) return;
    this.selection = new Set([inst.id]);
    this.refreshPanels();
    this._openParamsDialog(inst, def);
  }

  async _openParamsDialog(inst, def) {
    const schema = def.paramsSchema || [];
    if (!schema.length) {
      toast(`„${inst.label || def.label}“ hat keine einstellbaren Parameter`, 'info');
      return;
    }
    const fields = schema.map((s) => {
      const value = inst.params?.[s.key] ?? s.default;
      if (s.kind === 'select') return { key: s.key, label: s.label, type: 'select', value, options: s.options };
      if (s.kind === 'bool') return { key: s.key, label: s.label, type: 'checkbox', value };
      if (s.kind === 'int') return { key: s.key, label: s.label, type: 'number', value, min: s.min, max: s.max, step: s.step ?? 1 };
      return { key: s.key, label: s.label, type: 'text', value };
    });
    const result = await showDialog({ title: `${inst.label || def.label} – Parameter`, fields, submitLabel: 'Übernehmen' });
    if (!result) return;
    const newParams = { ...inst.params };
    for (const s of schema) {
      if (!Object.prototype.hasOwnProperty.call(result, s.key)) continue;
      let v = result[s.key];
      if (s.kind === 'int') v = Math.max(s.min ?? -Infinity, Math.min(s.max ?? Infinity, parseInt(v, 10) || 0));
      if (s.kind === 'bool') v = !!v;
      newParams[s.key] = v;
    }
    inst.params = newParams;
    this.pushHistory();
    this.refreshPanels();
  }

  _clearLongPressTimer() {
    if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; }
  }

  _onPointerDown(e) {
    const sp = this._screenPos(e);
    const wp = screenToWorld(this.camera, sp.x, sp.y);
    this.lastMouseWorld = wp;

    // Zweiter (oder weiterer) Finger: die eigentliche Pinch/Pan-Berechnung passiert komplett
    // in _onTouchStart/_onTouchMove (native TouchEvents, siehe Kommentar im Konstruktor).
    // Hier wird nur mitgezählt, wie viele Finger aktiv sind, damit eine schon laufende
    // Ein-Finger-Geste (Drag/Marquee/Kabel-Entwurf) sofort abgebrochen wird, sobald ein
    // zweiter Finger dazukommt - unabhängig davon, in welcher Reihenfolge touchstart und
    // pointerdown für diesen zweiten Finger feuern.
    if (e.pointerType === 'touch') {
      this._activeTouchIds.add(e.pointerId);
      if (this._activeTouchIds.size >= 2 || this._pinch) {
        this._clearLongPressTimer();
        this.drag = null;
        this.marquee = null;
        if (this.wireDraft) {
          this.wireDraft = null;
          this.canvas.classList.remove('mode-wiring');
        }
        return;
      }
    }

    // middle-mouse or space-drag => pan
    if (e.button === 1 || (e.button === 0 && this.keys.space)) {
      this.drag = { kind: 'pan', lastX: sp.x, lastY: sp.y };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.classList.add('mode-panning');
      return;
    }
    if (e.button !== 0) return;

    // aktiver Kabel-Entwurf: Klick entscheidet (Verbinden / Eckpunkt setzen / nichts) beim Loslassen,
    // hier merken wir uns nur, wo diese Geste beginnt (fürs Unterscheiden Klick vs. Ziehen).
    if (this.wireDraft) {
      this.wireDraft.gestureDownScreen = sp;
      return;
    }

    // placing a new component from the palette
    if (this.placingType) {
      const def = getComponentType(this.placingType);
      if (def) {
        const { x, y } = this._snap(wp.x, wp.y);
        const inst = new ComponentInstance({ type: this.placingType, x, y, params: defaultParams(def), state: def.init ? def.init(defaultParams(def)) : {} });
        this.circuit.addComponent(inst);
        this.selection = new Set([inst.id]);
        this.pushHistory();
        this.refreshPanels();
        if (!e.shiftKey) this._setPlacing(null);
      }
      return;
    }

    // pins first: startet immer einen neuen Kabel-Entwurf, fest am Start-Pin verankert
    const pinHit = this._findPinAt(wp.x, wp.y);
    if (pinHit) {
      this.wireDraft = {
        startInst: pinHit.inst, startPin: pinHit.pin,
        start: { x: pinHit.x, y: pinHit.y },
        corners: [], // nur im Ortho-Modus relevant: manuell gesetzte Zwischenpunkte
        points: [{ x: pinHit.x, y: pinHit.y }, { x: wp.x, y: wp.y }],
        valid: true,
      };
      this.canvas.classList.add('mode-wiring');
      return;
    }

    const compHit = this._findComponentAt(wp.x, wp.y);
    if (compHit) {
      const def = getComponentType(compHit.type);
      const alreadySelected = this.selection.has(compHit.id);
      if (e.shiftKey) {
        if (alreadySelected) this.selection.delete(compHit.id); else this.selection.add(compHit.id);
        this.refreshPanels();
        return;
      }
      if (!alreadySelected) {
        this.selection = new Set([compHit.id]);
        this.refreshPanels();
      }
      // interactive components: BUTTON fires immediately (press semantics)
      // Slider: Klick/Zug auf dem Track setzt den Wert, statt das Bauteil zu verschieben.
      if (def?.onSliderInput) {
        const track = sliderTrackRect(compHit);
        const onTrack = Math.abs(wp.y - track.y) <= 0.5 && wp.x >= track.x0 - 0.3 && wp.x <= track.x1 + 0.3;
        if (onTrack) {
          const t = Math.max(0, Math.min(1, (wp.x - track.x0) / (track.x1 - track.x0)));
          const prevValue = compHit.state?.value;
          compHit.state = def.onSliderInput(compHit.state, compHit.params || {}, t);
          this.drag = { kind: 'slider', inst: compHit, def, track, moved: false, prevValue };
          return;
        }
      }
      if (def?.interactive && def.onPointerDown) {
        const local = { x: wp.x - compHit.x, y: wp.y - compHit.y };
        compHit.state = def.onPointerDown(compHit.state, compHit.params || {}, local);
        this._buttonPressedId = compHit.id;
      }
      const startPositions = new Map();
      for (const id of this.selection) {
        const inst = this.circuit.getComponent(id);
        if (inst) startPositions.set(id, { x: inst.x, y: inst.y });
      }
      // Für jedes Kabel an einem bewegten Bauteil die Ausgangslage merken
      // (Wegpunkte + exakte alte Pin-Positionen), um während des Ziehens
      // absolut statt kumulativ neu rechnen zu können.
      const wireSnapshots = new Map();
      for (const wire of this.circuit.wires) {
        if (!startPositions.has(wire.from.compId) && !startPositions.has(wire.to.compId)) continue;
        const fromInst = this.circuit.getComponent(wire.from.compId);
        const toInst = this.circuit.getComponent(wire.to.compId);
        if (!fromInst || !toInst) continue;
        wireSnapshots.set(wire.id, {
          origPoints: wire.points.map((p) => ({ ...p })),
          oldSrc: pinWorldPos(fromInst, wire.from.pinId),
          oldTgt: pinWorldPos(toInst, wire.to.pinId),
        });
      }
      this.drag = {
        kind: 'move', startScreen: sp, startWorld: wp, moved: false,
        startPositions, wireSnapshots, clickedInst: compHit, clickedDef: def,
      };
      // Auf Touch-Geräten gibt es kein Rechtsklick - Lang-Drücken (ohne zu bewegen)
      // öffnet stattdessen die Parameter des Bauteils.
      if (e.pointerType === 'touch') {
        this._clearLongPressTimer();
        const heldId = compHit.id;
        this._longPressTimer = setTimeout(() => {
          this._longPressTimer = null;
          if (this.drag && this.drag.kind === 'move' && !this.drag.moved && this.drag.clickedInst?.id === heldId) {
            this.drag = null;
            this._openParamsAt(null, compHit);
          }
        }, 500);
      }
      return;
    }

    const wireHit = this._findWireAt(wp.x, wp.y);
    if (wireHit) {
      const { wire, segIndex, segDir } = wireHit;
      if (e.shiftKey) {
        if (this.selection.has(wire.id)) this.selection.delete(wire.id); else this.selection.add(wire.id);
        this.refreshPanels();
      } else {
        if (!this.selection.has(wire.id)) { this.selection = new Set([wire.id]); this.refreshPanels(); }
        // Segmente einzeln verschieben gibt es nur im Ortho-Modus: nur dort existieren
        // überhaupt Zwischenpunkte/Segmente, die unabhängig von den Pins bewegt werden können.
        if (this.orthoMode) {
          this.drag = {
            kind: 'wire-seg', wire, segIndex, segDir,
            startScreen: sp, startWorld: wp, moved: false,
            origPoints: wire.points.map((p) => ({ ...p })),
          };
          this.canvas.setPointerCapture(e.pointerId);
        }
      }
      return;
    }

    // empty canvas: marquee selection
    if (!e.shiftKey) { this.selection = new Set(); this.refreshPanels(); }
    this.marquee = { x0: wp.x, y0: wp.y, x1: wp.x, y1: wp.y };
    this.drag = { kind: 'marquee', additive: e.shiftKey };
  }

  _onPointerMove(e) {
    // Während ein Zwei-Finger-Pinch läuft, treibt ausschließlich _onTouchMove die Kamera an
    // (siehe Kommentar im Konstruktor) - jede normale Ein-Finger-Logik hier wird unterdrückt.
    if (this._pinch) return;

    const sp = this._screenPos(e);
    const wp = screenToWorld(this.camera, sp.x, sp.y);
    this.lastMouseWorld = wp;

    if (this.placingType) { this._updateHint(); return; }

    if (this.wireDraft) {
      const hit = this._findPinAt(wp.x, wp.y);
      let valid = true;
      let endX = wp.x, endY = wp.y;
      if (hit) {
        endX = hit.x; endY = hit.y;
        valid = this._pinsCompatible(this.wireDraft.startInst, this.wireDraft.startPin, hit.inst, hit.pin);
      }
      const start = this.wireDraft.points[0];
      if (this.orthoMode) {
        const lastFixed = this.wireDraft.corners.length
          ? this.wireDraft.corners[this.wireDraft.corners.length - 1]
          : start;
        this.wireDraft.points = [start, ...this.wireDraft.corners, { x: endX, y: lastFixed.y }, { x: endX, y: endY }];
      } else {
        // Nicht-Ortho: immer reine Pin-zu-Pin-Linie, keine Zwischenpunkte
        this.wireDraft.points = [start, { x: endX, y: endY }];
      }
      this.wireDraft.valid = valid;
      return;
    }

    if (this.drag?.kind === 'wire-seg') {
      const dxPx = sp.x - this.drag.startScreen.x, dyPx = sp.y - this.drag.startScreen.y;
      if (!this.drag.moved && Math.hypot(dxPx, dyPx) > MOVE_THRESHOLD_PX) this.drag.moved = true;
      if (this.drag.moved) {
        const { wire, segIndex, segDir, origPoints } = this.drag;
        const path = wirePath(this.circuit, wire);
        if (path) {
          const pinStart = path[0], pinEnd = path[path.length - 1];
          const snapped = this._snapForWire(wp.x, wp.y, [pinStart, pinEnd]);
          const newCoord = segDir === 'h' ? snapped.y : snapped.x;
          wire.points = this._computeDraggedPoints(origPoints, pinStart, pinEnd, segIndex, segDir, newCoord);
        }
      }
      return;
    }
    
    if (this.drag?.kind === 'slider') {
      const { inst, def, track } = this.drag;
      const t = Math.max(0, Math.min(1, (wp.x - track.x0) / (track.x1 - track.x0)));
      inst.state = def.onSliderInput(inst.state, inst.params || {}, t);
      this.drag.moved = true;
      return;
    }

    if (this.drag?.kind === 'move') {
      const dxPx = sp.x - this.drag.startScreen.x, dyPx = sp.y - this.drag.startScreen.y;
      if (!this.drag.moved && Math.hypot(dxPx, dyPx) > MOVE_THRESHOLD_PX) {
        this.drag.moved = true;
        this._clearLongPressTimer();
      }
      if (this.drag.moved) {
        const dx = Math.round(wp.x - this.drag.startWorld.x);
        const dy = Math.round(wp.y - this.drag.startWorld.y);
        for (const [id, start] of this.drag.startPositions) {
          const inst = this.circuit.getComponent(id);
          if (inst) { inst.x = start.x + dx; inst.y = start.y + dy; }
        }
        this._reflowWires(this.drag.startPositions);
      }
      return;
    }

    if (this.drag?.kind === 'pan') {
      const dx = sp.x - this.drag.lastX, dy = sp.y - this.drag.lastY;
      this.camera.panX += dx; this.camera.panY += dy;
      this.drag.lastX = sp.x; this.drag.lastY = sp.y;
      return;
    }

    if (this.drag?.kind === 'marquee') {
      this.marquee.x1 = wp.x; this.marquee.y1 = wp.y;
      return;
    }

    // idle hover detection (nur Tooltip/Cursor, startet KEIN Kabel)
    const pinHit = this._findPinAt(wp.x, wp.y);
    if (pinHit) {
      const bits = pinHit.pin.dir === 'out'
        ? this.instanceOutputs.get(pinHit.inst.id)?.[pinHit.pin.id]
        : (() => { const w = this.circuit.wireInto(pinHit.inst.id, pinHit.pin.id); return w ? this.wireValues.get(w.id) : null; })();
      const typeLabel = getComponentType(pinHit.inst.type)?.label || pinHit.inst.type;
      this.hover = { type: 'pin', sp: worldToScreen(this.camera, pinHit.x, pinHit.y), bits, label: `${pinHit.inst.label || typeLabel}.${pinHit.pin.label || pinHit.pin.id}` };
      this.canvas.style.cursor = 'crosshair';
      return;
    }
    const compHit = this._findComponentAt(wp.x, wp.y);
    if (compHit) {
      this.hover = { type: 'component', id: compHit.id };
      const def = getComponentType(compHit.type);
      let cursor = def?.interactive ? 'pointer' : 'move';
      if (def?.onSliderInput) {
        const track = sliderTrackRect(compHit);
        if (Math.abs(wp.y - track.y) <= 0.5 && wp.x >= track.x0 - 0.3 && wp.x <= track.x1 + 0.3) cursor = 'ew-resize';
      }
      this.canvas.style.cursor = cursor;
      return;
    }
    this.hover = null;
    this.canvas.style.cursor = this.keys.space ? 'grab' : 'default';
  }
  
  
  _onPointerUp(e, isCancel = false) {
    if (e.pointerType === 'touch') {
      this._activeTouchIds.delete(e.pointerId);
      this._clearLongPressTimer();
    }

    // Solange (noch) ein Pinch aktiv ist/war, bekommt dieses Loslassen keine normale
    // Klick-/Drag-Semantik - Release-Erkennung und die "Zwei-Finger-Tippen öffnet
    // Parameter"-Geste laufen komplett über _onTouchEnd (siehe Kommentar im Konstruktor).
    // Ein evtl. verbleibender Finger startet erst bei seinem eigenen nächsten
    // pointerdown wieder eine Ein-Finger-Geste.
    if (this._pinch) return;

    if (isCancel) {
      // System hat die Geste abgebrochen (z.B. iOS-Wischgeste) - laufende Drags/Entwürfe
      // sauber verwerfen statt sie so zu behandeln, als wäre regulär losgelassen worden.
      this.drag = null;
      if (this.wireDraft) {
        this.wireDraft = null;
        this.canvas.classList.remove('mode-wiring');
      }
      this.canvas.classList.remove('mode-panning');
      return;
    }

    const _upSp = this._screenPos(e);
    const _upWp = screenToWorld(this.camera, _upSp.x, _upSp.y);
    if (this.drag?.kind === 'wire-seg') {
      if (this.drag.moved) this.pushHistory();
      this.drag = null;
      return;
    }
    
    if (this.drag?.kind === 'slider') {
      if (this.drag.moved || this.drag.inst.state?.value !== this.drag.prevValue) this.pushHistory();
      this.drag = null;
      return;
    }

    if (this.drag?.kind === 'pan') {
      this.canvas.classList.remove('mode-panning');
      this.drag = null;
      return;
    }

    if (this.wireDraft) {
      const sp = _upSp;
      const wp = _upWp;
      const hit = this._findPinAt(wp.x, wp.y);
      if (hit && this._pinsCompatible(this.wireDraft.startInst, this.wireDraft.startPin, hit.inst, hit.pin)) {
        this._connect(this.wireDraft.startInst, this.wireDraft.startPin, hit.inst, hit.pin, this.wireDraft.corners);
        this.wireDraft = null;
        this.canvas.classList.remove('mode-wiring');
        return;
      }

      const gestureStart = this.wireDraft.gestureDownScreen || sp;
      const movedPx = Math.hypot(sp.x - gestureStart.x, sp.y - gestureStart.y);
      const isFirstSegment = this.wireDraft.corners.length === 0;

      if (movedPx > MOVE_THRESHOLD_PX && isFirstSegment) {
        // echtes Ziehen direkt vom Start-Pin ins Leere -> Kabel verwerfen
        this.wireDraft = null;
        this.canvas.classList.remove('mode-wiring');
        return;
      }

      // Klick (oder Ziehen nach der ersten Ecke) ins Leere -> Eckpunkt setzen
      // Auch hier auf exakte (ggf. nicht-ganzzahlige) Pin-Positionen einrasten,
      // nicht nur beim nachträglichen Verschieben eines Segments.
      const nearPin = this._findPinAt(wp.x, wp.y);
      const refPins = [this.wireDraft.start];
      if (nearPin) refPins.push({ x: nearPin.x, y: nearPin.y });
      const snap = this._snapForWire(wp.x, wp.y, refPins);
      const last = this.wireDraft.corners[this.wireDraft.corners.length - 1] || this.wireDraft.points[0];
      if (Math.hypot(snap.x - last.x, snap.y - last.y) > 0.01) {
        if (this.orthoMode && Math.abs(snap.x - last.x) > 0.01 && Math.abs(snap.y - last.y) > 0.01) {
          this.wireDraft.corners.push({ x: snap.x, y: last.y, auto: true });
        }
        this.wireDraft.corners.push({ x: snap.x, y: snap.y });
      }
      return;
    }

    if (this.drag?.kind === 'move') {
      const def = this.drag.clickedDef;
      const inst = this.drag.clickedInst;
      const local = { x: _upWp.x - inst.x, y: _upWp.y - inst.y };
      if (def?.onPointerUp && this._buttonPressedId === inst.id) {
        inst.state = def.onPointerUp(inst.state, inst.params || {}, local);
      }
      this._buttonPressedId = null;
      if (!this.drag.moved && def?.interactive && def.onActivate) {
        inst.state = def.onActivate(inst.state, inst.params || {}, local);
      }
      if (this.drag.moved) this.pushHistory();
      this.drag = null;
      this.refreshPanels();
      return;
    }

    if (this.drag?.kind === 'marquee') {
      const m = this.marquee;
      const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
      const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
      const picked = new Set(this.drag.additive ? this.selection : []);
      for (const inst of this.circuit.components) {
        const b = instanceBounds(inst);
        if (b.x + b.w >= x0 && b.x <= x1 && b.y + b.h >= y0 && b.y <= y1) picked.add(inst.id);
      }
      for (const w of this.circuit.wires) {
        const path = wirePath(this.circuit, w);
        if (!path) continue;
        if (path.some((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)) picked.add(w.id);
      }
      this.selection = picked;
      this.marquee = null;
      this.drag = null;
      this.refreshPanels();
      return;
    }

    if (this._buttonPressedId) {
      const inst = this.circuit.getComponent(this._buttonPressedId);
      const def = inst && getComponentType(inst.type);
      if (def?.onPointerUp) inst.state = def.onPointerUp(inst.state, inst.params || {});
      this._buttonPressedId = null;
    }
  }

  // ---------------------------------------------------------------- touch (pinch/pan)
  //
  // All two-finger camera control lives here, driven by native TouchEvents rather than
  // Pointer Events - see the long comment in the constructor for why. The key property
  // this relies on: within a single touchmove event, `e.touches` contains every active
  // finger's coordinates sampled at the SAME instant, so reading both pinch fingers out of
  // one event (instead of two independently-arriving pointermove events) can't combine a
  // stale position for one finger with a fresh position for the other.

  _onTouchStart(e) {
    if (e.touches.length < 2) return; // single finger stays on Pointer Events
    e.preventDefault();
    this._clearLongPressTimer();
    this.drag = null;
    this.marquee = null;
    if (this.wireDraft) {
      this.wireDraft = null;
      this.canvas.classList.remove('mode-wiring');
    }

    const t0 = e.touches[0], t1 = e.touches[1];
    const rect = this.canvas.getBoundingClientRect();
    const midScreen = { x: (t0.clientX + t1.clientX) / 2 - rect.left, y: (t0.clientY + t1.clientY) / 2 - rect.top };
    const midWorld = screenToWorld(this.camera, midScreen.x, midScreen.y);
    this._pinch = {
      id0: t0.identifier, id1: t1.identifier,
      startDist: Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY) || 1,
      startZoom: this.camera.zoom,
      startTime: performance.now(),
      startMidScreen: midScreen,
      compAtStart: this._findComponentAt(midWorld.x, midWorld.y),
    };
  }

  _onTouchMove(e) {
    if (!this._pinch) return;
    const touches = Array.from(e.touches);
    const t0 = touches.find((t) => t.identifier === this._pinch.id0);
    const t1 = touches.find((t) => t.identifier === this._pinch.id1);
    if (!t0 || !t1) return; // one of the two pinch fingers already lifted - wait for touchend
    e.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    const mid = { x: (t0.clientX + t1.clientX) / 2 - rect.left, y: (t0.clientY + t1.clientY) / 2 - rect.top };
    const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY) || 1;
    // Weltpunkt, der aktuell (mit der noch alten Kamera) unter dem Fingermittelpunkt liegt -
    // bleibt nach dem Update exakt unter den Fingern (Zoom UND Pan in einem Rutsch).
    const before = screenToWorld(this.camera, mid.x, mid.y);
    const factor = dist / this._pinch.startDist;
    this.camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this._pinch.startZoom * factor));
    this.camera.panX = mid.x - before.x * GRID * this.camera.zoom;
    this.camera.panY = mid.y - before.y * GRID * this.camera.zoom;
  }

  _onTouchEnd(e, isCancel = false) {
    if (!this._pinch) return;
    // The pinch only truly ends once one of its two tracked fingers actually lifts - a
    // third finger touching down or an unrelated finger lifting doesn't count.
    const stillDown = new Set(Array.from(e.touches).map((t) => t.identifier));
    if (stillDown.has(this._pinch.id0) && stillDown.has(this._pinch.id1)) return;

    // Zwei-Finger-Tippen (kurz, kaum Bewegung, kaum Zoom-Änderung) auf einem Bauteil öffnet
    // dessen Parameter - Ersatz für Rechtsklick auf Touch-Geräten.
    if (!isCancel && this._pinch.compAtStart) {
      const elapsed = performance.now() - this._pinch.startTime;
      const zoomRatio = Math.abs(this.camera.zoom - this._pinch.startZoom) / this._pinch.startZoom;
      const rect = this.canvas.getBoundingClientRect();
      const remaining = Array.from(e.touches)[0];
      let stillEnoughMid = true;
      if (remaining) {
        const curScreen = { x: remaining.clientX - rect.left, y: remaining.clientY - rect.top };
        stillEnoughMid = Math.hypot(curScreen.x - this._pinch.startMidScreen.x, curScreen.y - this._pinch.startMidScreen.y) < 24;
      }
      if (elapsed < 350 && zoomRatio < 0.06 && stillEnoughMid) {
        this._openParamsAt(null, this._pinch.compAtStart);
      }
    }
    this._pinch = null;
  }

  _pinsCompatible(instA, pinA, instB, pinB) {
    if (instA.id === instB.id && pinA.id === pinB.id) return false;
    if (pinA.dir === pinB.dir) return false;
    if ((pinA.width ?? 1) !== (pinB.width ?? 1)) return false;
    return true;
  }

  // Erstellt das endgültige Wire-Objekt. corners sind ausschließlich vom Nutzer per Klick
  // gesetzte Zwischenpunkte (nur im Ortho-Modus möglich); im Nicht-Ortho-Modus ist das Array
  // immer leer, wodurch garantiert eine reine Pin-zu-Pin-Gerade entsteht.
  _connect(instA, pinA, instB, pinB, extraPoints = []) {
    const [srcInst, srcPin, tgtInst, tgtPin] = pinA.dir === 'out' ? [instA, pinA, instB, pinB] : [instB, pinB, instA, pinA];
    const existing = this.circuit.wireInto(tgtInst.id, tgtPin.id);
    if (existing) this.circuit.removeWire(existing.id);

    const src = pinWorldPos(srcInst, srcPin.id);
    const tgt = pinWorldPos(tgtInst, tgtPin.id);

    let points;
    if (!this.orthoMode) {
      // Nicht-Ortho: garantiert keine Zwischenpunkte, egal was extraPoints enthält.
      points = [];
    } else {
      let corners = extraPoints.map((p) => ({ ...p }));
      if (pinA.dir !== 'out') corners = corners.reverse();

      // Auch ganz ohne manuell gesetzte Ecken: liegen Start und Ziel nicht auf einer
      // gemeinsamen Achse, MUSS ein Elbow-Punkt eingefügt werden - Kabel bleiben
      // in Ortho-Modus immer strikt horizontal/vertikal, ohne Ausnahme.
      if (corners.length === 0 && src && tgt &&
          Math.abs(src.x - tgt.x) > 0.01 && Math.abs(src.y - tgt.y) > 0.01) {
        corners = [{ x: tgt.x, y: src.y, auto: true }];
      }
      points = (src && tgt) ? simplifyPoints([src, ...corners, tgt]).slice(1, -1) : corners;
    }

    this.circuit.addWire(new Wire({ from: { compId: srcInst.id, pinId: srcPin.id }, to: { compId: tgtInst.id, pinId: tgtPin.id }, points }));
    this.pushHistory();
  }

  // Verschiebt Zwischenpunkte, die auf derselben Höhe/Breite wie ein bewegtes
  // Pin lagen, um denselben Versatz mit - automatische wie manuell gesetzte
  // Ecken gleichermaßen. Berechnung erfolgt jeden Frame neu ausgehend vom
  // Zustand bei Drag-Beginn (wireSnapshots), damit nichts kumulativ driftet.
  _reflowWires(movedIds) {
    const snapshots = this.drag?.wireSnapshots;
    const TOL = 0.05;
    for (const wire of this.circuit.wires) {
      if (!movedIds.has(wire.from.compId) && !movedIds.has(wire.to.compId)) continue;
      const fromInst = this.circuit.getComponent(wire.from.compId);
      const toInst = this.circuit.getComponent(wire.to.compId);
      if (!fromInst || !toInst) continue;
      const src = pinWorldPos(fromInst, wire.from.pinId);
      const tgt = pinWorldPos(toInst, wire.to.pinId);
      if (!src || !tgt) continue;

      const snap = snapshots?.get(wire.id);

      if (!snap || snap.origPoints.length === 0) {
        if (this.orthoMode && Math.abs(src.x - tgt.x) > 0.01 && Math.abs(src.y - tgt.y) > 0.01) {
          wire.points = [{ x: tgt.x, y: src.y, auto: true }];
        } else if (snap) {
          wire.points = [];
        }
        continue;
      }

      if (!this.orthoMode) continue; // im Nicht-Ortho-Modus keine Zwischenpunkte anfassen

      const dxSrc = src.x - snap.oldSrc.x, dySrc = src.y - snap.oldSrc.y;
      const dxTgt = tgt.x - snap.oldTgt.x, dyTgt = tgt.y - snap.oldTgt.y;

      const shifted = snap.origPoints.map((p) => {
        const np = { ...p };
        if (Math.abs(p.x - snap.oldSrc.x) < TOL) np.x += dxSrc;
        else if (Math.abs(p.x - snap.oldTgt.x) < TOL) np.x += dxTgt;
        if (Math.abs(p.y - snap.oldSrc.y) < TOL) np.y += dySrc;
        else if (Math.abs(p.y - snap.oldTgt.y) < TOL) np.y += dyTgt;
        return np;
      });

      wire.points = simplifyPoints([src, ...shifted, tgt]).slice(1, -1);
    }
  }

  // Recompute waypoints after dragging one segment.
  // origPoints: wire.points snapshot at drag start
  // pinStart/pinEnd: immovable pin world positions
  // segIdx: index of the dragged segment in the FULL path [pinStart, ...origPoints, pinEnd]
  // segDir: 'h' (horizontal segment, drag changes y) | 'v' (vertical, drag changes x)
  // newCoord: snapped target coordinate (y for 'h', x for 'v')
  // Nach der Neuberechnung laufen die Punkte immer durch simplifyPoints, wodurch Punkte,
  // die durch das Verschieben redundant (kollinear zu ihren Nachbarn) geworden sind,
  // automatisch entfernt werden.
  _computeDraggedPoints(origPoints, pinStart, pinEnd, segIdx, segDir, newCoord) {
    const path = [pinStart, ...origPoints.map((p) => ({ ...p })), pinEnd];
    const n = path.length;
    const coord = segDir === 'h' ? 'y' : 'x';
    const otherCoord = segDir === 'h' ? 'x' : 'y';

    const aPin = segIdx === 0;           // path[segIdx] is the immovable start pin
    const bPin = segIdx + 1 === n - 1;  // path[segIdx+1] is the immovable end pin

    // Move the movable endpoint(s) of the dragged segment
    if (!aPin) path[segIdx][coord] = newCoord;
    if (!bPin) path[segIdx + 1][coord] = newCoord;

    // If the segment touches the start pin, insert a bridge waypoint so orthogonality holds
    if (aPin) {
      path.splice(1, 0, { [coord]: newCoord, [otherCoord]: path[0][otherCoord] });
    }
    // If the segment touches the end pin, insert a bridge waypoint before it
    if (bPin) {
      const last = path.length - 1; // recomputed after potential aPin insertion
      path.splice(last, 0, { [coord]: newCoord, [otherCoord]: path[last][otherCoord] });
    }

    return simplifyPoints(path).slice(1, -1); // strip pin endpoints → nur bereinigte, redundanzfreie Wegpunkte
  }

  toggleOrthoMode() {
    this.orthoMode = !this.orthoMode;
    localStorage.setItem('logicforge:orthoMode', this.orthoMode ? '1' : '0');
    this._updateOrthoButton();
    // Ein laufender Kabel-Entwurf wird beim Umschalten verworfen, damit nie ein
    // Entwurf mit inkonsistenten Zwischenpunkten (Ortho <-> Nicht-Ortho) übrig bleibt.
    if (this.wireDraft) {
      this.wireDraft = null;
      this.canvas.classList.remove('mode-wiring');
    }
    toast(this.orthoMode ? 'Ortho-Modus aktiv — Kabel laufen nur waagrecht/senkrecht' : 'Ortho-Modus deaktiviert — nur direkte Pin-zu-Pin-Verbindungen', 'info');
  }

  _updateOrthoButton() {
    const btn = document.getElementById('btn-ortho');
    if (btn) btn.classList.toggle('active', this.orthoMode);
  }

  _onWheel(e) {
    e.preventDefault();
    const sp = this._screenPos(e);
    const before = screenToWorld(this.camera, sp.x, sp.y);
    const factor = Math.exp(-e.deltaY * 0.0012);
    this.camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.camera.zoom * factor));
    this.camera.panX = sp.x - before.x * GRID * this.camera.zoom;
    this.camera.panY = sp.y - before.y * GRID * this.camera.zoom;
  }

  _onDblClick(e) {
    const sp = this._screenPos(e);
    const wp = screenToWorld(this.camera, sp.x, sp.y);
    const inst = this._findComponentAt(wp.x, wp.y);
    if (inst) this.dom.focusLabelField?.(inst.id);
  }

  // Ist genau ein Bauteil ausgewählt und bringt einen `onKeyDown`/`onKeyUp`-Handler mit
  // (z.B. Terminal, Gamepad), bekommt es Tastatureingaben zuerst - vor allen globalen
  // Shortcuts. So kann man z.B. ins ausgewählte Terminal tippen, ohne dass "r" das
  // Bauteil dreht oder "Entf" es löscht. Der Handler gibt `null`/`undefined` zurück,
  // wenn er die Taste nicht kennt - dann greifen die globalen Shortcuts wie gewohnt.
  _focusedInteractiveComponent() {
    if (this.selection.size !== 1) return null;
    const [onlyId] = this.selection;
    const inst = this.circuit.getComponent(onlyId);
    if (!inst) return null;
    const def = getComponentType(inst.type);
    return def ? { inst, def } : null;
  }

  _onKeyDown(e) {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (e.code === 'Space' && !typing) { this.keys.space = true; this.canvas.classList.add('mode-pan'); }
    if (typing) return;

    const focused = this._focusedInteractiveComponent();
    if (focused?.def.onKeyDown) {
      const next = focused.def.onKeyDown(focused.inst.state, focused.inst.params || {}, e);
      if (next) {
        focused.inst.state = next;
        e.preventDefault();
        return;
      }
    }

    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.saveToFile(); return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); this.openFromFile(); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selection = new Set([...this.circuit.components.map((c) => c.id), ...this.circuit.wires.map((w) => w.id)]); this.refreshPanels(); return; }
    if (mod && e.key.toLowerCase() === 'c') { this.copySelection(); return; }
    if (mod && e.key.toLowerCase() === 'v') { this.pasteClipboard(); return; }
    if (e.key === 'Escape') {
      this._setPlacing(null);
      if (this.wireDraft) { this.wireDraft = null; this.canvas.classList.remove('mode-wiring'); }
      this.selection = new Set();
      this.refreshPanels();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { this.deleteSelection(); return; }
    if (e.key.toLowerCase() === 'r') { this.rotateSelection(); return; }
    if (e.key.toLowerCase() === 'o') { this.toggleOrthoMode(); return; }
  }

  _onKeyUp(e) {
    if (e.code === 'Space') { this.keys.space = false; this.canvas.classList.remove('mode-pan'); }
    const focused = this._focusedInteractiveComponent();
    if (focused?.def.onKeyUp) {
      const next = focused.def.onKeyUp(focused.inst.state, focused.inst.params || {}, e);
      if (next) focused.inst.state = next;
    }
  }

  // ---------------------------------------------------------------- actions

  deleteSelection() {
    if (this.selection.size === 0) return;
    for (const id of [...this.selection]) {
      if (this.circuit.getComponent(id)) this.circuit.removeComponent(id);
      else this.circuit.removeWire(id);
    }
    this.selection = new Set();
    this.pushHistory();
    this.refreshPanels();
  }

  rotateSelection() {
    let any = false;
    for (const id of this.selection) {
      const inst = this.circuit.getComponent(id);
      if (inst) { inst.rot = (inst.rot + 1) % 4; any = true; }
    }
    if (any) { this.pushHistory(); this.refreshPanels(); }
  }

  copySelection() {
    const compIds = new Set([...this.selection].filter((id) => this.circuit.getComponent(id)));
    if (!compIds.size) return;
    const tmp = new Circuit();
    for (const id of compIds) tmp.addComponent(this.circuit.getComponent(id).clone());
    for (const w of this.circuit.wires) {
      if (compIds.has(w.from.compId) && compIds.has(w.to.compId)) tmp.addWire(w.clone());
    }
    this.clipboard = JSON.parse(JSON.stringify(tmp.toPlain(), stateReplacer), stateReviver);
    toast(`${compIds.size} Bauteil(e) kopiert`, 'info');
  }

  pasteClipboard() {
    if (!this.clipboard) return;
    const idMap = new Map();
    const newSel = new Set();
    for (const c of this.clipboard.components) {
      const newId = nextId('c');
      idMap.set(c.id, newId);
      const inst = new ComponentInstance({ ...c, id: newId, x: c.x + 2, y: c.y + 2 });
      this.circuit.addComponent(inst);
      newSel.add(newId);
    }
    for (const w of this.clipboard.wires) {
      this.circuit.addWire(new Wire({
        from: { compId: idMap.get(w.from.compId), pinId: w.from.pinId },
        to: { compId: idMap.get(w.to.compId), pinId: w.to.pinId },
        points: [],
      }));
    }
    this.selection = newSel;
    this.pushHistory();
    this.refreshPanels();
  }

  // Wird nach einer Parameteränderung aufgerufen, die Pins verändern kann (z.B. Bitbreite,
  // oder beim Pixel-Display der Farbmodus, der DI von 1 auf 24 Bit umstellt). Entfernt
  // Leitungen, die dadurch nicht mehr passen - sonst bleibt z.B. ein 1-Bit-Switch an einem
  // inzwischen 24 Bit breiten Pin hängen: toInt() liefert dann still `null` (wegen der
  // fehlenden/floatenden restlichen Bits) und Schreibzugriffe verschwinden kommentarlos,
  // ohne dass irgendwo ein Fehler auftaucht.
  pruneInvalidWiresFor(instId) {
    const inst = this.circuit.getComponent(instId);
    const def = inst && getComponentType(inst.type);
    if (!inst || !def) return false;
    const currentPins = new Map(def.pins(inst.params || {}).map((p) => [p.id, p]));
    let removed = false;
    for (const w of [...this.circuit.wires]) {
      const onThis =
        w.from.compId === instId ? { pinId: w.from.pinId, otherId: w.to.compId, otherPinId: w.to.pinId } :
        w.to.compId === instId ? { pinId: w.to.pinId, otherId: w.from.compId, otherPinId: w.from.pinId } :
        null;
      if (!onThis) continue;
      const pin = currentPins.get(onThis.pinId);
      const otherInst = this.circuit.getComponent(onThis.otherId);
      const otherDef = otherInst && getComponentType(otherInst.type);
      const otherPin = otherDef && otherDef.pins(otherInst.params || {}).find((p) => p.id === onThis.otherPinId);
      if (!pin || !otherPin || (pin.width ?? 1) !== (otherPin.width ?? 1)) {
        this.circuit.removeWire(w.id);
        removed = true;
      }
    }
    return removed;
  }

  resetSimulation() {
    resetCircuitState(this.circuit);
    toast('Simulationszustand zurückgesetzt', 'info');
  }

  _setPlacing(type) {
    this.placingType = type;
    this.canvas.classList.toggle('mode-placing', !!type);
    this._updateHint();
    this.dom.renderPalette();
  }

  _updateHint() {
    const hintEl = this.dom.canvasHint;
    if (this.placingType) {
      const def = getComponentType(this.placingType);
      hintEl.textContent = `Platziere „${def?.label || this.placingType}“ — Klick zum Setzen, weiter mit Shift, Esc zum Abbrechen`;
      hintEl.classList.add('visible');
    } else {
      hintEl.classList.remove('visible');
    }
  }

  // ---------------------------------------------------------------- view

  zoomBy(factor) {
    const cx = this._cssW / 2, cy = this._cssH / 2;
    const before = screenToWorld(this.camera, cx, cy);
    this.camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.camera.zoom * factor));
    this.camera.panX = cx - before.x * GRID * this.camera.zoom;
    this.camera.panY = cy - before.y * GRID * this.camera.zoom;
  }

  zoomReset() { this.camera.zoom = 1; }

  zoomFit() {
    if (this.circuit.components.length === 0) { this.camera = { panX: 60, panY: 60, zoom: 1.2 }; return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const inst of this.circuit.components) {
      const b = instanceBounds(inst);
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    const pad = 3;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const zoomX = this._cssW / ((maxX - minX) * GRID);
    const zoomY = this._cssH / ((maxY - minY) * GRID);
    this.camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(zoomX, zoomY)));
    this.camera.panX = -minX * GRID * this.camera.zoom + (this._cssW - (maxX - minX) * GRID * this.camera.zoom) / 2;
    this.camera.panY = -minY * GRID * this.camera.zoom + (this._cssH - (maxY - minY) * GRID * this.camera.zoom) / 2;
  }

  // ---------------------------------------------------------------- file I/O

  async newCircuit() {
    if (this.circuit.components.length && !(await confirmDialog({ title: 'Neue Schaltung', message: 'Aktuelle Schaltung verwerfen und neu beginnen?' }))) return;
    this.setCircuit(new Circuit(), { name: 'Unbenannte Schaltung' });
    toast('Neue Schaltung angelegt', 'info');
  }

  saveToFile() {
    const text = serializeCircuit(this.circuit, this.meta);
    const filename = (this.meta.name || 'schaltung').replace(/[^\w\-]+/g, '_') + '.lgf';
    downloadTextFile(filename, text);
    toast(`Gespeichert als ${filename}`, 'success');
  }

  async openFromFile() {
    try {
      const { text, filename } = await pickTextFile();
      const { circuit, meta } = deserializeCircuit(text);
      this.setCircuit(circuit, meta);
      toast(`„${filename}“ geladen`, 'success');
    } catch (e) {
      if (e?.message) toast('Öffnen fehlgeschlagen: ' + e.message, 'error');
    }
  }

  async importComponent() {
    try {
      const { text } = await pickTextFile();
      importComponentFile(text);
      this.refreshPanels();
      toast('Komponente importiert', 'success');
    } catch (e) {
      if (e?.message) toast('Import fehlgeschlagen: ' + e.message, 'error');
    }
  }

  exportDefinition(defId, name) {
    const text = serializeComponent(defId, { name });
    downloadTextFile((name || 'komponente').replace(/[^\w\-]+/g, '_') + '.lgf', text);
    toast(`„${name}“ exportiert`, 'success');
  }

  // ---------------------------------------------------------------- grouping into a component

  async groupSelectionIntoComponent() {
    const compIds = new Set([...this.selection].filter((id) => this.circuit.getComponent(id)));
    if (compIds.size === 0) { toast('Keine Bauteile ausgewählt', 'error'); return; }

    const sub = new Circuit();
    const idMap = new Map();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of compIds) {
      const inst = this.circuit.getComponent(id);
      const clone = inst.clone();
      sub.addComponent(clone);
      idMap.set(id, clone);
      const b = instanceBounds(inst);
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    for (const w of this.circuit.wires) {
      if (compIds.has(w.from.compId) && compIds.has(w.to.compId)) {
        sub.addWire(new Wire({ from: { ...w.from }, to: { ...w.to }, points: w.points.map((p) => ({ ...p })) }));
      }
    }

    let pinY = 0;
    const outPinFor = new Map();
    const inPinFor = new Map();
    const outerRewires = [];

    for (const w of this.circuit.wires) {
      const fromIn = compIds.has(w.from.compId);
      const toIn = compIds.has(w.to.compId);
      if (fromIn === toIn) continue; // internal (handled above) or unrelated

      if (fromIn) {
        const key = `${w.from.compId}|${w.from.pinId}`;
        let pinOut = outPinFor.get(key);
        if (!pinOut) {
          const srcInst = idMap.get(w.from.compId);
          const srcDef = getComponentType(srcInst.type);
          const srcPin = srcDef.pins(srcInst.params || {}).find((p) => p.id === w.from.pinId);
          pinOut = new ComponentInstance({ type: 'PIN_OUT', x: maxX + 2, y: minY + pinY, params: { name: srcPin?.label || 'OUT', width: srcPin?.width ?? 1 } });
          pinY += 2;
          sub.addComponent(pinOut);
          sub.addWire(new Wire({ from: { ...w.from }, to: { compId: pinOut.id, pinId: 'in0' }, points: [] }));
          outPinFor.set(key, pinOut);
        }
        outerRewires.push({ from: { compId: '__NEW__', pinId: pinOut.id }, to: { ...w.to } });
      } else {
        const key = `${w.to.compId}|${w.to.pinId}`;
        let pinIn = inPinFor.get(key);
        if (!pinIn) {
          const tgtInst = idMap.get(w.to.compId);
          const tgtDef = getComponentType(tgtInst.type);
          const tgtPin = tgtDef.pins(tgtInst.params || {}).find((p) => p.id === w.to.pinId);
          pinIn = new ComponentInstance({ type: 'PIN_IN', x: minX - 4, y: minY + pinY, params: { name: tgtPin?.label || 'IN', width: tgtPin?.width ?? 1 } });
          pinY += 2;
          sub.addComponent(pinIn);
          sub.addWire(new Wire({ from: { compId: pinIn.id, pinId: 'out' }, to: { ...w.to }, points: [] }));
          inPinFor.set(key, pinIn);
        }
        outerRewires.push({ from: { ...w.from }, to: { compId: '__NEW__', pinId: pinIn.id } });
      }
    }

    const meta = await showDialog({
      title: 'Zu Komponente zusammenfassen',
      fields: [
        { key: 'name', label: 'Name', type: 'text', value: 'MeineKomponente' },
        { key: 'category', label: 'Kategorie', type: 'text', value: 'Meine Komponenten' },
        { key: 'color', label: 'Farbe', type: 'color', value: '#5eead4' },
      ],
      submitLabel: 'Erstellen',
    });
    if (!meta || !meta.name.trim()) return;

    const def = createCompositeDefinition({ name: meta.name.trim(), category: meta.category.trim() || 'Meine Komponenten', color: meta.color, circuit: sub });

    for (const id of compIds) this.circuit.removeComponent(id);
    const newInst = new ComponentInstance({ type: def.id, x: Math.round((minX + maxX) / 2 - 2.5), y: Math.round((minY + maxY) / 2 - 2) });
    this.circuit.addComponent(newInst);
    for (const rw of outerRewires) {
      const from = rw.from.compId === '__NEW__' ? { compId: newInst.id, pinId: rw.from.pinId } : rw.from;
      const to = rw.to.compId === '__NEW__' ? { compId: newInst.id, pinId: rw.to.pinId } : rw.to;
      this.circuit.addWire(new Wire({ from, to, points: [] }));
    }

    this.selection = new Set([newInst.id]);
    this.pushHistory();
    this.refreshPanels();
    toast(`Komponente „${meta.name}“ erstellt (${def.pins.length} Pins)`, 'success');
  }

  async createCodeComponentDialog() {
    const meta = await showDialog({
      title: 'Code-Komponente erstellen',
      wide: true,
      fields: [
        { key: 'name', label: 'Name', type: 'text', value: 'MeinBaustein' },
        { key: 'category', label: 'Kategorie', type: 'text', value: 'Meine Komponenten (Code)' },
        { key: 'color', label: 'Farbe', type: 'color', value: '#c084fc' },
        { key: 'pins', label: 'Pins — ein Pin pro Zeile: name,in|out,breite', type: 'textarea', rows: 4, value: 'A,in,1\nB,in,1\nY,out,1' },
        { key: 'code', label: 'JavaScript (inputs, state, params, helpers)', type: 'textarea', rows: 12, value: DEFAULT_CODE_TEMPLATE },
      ],
      submitLabel: 'Erstellen',
    });
    if (!meta || !meta.name.trim()) return;

    const pins = meta.pins.split('\n').map((l) => l.trim()).filter(Boolean).map((line, i) => {
      const [rawName, rawDir, rawWidth] = line.split(',').map((s) => (s || '').trim());
      const dir = rawDir === 'out' ? 'out' : 'in';
      return { id: (rawName || `p${i}`).replace(/[^\w]+/g, '_'), label: rawName || `P${i}`, dir, width: Math.max(1, parseInt(rawWidth, 10) || 1), order: i };
    });
    if (!pins.length || !pins.some((p) => p.dir === 'out')) {
      toast('Mindestens ein Ausgang (out) wird benötigt', 'error');
      return;
    }

    createCodeDefinition({ name: meta.name.trim(), category: meta.category.trim() || 'Meine Komponenten (Code)', color: meta.color, code: meta.code, pins });
    this.refreshPanels();
    toast(`Code-Komponente „${meta.name}“ erstellt`, 'success');
  }

  async deleteDefinition(defId, name) {
    const ok = await confirmDialog({ title: 'Komponente löschen', message: `„${name}“ endgültig aus der Bibliothek löschen? Platzierte Instanzen bleiben als fehlender Typ erhalten.`, danger: true });
    if (!ok) return;
    removeDefinition(defId);
    this.refreshPanels();
    toast(`„${name}“ gelöscht`, 'info');
  }

  // ---------------------------------------------------------------- panel refresh (wired up from main.js)

  refreshPanels() {
    this.dom.renderPalette();
    this.dom.renderProperties();
    this.dom.renderLibrary();
    this._updateHistoryButtons();
  }

  _updateStatusBar() {
    const d = this.dom;
    d.statusZoom.textContent = Math.round(this.camera.zoom * 100) + '%';
    d.statusCoords.textContent = `x ${Math.round(this.lastMouseWorld.x)}, y ${Math.round(this.lastMouseWorld.y)}`;
    d.statusSelection.textContent = `${this.selection.size} ausgewählt`;
  }
}

export { CATEGORY_ORDER, categorized, listDefinitions };