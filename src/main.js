// Einstiegspunkt: registriert alle Bauteiltypen, baut den Editor auf und
// verdrahtet die DOM-Panels (Palette / Eigenschaften / Bibliothek / Toolbar),
// die editor.js über `this.dom.render*()` aufruft.

import './components/index.js'; // Seiteneffekt: registriert alle eingebauten Bauteiltypen
import './style.css';
import { Editor, CATEGORY_ORDER, categorized, listDefinitions } from './ui/editor.js';
import { getComponentType } from './core/registry.js';
import { loadFromStorage } from './core/library.js';
import { deserializeCircuit } from './core/fileformat.js';
import { showDialog, showShortcuts } from './ui/dialog.js';

// Minimale Fallback-Styles für den neuen "Erklärung"-Abschnitt im Eigenschaften-Panel.
// Eigenständig hier injiziert (statt in style.css), da diese Datei hier nicht vorlag -
// bei Bedarf gerne 1:1 nach style.css verschieben und diesen Block entfernen.
(function injectHelpPanelStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .prop-help-summary { opacity: 0.85; font-size: 0.92em; line-height: 1.4; margin: 4px 0 8px; }
    .prop-help-usage { font-size: 0.9em; line-height: 1.4; margin: 0 0 10px; opacity: 0.8; }
    .prop-help-pins { width: 100%; border-collapse: collapse; font-size: 0.82em; }
    .prop-help-pins th, .prop-help-pins td { text-align: left; padding: 3px 6px; border-bottom: 1px solid rgba(255,255,255,0.08); vertical-align: top; }
    .prop-help-pins th { opacity: 0.6; font-weight: 500; }
  `;
  document.head.appendChild(style);
})();

const AUTOSAVE_KEY = 'logicforge:autosave:v1';

// 1) gespeicherte "Meine Komponenten" (aus vorherigen Sitzungen) laden,
//    BEVOR die Palette zum ersten Mal gerendert wird.
loadFromStorage();

// ---------------------------------------------------------------- DOM refs

const dom = {
  canvas: document.getElementById('stage'),
  canvasWrap: document.getElementById('canvas-wrap'),
  canvasHint: document.getElementById('canvas-hint'),
  btnUndo: document.getElementById('btn-undo'),
  btnRedo: document.getElementById('btn-redo'),
  statusZoom: document.getElementById('status-zoom'),
  statusCoords: document.getElementById('status-coords'),
  statusSelection: document.getElementById('status-selection'),
  renderPalette,
  renderProperties,
  renderLibrary,
  focusLabelField,
};

const editor = new Editor(dom);

// 2) letzten Autosave wiederherstellen (falls vorhanden)
try {
  const raw = localStorage.getItem(AUTOSAVE_KEY);
  if (raw) {
    const { circuit, meta } = deserializeCircuit(raw);
    editor.setCircuit(circuit, meta);
  }
} catch (e) {
  console.warn('LogicForge: Autosave konnte nicht geladen werden', e);
}

// ---------------------------------------------------------------- Toolbar

bind('btn-new', () => editor.newCircuit());
bind('btn-open', () => editor.openFromFile());
bind('btn-save', () => editor.saveToFile());
bind('btn-import-component', () => editor.importComponent());
bind('btn-undo', () => editor.undo());
bind('btn-redo', () => editor.redo());
bind('btn-rotate', () => editor.rotateSelection());
bind('btn-delete', () => editor.deleteSelection());
bind('btn-group', () => editor.groupSelectionIntoComponent());
bind('btn-code-component', () => editor.createCodeComponentDialog());
bind('btn-reset-sim', () => editor.resetSimulation());
bind('btn-zoom-out', () => editor.zoomBy(1 / 1.2));
bind('btn-zoom-in', () => editor.zoomBy(1.2));
bind('btn-zoom-reset', () => editor.zoomReset());
bind('btn-zoom-fit', () => editor.zoomFit());
bind('btn-ortho', () => editor.toggleOrthoMode());
bind('canvas-help', () => showShortcuts());

function bind(id, fn) {
  const el = document.getElementById(id);
  if (el) el.onclick = fn;
}

// ---------------------------------------------------------------- Palette

const paletteTabsEl = document.getElementById('palette-tabs');
const paletteBodyEl = document.getElementById('palette-body');
let activeCategory = null;

function renderPalette() {
  const cats = categorized();
  const order = CATEGORY_ORDER.filter((c) => cats.has(c)).concat(
    [...cats.keys()].filter((c) => !CATEGORY_ORDER.includes(c))
  );
  if (!activeCategory || !cats.has(activeCategory)) activeCategory = order[0];

  paletteTabsEl.innerHTML = '';
  for (const cat of order) {
    const btn = document.createElement('button');
    btn.className = 'palette-tab' + (cat === activeCategory ? ' active' : '');
    btn.textContent = cat;
    btn.onclick = () => {
      activeCategory = cat;
      renderPalette();
    };
    paletteTabsEl.appendChild(btn);
  }

  paletteBodyEl.innerHTML = '';
  const defs = (cats.get(activeCategory) || []).slice().sort((a, b) => a.label.localeCompare(b.label));
  if (!defs.length) {
    paletteBodyEl.innerHTML = '<div class="palette-empty">Keine Bauteile in dieser Kategorie.</div>';
    return;
  }
  for (const def of defs) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'palette-item' + (editor.placingType === def.type ? ' placing' : '');
    item.innerHTML =
      `<span class="swatch" style="background:${def.color || '#5eead4'}"></span>` +
      `<span class="pname">${escapeHtml(def.label)}</span>`;
    item.title = 'Klicken zum Platzieren (Shift-Klick zum Anpinnen)';
    item.onclick = () => editor._setPlacing(editor.placingType === def.type ? null : def.type);
    paletteBodyEl.appendChild(item);
  }
}

// ---------------------------------------------------------------- Eigenschaften

const propertiesBodyEl = document.getElementById('properties-body');

function renderProperties() {
  propertiesBodyEl.innerHTML = '';
  const sel = [...editor.selection];

  if (sel.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'prop-empty';
    empty.textContent = 'Nichts ausgewählt. Klicke auf ein Bauteil oder eine Leitung.';
    propertiesBodyEl.appendChild(empty);
    appendStats();
    return;
  }

  if (sel.length > 1) {
    const stats = document.createElement('div');
    stats.className = 'prop-stats';
    stats.innerHTML = `<b>${sel.length}</b> Elemente ausgewählt.`;
    propertiesBodyEl.appendChild(stats);
    const row = document.createElement('div');
    row.className = 'prop-row';
    row.innerHTML = `<button class="btn" id="prop-rotate">Drehen</button><button class="btn danger" id="prop-delete">Löschen</button>`;
    propertiesBodyEl.appendChild(row);
    row.querySelector('#prop-rotate').onclick = () => editor.rotateSelection();
    row.querySelector('#prop-delete').onclick = () => editor.deleteSelection();
    return;
  }

  const id = sel[0];
  const inst = editor.circuit.getComponent(id);
  if (inst) return renderInstanceProperties(inst);
  const wire = editor.circuit.wires.find((w) => w.id === id);
  if (wire) return renderWireProperties();
}

function renderInstanceProperties(inst) {
  const def = getComponentType(inst.type);

  const head = document.createElement('div');
  head.className = 'prop-section';
  head.innerHTML = `<div class="prop-title">${escapeHtml(def?.label || inst.type)}</div>`;
  const labelField = document.createElement('div');
  labelField.className = 'prop-field';
  labelField.innerHTML = `<label>Bezeichnung</label><input type="text" id="prop-label" value="${escapeHtml(inst.label || '')}" />`;
  head.appendChild(labelField);
  propertiesBodyEl.appendChild(head);

  const labelInput = labelField.querySelector('#prop-label');
  labelInput.oninput = () => {
    inst.label = labelInput.value;
  };
  labelInput.onchange = () => editor.pushHistory();

  if (!def) {
    const warn = document.createElement('div');
    warn.className = 'prop-empty';
    warn.textContent = `Unbekannter Bauteiltyp "${inst.type}" (fehlende Komponentendefinition).`;
    propertiesBodyEl.appendChild(warn);
  } else if (def.paramsSchema?.length) {
    const paramSection = document.createElement('div');
    paramSection.className = 'prop-section';
    paramSection.innerHTML = '<div class="prop-title">Parameter</div>';
    for (const schema of def.paramsSchema) {
      const field = document.createElement('div');
      field.className = 'prop-field' + (schema.kind === 'bool' ? ' checkbox' : '');
      const current = inst.params[schema.key] ?? schema.default;
      let inputHtml;
      if (schema.kind === 'select') {
        inputHtml = `<select data-key="${schema.key}">${schema.options
          .map((o) => `<option value="${o}" ${o === current ? 'selected' : ''}>${o}</option>`)
          .join('')}</select>`;
      } else if (schema.kind === 'bool') {
        inputHtml = `<input type="checkbox" data-key="${schema.key}" ${current ? 'checked' : ''} />`;
      } else if (schema.kind === 'text') {
        inputHtml = `<textarea data-key="${schema.key}" rows="3">${escapeHtml(String(current ?? ''))}</textarea>`;
      } else {
        inputHtml = `<input type="number" data-key="${schema.key}" value="${current}" min="${schema.min ?? ''}" max="${schema.max ?? ''}" step="${schema.step ?? 1}" />`;
      }
      field.innerHTML =
        (schema.kind === 'bool' ? inputHtml : '') +
        `<label>${escapeHtml(schema.label)}</label>` +
        (schema.kind === 'bool' ? '' : inputHtml);
      paramSection.appendChild(field);

      const input = field.querySelector(`[data-key="${schema.key}"]`);
      input.onchange = () => {
        let v = input.value;
        if (schema.kind === 'int') {
          v = parseInt(v, 10) || 0;
          if (schema.min !== undefined) v = Math.max(schema.min, v);
          if (schema.max !== undefined) v = Math.min(schema.max, v);
        } else if (schema.kind === 'bool') {
          v = input.checked;
        }
        inst.params = { ...inst.params, [schema.key]: v };
        // Größe/Pins hängen von params ab -> Zustand sauber neu initialisieren
        inst.state = def.init ? def.init(inst.params) : {};
        editor.pushHistory();
        editor.refreshPanels();
      };
    }
    propertiesBodyEl.appendChild(paramSection);
  }

  if (def?.help) {
    propertiesBodyEl.appendChild(renderHelpSection(def, inst));
  }

  const actions = document.createElement('div');
  actions.className = 'prop-section';
  actions.innerHTML = '<div class="prop-title">Aktionen</div>';
  const row = document.createElement('div');
  row.className = 'prop-row';
  row.innerHTML = `<button class="btn" id="prop-rotate">Drehen (R)</button><button class="btn danger" id="prop-delete">Löschen</button>`;
  actions.appendChild(row);
  if (def?.isComposite || def?.isCode) {
    const exportRow = document.createElement('div');
    exportRow.className = 'prop-row';
    exportRow.innerHTML = `<button class="btn full" id="prop-export">Als .lgf exportieren</button>`;
    actions.appendChild(exportRow);
    exportRow.querySelector('#prop-export').onclick = () => editor.exportDefinition(inst.type, def.label);
  }
  propertiesBodyEl.appendChild(actions);
  row.querySelector('#prop-rotate').onclick = () => editor.rotateSelection();
  row.querySelector('#prop-delete').onclick = () => editor.deleteSelection();
}

// Baut den "Erklärung"-Abschnitt im Eigenschaften-Panel: Kurzbeschreibung, Verwendung
// und eine Pin-Tabelle (Richtung + Breite direkt aus den aktuellen Pins des Bauteils,
// Beschreibungstext aus def.help.pins, falls vorhanden).
function renderHelpSection(def, inst) {
  const section = document.createElement('div');
  section.className = 'prop-section prop-help';
  const pins = def.pins(inst.params || {});
  const pinRows = pins.map((p) => {
    const desc = def.help.pins?.[p.id] || '';
    const dirLabel = p.dir === 'in' ? 'Eingang' : 'Ausgang';
    return `<tr><td>${escapeHtml(p.label || p.id)}</td><td>${dirLabel}</td><td>${p.width}</td><td>${escapeHtml(desc)}</td></tr>`;
  }).join('');
  section.innerHTML = `
    <div class="prop-title">Erklärung</div>
    ${def.help.summary ? `<p class="prop-help-summary">${escapeHtml(def.help.summary)}</p>` : ''}
    ${def.help.usage ? `<p class="prop-help-usage"><strong>Verwendung:</strong> ${escapeHtml(def.help.usage)}</p>` : ''}
    ${pins.length ? `
      <table class="prop-help-pins">
        <thead><tr><th>Pin</th><th>Richtung</th><th>Breite</th><th>Beschreibung</th></tr></thead>
        <tbody>${pinRows}</tbody>
      </table>` : ''}
  `;
  return section;
}

function renderWireProperties() {
  const section = document.createElement('div');
  section.className = 'prop-section';
  section.innerHTML = '<div class="prop-title">Leitung</div>';
  const row = document.createElement('div');
  row.className = 'prop-row';
  row.innerHTML = `<button class="btn danger" id="prop-delete-wire">Löschen</button>`;
  section.appendChild(row);
  propertiesBodyEl.appendChild(section);
  row.querySelector('#prop-delete-wire').onclick = () => editor.deleteSelection();
}

function appendStats() {
  const stats = document.createElement('div');
  stats.className = 'prop-stats';
  stats.innerHTML = `Bauteile: <b>${editor.circuit.components.length}</b><br/>Leitungen: <b>${editor.circuit.wires.length}</b>`;
  propertiesBodyEl.appendChild(stats);
}

function focusLabelField(instId) {
  editor.selection = new Set([instId]);
  editor.refreshPanels();
  const input = propertiesBodyEl.querySelector('#prop-label');
  if (input) {
    input.focus();
    input.select();
  }
}

// ---------------------------------------------------------------- Bibliothek

const libraryBodyEl = document.getElementById('library-body');

function renderLibrary() {
  libraryBodyEl.innerHTML = '';
  const defs = listDefinitions();
  if (!defs.length) {
    libraryBodyEl.innerHTML =
      '<div class="lib-empty">Noch keine eigenen Komponenten. Wähle Bauteile aus und klicke „Zu Komponente machen“, oder erstelle eine Code-Komponente.</div>';
    return;
  }
  for (const def of defs) {
    const item = document.createElement('div');
    item.className = 'lib-item';
    item.innerHTML = `
      <div class="lib-item-head">
        <span class="swatch" style="background:${def.color || '#5eead4'}"></span>
        <span class="lname" title="${escapeHtml(def.name)}">${escapeHtml(def.name)}</span>
        <span class="lkind">${def.kind === 'code' ? 'Code' : 'IC'}</span>
      </div>
      <div class="lib-item-actions">
        <button data-act="place">Platzieren</button>
        <button data-act="export">Export</button>
        <button data-act="delete" class="danger">Löschen</button>
      </div>`;
    item.querySelector('[data-act="place"]').onclick = () => editor._setPlacing(def.id);
    item.querySelector('[data-act="export"]').onclick = () => editor.exportDefinition(def.id, def.name);
    item.querySelector('[data-act="delete"]').onclick = () => editor.deleteDefinition(def.id, def.name);
    libraryBodyEl.appendChild(item);
  }
}

// ---------------------------------------------------------------- utils

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

editor.refreshPanels();
