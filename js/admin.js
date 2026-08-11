// Panel de administración: usuarios, catálogos de los desplegables y columnas
// personalizadas. Solo visible (y solo operativo) para administradores: el
// candado de verdad está en las Edge Functions y en RLS, no en esta vista.
import { sb } from './supabaseClient.js';
import { getProfile } from './auth.js';
import {
  state, addCatalogOption, removeCatalogOption, addFieldDef, removeFieldDef, loadAll,
} from './store.js';
import { escHtml, genPassword, toast } from './util.js';

let afterChange = () => {};

// Invoca una Edge Function desenvolviendo el mensaje real del error, que
// supabase-js deja enterrado en error.context.
async function invoke(fn, body) {
  const { data, error } = await sb.functions.invoke(fn, { body });
  if (error) {
    let msg = error.message || 'Error';
    try {
      if (error.context && typeof error.context.json === 'function') {
        const j = await error.context.json();
        if (j && j.error) msg = j.error;
      }
    } catch (_e) { /* nos quedamos con el mensaje genérico */ }
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

function showOk(html) {
  const el = document.getElementById('adminMsg');
  el.className = 'msg ok';
  el.innerHTML = html;
  el.hidden = false;
}
function showErr(msg) {
  const el = document.getElementById('adminMsg');
  el.className = 'msg err';
  el.textContent = msg;
  el.hidden = false;
}

// ─────────────────────────── usuarios ───────────────────────────

async function fetchUsers() {
  const { data, error } = await sb
    .from('profiles')
    .select('id, email, full_name, role, is_active, must_change_password, created_at')
    .order('full_name');
  if (error) throw error;
  return data || [];
}

function userRow(u, meId) {
  const self = u.id === meId;
  const cuentas = state.accounts.filter((a) => a.owner_id === u.id).length;
  return `<div class="urow" data-u="${u.id}">
    <div class="uname">${escHtml(u.full_name || '(sin nombre)')}
      ${self ? '<span class="tag">tú</span>' : ''}
      ${u.must_change_password ? '<span class="tag warn">contraseña provisional</span>' : ''}
      ${u.is_active ? '' : '<span class="tag off">desactivado</span>'}
      <small>${escHtml(u.email || '')} · ${cuentas} cuenta${cuentas === 1 ? '' : 's'}</small>
    </div>
    <div class="urole">
      <select data-role ${self ? 'disabled title="No puedes cambiar tu propio rol"' : ''}>
        <option value="user"${u.role === 'user' ? ' selected' : ''}>Usuario</option>
        <option value="admin"${u.role === 'admin' ? ' selected' : ''}>Administrador</option>
      </select>
    </div>
    <div class="uacts">
      <button type="button" data-reset>Nueva contraseña</button>
      <button type="button" data-active>${u.is_active ? 'Desactivar' : 'Activar'}</button>
      ${!u.is_active && !self ? '<button type="button" class="danger" data-del>Borrar</button>' : ''}
    </div>
  </div>`;
}

async function renderUsers() {
  const wrap = document.getElementById('adminUsers');
  wrap.innerHTML = '<p class="muted">Cargando…</p>';
  let users;
  try { users = await fetchUsers(); } catch (e) { wrap.innerHTML = `<p class="err-box">${escHtml(e.message)}</p>`; return; }

  const meId = getProfile()?.id;
  wrap.innerHTML = users.map((u) => userRow(u, meId)).join('');

  wrap.querySelectorAll('.urow').forEach((row) => {
    const id = row.dataset.u;
    const u = users.find((x) => x.id === id);

    row.querySelector('[data-role]')?.addEventListener('change', async (e) => {
      try {
        await invoke('admin-user-action', { action: 'update_profile', user_id: id, role: e.target.value });
        showOk(`Rol de <b>${escHtml(u.full_name || u.email)}</b> actualizado.`);
      } catch (err) { showErr(err.message); e.target.value = u.role; }
    });

    row.querySelector('[data-reset]').addEventListener('click', async () => {
      if (!confirm(`¿Generar una contraseña provisional nueva para ${u.full_name || u.email}?`)) return;
      const pw = genPassword();
      try {
        await invoke('admin-user-action', { action: 'reset_password', user_id: id, password: pw });
        showOk(`Contraseña provisional de <b>${escHtml(u.email)}</b>: <code>${escHtml(pw)}</code>.
                Compártela por un canal seguro; tendrá que cambiarla al entrar.`);
        renderUsers();
      } catch (err) { showErr(err.message); }
    });

    row.querySelector('[data-active]').addEventListener('click', async () => {
      try {
        await invoke('admin-user-action', { action: 'set_active', user_id: id, is_active: !u.is_active });
        showOk(`${escHtml(u.full_name || u.email)} ${u.is_active ? 'desactivado' : 'activado'}.`);
        renderUsers();
      } catch (err) { showErr(err.message); }
    });

    row.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!confirm(`¿Borrar definitivamente a ${u.full_name || u.email}?\n\nSus cuentas NO se borran: se quedan sin owner.`)) return;
      try {
        await invoke('admin-user-action', { action: 'delete_user', user_id: id });
        showOk('Usuario borrado.');
        await loadAll();
        renderUsers();
        afterChange();
      } catch (err) { showErr(err.message); }
    });
  });
}

function initCreateUser() {
  document.getElementById('nuGen').addEventListener('click', () => {
    document.getElementById('nuPass').value = genPassword();
  });
  document.getElementById('nuCreate').addEventListener('click', async () => {
    const name = document.getElementById('nuName').value.trim();
    const email = document.getElementById('nuEmail').value.trim();
    const role = document.getElementById('nuRole').value;
    let pw = document.getElementById('nuPass').value.trim();
    if (!email) { showErr('El correo es obligatorio.'); return; }
    if (!pw) pw = genPassword();
    if (pw.length < 8) { showErr('La contraseña debe tener al menos 8 caracteres.'); return; }

    const btn = document.getElementById('nuCreate');
    btn.disabled = true;
    try {
      const res = await invoke('admin-create-user', { email, full_name: name, role, password: pw });
      const adopted = res?.adopted
        ? ` Se le han asignado <b>${res.adopted}</b> cuentas que en el Excel llevaban su nombre.`
        : '';
      showOk(`Usuario <b>${escHtml(email)}</b> creado. Contraseña provisional:
              <code>${escHtml(pw)}</code>. Compártela por un canal seguro; deberá cambiarla
              en su primer acceso.${adopted}`);
      ['nuName', 'nuEmail', 'nuPass'].forEach((i) => { document.getElementById(i).value = ''; });
      await loadAll();
      renderUsers();
      afterChange();
    } catch (e) { showErr(e.message); } finally { btn.disabled = false; }
  });
}

// ────────────────────── catálogos y columnas ──────────────────────

function renderCatalog(kind) {
  const wrap = document.getElementById(`cat_${kind}`);
  wrap.innerHTML = state.catalogs[kind].map((v) => `
    <span class="catpill">${escHtml(v)}<button type="button" data-v="${escHtml(v)}" title="Quitar">×</button></span>`).join('')
    || '<span class="muted">Sin valores</span>';
  wrap.querySelectorAll('button[data-v]').forEach((b) => b.addEventListener('click', async () => {
    const v = b.dataset.v;
    const usadas = state.accounts.filter((a) => a[kind] === v).length;
    if (usadas && !confirm(`«${v}» está en uso en ${usadas} cuenta${usadas === 1 ? '' : 's'}.\n\nQuitarlo del catálogo no borra ese dato, solo deja de ofrecerse en el desplegable. ¿Seguir?`)) return;
    const { error } = await removeCatalogOption(kind, v);
    if (error) { showErr(error.message); return; }
    renderCatalog(kind);
  }));
}

function initCatalogs() {
  ['region', 'sector'].forEach((kind) => {
    document.getElementById(`catAdd_${kind}`).addEventListener('click', async () => {
      const input = document.getElementById(`catNew_${kind}`);
      const v = input.value.trim();
      if (!v) return;
      if (state.catalogs[kind].includes(v)) { showErr('Ese valor ya está en la lista.'); return; }
      const { error } = await addCatalogOption(kind, v);
      if (error) { showErr(error.message); return; }
      input.value = '';
      renderCatalog(kind);
    });
  });
}

function renderFields() {
  const wrap = document.getElementById('adminFields');
  const TIPOS = { text: 'Texto', number: 'Número', date: 'Fecha', select: 'Lista' };
  wrap.innerHTML = state.fields.length
    ? state.fields.map((f) => `<div class="frow" data-f="${f.id}">
        <div><b>${escHtml(f.label)}</b> <small>${TIPOS[f.type]}${f.options?.length ? ` · ${escHtml(f.options.join(', '))}` : ''}</small></div>
        <button type="button" class="danger" data-delf>Borrar</button></div>`).join('')
    : '<p class="muted">Todavía no hay columnas personalizadas.</p>';
  wrap.querySelectorAll('[data-delf]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.closest('.frow').dataset.f;
    if (!confirm('¿Borrar la columna? Los valores ya guardados en las cuentas dejarán de mostrarse.')) return;
    const { error } = await removeFieldDef(id);
    if (error) { showErr(error.message); return; }
    renderFields();
    afterChange();
  }));
}

function initFields() {
  const typeSel = document.getElementById('nfType');
  typeSel.addEventListener('change', () => {
    document.getElementById('nfOptsWrap').hidden = typeSel.value !== 'select';
  });
  document.getElementById('nfCreate').addEventListener('click', async () => {
    const label = document.getElementById('nfLabel').value.trim();
    if (!label) { showErr('Ponle un nombre a la columna.'); return; }
    // La clave sale del nombre: minúsculas, sin acentos y sin espacios, que es
    // lo que acepta el CHECK de field_defs.
    const key = label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || `col_${Date.now() % 100000}`;
    if (state.fields.some((f) => f.key === key)) { showErr('Ya existe una columna con ese nombre.'); return; }
    const type = typeSel.value;
    const options = type === 'select'
      ? document.getElementById('nfOpts').value.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    if (type === 'select' && !options.length) { showErr('Una lista necesita al menos un valor.'); return; }
    const { error } = await addFieldDef({ key, label, type, options });
    if (error) { showErr(error.message); return; }
    document.getElementById('nfLabel').value = '';
    document.getElementById('nfOpts').value = '';
    showOk(`Columna <b>${escHtml(label)}</b> creada. Actívala desde el botón «Columnas» de la tabla.`);
    renderFields();
    afterChange();
  });
}

// ─────────────────────────── entrada ───────────────────────────

let wired = false;

export function initAdmin(onChange) {
  afterChange = onChange || (() => {});
}

export function renderAdmin() {
  if (!wired) { initCreateUser(); initCatalogs(); initFields(); wired = true; }
  document.getElementById('adminMsg').hidden = true;
  renderUsers();
  renderCatalog('region');
  renderCatalog('sector');
  renderFields();
}
