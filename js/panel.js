// Ficha lateral de una cuenta: todos los campos (incluidos los personalizados)
// y el historial de notas con autor y fecha.
import {
  state, panelFields, getValue, updateField, deleteAccount,
  notesFor, addNote, updateNote, deleteNote, createAccount,
} from './store.js';
import { getProfile, isAdmin } from './auth.js';
import { writeFailed } from './net.js';
import { escHtml, fmtDateTime, toast, looksLikeDuplicate } from './util.js';

let currentId = null;
let afterChange = () => {};

export function initPanel(onChange) {
  afterChange = onChange || (() => {});
  document.getElementById('panelClose').addEventListener('click', closePanel);
  document.getElementById('panelBackdrop').addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentId && !document.getElementById('dlgNew').open) closePanel();
  });
  initNewDialog();
}

export function closePanel() {
  currentId = null;
  document.getElementById('panel').classList.remove('open');
  document.getElementById('panelBackdrop').hidden = true;
}

function fieldControl(acc, col) {
  const val = col.key === 'owner_id' ? (acc.owner_id || '') : (getValue(acc, col.key) ?? '');
  const id = `f_${col.key.replace('.', '_')}`;

  if (col.type === 'date') {
    return `<input id="${id}" data-f="${escHtml(col.key)}" type="date" value="${escHtml(val)}">`;
  }
  if (col.type === 'select' || col.type === 'catalog' || col.type === 'owner') {
    let opts;
    let blank = '—';
    if (col.type === 'owner') {
      opts = state.profiles.filter((p) => p.is_active).map((p) => [p.id, p.full_name || p.email]);
      // Owner heredado del Excel que todavía no tiene usuario en la app.
      if (!acc.owner_id && acc.owner_name) blank = `${acc.owner_name} (sin usuario)`;
    } else {
      const list = col.type === 'catalog' ? state.catalogs[col.catalog] : (col.options || []);
      opts = list.map((v) => [v, v]);
      if (val && !list.includes(val)) opts.unshift([val, `${val} (fuera de catálogo)`]);
    }
    return `<select id="${id}" data-f="${escHtml(col.key)}">
      <option value="">${escHtml(blank)}</option>
      ${opts.map(([v, l]) => `<option value="${escHtml(v)}"${String(v) === String(val) ? ' selected' : ''}>${escHtml(l)}</option>`).join('')}
    </select>`;
  }
  if (col.type === 'url') {
    return `<input id="${id}" data-f="${escHtml(col.key)}" type="url"
      placeholder="https://app-eu1.hubspot.com/…" value="${escHtml(val)}">`;
  }
  return `<input id="${id}" data-f="${escHtml(col.key)}" type="text" value="${escHtml(val)}">`;
}

// El historial. Lo comparten la ficha completa y el popup de solo notas.
function notesBlockHtml() {
  return `<div class="notes">
      <div class="notes-head">
        <h3>Historial</h3>
        <span class="muted">se guarda con tu nombre y la fecha</span>
      </div>
      <div class="note-new">
        <textarea id="noteBody" rows="3" placeholder="Añadir una entrada…"></textarea>
        <button id="noteAdd" class="btn primary" type="button">Añadir</button>
      </div>
      <div id="noteList" class="note-list"></div>
    </div>`;
}

function noteHtml(n, meId) {
  const mine = n.author_id && n.author_id === meId;
  const canEdit = mine || isAdmin();
  return `<article class="note${n.is_legacy ? ' legacy' : ''}" data-note="${n.id}">
    <header>
      <strong>${escHtml(n.author_name || 'Anónimo')}</strong>
      <span class="note-when">${fmtDateTime(n.created_at)}</span>
      ${n.is_legacy ? '<span class="tag">Importado del Excel</span>' : ''}
      ${canEdit ? `<span class="note-acts">
        <button type="button" data-edit-note>Editar</button>
        <button type="button" data-del-note>Borrar</button></span>` : ''}
    </header>
    <div class="note-body">${escHtml(n.body).replace(/\n/g, '<br>')}</div>
  </article>`;
}

// Ficha de la cuenta: solo sus datos. El historial no se repite aquí — se abre
// desde el botón «Notas» de la tabla, que es su sitio.
export function openPanel(id) {
  const acc = state.byId.get(id);
  if (!acc) return;
  currentId = id;

  const cols = panelFields();
  const body = document.getElementById('panelBody');

  document.getElementById('panelTitle').textContent = acc.name;
  body.classList.remove('solo-notas');
  body.innerHTML = `
    <label class="fld wide"><span>Cuenta</span>
      <input data-f="name" type="text" value="${escHtml(acc.name)}"></label>
    ${cols.map((c) => `<label class="fld${c.type === 'url' ? ' wide' : ''}">
        <span>${escHtml(c.label)}</span>${fieldControl(acc, c)}</label>`).join('')}

    <div class="panel-foot">
      <button id="delAcc" class="btn danger ghost" type="button">Borrar cuenta</button>
    </div>`;

  document.getElementById('panel').classList.add('open');
  document.getElementById('panelBackdrop').hidden = false;

  // Guardado al salir del campo: un cambio por petición, como en la tabla.
  body.querySelectorAll('[data-f]').forEach((el) => {
    el.addEventListener('change', async () => {
      const key = el.dataset.f;
      const next = el.value.trim() === '' ? null : el.value.trim();
      if (key === 'name' && !next) { toast('La cuenta necesita un nombre.', 'err'); el.value = acc.name; return; }
      const { error } = await updateField(id, key, next);
      // A propósito no se restaura el valor anterior en el campo: lo que el
      // usuario escribió se queda a la vista para poder reintentar.
      if (error) { await writeFailed(error, 'guardar'); return; }
      if (key === 'name') document.getElementById('panelTitle').textContent = next;
      afterChange();
    });
  });

  document.getElementById('delAcc').addEventListener('click', async () => {
    if (!confirm(`¿Borrar «${acc.name}» y todo su historial? No se puede deshacer.`)) return;
    const { error } = await deleteAccount(id);
    if (error) { await writeFailed(error, 'borrar'); return; }
    closePanel();
    toast('Cuenta borrada.');
    afterChange();
  });
}

// Popup con ÚNICAMENTE el historial: ni región, ni owner, ni fecha, ni el botón
// de borrar. El título sigue siendo el nombre de la cuenta, que es el mínimo
// para saber de quién son las notas que estás leyendo.
export function openNotes(id) {
  const acc = state.byId.get(id);
  if (!acc) return;
  currentId = id;

  document.getElementById('panelTitle').textContent = acc.name;
  const body = document.getElementById('panelBody');
  body.classList.add('solo-notas');
  body.innerHTML = notesBlockHtml();

  document.getElementById('panel').classList.add('open');
  document.getElementById('panelBackdrop').hidden = false;
  renderNotes(id);
}

function renderNotes(id) {
  // Las notas ya están en memoria desde la carga inicial: no hay espera.
  const notes = notesFor(id);
  const list = document.getElementById('noteList');
  if (!list) return;
  const meId = getProfile()?.id;
  list.innerHTML = notes.length
    ? notes.map((n) => noteHtml(n, meId)).join('')
    : '<p class="muted">Todavía no hay entradas.</p>';

  document.getElementById('noteAdd').onclick = async () => {
    const ta = document.getElementById('noteBody');
    const text = ta.value.trim();
    if (!text) return;
    const { error } = await addNote(id, text, getProfile());
    // El textarea no se vacía si ha fallado: el texto sigue ahí y basta con
    // volver a pulsar «Añadir» cuando se recupere la conexión.
    if (error) { await writeFailed(error, 'guardar la nota'); return; }
    ta.value = '';
    renderNotes(id);
    afterChange();
  };

  list.querySelectorAll('[data-del-note]').forEach((b) => b.addEventListener('click', async () => {
    const noteId = b.closest('[data-note]').dataset.note;
    if (!confirm('¿Borrar esta entrada del historial?')) return;
    const { error } = await deleteNote(noteId, id);
    if (error) { await writeFailed(error, 'borrar'); return; }
    renderNotes(id);
    afterChange();
  }));

  list.querySelectorAll('[data-edit-note]').forEach((b) => b.addEventListener('click', () => {
    const art = b.closest('[data-note]');
    const noteId = art.dataset.note;
    const note = notesFor(id).find((n) => n.id === noteId);
    const bodyEl = art.querySelector('.note-body');
    bodyEl.innerHTML = `<textarea class="note-edit" rows="4">${escHtml(note.body)}</textarea>
      <div class="note-edit-acts"><button type="button" data-save>Guardar</button>
      <button type="button" data-cancel>Cancelar</button></div>`;
    bodyEl.querySelector('[data-cancel]').onclick = () => renderNotes(id);
    bodyEl.querySelector('[data-save]').onclick = async () => {
      const text = bodyEl.querySelector('textarea').value.trim();
      if (!text) return;
      const { error } = await updateNote(noteId, text);
      // Igual que en el alta: el editor de la nota se queda abierto con el texto.
      if (error) { await writeFailed(error, 'guardar'); return; }
      renderNotes(id);
    };
  }));
}

// ─────────────────────── alta de cuenta nueva ───────────────────────

function initNewDialog() {
  const dlg = document.getElementById('dlgNew');
  document.getElementById('btnNew').addEventListener('click', () => {
    dlg.querySelector('#nName').value = '';
    dlg.querySelector('#nRegion').innerHTML = optionsFor(state.catalogs.region);
    dlg.querySelector('#nSector').innerHTML = optionsFor(state.catalogs.sector);
    dlg.querySelector('#nOwner').innerHTML = '<option value="">—</option>' +
      state.profiles.filter((p) => p.is_active)
        .map((p) => `<option value="${p.id}">${escHtml(p.full_name || p.email)}</option>`).join('');
    dlg.querySelector('#nOwner').value = getProfile()?.id || '';
    // Las columnas personalizadas (Tipo de empresa…) se pintan con el mismo
    // control que la ficha, así que la que cree el admin mañana aparece aquí sin
    // tocar código. La cuenta de pega basta: getValue devuelve null y el control
    // sale vacío. Se repinta en cada apertura, así que nunca arrastra lo anterior.
    dlg.querySelector('#nCustom').innerHTML = panelFields()
      .filter((c) => c.custom)
      .map((c) => `<label class="fld"><span>${escHtml(c.label)}</span>
        ${fieldControl({ custom: {} }, c)}</label>`).join('');
    dlg.querySelector('#nDup').hidden = true;
    dlg.showModal();
    dlg.querySelector('#nName').focus();
  });

  // Aviso de duplicado mientras se escribe: es el momento útil, no después.
  dlg.querySelector('#nName').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    const warn = dlg.querySelector('#nDup');
    if (q.length < 3) { warn.hidden = true; return; }
    const hits = state.accounts.filter((a) => looksLikeDuplicate(a.name, q)).slice(0, 4);
    if (!hits.length) { warn.hidden = true; return; }
    warn.hidden = false;
    warn.innerHTML = `Ya existe algo parecido: ${hits.map((h) => `<b>${escHtml(h.name)}</b>`).join(', ')}`;
  });

  dlg.querySelector('#nCancel').addEventListener('click', () => dlg.close());
  dlg.querySelector('#nCreate').addEventListener('click', async () => {
    const name = dlg.querySelector('#nName').value.trim();
    if (!name) { toast('Pon un nombre de cuenta.', 'err'); return; }
    const ownerId = dlg.querySelector('#nOwner').value || null;
    const owner = state.profiles.find((p) => p.id === ownerId);

    // Los personalizados viajan juntos en la columna jsonb `custom`. Se recogen
    // por su data-f y dentro del diálogo: el mismo control puede estar montado en
    // la ficha lateral si estaba abierta, con lo que el id se repite en la página.
    // Solo los que traen valor: una clave con cadena vacía no es "sin rellenar",
    // es un dato que luego sale como valor fuera de catálogo.
    const custom = {};
    dlg.querySelectorAll('[data-f^="custom."]').forEach((el) => {
      if (el.value) custom[el.dataset.f.slice(7)] = el.value;
    });

    const fields = {
      name,
      region: dlg.querySelector('#nRegion').value || null,
      sector: dlg.querySelector('#nSector').value || null,
      owner_id: ownerId,
      owner_name: owner ? (owner.full_name || owner.email) : null,
      hubspot_url: dlg.querySelector('#nHs').value.trim() || null,
    };
    if (Object.keys(custom).length) fields.custom = custom;

    const { account, error } = await createAccount(fields);
    // El diálogo no se cierra si falla: los datos escritos siguen dentro.
    if (error) { await writeFailed(error, 'crear la cuenta'); return; }
    dlg.close();
    dlg.querySelector('#nHs').value = '';
    toast(`«${account.name}» creada.`);
    afterChange();
    openPanel(account.id);
  });
}

function optionsFor(list) {
  return '<option value="">—</option>' + list.map((v) => `<option value="${escHtml(v)}">${escHtml(v)}</option>`).join('');
}
