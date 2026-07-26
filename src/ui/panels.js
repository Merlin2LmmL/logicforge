// Ein-/ausklappbare und in der Breite verstellbare Seiten-Panels (Bauteil-Palette links,
// Eigenschaften/Bibliothek rechts).
//
// Rein DOM-/CSS-getrieben und komplett unabhängig vom Editor: die Panel-Breite steuert
// jeweils eine CSS-Variable (--sidebar-left-width / --sidebar-right-width), die die
// entsprechende .sidebar-Regel in style.css konsumiert. Die Canvas-Größe passt sich dabei
// automatisch an - der Editor hat bereits einen ResizeObserver auf #canvas-wrap laufen
// (siehe editor.js `_resizeCanvas`), der jede Breitenänderung der Nachbar-Panels mitbekommt,
// ganz ohne dass dieses Modul den Editor kennen oder importieren müsste.

const LS_KEY = 'logicforge:panels:v1';
const MIN_WIDTH = 160;
const MAX_WIDTH = 480;
const DEFAULTS = {
  left: { width: 220, collapsed: false },
  right: { width: 260, collapsed: false },
};

function loadState() {
  const fallback = { left: { ...DEFAULTS.left }, right: { ...DEFAULTS.right } };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      left: { ...fallback.left, ...(parsed.left || {}) },
      right: { ...fallback.right, ...(parsed.right || {}) },
    };
  } catch (e) {
    return fallback;
  }
}

function saveState(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch (e) {
    // Speicherquota oder privater Modus - Layout funktioniert trotzdem, nur ohne Persistenz.
  }
}

// side: 'left' | 'right'. `edge` bestimmt, von welcher Seite des Workspace aus die
// Zeigerposition in eine Panel-Breite umgerechnet wird (links wächst von links, rechts
// wächst von rechts), `collapseGlyph`/`expandGlyph` zeigen die Pfeilrichtung "zuklappen"
// bzw. "aufklappen" relativ zur Seite an, auf der das Panel sitzt.
function setupSide(side, { workspace, state, cssVar, edge, collapseGlyph, expandGlyph }) {
  const handle = document.getElementById(`sidebar-handle-${side}`);
  const toggleBtn = document.getElementById(`sidebar-toggle-${side}`);
  if (!handle || !toggleBtn) return;

  function apply() {
    const s = state[side];
    workspace.style.setProperty(cssVar, (s.collapsed ? 0 : s.width) + 'px');
    toggleBtn.textContent = s.collapsed ? expandGlyph : collapseGlyph;
    toggleBtn.title = s.collapsed ? 'Panel einblenden' : 'Panel ausblenden';
    handle.classList.toggle('collapsed', s.collapsed);
  }
  apply();

  toggleBtn.onclick = (e) => {
    e.stopPropagation();
    state[side].collapsed = !state[side].collapsed;
    apply();
    saveState(state);
  };

  // Doppelklick auf den Griff setzt die Breite auf den Standardwert zurück - praktisch,
  // falls man sich beim Ziehen "verirrt" hat.
  handle.addEventListener('dblclick', (e) => {
    if (e.target === toggleBtn) return;
    state[side].width = DEFAULTS[side].width;
    if (!state[side].collapsed) workspace.style.setProperty(cssVar, state[side].width + 'px');
    saveState(state);
  });

  let dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target === toggleBtn) return; // Klick auf den Button selbst löst kein Ziehen aus
    if (state[side].collapsed) return;  // eingeklappt: nur der Button reagiert, kein Aufziehen per Drag
    dragging = true;
    handle.classList.add('dragging');
    workspace.classList.add(`dragging-${side}`);
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = workspace.getBoundingClientRect();
    const raw = edge === 'left' ? e.clientX - rect.left : rect.right - e.clientX;
    const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(raw)));
    state[side].width = width;
    workspace.style.setProperty(cssVar, width + 'px');
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    workspace.classList.remove(`dragging-${side}`);
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    saveState(state);
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
}

export function initResizablePanels() {
  const workspace = document.querySelector('.workspace');
  if (!workspace) return;
  const state = loadState();

  setupSide('left', {
    workspace, state,
    cssVar: '--sidebar-left-width',
    edge: 'left',
    collapseGlyph: '‹',
    expandGlyph: '›',
  });
  setupSide('right', {
    workspace, state,
    cssVar: '--sidebar-right-width',
    edge: 'right',
    collapseGlyph: '›',
    expandGlyph: '‹',
  });
}
