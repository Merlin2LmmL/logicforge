// "Echte Rechner später"-Peripherie: Bauteile, die über eine Adresse/Daten-Schnittstelle
// wie ein echtes Peripheriegerät angesprochen werden (Terminal, Pixel-Display) sowie ein
// interaktives Eingabegerät (Gamepad) mit mehreren unabhängigen Tastenzonen innerhalb
// eines einzigen Bauteils.
import { registerComponentType } from '../core/registry.js';
import { FLOATING, toInt, fromInt } from '../core/bits.js';

function ctrl(v, fallback) { return v === 1 || v === 0 ? v : fallback; }

// Tastatur-Mapping fürs Gamepad: Pfeiltasten/WASD für die Richtungen, K/L für die
// beiden Aktionstasten (A/B), ","/"." für Select/Start. Mehrere Tasten können
// gleichzeitig gehalten werden (unabhängig von der Zeiger-Bedienung, die nur eine
// aktive Taste kennt), damit sich Diagonalen und Kombis wie am echten Pad tippen lassen.
const GAMEPAD_KEYMAP = {
  arrowup: 'up', w: 'up',
  arrowdown: 'down', s: 'down',
  arrowleft: 'left', a: 'left',
  arrowright: 'right', d: 'right',
  k: 'a',
  l: 'b',
  ',': 'select',
  '.': 'start',
};

// ---------------------------------------------------------------------------------
// Gamepad: ein Bauteil, acht unabhängige Tastenzonen. Layout ist als Anteile der
// Bauteilbreite/-höhe (0..1) definiert, nicht in Pixeln - dieselbe Tabelle wird
// sowohl fürs Hit-Testing (Klick, Weltkoordinaten) als auch fürs Zeichnen
// (Bauteil-lokale Pixel, zentrumsbezogen) verwendet, damit Klickzone und
// Zeichnung nie auseinanderlaufen.
// ---------------------------------------------------------------------------------

export const GAMEPAD_SIZE = { w: 7, h: 5 };

export const GAMEPAD_BUTTONS = {
  up: { cx: 0.20, cy: 0.28, hw: 0.09, hh: 0.13, bit: 0, shape: 'rect' },
  down: { cx: 0.20, cy: 0.66, hw: 0.09, hh: 0.13, bit: 1, shape: 'rect' },
  left: { cx: 0.08, cy: 0.47, hw: 0.09, hh: 0.13, bit: 2, shape: 'rect' },
  right: { cx: 0.32, cy: 0.47, hw: 0.09, hh: 0.13, bit: 3, shape: 'rect' },
  a: { cx: 0.86, cy: 0.34, hw: 0.09, hh: 0.12, bit: 4, shape: 'circle' },
  b: { cx: 0.68, cy: 0.56, hw: 0.09, hh: 0.12, bit: 5, shape: 'circle' },
  select: { cx: 0.45, cy: 0.82, hw: 0.06, hh: 0.06, bit: 6, shape: 'pill' },
  start: { cx: 0.60, cy: 0.82, hw: 0.06, hh: 0.06, bit: 7, shape: 'pill' },
};

export function hitGamepadButton(local) {
  const { w, h } = GAMEPAD_SIZE;
  const fx = local.x / w, fy = local.y / h;
  for (const [key, b] of Object.entries(GAMEPAD_BUTTONS)) {
    if (Math.abs(fx - b.cx) <= b.hw && Math.abs(fy - b.cy) <= b.hh) return key;
  }
  return null;
}

registerComponentType({
  type: 'GAMEPAD',
  category: 'Zubehör',
  label: 'Gamepad',
  color: '#e0e6ec',
  paramsSchema: [],
  pins: () => [{ id: 'out', label: '', dir: 'out', width: 8, side: 'bottom', order: 0 }],
  size: () => ({ w: GAMEPAD_SIZE.w, h: GAMEPAD_SIZE.h }),
  init: () => ({ keys: {}, activeKey: null }),
  interactive: true,
  // Nur eine Taste gleichzeitig per Maus/Touch gedrückt haltbar (ein Zeigegerät = ein
  // Finger/eine Maustaste); die Tastatursteuerung unten ist davon unabhängig und
  // erlaubt beliebig viele gleichzeitig gehaltene Tasten.
  onPointerDown: (state, params, local) => {
    const key = local && hitGamepadButton(local);
    if (!key) return state;
    return { ...state, keys: { ...state.keys, [key]: true }, activeKey: key };
  },
  onPointerUp: (state) => {
    if (!state.activeKey) return state;
    return { ...state, keys: { ...state.keys, [state.activeKey]: false }, activeKey: null };
  },
  // Tastatursteuerung: nur aktiv, während genau dieses Gamepad ausgewählt ist (siehe
  // Editor). Gibt `null` für nicht zugeordnete Tasten zurück, damit globale Shortcuts
  // (z.B. Entf, R zum Drehen) weiterhin funktionieren, wenn man das Bauteil selektiert hat.
  onKeyDown: (state, params, e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    const btn = GAMEPAD_KEYMAP[e.key.toLowerCase()];
    if (!btn) return null;
    return { ...state, keys: { ...state.keys, [btn]: true } };
  },
  onKeyUp: (state, params, e) => {
    const btn = GAMEPAD_KEYMAP[e.key.toLowerCase()];
    if (!btn) return null;
    return { ...state, keys: { ...state.keys, [btn]: false } };
  },
  evaluate: ({ state }) => {
    const k = state.keys || {};
    const bits = new Array(8).fill(0);
    bits[0] = k.up ? 1 : 0;
    bits[1] = k.down ? 1 : 0;
    bits[2] = k.left ? 1 : 0;
    bits[3] = k.right ? 1 : 0;
    bits[4] = k.a ? 1 : 0;
    bits[5] = k.b ? 1 : 0;
    bits[6] = k.select ? 1 : 0;
    bits[7] = k.start ? 1 : 0;
    return { outputs: { out: bits }, state };
  },
  help: {
    summary: 'Interaktiver Controller mit 8 unabhängigen Tasten (D-Pad, A, B, Select, Start), die als 8-Bit-Bus ausgegeben werden.',
    usage: 'Mit der Maus auf die Tasten klicken/halten, ODER das Bauteil per Klick auswählen und die Tastatur benutzen: Pfeiltasten/WASD = D-Pad, K = A, L = B, "," = Select, "." = Start. Solange das Gamepad ausgewählt ist, gehen diese Tasten an das Bauteil statt an globale Editor-Shortcuts. OUT an einen Splitter oder direkt an Bedingungen/Zähler anschließen, um die einzelnen Bits (Bit 0 = Up ... Bit 7 = Start) auszuwerten.',
    pins: { out: 'Bit 0=Up, 1=Down, 2=Left, 3=Right, 4=A, 5=B, 6=Select, 7=Start (1 = gedrückt).' },
  },
});

// ---------------------------------------------------------------------------------
// Terminal: einfache Zeichenkonsole für spätere CPU-Projekte. Schreibt bei jeder
// steigenden Taktflanke (WE=1) den anliegenden Zeichencode in einen Zeilenpuffer.
// LF (10) beginnt eine neue Zeile, BS (8) löscht das letzte Zeichen, alles außerhalb
// des druckbaren ASCII-Bereichs wird als '.' dargestellt statt die Anzeige zu
// verwirren. Läuft der Puffer über `rows` Zeilen, scrollt die älteste Zeile heraus
// (klassisches Terminal-Verhalten), keine Fehlermeldung oder Stillstand.
// ---------------------------------------------------------------------------------

registerComponentType({
  type: 'TERMINAL',
  category: 'Zubehör',
  label: 'Terminal',
  color: '#7cff9e',
  paramsSchema: [
    { key: 'cols', label: 'Spalten', kind: 'int', min: 8, max: 120, step: 1, default: 40 },
    { key: 'rows', label: 'Zeilen', kind: 'int', min: 2, max: 40, step: 1, default: 12 },
  ],
  pins: () => [
    { id: 'data', label: 'D', dir: 'in', width: 8, side: 'left', order: 0 },
    { id: 'we', label: 'WE', dir: 'in', width: 1, side: 'left', order: 1 },
    { id: 'clk', label: '>', dir: 'in', width: 1, side: 'left', order: 2 },
    { id: 'rst', label: 'R', dir: 'in', width: 1, side: 'left', order: 3 },
    { id: 'keyOut', label: 'KEY', dir: 'out', width: 8, side: 'right', order: 0 },
    { id: 'keyStrobe', label: 'KSTB', dir: 'out', width: 1, side: 'right', order: 1 },
  ],
  size: (params) => ({
    w: Math.max(6, Math.min(30, (params.cols ?? 40) * 0.32 + 2)),
    h: Math.max(4, Math.min(22, (params.rows ?? 12) * 0.48 + 2)),
  }),
  init: () => ({ lines: [''], cursorCol: 0, prevClk: 0, pendingKey: 0, strobe: false }),
  interactive: true,
  // Tastatureingabe (Punkt 1: "Schreiben im Terminal"): das Bauteil auswählen und
  // tippen. Jeder Tastendruck landet als ASCII-Code auf KEY, zusammen mit einem
  // einmaligen Puls auf KSTB - das ist die "Schreibrichtung" in die Schaltung hinein
  // (z.B. an eine CPU/ein Register), unabhängig vom bestehenden D/WE/CLK-Eingang, über
  // den die Schaltung umgekehrt auf den Bildschirm schreibt. Ctrl/Alt/Meta-Kombinationen
  // werden durchgelassen, damit z.B. Strg+Z (Undo) weiterhin funktioniert.
  onKeyDown: (state, params, e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    let code = null;
    if (e.key.length === 1) code = e.key.charCodeAt(0);
    else if (e.key === 'Enter') code = 10;
    else if (e.key === 'Backspace') code = 8;
    else if (e.key === 'Tab') code = 9;
    if (code === null) return null;
    return { ...state, pendingKey: code, strobe: true };
  },
  evaluate: ({ inputs, state, params }) => {
    const cols = params.cols ?? 40;
    const rows = params.rows ?? 12;
    let lines = state.lines && state.lines.length ? state.lines : [''];
    let cursorCol = state.cursorCol ?? 0;
    const we = ctrl(inputs.we?.[0], 0);
    const clk = ctrl(inputs.clk?.[0], 0);
    const rst = ctrl(inputs.rst?.[0], 0);
    const rising = state.prevClk === 0 && clk === 1;
    if (rst === 1) {
      lines = [''];
      cursorCol = 0;
    } else if (we === 1 && rising) {
      const code = toInt(inputs.data || new Array(8).fill(FLOATING));
      if (code !== null) {
        lines = lines.slice();
        if (code === 10) {
          lines.push('');
          if (lines.length > rows) lines.shift();
          cursorCol = 0;
        } else if (code === 8) {
          lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1);
          cursorCol = Math.max(0, cursorCol - 1);
        } else {
          const ch = (code >= 32 && code < 127) ? String.fromCharCode(code) : '.';
          let last = lines[lines.length - 1] + ch;
          if (last.length > cols) {
            lines[lines.length - 1] = last.slice(0, cols);
            lines.push(last.slice(cols));
            if (lines.length > rows) lines.shift();
            cursorCol = last.length - cols;
          } else {
            lines[lines.length - 1] = last;
            cursorCol = last.length;
          }
        }
      }
    }
    // keyStrobe pulst genau einen Auswertungsdurchlauf lang (self-clearing), sobald
    // eine Taste gedrückt wurde - danach fällt er von selbst wieder auf 0.
    const keyOut = fromInt(state.pendingKey || 0, 8);
    const keyStrobe = [state.strobe ? 1 : 0];
    return { outputs: { keyOut, keyStrobe }, state: { lines, cursorCol, prevClk: clk, pendingKey: state.pendingKey || 0, strobe: false } };
  },
  help: {
    summary: 'Zeichenkonsole für Textausgabe UND -eingabe: schreibt Zeichen, die per D/WE/CLK ankommen, in einen scrollenden Zeilenpuffer, und liefert per Tastatur getippte Zeichen als eigenen ASCII-Ausgang zurück.',
    usage: 'Ausgabe: DATA (8-Bit-Zeichencode) anlegen, WE=1 setzen und CLK von 0→1 takten - das Zeichen erscheint im Puffer (LF=10 neue Zeile, BS=8 löscht, R=1 leert alles). Eingabe/Schreiben: das Terminal per Klick auswählen und tippen - jede Taste erscheint als Code auf KEY, zusammen mit einem einmaligen Puls auf KSTB (an ein Register/eine CPU als "neues Zeichen verfügbar"-Signal anschließen).',
    pins: {
      data: '8-Bit-Zeichencode, der bei WE=1 + steigender CLK-Flanke geschrieben wird.',
      we: 'Write-Enable: muss 1 sein, damit die steigende CLK-Flanke ein Zeichen übernimmt.',
      clk: 'Takt; steigende Flanke (0→1) löst das Schreiben aus.',
      rst: 'Reset: 1 löscht den gesamten Bildschirminhalt.',
      keyOut: 'ASCII-Code der zuletzt getippten Taste (Tastatureingabe, siehe „Verwendung“).',
      keyStrobe: 'Pulst einmalig auf 1, sobald eine Taste getippt wurde - als Takt/Enable für nachgeschaltete Logik nutzen.',
    },
  },
});

// ---------------------------------------------------------------------------------
// Pixel-Display: adressierter Framebuffer mit einstellbarer Auflösung, ein Pixel
// pro Schreibzugriff (wie ein reales Display-Controller-Interface: Adresse setzen,
// Wert reinschreiben, Takt pulsen). Monochrom oder 24-Bit RGB pro Pixel.
// Feste Bauteilgröße unabhängig von der Auflösung - das Display skaliert intern,
// genau wie ein echter Bildschirm auch nicht mit der Pixeldichte physisch wächst.
// ---------------------------------------------------------------------------------

function pixelCount(params) {
  const cols = Math.max(1, Math.min(64, params.cols ?? 16));
  const rows = Math.max(1, Math.min(64, params.rows ?? 16));
  return { cols, rows, n: cols * rows };
}
function pixelAddrWidth(params) {
  const { n } = pixelCount(params);
  return Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
}

registerComponentType({
  type: 'PIXELDISPLAY',
  category: 'Zubehör',
  label: 'Pixel-Display',
  color: '#e0e6ec',
  paramsSchema: [
    { key: 'cols', label: 'Breite (px)', kind: 'int', min: 1, max: 64, step: 1, default: 16 },
    { key: 'rows', label: 'Höhe (px)', kind: 'int', min: 1, max: 64, step: 1, default: 16 },
    { key: 'mode', label: 'Farbmodus', kind: 'select', options: ['mono', 'rgb'], default: 'mono' },
  ],
  pins: (params) => [
    { id: 'addr', label: 'A', dir: 'in', width: pixelAddrWidth(params), side: 'left', order: 0 },
    { id: 'din', label: 'DI', dir: 'in', width: (params.mode ?? 'mono') === 'rgb' ? 24 : 1, side: 'left', order: 1 },
    { id: 'we', label: 'WE', dir: 'in', width: 1, side: 'left', order: 2 },
    { id: 'clk', label: '>', dir: 'in', width: 1, side: 'left', order: 3 },
    { id: 'rst', label: 'R', dir: 'in', width: 1, side: 'left', order: 4 },
  ],
  size: () => ({ w: 8, h: 8 }),
  init: (params) => ({ fb: new Array(pixelCount(params).n).fill(0), prevClk: 0 }),
  evaluate: ({ inputs, state, params }) => {
    const { cols, rows, n } = pixelCount(params);
    const mode = params.mode ?? 'mono';
    let fb = state.fb;
    if (!fb || fb.length !== n) fb = new Array(n).fill(0);
    const addrWidth = pixelAddrWidth(params);
    const addrBits = inputs.addr || new Array(addrWidth).fill(FLOATING);
    const addr = toInt(addrBits) ?? 0;
    const we = ctrl(inputs.we?.[0], 0);
    const clk = ctrl(inputs.clk?.[0], 0);
    const rst = ctrl(inputs.rst?.[0], 0);
    const rising = state.prevClk === 0 && clk === 1;
    if (rst === 1) {
      fb = new Array(n).fill(0);
    } else if (we === 1 && rising && addr >= 0 && addr < n) {
      const dinWidth = mode === 'rgb' ? 24 : 1;
      const v = toInt(inputs.din || new Array(dinWidth).fill(FLOATING));
      if (v !== null) {
        fb = fb.slice();
        fb[addr] = v;
      }
    }
    return { outputs: {}, state: { fb, prevClk: clk, cols, rows, mode } };
  },
  help: {
    summary: 'Adressierter Framebuffer (mono oder 24-Bit RGB) - ein Pixel pro Schreibzugriff, wie ein echter Display-Controller.',
    usage: 'ADDR auf den gewünschten Pixel-Index setzen (Zeile*Breite + Spalte, 0-basiert), DIN auf den Farbwert (1 Bit mono, oder 24-Bit RGB als 0xRRGGBB), WE=1 und CLK von 0→1 takten, um genau dieses Pixel zu schreiben. Zum Testen z.B. einen Zähler an ADDR und CLK hängen, siehe Anleitung im Chat.',
    pins: {
      addr: 'Pixel-Adresse (Zeile*Breite+Spalte). Breite hängt von Auflösung ab (log2 der Pixelzahl).',
      din: 'Zu schreibender Farbwert: 1 Bit im Mono-Modus, 24 Bit (RRGGBB) im RGB-Modus.',
      we: 'Write-Enable: muss 1 sein, damit die steigende CLK-Flanke das Pixel schreibt.',
      clk: 'Takt; steigende Flanke (0→1) übernimmt DIN an Adresse ADDR.',
      rst: 'Reset: 1 löscht den kompletten Framebuffer (alle Pixel auf 0/schwarz).',
    },
  },
});
