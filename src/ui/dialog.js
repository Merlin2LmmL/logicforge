// Minimal dependency-free modal dialog builder.

export function showDialog({ title, fields = [], submitLabel = 'OK', cancelLabel = 'Abbrechen', wide = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'lf-modal-overlay';
    const box = document.createElement('div');
    box.className = 'lf-modal' + (wide ? ' lf-modal-wide' : '');
    box.innerHTML = `<h3>${escapeHtml(title)}</h3>`;
    const form = document.createElement('form');
    form.className = 'lf-form';

    const inputs = {};
    for (const f of fields) {
      const row = document.createElement('label');
      row.className = 'lf-field';
      row.innerHTML = `<span>${escapeHtml(f.label)}</span>`;
      let input;
      if (f.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = f.rows || 6;
      } else if (f.type === 'select') {
        input = document.createElement('select');
        for (const opt of f.options) {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          input.appendChild(o);
        }
      } else if (f.type === 'color') {
        input = document.createElement('input');
        input.type = 'color';
      } else {
        input = document.createElement('input');
        input.type = f.type || 'text';
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
      }
      input.value = f.value ?? '';
      if (f.placeholder) input.placeholder = f.placeholder;
      row.appendChild(input);
      form.appendChild(row);
      inputs[f.key] = input;
    }

    const actions = document.createElement('div');
    actions.className = 'lf-modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'lf-btn lf-btn-ghost';
    cancelBtn.textContent = cancelLabel;
    const okBtn = document.createElement('button');
    okBtn.type = 'submit';
    okBtn.className = 'lf-btn lf-btn-primary';
    okBtn.textContent = submitLabel;
    actions.append(cancelBtn, okBtn);
    form.appendChild(actions);
    box.appendChild(form);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (result) => { overlay.remove(); resolve(result); };
    cancelBtn.onclick = () => close(null);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    form.onsubmit = (e) => {
      e.preventDefault();
      const result = {};
      for (const key of Object.keys(inputs)) result[key] = inputs[key].value;
      close(result);
    };
    const first = form.querySelector('input,textarea,select');
    if (first) setTimeout(() => first.focus(), 0);
  });
}

export function confirmDialog({ title, message, danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'lf-modal-overlay';
    const box = document.createElement('div');
    box.className = 'lf-modal';
    box.innerHTML = `<h3>${escapeHtml(title)}</h3><p class="lf-modal-msg">${escapeHtml(message)}</p>`;
    const actions = document.createElement('div');
    actions.className = 'lf-modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'lf-btn lf-btn-ghost';
    cancelBtn.textContent = 'Abbrechen';
    const okBtn = document.createElement('button');
    okBtn.className = 'lf-btn ' + (danger ? 'lf-btn-danger' : 'lf-btn-primary');
    okBtn.textContent = 'OK';
    actions.append(cancelBtn, okBtn);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = (r) => { overlay.remove(); resolve(r); };
    cancelBtn.onclick = () => close(false);
    okBtn.onclick = () => close(true);
    overlay.onclick = (e) => { if (e.target === overlay) close(false); };
  });
}

export function toast(msg, kind = 'info') {
  let container = document.getElementById('lf-toasts');
  if (!container) {
    container = document.createElement('div');
    container.id = 'lf-toasts';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `lf-toast lf-toast-${kind}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('lf-toast-out'); setTimeout(() => el.remove(), 300); }, 3200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const SHORTCUTS = [
  ['Strg+Z', 'Rückgängig'],
  ['Strg+Y / Strg+Shift+Z', 'Wiederholen'],
  ['Strg+S', 'Speichern'],
  ['Strg+O', 'Öffnen'],
  ['Strg+A', 'Alles auswählen'],
  ['Strg+C / Strg+V', 'Kopieren / Einfügen'],
  ['R', 'Drehen'],
  ['Entf', 'Löschen'],
  ['O', 'Ortho-Modus umschalten'],
  ['Leertaste + Ziehen', 'Schwenken'],
  ['Mausrad', 'Zoomen'],
  ['Esc', 'Abbrechen'],
];

export function showShortcuts() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'lf-modal-overlay';
    const box = document.createElement('div');
    box.className = 'lf-modal lf-shortcuts-modal';
    box.innerHTML = `
      <h3>Tastenkürzel</h3>
      <dl class="lf-shortcuts">
        ${SHORTCUTS.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}
      </dl>
      <p class="lf-modal-msg">Ortho-Modus: Neue Kabel laufen nur waagrecht/senkrecht. Bei aktivem Ortho-Modus lassen sich einzelne Segmente per Klick+Ziehen verschieben.</p>
      <div class="lf-modal-actions">
        <button class="lf-btn lf-btn-primary" id="lf-shortcuts-close">Schließen</button>
      </div>
      <div class="lf-credit">LogicForge &middot; Merlin Ortner &middot; <a href="mailto:ortnermerlin@gmail.com">ortnermerlin@gmail.com</a></div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); resolve(); };
    box.querySelector('#lf-shortcuts-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
  });
}
