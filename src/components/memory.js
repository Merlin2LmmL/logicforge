import { registerComponentType } from '../core/registry.js';
import { fromInt, toInt, FLOATING, CONFLICT } from '../core/bits.js';

function bit1(v) { return v === 1 ? 1 : v === 0 ? 0 : FLOATING; }
// Control pins default to a sane value when left unconnected: enable=on, reset/clock=off.
function ctrl(v, fallback) { return v === 1 || v === 0 ? v : fallback; }

registerComponentType({
  type: 'SRFF',
  category: 'Speicher',
  label: 'SR-Flipflop',
  color: '#f0a35e',
  paramsSchema: [],
  pins: () => [
    { id: 's', label: 'S', dir: 'in', width: 1, side: 'left', order: 0 },
    { id: 'r', label: 'R', dir: 'in', width: 1, side: 'left', order: 1 },
    { id: 'clk', label: '>', dir: 'in', width: 1, side: 'left', order: 2 },
    { id: 'en', label: 'EN', dir: 'in', width: 1, side: 'left', order: 3 },
    { id: 'rst', label: 'R̄', dir: 'in', width: 1, side: 'left', order: 4 },
    { id: 'q', label: 'Q', dir: 'out', width: 1, side: 'right', order: 0 },
    { id: 'nq', label: 'Q̄', dir: 'out', width: 1, side: 'right', order: 1 },
  ],
  size: () => ({ w: 3, h: 4 }),
  init: () => ({ q: 0, prevClk: 0 }),
  // Taktflankengesteuert wie das D-Flipflop (nicht das reine Pegel-Latch), damit es
  // sich in synchronen Schaltungen genauso verhält wie DFF/Register. S=R=1 ist der
  // klassische verbotene Zustand eines SR-Speichers und wird als Konflikt ausgegeben,
  // statt stillschweigend einen der beiden Fälle zu bevorzugen.
  evaluate: ({ inputs, state, callStartState }) => {
    const s = bit1(inputs.s?.[0]);
    const r = bit1(inputs.r?.[0]);
    const clk = ctrl(inputs.clk?.[0], 0);
    const en = ctrl(inputs.en?.[0], 1);
    const rst = ctrl(inputs.rst?.[0], 0);
    let q = state.q ?? 0;
    let conflict = false;
    if (rst === 1) {
      q = 0;
    } else if (en === 1) {
      // Compare against the state from BEFORE this settle() call (frozen for the whole
      // call), not state.prevClk (which is updated every settle iteration). Otherwise a
      // rising edge can be "consumed" in an early iteration before inputs coming from
      // multi-stage combinational logic (e.g. an ENCODER/MUX) have finished propagating,
      // silently latching a stale/floating value. See simulator.js for details.
      const rising = (callStartState ?? state).prevClk === 0 && clk === 1;
      if (rising) {
        const sv = s === 1, rv = r === 1;
        if (sv && rv) conflict = true;
        else if (sv) q = 1;
        else if (rv) q = 0;
      }
    }
    const qOut = conflict ? CONFLICT : q;
    const nqOut = conflict ? CONFLICT : (q ? 0 : 1);
    return { outputs: { q: [qOut], nq: [nqOut] }, state: { q, prevClk: clk } };
  },
  help: {
    summary: 'SR-Flipflop: Set/Reset-Speicher, taktflankengesteuert (wie DFF/Register). S=R=1 ist der klassische verbotene Zustand und wird als Konflikt (X) ausgegeben.',
    usage: 'S=1 setzt Q=1, R=1 setzt Q=0 - übernommen jeweils bei steigender CLK-Flanke, solange EN=1 ist. RST setzt Q sofort (asynchron) auf 0.',
    pins: { s: 'Set: bei steigender Flanke Q auf 1 setzen.', r: 'Reset: bei steigender Flanke Q auf 0 setzen.', clk: 'Takt; steigende Flanke übernimmt S/R.', en: 'Enable: 1/offen = aktiv.', rst: 'Asynchroner Reset: 1 setzt Q sofort auf 0.', q: 'Gespeicherter Zustand.', nq: 'Invertierter Zustand (bzw. X bei S=R=1).' },
  },
});

registerComponentType({
  type: 'JKFF',
  category: 'Speicher',
  label: 'JK-Flipflop',
  color: '#f0a35e',
  paramsSchema: [],
  pins: () => [
    { id: 'j', label: 'J', dir: 'in', width: 1, side: 'left', order: 0 },
    { id: 'k', label: 'K', dir: 'in', width: 1, side: 'left', order: 1 },
    { id: 'clk', label: '>', dir: 'in', width: 1, side: 'left', order: 2 },
    { id: 'en', label: 'EN', dir: 'in', width: 1, side: 'left', order: 3 },
    { id: 'rst', label: 'R', dir: 'in', width: 1, side: 'left', order: 4 },
    { id: 'q', label: 'Q', dir: 'out', width: 1, side: 'right', order: 0 },
    { id: 'nq', label: 'Q̄', dir: 'out', width: 1, side: 'right', order: 1 },
  ],
  size: () => ({ w: 3, h: 4 }),
  init: () => ({ q: 0, prevClk: 0 }),
  // J=K=1 toggelt (der Fall, der beim SR-Flipflop verboten ist) - das ist der ganze
  // Sinn des JK-Typs, deshalb hier kein Konfliktpfad nötig.
  evaluate: ({ inputs, state, callStartState }) => {
    const j = bit1(inputs.j?.[0]);
    const k = bit1(inputs.k?.[0]);
    const clk = ctrl(inputs.clk?.[0], 0);
    const en = ctrl(inputs.en?.[0], 1);
    const rst = ctrl(inputs.rst?.[0], 0);
    let q = state.q ?? 0;
    if (rst === 1) {
      q = 0;
    } else if (en === 1) {
      // See SRFF above: compare against the pre-call snapshot, not the live per-iteration
      // state, so a rising edge isn't consumed before slower combinational inputs settle.
      const rising = (callStartState ?? state).prevClk === 0 && clk === 1;
      if (rising) {
        const jv = j === 1, kv = k === 1;
        if (jv && kv) q = q ? 0 : 1;
        else if (jv) q = 1;
        else if (kv) q = 0;
      }
    }
    return { outputs: { q: [q], nq: [q ? 0 : 1] }, state: { q, prevClk: clk } };
  },
  help: {
    summary: 'JK-Flipflop: wie SRFF, aber J=K=1 toggelt den Zustand statt einen verbotenen Zustand zu erzeugen.',
    usage: 'J=1 setzt Q=1, K=1 setzt Q=0, J=K=1 kippt Q bei jeder steigenden CLK-Flanke um - übernommen jeweils bei steigender Flanke, solange EN=1.',
    pins: { j: 'Set-Eingang.', k: 'Reset-Eingang.', clk: 'Takt; steigende Flanke übernimmt J/K.', en: 'Enable: 1/offen = aktiv.', rst: 'Asynchroner Reset: 1 setzt Q sofort auf 0.', q: 'Gespeicherter Zustand.', nq: 'Invertierter Zustand.' },
  },
});

registerComponentType({
  type: 'DFF',
  category: 'Speicher',
  label: 'D-Flipflop',
  color: '#f0a35e',
  paramsSchema: [],
  pins: () => [
    { id: 'd', label: 'D', dir: 'in', width: 1, side: 'left', order: 0 },
    { id: 'clk', label: '>', dir: 'in', width: 1, side: 'left', order: 1 },
    { id: 'en', label: 'EN', dir: 'in', width: 1, side: 'left', order: 2 },
    { id: 'rst', label: 'R', dir: 'in', width: 1, side: 'left', order: 3 },
    { id: 'q', label: 'Q', dir: 'out', width: 1, side: 'right', order: 0 },
    { id: 'nq', label: 'Q̄', dir: 'out', width: 1, side: 'right', order: 1 },
  ],
  size: () => ({ w: 3, h: 4 }),
  init: () => ({ q: 0, prevClk: 0 }),
  evaluate: ({ inputs, state, callStartState }) => {
    const d = bit1(inputs.d?.[0]);
    const clk = ctrl(inputs.clk?.[0], 0);
    const en = ctrl(inputs.en?.[0], 1);
    const rst = ctrl(inputs.rst?.[0], 0);
    let q = state.q ?? 0;
    if (rst === 1) {
      q = 0;
    } else if (en === 1) {
      // See SRFF above: compare against the pre-call snapshot, not the live per-iteration
      // state, so a rising edge isn't consumed before slower combinational inputs settle.
      const rising = (callStartState ?? state).prevClk === 0 && clk === 1;
      if (rising && (d === 0 || d === 1)) q = d;
    }
    return { outputs: { q: [q], nq: [q ? 0 : 1] }, state: { q, prevClk: clk } };
  },
  help: {
    summary: 'D-Flipflop: übernimmt bei jeder steigenden CLK-Flanke den Wert von D nach Q - der einfachste 1-Bit-Speicherbaustein.',
    usage: 'D anschließen; bei jeder steigenden CLK-Flanke (0→1), solange EN=1, wird Q=D. Grundbaustein für Register, Zähler und Zustandsautomaten.',
    pins: { d: 'Zu übernehmender Wert.', clk: 'Takt; steigende Flanke übernimmt D.', en: 'Enable: 1/offen = aktiv.', rst: 'Asynchroner Reset: 1 setzt Q sofort auf 0.', q: 'Gespeicherter Zustand.', nq: 'Invertierter Zustand.' },
  },
});

registerComponentType({
  type: 'REGISTER',
  category: 'Speicher',
  label: 'Register',
  color: '#f0a35e',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 }],
  pins: (params) => [
    { id: 'd', label: 'D', dir: 'in', width: params.width ?? 8, side: 'left', order: 0 },
    { id: 'clk', label: '>', dir: 'in', width: 1, side: 'left', order: 1 },
    { id: 'en', label: 'EN', dir: 'in', width: 1, side: 'left', order: 2 },
    { id: 'rst', label: 'R', dir: 'in', width: 1, side: 'left', order: 3 },
    { id: 'q', label: 'Q', dir: 'out', width: params.width ?? 8, side: 'right', order: 0 },
  ],
  size: (params) => ({ w: 4, h: Math.max(4, Math.ceil((params.width ?? 8) / 4) + 2) }),
  init: (params) => ({ value: 0, prevClk: 0, width: params.width ?? 8 }),
  evaluate: ({ inputs, state, params, callStartState }) => {
    const width = params.width ?? 8;
    const clk = ctrl(inputs.clk?.[0], 0);
    const en = ctrl(inputs.en?.[0], 1);
    const rst = ctrl(inputs.rst?.[0], 0);
    let value = state.value ?? 0;
    // Compare against the state from BEFORE this settle() call (frozen for the whole call),
    // not state.prevClk (which updates every settle iteration). Otherwise a rising edge can
    // get "consumed" in an early iteration before D has finished propagating through
    // multi-stage combinational logic (e.g. an ENCODER or MUX driving D) - the register then
    // silently latches a stale/floating value and never gets a second chance within this
    // call. See simulator.js for the full explanation.
    const rising = (callStartState ?? state).prevClk === 0 && clk === 1;
    if (rst === 1) {
      value = 0;
    } else if (en === 1 && rising) {
      const dBits = inputs.d || new Array(width).fill(FLOATING);
      const v = toInt(dBits);
      if (v !== null) value = v;
    }
    return { outputs: { q: fromInt(value, width) }, state: { value, prevClk: clk, width } };
  },
  help: {
    summary: 'Register: mehrbreiter D-Flipflop-Block, übernimmt bei jeder steigenden CLK-Flanke den gesamten D-Bus nach Q.',
    usage: 'Bitbreite über Parameter einstellen. D anschließen, bei steigender CLK-Flanke (EN=1) wird der komplette Wert übernommen. Typisch als Akkumulator, Zwischenspeicher oder Pipeline-Stufe.',
    pins: { d: 'Zu übernehmender Wert.', clk: 'Takt; steigende Flanke übernimmt D.', en: 'Enable: 1/offen = aktiv.', rst: 'Reset: 1 setzt Q sofort auf 0.', q: 'Gespeicherter Wert.' },
  },
});

const MAX_ADDR_BITS = 20; // 1M words - genug für "echte" Rechnerprojekte, dicht als Array gehalten

registerComponentType({
  type: 'RAM',
  category: 'Speicher',
  label: 'RAM',
  color: '#f0a35e',
  paramsSchema: [
    { key: 'addrWidth', label: 'Adressbreite', kind: 'int', min: 1, max: MAX_ADDR_BITS, step: 1, default: 4 },
    { key: 'dataWidth', label: 'Datenbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 },
    { key: 'preset', label: 'Inhalt (hex, Leerzeichen-getrennt)', kind: 'text', default: '' },
  ],
  pins: (params) => [
    { id: 'addr', label: 'A', dir: 'in', width: params.addrWidth ?? 4, side: 'left', order: 0 },
    { id: 'din', label: 'DI', dir: 'in', width: params.dataWidth ?? 8, side: 'left', order: 1 },
    { id: 'we', label: 'WE', dir: 'in', width: 1, side: 'left', order: 2 },
    { id: 'clk', label: '>', dir: 'in', width: 1, side: 'left', order: 3 },
    { id: 'ce', label: 'CE', dir: 'in', width: 1, side: 'left', order: 4 },
    { id: 'cs', label: 'CS', dir: 'in', width: 1, side: 'left', order: 5 },
    { id: 'dout', label: 'DO', dir: 'out', width: params.dataWidth ?? 8, side: 'right', order: 0 },
  ],
  size: () => ({ w: 4, h: 7 }),
  init: (params) => ({ mem: presetToMem(params), prevClk: 0 }),
  // CE (Chip Enable) und CS (Chip Select) entsprechen den Pins realer SRAM-Bausteine:
  // beide unbeschaltet -> Baustein aktiv (Rückwärtskompatibilität mit bestehenden
  // Schaltungen ohne diese Pins). Ist einer der beiden 0, tristated der Ausgang und
  // Schreibzugriffe werden ignoriert, so wie beim echten Chip.
  evaluate: ({ inputs, state, params, callStartState }) => {
    const addrWidth = Math.min(params.addrWidth ?? 4, MAX_ADDR_BITS);
    const dataWidth = params.dataWidth ?? 8;
    const size = 2 ** addrWidth;
    let mem = state.mem;
    if (!mem || mem.length !== size) mem = presetToMem(params);
    const addrBits = inputs.addr || new Array(addrWidth).fill(FLOATING);
    const addr = toInt(addrBits) ?? 0;
    const we = ctrl(inputs.we?.[0], 0);
    const clk = ctrl(inputs.clk?.[0], 0);
    const ce = ctrl(inputs.ce?.[0], 1);
    const cs = ctrl(inputs.cs?.[0], 1);
    const enabled = ce === 1 && cs === 1;
    // See REGISTER above: compare against the pre-call snapshot, not the live
    // per-iteration state, so a rising edge isn't consumed before DIN/ADDR (which may come
    // from multi-stage combinational logic) have finished propagating this call.
    const rising = (callStartState ?? state).prevClk === 0 && clk === 1;
    if (we === 1 && rising && enabled) {
      const dinBits = inputs.din || new Array(dataWidth).fill(FLOATING);
      const v = toInt(dinBits);
      if (v !== null) {
        mem = mem.slice();
        mem[addr % size] = v;
      }
    }
    const out = mem[addr % size] ?? 0;
    const dout = enabled ? fromInt(out, dataWidth) : new Array(dataWidth).fill(FLOATING);
    return { outputs: { dout }, state: { mem, prevClk: clk } };
  },
  help: {
    summary: 'RAM: adressierter, beschreib- und lesbarer Speicher (wie ein SRAM-Baustein), Inhalt bleibt bis zum Reset/Neuladen erhalten.',
    usage: 'ADDR anlegen, für Schreibzugriffe DIN setzen, WE=1 und CLK von 0→1 takten. DOUT zeigt jederzeit den Wert an der aktuellen Adresse (solange CE/CS aktiv sind). Optional Startinhalt im Parameter „Inhalt“ als Hex-Werte vorbelegen.',
    pins: {
      addr: 'Adresse.',
      din: 'Zu schreibender Wert (bei WE=1 + steigender Flanke).',
      we: 'Write-Enable: 1 = Schreibzugriff bei steigender CLK-Flanke.',
      clk: 'Takt; steigende Flanke löst das Schreiben aus.',
      ce: 'Chip-Enable: 0 = Baustein inaktiv (DOUT hochohmig, kein Schreiben). Offen/1 = aktiv.',
      cs: 'Chip-Select: wie CE, zweites Freigabesignal für Adressdekodierung.',
      dout: 'Wert an der aktuellen Adresse (hochohmig, wenn CE/CS nicht beide aktiv sind).',
    },
  },
});

// ---------------------------------------------------------------------------------
// ROM: bewusst keine Kopie von RAM ohne Schreibpin, sondern strukturell anders:
//  - rein kombinatorisch, kein Takt (echte (a)synchrone ROM-Chips liefern Daten
//    direkt aus der Adresse, es gibt keine Flanke abzuwarten)
//  - Speicher als Sparse-Map statt dichtem Array, deshalb ist eine sehr große
//    Adressbreite (bis 24 Bit / 16M Worte) ohne Speicherexplosion möglich, auch
//    wenn nur ein kleiner Adressbereich tatsächlich programmiert ist
//  - Inhalt wird als kleines Programm-artiges Textformat eingegeben (Adressmarken
//    "@ADDR" / "ADDR:" plus fortlaufende Hex-Werte, Kommentare mit ; oder #),
//    nicht als ein einziger langer Hex-Blob - realistischer zum Schreiben von
//    Bootcode / Microcode von Hand
//  - konfigurierbarer Füllwert für unprogrammierte Zellen (z.B. eine NOP-Opcode
//    statt still 0)
//  - CE/OE statt WE/CLK, wie am echten ROM-Baustein
// ---------------------------------------------------------------------------------

function parseRomProgram(text) {
  const map = new Map();
  let addr = 0;
  for (const raw of (text || '').split('\n')) {
    const line = raw.split(';')[0].split('#')[0].trim();
    if (!line) continue;
    let rest = line;
    if (line.startsWith('@')) {
      const m = line.match(/^@([0-9a-fA-F]+)\s*(.*)$/);
      if (m) { addr = parseInt(m[1], 16) || 0; rest = m[2]; }
    } else if (line.includes(':')) {
      const idx = line.indexOf(':');
      const a = parseInt(line.slice(0, idx).trim(), 16);
      if (Number.isFinite(a)) { addr = a; rest = line.slice(idx + 1); }
    }
    for (const tok of rest.trim().split(/\s+/).filter(Boolean)) {
      const v = parseInt(tok, 16);
      if (Number.isFinite(v)) map.set(addr, v);
      addr++;
    }
  }
  return map;
}

const ROM_MAX_ADDR_BITS = 24; // Sparse-Map macht das unabhängig vom RAM-Limit vertretbar

registerComponentType({
  type: 'ROM',
  category: 'Speicher',
  label: 'ROM',
  color: '#c98a4a',
  paramsSchema: [
    { key: 'addrWidth', label: 'Adressbreite', kind: 'int', min: 1, max: ROM_MAX_ADDR_BITS, step: 1, default: 8 },
    { key: 'dataWidth', label: 'Datenbreite', kind: 'int', min: 1, max: 64, step: 1, default: 8 },
    { key: 'fill', label: 'Füllwert unprogrammierter Zellen (hex)', kind: 'text', default: '00' },
    {
      key: 'preset',
      label: 'Programm: "@ADDR" bzw. "ADDR:" setzt die Adresse, danach Hex-Werte fortlaufend; ";" oder "#" = Kommentar',
      kind: 'text',
      default: '@0000\n00 01 02 03',
    },
  ],
  pins: (params) => [
    { id: 'addr', label: 'A', dir: 'in', width: params.addrWidth ?? 8, side: 'left', order: 0 },
    { id: 'ce', label: 'CE', dir: 'in', width: 1, side: 'left', order: 1 },
    { id: 'oe', label: 'OE', dir: 'in', width: 1, side: 'left', order: 2 },
    { id: 'dout', label: 'DO', dir: 'out', width: params.dataWidth ?? 8, side: 'right', order: 0 },
  ],
  // Deutlich mehr Grundfläche als RAM: ROM soll als Nachschlagewerk/Programmspeicher
  // tatsächlich benutzbar sein, nicht nur eine Blackbox mit vier Pins.
  size: () => ({ w: 6, h: 8 }),
  init: (params) => ({
    mem: parseRomProgram(params.preset),
    fill: parseInt(params.fill ?? '0', 16) || 0,
    cachedPreset: params.preset,
    cachedFill: params.fill,
  }),
  evaluate: ({ inputs, state, params }) => {
    const addrWidth = Math.min(params.addrWidth ?? 8, ROM_MAX_ADDR_BITS);
    const dataWidth = params.dataWidth ?? 8;
    let mem = state.mem;
    let fill = state.fill;
    // Verteidigung gegen alte Speicherstände (Autosave/.lgf), die VOR dem Map-sicheren
    // Serialisierungs-Fix (model.js/fileformat.js/library.js) angelegt wurden: dort wurde
    // die Map beim Speichern/Laden lautlos zu einem normalen Objekt `{}`, was hier zum
    // Absturz führte ("mem.has is not a function"). Statt zu crashen, wird in dem Fall
    // das Programm einfach neu aus dem Preset geparst.
    if (!(mem instanceof Map)) mem = parseRomProgram(params.preset);
    else if (state.cachedPreset !== params.preset) mem = parseRomProgram(params.preset);
    if (state.cachedFill !== params.fill) fill = parseInt(params.fill ?? '0', 16) || 0;
    const addrBits = inputs.addr || new Array(addrWidth).fill(FLOATING);
    const addr = toInt(addrBits) ?? 0;
    const ce = ctrl(inputs.ce?.[0], 1);
    const oe = ctrl(inputs.oe?.[0], 1);
    const enabled = ce === 1 && oe === 1;
    const value = mem.has(addr) ? mem.get(addr) : fill;
    const dout = enabled ? fromInt(value, dataWidth) : new Array(dataWidth).fill(FLOATING);
    return { outputs: { dout }, state: { mem, fill, cachedPreset: params.preset, cachedFill: params.fill } };
  },
  help: {
    summary: 'ROM: nur lesbarer, fest programmierter Speicher (Programm/Microcode/Nachschlagetabelle). Kein Schreibzugriff über Pins möglich.',
    usage: 'Programm im Parameter „preset“ eintragen: "@ADDR" bzw. "ADDR:" setzt die aktuelle Adresse, danach folgen fortlaufend Hex-Werte; ";" oder "#" leitet einen Kommentar ein. ADDR anlegen, CE=OE=1 (offen reicht), DOUT liefert den gespeicherten Wert (bzw. den Füllwert für unprogrammierte Zellen).',
    pins: {
      addr: 'Adresse.',
      ce: 'Chip-Enable: 0 = Ausgang hochohmig.',
      oe: 'Output-Enable: 0 = Ausgang hochohmig.',
      dout: 'Gespeicherter Wert an ADDR (oder Füllwert, falls dort nichts programmiert wurde).',
    },
  },
});

registerComponentType({
  type: 'COUNTER',
  category: 'Speicher',
  label: 'Zähler',
  color: '#f0a35e',
  paramsSchema: [{ key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 }],
  pins: (params) => [
    { id: 'clk', label: '>', dir: 'in', width: 1, side: 'left', order: 0 },
    { id: 'en', label: 'EN', dir: 'in', width: 1, side: 'left', order: 1 },
    { id: 'rst', label: 'R', dir: 'in', width: 1, side: 'left', order: 2 },
    { id: 'dir', label: 'UP/DN', dir: 'in', width: 1, side: 'left', order: 3 },
    { id: 'q', label: 'Q', dir: 'out', width: params.width ?? 8, side: 'right', order: 0 },
    { id: 'tc', label: 'TC', dir: 'out', width: 1, side: 'right', order: 1 },
  ],
  size: () => ({ w: 4, h: 5 }),
  init: () => ({ value: 0, prevClk: 0 }),
  // TC (Terminal Count) geht auf 1, sobald der Zähler seinen Endwert erreicht -
  // nützlich zum Kaskadieren mehrerer Zähler zu breiteren Zählketten.
  evaluate: ({ inputs, state, params, callStartState }) => {
    const width = params.width ?? 8;
    const max = 2 ** width;
    const clk = ctrl(inputs.clk?.[0], 0);
    const en = ctrl(inputs.en?.[0], 1);
    const rst = ctrl(inputs.rst?.[0], 0);
    const dir = ctrl(inputs.dir?.[0], 1); // 1 = hoch (Standard), 0 = runter
    let value = state.value ?? 0;
    // See REGISTER above: compare against the pre-call snapshot, not the live
    // per-iteration state, so a rising edge isn't consumed before DIR (or any input coming
    // from combinational logic) has finished propagating this call.
    const rising = (callStartState ?? state).prevClk === 0 && clk === 1;
    if (rst === 1) {
      value = 0;
    } else if (en === 1 && rising) {
      value = dir === 1 ? (value + 1) % max : (value - 1 + max) % max;
    }
    const tc = dir === 1 ? (value === max - 1 ? 1 : 0) : (value === 0 ? 1 : 0);
    return { outputs: { q: fromInt(value, width), tc: [tc] }, state: { value, prevClk: clk } };
  },
  help: {
    summary: 'Zähler: erhöht (oder verringert) seinen Wert bei jeder steigenden CLK-Flanke, mit Überlauf/Wrap-around.',
    usage: 'CLK anschließen; DIR bestimmt Zählrichtung (offen/1 = hoch, 0 = runter). TC geht auf 1, sobald der End-/Startwert erreicht ist - praktisch zum Kaskadieren mehrerer Zähler zu breiteren Zählketten.',
    pins: { clk: 'Takt; steigende Flanke zählt.', en: 'Enable: 1/offen = aktiv.', rst: 'Reset: 1 setzt Q sofort auf 0.', dir: '1/offen = aufwärts, 0 = abwärts.', q: 'Aktueller Zählerstand.', tc: 'Terminal Count: 1 bei Endwert (Überlauf/Unterlauf).' },
  },
});

registerComponentType({
  type: 'SHIFTREG',
  category: 'Speicher',
  label: 'Schieberegister',
  color: '#f0a35e',
  paramsSchema: [
    { key: 'width', label: 'Bitbreite', kind: 'int', min: 1, max: 32, step: 1, default: 8 },
    { key: 'direction', label: 'Richtung', kind: 'select', options: ['left', 'right'], default: 'left' },
  ],
  pins: (params) => [
    { id: 'd', label: 'D', dir: 'in', width: params.width ?? 8, side: 'left', order: 0 },
    { id: 'sin', label: 'SIN', dir: 'in', width: 1, side: 'left', order: 1 },
    { id: 'clk', label: '>', dir: 'in', width: 1, side: 'left', order: 2 },
    { id: 'en', label: 'EN', dir: 'in', width: 1, side: 'left', order: 3 },
    { id: 'ld', label: 'LD', dir: 'in', width: 1, side: 'left', order: 4 },
    { id: 'rst', label: 'R', dir: 'in', width: 1, side: 'left', order: 5 },
    { id: 'q', label: 'Q', dir: 'out', width: params.width ?? 8, side: 'right', order: 0 },
    { id: 'sout', label: 'SOUT', dir: 'out', width: 1, side: 'right', order: 1 },
  ],
  size: () => ({ w: 4, h: 6 }),
  init: () => ({ value: 0, prevClk: 0 }),
  evaluate: ({ inputs, state, params, callStartState }) => {
    const width = params.width ?? 8;
    const dir = params.direction ?? 'left';
    const clk = ctrl(inputs.clk?.[0], 0);
    const en = ctrl(inputs.en?.[0], 1);
    const rst = ctrl(inputs.rst?.[0], 0);
    const ld = ctrl(inputs.ld?.[0], 0);
    const sin = ctrl(inputs.sin?.[0], 0);
    let value = state.value ?? 0;
    let soutBit = dir === 'left' ? (value >> (width - 1)) & 1 : value & 1;
    // See REGISTER above: compare against the pre-call snapshot, not the live
    // per-iteration state, so a rising edge isn't consumed before D (which may come from
    // multi-stage combinational logic) has finished propagating this call.
    const rising = (callStartState ?? state).prevClk === 0 && clk === 1;
    const mask = width >= 31 ? 0xFFFFFFFF : (2 ** width - 1);
    if (rst === 1) {
      value = 0;
    } else if (en === 1 && rising) {
      if (ld === 1) {
        const dBits = inputs.d || new Array(width).fill(FLOATING);
        const v = toInt(dBits);
        if (v !== null) value = v;
      } else if (dir === 'left') {
        soutBit = (value >> (width - 1)) & 1;
        value = ((value << 1) | (sin ? 1 : 0)) & mask;
      } else {
        soutBit = value & 1;
        value = ((value >>> 1) | ((sin ? 1 : 0) << (width - 1))) & mask;
      }
    }
    return { outputs: { q: fromInt(value, width), sout: [soutBit] }, state: { value, prevClk: clk } };
  },
  help: {
    summary: 'Schieberegister: schiebt seinen Inhalt bei jeder steigenden CLK-Flanke um 1 Bit (links oder rechts), oder lädt bei LD=1 einen kompletten Wert parallel.',
    usage: 'LD=1 lädt D parallel in Q. LD=0: bei jeder steigenden CLK-Flanke wird um 1 Bit verschoben, SIN wird von der freien Seite eingeschoben, SOUT liefert das herausgeschobene Bit - so lassen sich mehrere Schieberegister zu einer längeren Kette verbinden.',
    pins: { d: 'Parallel zu ladender Wert (bei LD=1).', sin: 'Seriell einzuschiebendes Bit.', clk: 'Takt; steigende Flanke schiebt/lädt.', en: 'Enable: 1/offen = aktiv.', ld: '1 = paralleles Laden von D statt Schieben.', rst: 'Reset: 1 setzt Q sofort auf 0.', q: 'Aktueller Inhalt.', sout: 'Zuletzt herausgeschobenes Bit.' },
  },
});

function presetToMem(params) {
  const addrWidth = Math.min(params.addrWidth ?? 4, MAX_ADDR_BITS);
  const size = 2 ** addrWidth;
  const mem = new Array(size).fill(0);
  const words = (params.preset || '').trim().split(/\s+/).filter(Boolean);
  words.forEach((w, i) => {
    if (i >= size) return;
    const v = parseInt(w, 16);
    mem[i] = Number.isFinite(v) ? v : 0;
  });
  return mem;
}
