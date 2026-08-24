// La tabla: cabecera con orden y filtro, filas con edición en celda, tiles de
// KPI y selector de columnas. Todo se repinta desde memoria.
import {
  state, allColumns, updateField, updateFieldMany, ownerName, getValue, onChange,
  addNote, updateNote,
} from './store.js';
import { getProfile, isAdmin, isFavorite, toggleFavorite, saveColumnPrefs } from './auth.js';
import { attachMentions, renderNoteBody } from './mentions.js';
import { DEFAULT_VISIBLE, EDITABLE_TYPES } from './data.js';
import {
  filters, sort, visibleRows, computeKpis, breakdown, hasActiveFilters,
  clearFilters, isFiltered, openFilterMenu, closeFilterMenu, cellValue, rangoPreset,
} from './filters.js';
import { escHtml, fmtDate, fmtDateTime, daysFromToday, toast } from './util.js';
import { writeFailed } from './net.js';
import { openPanel, openNotes } from './panel.js';

const HS_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="18" cy="6" r="2.6"/><circle cx="6" cy="12" r="3"/><circle cx="17" cy="17.5" r="2.6"/><path d="M8.6 10.6 15.6 7M8.7 13.6l6 3.2"/></svg>';
const STAR = '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3.6 2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.9l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z"/></svg>';

let editing = null;   // { id, key } de la celda abierta
let pendingRender = false;   // hubo cambios que no se pintaron por estar editando

// Filas marcadas para editar en bloque. Vive fuera de render() para sobrevivir a
// los repintados (Realtime, guardados), y se poda a lo visible en cada pintado:
// nunca se actúa sobre una fila que un filtro se ha llevado de la pantalla.
const selected = new Set();
let lastSelId = null;   // ancla del rango con Shift

// Celdas cuya última edición no llegó a la base de datos. La celda sigue
// mostrando el valor de la base de datos (lo que no está guardado no puede
// aparentar estarlo), pero se marca en ámbar y guarda lo tecleado para que un
// clic reabra el editor con ese texto. Antes se cerraba el editor sin más y el
// cambio se perdía sin dejar rastro.
//
// Esto NO es una cola de reintentos: no sobrevive a recargar la página, y el
// reintento lo decide el usuario.
const pending = new Map();   // `${id}:${key}` -> { value, label }
const pkey = (id, key) => `${id}:${key}`;
const pendingTip = (p) => `Sin guardar: «${p.label || '(vacío)'}». Clic para reintentar.`;

// ─────────────────── preferencias de columnas ───────────────────

export function visibleColumns() {
  const prefs = getProfile()?.column_prefs || {};
  const cols = allColumns();
  const guardadas = Array.isArray(prefs.order) && prefs.order.length > 0;

  const order = guardadas ? prefs.order : cols.map((c) => c.key);
  // Sin preferencias propias manda la vista por defecto; en cuanto el usuario
  // toca el selector, manda exactamente lo que dejó marcado.
  const hidden = new Set(guardadas
    ? (prefs.hidden || [])
    : cols.filter((c) => !DEFAULT_VISIBLE.includes(c.key)).map((c) => c.key));
  const byKey = new Map(cols.map((c) => [c.key, c]));

  const out = [];
  for (const k of order) {
    const c = byKey.get(k);
    if (c && !hidden.has(k)) { out.push(c); byKey.delete(k); }
  }
  // Columnas nuevas (p. ej. las que acaba de crear el admin) al final: no deben
  // quedar invisibles solo porque las preferencias son anteriores a ellas.
  for (const c of byKey.values()) if (!hidden.has(c.key)) out.push(c);
  return out.length ? out : cols.filter((c) => DEFAULT_VISIBLE.includes(c.key));
}

async function setPrefs(next) {
  await saveColumnPrefs(next);
  render();
}

// ─────────────────────────── pintado ───────────────────────────

// `tip`: el tramo de fechas del tile. Va en data-tip y lo pinta el CSS al vuelo,
// no en title: el aviso del navegador tarda casi un segundo en salir y esto se
// consulta de pasada, mirando y siguiendo.
function kpiTile(value, label, active, attr, tip) {
  const t = tip ? ` data-tip="${escHtml(tip)}"` : '';
  return `<button class="kpi${active ? ' on' : ''}" ${attr}${t} type="button">
    <span class="kpi-v">${value}</span><span class="kpi-l">${escHtml(label)}</span></button>`;
}

function renderKpis() {
  const k = computeKpis();
  const el = document.getElementById('kpis');
  // Grupo de pastillas con su etiqueta. Si no queda ningún valor con los demás
  // filtros puestos —y ninguno marcado— no se pinta el grupo: una etiqueta
  // suelta sin nada al lado solo genera dudas.
  const grupo = (rotulo, key) => {
    const entries = breakdown(key);
    if (!entries.length) return '';
    return `<span class="chip-lbl">${escHtml(rotulo)}</span>` + entries.map(([v, n]) => {
      const on = filters.values[key]?.has(v);
      return `<button class="chip${on ? ' on' : ''}" type="button" data-chip="${escHtml(key)}" data-v="${escHtml(v)}">
        ${escHtml(v)} <b>${n}</b></button>`;
    }).join('');
  };
  const owners = grupo('Owner', 'owner_id');

  // «Cuentas» ya no muestra el total de la tabla sino el de los filtros puestos,
  // pero al pulsarlo sigue quitándolos todos. El title dice las dos cosas: es el
  // único tile cuyo número no anticipa lo que sale al pulsarlo.
  const attrTodo = `data-kpi="todo" title="Quita todos los filtros (${state.accounts.length} cuentas en total)"`;

  el.innerHTML = `
    <div class="kpi-row">
      ${kpiTile(k.total, 'Cuentas', !hasActiveFilters(), attrTodo)}
      ${kpiTile(k.hoy, 'Hoy', filters.datePreset === 'hoy', 'data-kpi="hoy"', rangoPreset('hoy'))}
      ${kpiTile(k.semana, 'Esta semana', filters.datePreset === 'semana', 'data-kpi="semana"', rangoPreset('semana'))}
      ${kpiTile(k.proxsemana, 'Próxima semana', filters.datePreset === 'proxsemana', 'data-kpi="proxsemana"', rangoPreset('proxsemana'))}
      ${kpiTile(k.mes, 'Mes actual', filters.datePreset === 'mes', 'data-kpi="mes"', rangoPreset('mes'))}
      ${kpiTile(k.proxmes, 'Próximo mes', filters.datePreset === 'proxmes', 'data-kpi="proxmes"', rangoPreset('proxmes'))}
      ${kpiTile(k.vencidos, 'Vencidos', filters.datePreset === 'vencidos', 'data-kpi="vencidos"')}
      ${kpiTile(k.sinfecha, 'Sin fecha', filters.datePreset === 'sinfecha', 'data-kpi="sinfecha"')}
      ${kpiTile(k.mias, 'Mías', filters.mine, 'data-kpi="mias"')}
      ${kpiTile(k.favoritas, 'Favoritas', filters.fav, 'data-kpi="fav" title="Las cuentas que has marcado con la estrella. Son tuyas: los demás no las ven."')}
      ${kpiTile(k.menciones, 'Menciones', filters.mentions, 'data-kpi="mentions" title="Cuentas donde te han mencionado y no lo has dado por hecho"')}
    </div>
    <div class="chip-row"${owners ? '' : ' hidden'}>${owners}</div>`;

  el.querySelectorAll('[data-kpi]').forEach((b) => b.addEventListener('click', () => {
    const k2 = b.dataset.kpi;
    if (k2 === 'todo') clearFilters();
    else if (k2 === 'mias') { filters.mine = !filters.mine; }
    else if (k2 === 'fav') { filters.fav = !filters.fav; }
    else if (k2 === 'mentions') { filters.mentions = !filters.mentions; }
    else filters.datePreset = filters.datePreset === k2 ? null : k2;
    document.getElementById('q').value = filters.search;
    render();
  }));
  el.querySelectorAll('[data-chip]').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.chip;
    const set = filters.values[key] || new Set();
    if (set.has(b.dataset.v)) set.delete(b.dataset.v); else set.add(b.dataset.v);
    if (set.size) filters.values[key] = set; else delete filters.values[key];
    render();
  }));
}

// ¿Puede este usuario editar la última nota de la cuenta desde la celda?
// La misma regla que el historial: escribe quien firmó, o un admin. Sin nota
// todavía, cualquiera puede escribir la primera —eso no pisa nada de nadie—.
function noteEditable(acc) {
  const n = acc.last_note;
  if (!n) return true;
  return isAdmin() || (!!n.author_id && n.author_id === getProfile()?.id);
}

function cellHtml(acc, col) {
  const v = cellValue(acc, col.key);

  if (col.key === 'name') {
    // El icono sustituye a la columna de HubSpot que había antes.
    const link = acc.hubspot_url
      ? `<a class="hs-dot" href="${escHtml(acc.hubspot_url)}" target="_blank" rel="noopener"
            title="Abrir en HubSpot" data-stop>${HS_ICON}</a>` : '';
    const fav = isFavorite(acc.id);
    const estrella = `<button class="fav-dot${fav ? ' on' : ''}" type="button" data-fav
        title="${fav ? 'Quitar de favoritas' : 'Añadir a favoritas'}">${STAR}</button>`;
    return `<span class="gname">${escHtml(acc.name)}</span>${estrella}${link}`;
  }
  if (col.type === 'note') {
    // El title de la celda ya está contado (aviso de "sin guardar"): no se pisa
    // con la firma, que es lo secundario cuando hay un cambio en el aire.
    const stuck = pending.has(pkey(acc.id, col.key));
    if (!acc.last_note) {
      const tip = stuck ? '' : ' title="Clic para escribir la primera nota"';
      return `<span class="muted"${tip}>—</span>`;
    }
    // El texto completo, con sus saltos de línea: la fila crece hasta que cabe.
    // Autor y fecha van en el title para no meter ruido en la celda.
    const n = acc.last_note;
    const firma = `${n.author_name || 'Anónimo'} · ${fmtDateTime(n.created_at)}`;
    const tip = stuck ? '' : ` title="${escHtml(firma)}\n${noteEditable(acc)
      ? 'Clic para editarla'
      : 'Solo su autor o un admin pueden editarla. Clic para ver el historial'}"`;
    // renderNoteBody escapa y, encima de lo escapado, resalta las menciones.
    return `<div class="gnote"${tip}>${renderNoteBody(n.body)}</div>`;
  }
  if (col.type === 'noteslog') {
    const n = acc.notes_count || 0;
    return `<button class="btn-notes" type="button" data-notes title="Ver el historial de notas">
      Notas${n ? `<span class="ncount">${n}</span>` : ''}</button>`;
  }
  if (col.key === 'next_touch') {
    if (!v) return '<span class="muted">—</span>';
    const d = daysFromToday(v);
    const cls = d < 0 ? 'due late' : d === 0 ? 'due today' : '';
    return `<span class="${cls}">${fmtDate(v)}</span>`;
  }
  if (col.key === 'updated_at') return `<span class="muted">${fmtDateTime(v)}</span>`;
  if (col.key === 'owner_id') {
    if (!v) return '<span class="muted">—</span>';
    // Owner sin cuenta en la app todavía: se marca para que se note.
    const orphan = !acc.owner_id && acc.owner_name;
    return `<span class="${orphan ? 'owner-orphan' : ''}" ${orphan ? 'title="Sin usuario en la app todavía"' : ''}>${escHtml(v)}</span>`;
  }
  return v ? escHtml(v) : '<span class="muted">—</span>';
}

export function render() {
  if (!document.getElementById('grid')) return;
  renderKpis();

  const cols = visibleColumns();
  const rows = visibleRows();
  const visibles = new Set(rows.map((r) => r.id));
  for (const id of selected) if (!visibles.has(id)) selected.delete(id);
  const todas = rows.length > 0 && selected.size >= rows.length;
  // La casilla de selección es una columna fija por delante de las del usuario.
  // No es una columna de datos: no está en visibleColumns(), así que ni se
  // ordena, ni se arrastra, ni se exporta.
  const tpl = ['34px', ...cols.map((c) => `minmax(${c.min}px, ${c.width})`)].join(' ');

  const head = cols.map((c) => {
    const rotulo = c.noSort
      ? `<span class="gh-sort static">${escHtml(c.label)}</span>`
      : `<button class="gh-sort" type="button" data-sort="${escHtml(c.key)}">
           ${escHtml(c.label)}${sort.key === c.key ? `<i class="arr">${sort.dir > 0 ? '▲' : '▼'}</i>` : ''}
         </button>`;
    // Sin embudo en las columnas de texto libre: listar 250 valores distintos
    // no es un filtro, es un índice.
    const embudo = c.noFilter ? '' : `
      <button class="gh-filter" type="button" data-filter="${escHtml(c.key)}" title="Filtrar">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4"
             stroke-linecap="round"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>
      </button>`;
    // draggable en la cabecera: arrastrarla reordena la columna. El clic sigue
    // ordenando — el navegador no dispara click si ha habido arrastre.
    return `<div class="gc gh${isFiltered(c.key) ? ' filtered' : ''}" data-k="${escHtml(c.key)}"
                 draggable="true" title="Arrastra para mover la columna">${rotulo}${embudo}</div>`;
  }).join('');

  const cabeceraSel = `<div class="gc gsel">
    <input type="checkbox" data-sel-all ${todas ? 'checked' : ''}
           title="Marcar o desmarcar todas las filas visibles"></div>`;

  const body = rows.map((a) => {
    const d = a.next_touch ? daysFromToday(a.next_touch) : null;
    const cls = d !== null && d < 0 ? ' overdue' : '';
    const sel = selected.has(a.id);
    const casilla = `<div class="gc gsel">
      <input type="checkbox" data-sel ${sel ? 'checked' : ''}></div>`;
    return `<div class="grow${cls}${sel ? ' selected' : ''}" data-id="${a.id}">${casilla}${cols.map((c) => {
      const p = pending.get(pkey(a.id, c.key));
      // La nota se edita en la celda como cualquier otro campo, pero solo la
      // suya: si es de otro, la celda no se ofrece como editable y el clic
      // lleva al historial.
      const editable = c.type === 'note' ? noteEditable(a) : EDITABLE_TYPES.has(c.type);
      const extra = (editable ? ' editable' : '')
        + (c.type === 'note' ? ' gc-note' : '')
        + (p ? ' pending' : '');
      const tip = p ? ` title="${escHtml(pendingTip(p))}"` : '';
      return `<div class="gc${extra}" data-k="${escHtml(c.key)}"${tip}>${cellHtml(a, c)}</div>`;
    }).join('')}</div>`;
  }).join('');

  document.getElementById('grid').innerHTML = `
    <div class="gtable${selected.size ? ' has-sel' : ''}" style="--cols:${tpl}">
      <div class="grow ghead">${cabeceraSel}${head}</div>
      <div class="gbody">${body || '<div class="gempty">Ninguna cuenta cumple los filtros.</div>'}</div>
    </div>`;

  // Ni a medias ni del todo: el estado intermedio de la casilla de cabecera no
  // se puede pintar desde el HTML.
  const todo = document.querySelector('[data-sel-all]');
  if (todo) todo.indeterminate = selected.size > 0 && !todas;
  renderBulkBar();

  document.getElementById('rowCount').textContent =
    rows.length === state.accounts.length
      ? `${rows.length} cuentas`
      : `${rows.length} de ${state.accounts.length} cuentas`;
  document.getElementById('btnClear').hidden = !hasActiveFilters();
}

// ─────────────────────── selección múltiple ───────────────────────
// Marcar filas y cambiarles el Owner o la Fecha de una vez. Es lo único que el
// Excel hacía mejor que la app: reasignar una cartera eran diez ediciones celda
// a celda. La escritura va en UNA petición (updateFieldMany) y deja un
// «Deshacer» en el aviso, porque un cambio en bloque equivocado se arregla mal
// a mano.

// Repinta lo que depende de la selección sin rehacer la tabla: repintarla
// entera por marcar una casilla devolvería el scroll al principio.
function refreshSelUi() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const filas = grid.querySelectorAll('.grow:not(.ghead)');
  filas.forEach((row) => {
    const on = selected.has(row.dataset.id);
    row.classList.toggle('selected', on);
    const box = row.querySelector('[data-sel]');
    if (box) box.checked = on;
  });
  grid.querySelector('.gtable')?.classList.toggle('has-sel', selected.size > 0);
  const todo = grid.querySelector('[data-sel-all]');
  if (todo) {
    todo.checked = filas.length > 0 && selected.size >= filas.length;
    todo.indeterminate = selected.size > 0 && selected.size < filas.length;
  }
  renderBulkBar();
}

function renderBulkBar() {
  const bar = document.getElementById('bulkBar');
  if (!bar) return;
  const n = selected.size;
  bar.hidden = n === 0;
  // El aviso se aparta de la barra mientras esté puesta (los dos viven abajo).
  document.body.classList.toggle('has-bulk', n > 0);
  if (!n) { document.getElementById('bulkMenu')?.remove(); return; }
  bar.innerHTML = `<span class="bulk-n">${n} seleccionada${n === 1 ? '' : 's'}</span>
    <button class="btn" type="button" data-bulk="owner">Owner ▾</button>
    <button class="btn" type="button" data-bulk="fecha">Fecha ▾</button>
    <span class="spacer"></span>
    <button class="btn ghost" type="button" data-bulk="none">Quitar selección</button>`;
}

// Desplegable colgado de un botón de la barra, como el de Exportar.
function bulkMenu(anchorEl, html) {
  document.getElementById('bulkMenu')?.remove();
  const m = document.createElement('div');
  m.id = 'bulkMenu';
  m.className = 'fmenu mini';
  m.innerHTML = html;
  document.body.appendChild(m);
  // La barra vive pegada al borde inferior de la ventana, así que por debajo casi
  // nunca hay sitio: el menú se abre hacia arriba salvo que quepa abajo. Se mide
  // ya montado, que es cuando el menú tiene alto.
  const r = anchorEl.getBoundingClientRect();
  const alto = m.offsetHeight;
  const abajo = r.bottom + 6;
  const cabeAbajo = abajo + alto <= window.innerHeight - 8;
  m.style.top = `${Math.round(cabeAbajo ? abajo : Math.max(8, r.top - 6 - alto))}px`;
  m.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 12)))}px`;
  setTimeout(() => document.addEventListener('mousedown', function off(ev) {
    if (m.contains(ev.target)) return;
    document.removeEventListener('mousedown', off);
    m.remove();
  }), 0);
  return m;
}

function menuOwnerBulk(anchorEl) {
  const opts = state.profiles.filter((p) => p.is_active)
    .map((p) => `<button type="button" data-v="${escHtml(p.id)}">${escHtml(p.full_name || p.email)}</button>`)
    .join('');
  const m = bulkMenu(anchorEl, `${opts}<button type="button" data-v="">— Sin owner</button>`);
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    const v = b.dataset.v || null;
    m.remove();
    aplicarEnBloque('owner_id', v, v ? `owner → ${b.textContent.trim()}` : 'sin owner');
  });
}

function menuFechaBulk(anchorEl) {
  const m = bulkMenu(anchorEl, `<div class="bulk-date">
      <input type="date" data-d>
      <button class="btn primary" type="button" data-apply>Aplicar</button>
    </div>
    <button type="button" data-clear>Quitar la fecha</button>`);
  m.querySelector('[data-apply]').addEventListener('click', () => {
    const v = m.querySelector('[data-d]').value;
    if (!v) return;
    m.remove();
    aplicarEnBloque('next_touch', v, `fecha → ${fmtDate(v)}`);
  });
  m.querySelector('[data-clear]').addEventListener('click', () => {
    m.remove();
    aplicarEnBloque('next_touch', null, 'sin fecha');
  });
  m.querySelector('[data-d]').focus();
}

async function aplicarEnBloque(key, value, etiqueta) {
  const ids = [...selected];
  if (!ids.length) return;
  const { error, updated, prev } = await updateFieldMany(ids, key, value);
  // La selección se queda puesta también cuando falla: reintentar es volver a
  // elegir el valor, no volver a marcar veinte filas.
  if (error) { await writeFailed(error, 'guardar el cambio en bloque'); return; }
  toast(`${updated} cuenta${updated === 1 ? '' : 's'}: ${etiqueta}.`, 'ok',
    { label: 'Deshacer', fn: () => deshacerEnBloque(key, prev) });
}

async function deshacerEnBloque(key, prev) {
  // Cada fila tenía lo suyo, y un UPDATE escribe un solo valor: se agrupan las
  // filas que compartían estado anterior. En la práctica son uno o dos grupos
  // («las de Ana» y «las que no tenían owner»), no veinte peticiones.
  const grupos = new Map();
  for (const [id, before] of prev) {
    const k = JSON.stringify(before);
    if (!grupos.has(k)) grupos.set(k, { before, ids: [] });
    grupos.get(k).ids.push(id);
  }
  for (const { before, ids } of grupos.values()) {
    // El owner_name se restaura tal cual estaba y no se deriva del owner_id: en
    // las cuentas que vienen del Excel hay nombre sin usuario, y derivarlo lo
    // borraría.
    const derivados = key === 'owner_id' ? { owner_name: before.owner_name ?? null } : null;
    const { error } = await updateFieldMany(ids, key, before[key] ?? null, derivados);
    if (error) { await writeFailed(error, 'deshacer el cambio'); return; }
  }
  toast('Cambio deshecho.');
}

function initBulkBar() {
  document.getElementById('bulkBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bulk]');
    if (!b) return;
    if (b.dataset.bulk === 'owner') menuOwnerBulk(b);
    if (b.dataset.bulk === 'fecha') menuFechaBulk(b);
    if (b.dataset.bulk === 'none') { selected.clear(); lastSelId = null; refreshSelUi(); }
  });
}

// ─────────────────────── edición en celda ───────────────────────

function closeEditor(cellEl, acc, col) {
  editing = null;
  cellEl.classList.remove('editing');

  const p = pending.get(pkey(acc.id, col.key));
  cellEl.classList.toggle('pending', !!p);
  if (p) cellEl.title = pendingTip(p); else cellEl.removeAttribute('title');
  cellEl.innerHTML = cellHtml(acc, col);

  // Mientras había un editor abierto se ignoraron los avisos de cambio (Realtime,
  // resincronización) para no quitarle el foco al usuario a mitad de escribir.
  // Ahora que ha cerrado, se aplican: si no, la fila se quedaba con datos viejos
  // hasta el siguiente cambio que sí pillara la tabla libre.
  if (pendingRender) { pendingRender = false; render(); }
}

// Cierra el editor abierto descartando lo tecleado. Lo necesita el doble clic
// sobre el nombre: el primer clic del par ya ha abierto el renombrado y, si no
// se retira, el input se queda montado detrás de la ficha.
export function cancelEdit() {
  editing?.cancel?.();
}

function startEdit(cellEl, acc, col) {
  if (editing) return;
  editing = { id: acc.id, key: col.key };
  cellEl.classList.add('editing');

  // Si la última edición de esta celda no llegó a guardarse, el editor se abre
  // con lo que el usuario había escrito, no con lo que hay en la base de datos:
  // reintentar tiene que ser un clic, no volver a teclearlo.
  const stored = col.key === 'owner_id' ? (acc.owner_id || '') : (getValue(acc, col.key) ?? '');
  const stuck = pending.get(pkey(acc.id, col.key));
  const raw = stuck ? (stuck.value ?? '') : stored;
  let ctrl;

  if (col.type === 'date') {
    ctrl = document.createElement('input');
    ctrl.type = 'date';
    ctrl.value = raw || '';
  } else if (col.type === 'select' || col.type === 'catalog' || col.type === 'owner') {
    ctrl = document.createElement('select');
    let opts;
    let blank = '—';
    if (col.type === 'owner') {
      opts = state.profiles.filter((p) => p.is_active).map((p) => [p.id, p.full_name || p.email]);
      // Owner heredado del Excel sin usuario todavía: se muestra como opción
      // vacía etiquetada, para no dar la falsa impresión de que no hay nadie.
      if (!acc.owner_id && acc.owner_name) blank = `${acc.owner_name} (sin usuario)`;
    } else {
      const list = col.type === 'catalog' ? state.catalogs[col.catalog] : (col.options || []);
      opts = list.map((v) => [v, v]);
      // El valor guardado puede no estar en el catálogo (dato antiguo); se
      // añade para no borrarlo sin querer al abrir el desplegable.
      if (raw && !list.includes(raw)) opts.unshift([raw, `${raw} (fuera de catálogo)`]);
    }
    ctrl.innerHTML = `<option value="">${escHtml(blank)}</option>` +
      opts.map(([v, l]) => `<option value="${escHtml(v)}"${String(v) === String(raw) ? ' selected' : ''}>${escHtml(l)}</option>`).join('');
  } else {
    ctrl = document.createElement('input');
    ctrl.type = 'text';
    ctrl.value = raw || '';
  }

  ctrl.className = 'cell-edit';
  cellEl.innerHTML = '';
  cellEl.appendChild(ctrl);
  ctrl.focus();
  if (ctrl.select) ctrl.select();

  let done = false;
  async function commit() {
    if (done) return;
    const next = ctrl.value === '' ? null : ctrl.value;
    const before = col.key === 'owner_id' ? (acc.owner_id || null) : (getValue(acc, col.key) ?? null);
    const k = pkey(acc.id, col.key);
    done = true;

    if (String(next ?? '') === String(before ?? '')) {
      // La base de datos ya dice lo que el usuario quería: si quedaba la marca de
      // un intento anterior que no llegó, sobra.
      pending.delete(k);
      closeEditor(cellEl, acc, col);
      return;
    }
    if (col.key === 'name' && !next) {
      toast('La cuenta necesita un nombre.', 'err');
      closeEditor(cellEl, acc, col);
      return;
    }

    // La etiqueta del desplegable, no el valor: en Owner el valor es un UUID y
    // «Sin guardar: 9f3c-…» no le dice nada a nadie.
    const label = ctrl.tagName === 'SELECT'
      ? (ctrl.selectedOptions[0]?.textContent.trim() || '')
      : (next ?? '');
    ctrl.disabled = true;   // guardando: ni doble envío ni seguir tecleando

    const { error } = await updateField(acc.id, col.key, next);
    if (error) {
      // updateField ya ha devuelto la celda a su valor anterior. Lo que el
      // usuario escribió se queda aquí para que pueda reintentarlo con un clic.
      pending.set(k, { value: next, label });
      closeEditor(cellEl, acc, col);
      await writeFailed(error, 'guardar');
      return;
    }
    pending.delete(k);
    pendingRender = true;   // closeEditor repinta la tabla entera
    closeEditor(cellEl, acc, col);
  }
  function cancel() {
    if (done) return;
    done = true;
    ctrl.removeEventListener('blur', commit);   // el blur no debe guardar tras cancelar
    closeEditor(cellEl, acc, col);
  }
  editing.cancel = cancel;

  ctrl.addEventListener('blur', commit);
  ctrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); ctrl.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  if (ctrl.tagName === 'SELECT') ctrl.addEventListener('change', () => ctrl.blur());
}

// ───────────────────────── favoritas ─────────────────────────

async function marcarFavorita(acc) {
  const eraFav = isFavorite(acc.id);
  const { error } = await toggleFavorite(acc.id);
  if (error) { await writeFailed(error, eraFav ? 'quitar de favoritas' : 'añadir a favoritas'); return; }
  render();   // la estrella y el recuento del tile cambian a la vez
}

// ───────────────── edición de la última nota ─────────────────
// La nota no se guarda en `accounts` sino en `account_notes`, así que tiene su
// propio editor: un textarea que crece con el texto y escribe sobre la entrada
// del historial que se está viendo (o crea la primera si no hay ninguna).
// Editar aquí NO añade una entrada nueva: es la misma nota, para corregirla sin
// abrir el popup. Para añadir otra entrada está el botón «Notas».

function startNoteEdit(cellEl, acc, col) {
  if (editing) return;
  editing = { id: acc.id, key: col.key };
  cellEl.classList.add('editing');

  const note = acc.last_note;
  const k = pkey(acc.id, col.key);
  const stuck = pending.get(k);
  const raw = stuck ? (stuck.value ?? '') : (note?.body ?? '');

  const ta = document.createElement('textarea');
  ta.className = 'cell-edit note-cell-edit';
  ta.rows = 1;
  ta.value = raw;
  ta.placeholder = note ? '' : 'Escribe la nota…';
  cellEl.innerHTML = '';
  cellEl.appendChild(ta);

  // ANTES de registrar las teclas del editor: los dos listeners viven en este
  // mismo textarea y con la lista de menciones abierta manda ella (Escape la
  // cierra sin cancelar la edición, Enter elige en vez de saltar de línea).
  // Con los dos listeners en el mismo elemento, decide el orden de registro.
  attachMentions(ta);

  // Crece con el contenido: una nota de seis líneas no se edita por una mirilla.
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
  ta.addEventListener('input', grow);
  grow();
  ta.focus();
  // Cursor al final, sin seleccionar: lo normal es rematar la nota, no
  // reescribirla, y con todo seleccionado la primera tecla se la lleva por delante.
  ta.setSelectionRange(ta.value.length, ta.value.length);

  let done = false;
  async function commit() {
    if (done) return;
    const next = ta.value.trim();
    const before = note?.body ?? '';
    done = true;

    if (next === before) {
      pending.delete(k);
      closeEditor(cellEl, acc, col);
      return;
    }
    // Vaciar la celda no borra la entrada: eso es tirar historial firmado, y se
    // hace a conciencia desde el popup, no por dejar un textarea en blanco.
    if (!next) {
      toast('La nota no puede quedarse vacía. Bórrala desde «Notas».', 'err');
      closeEditor(cellEl, acc, col);
      return;
    }

    ta.disabled = true;   // guardando: ni doble envío ni seguir tecleando
    const { error } = note
      ? await updateNote(note.id, next)
      : await addNote(acc.id, next, getProfile());
    if (error) {
      // Igual que en el resto de celdas: la celda vuelve a lo que dice la base
      // de datos, en ámbar, y guarda lo escrito para reintentarlo con un clic.
      pending.set(k, { value: next, label: next.length > 60 ? `${next.slice(0, 60)}…` : next });
      closeEditor(cellEl, acc, col);
      await writeFailed(error, 'guardar la nota');
      return;
    }
    pending.delete(k);
    pendingRender = true;   // el alto de la fila cambia: repinta la tabla
    closeEditor(cellEl, acc, col);
  }
  function cancel() {
    if (done) return;
    done = true;
    ta.removeEventListener('blur', commit);
    closeEditor(cellEl, acc, col);
  }
  editing.cancel = cancel;

  ta.addEventListener('blur', commit);
  ta.addEventListener('keydown', (e) => {
    // Enter hace salto de línea (es una nota, no un campo de una línea); se
    // guarda al salir, con Ctrl/⌘+Enter o con Esc para descartar.
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ta.blur(); }
  });
}

// ──────────────── reordenar columnas arrastrando ────────────────
// Alternativa directa a las flechas del selector de columnas, que se mantienen
// como camino accesible y como única vía en táctil (el arrastre HTML5 no
// funciona con el dedo).

let drag = null;          // { key, sobre, antes }
let arrastroReciente = 0; // sella el fin del arrastre para descartar el clic

// El orden completo y efectivo, incluidas las columnas ocultas: si solo se
// reordenaran las visibles, al volver a mostrar una aparecería siempre al final.
function ordenCompleto(prefs) {
  const todas = allColumns().map((c) => c.key);
  const guardado = Array.isArray(prefs.order) && prefs.order.length
    ? prefs.order.filter((k) => todas.includes(k))
    : [];
  return [...guardado, ...todas.filter((k) => !guardado.includes(k))];
}

async function moveColumn(desdeKey, sobreKey, antes) {
  if (!desdeKey || !sobreKey || desdeKey === sobreKey) return;
  const prefs = getProfile()?.column_prefs || {};
  const order = ordenCompleto(prefs);

  const i = order.indexOf(desdeKey);
  if (i < 0) return;
  order.splice(i, 1);
  let j = order.indexOf(sobreKey);
  if (j < 0) return;
  if (!antes) j += 1;
  order.splice(j, 0, desdeKey);

  // Si el usuario no tenía preferencias guardadas, este arrastre las crea. Hay
  // que sembrar `hidden` con lo que hay en pantalla ahora mismo; con la lista
  // vacía aparecerían de golpe las columnas ocultas por defecto.
  const hidden = Array.isArray(prefs.order) && prefs.order.length
    ? (prefs.hidden || [])
    : allColumns().map((c) => c.key).filter((k) => !visibleColumns().some((c) => c.key === k));

  await setPrefs({ order, hidden });
}

function clearDropHint() {
  document.getElementById('dropLine')?.remove();
  document.querySelectorAll('.gh.drop-target, .gh.dragging')
    .forEach((el) => el.classList.remove('drop-target', 'dragging'));
}

// Marca dónde va a aterrizar: una línea a toda la altura de la tabla en el punto
// exacto de inserción, y la cabecera de destino resaltada.
function showDropHint(gh, antes) {
  const table = document.querySelector('.gtable');
  if (!table) return;
  let line = document.getElementById('dropLine');
  if (!line) {
    line = document.createElement('div');
    line.id = 'dropLine';
    line.className = 'drop-line';
    table.appendChild(line);
  }
  const t = table.getBoundingClientRect();
  const r = gh.getBoundingClientRect();
  line.style.left = `${Math.round((antes ? r.left : r.right) - t.left)}px`;

  table.querySelectorAll('.gh.drop-target').forEach((el) => el.classList.remove('drop-target'));
  gh.classList.add('drop-target');
}

function initColumnDrag(grid) {
  grid.addEventListener('dragstart', (e) => {
    const gh = e.target.closest('.gh');
    if (!gh) return;
    drag = { key: gh.dataset.k };
    gh.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox no inicia el arrastre si no se fija algún dato.
    e.dataTransfer.setData('text/plain', gh.dataset.k);
  });

  grid.addEventListener('dragover', (e) => {
    if (!drag) return;
    const gh = e.target.closest('.gh');
    if (!gh) return;
    e.preventDefault();
    const r = gh.getBoundingClientRect();
    // Mitad izquierda → cae antes de esa columna; mitad derecha → después.
    drag.antes = (e.clientX - r.left) < r.width / 2;
    drag.sobre = gh.dataset.k;
    showDropHint(gh, drag.antes);
  });

  grid.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    const { key, sobre, antes } = drag;
    clearDropHint();
    drag = null;
    arrastroReciente = Date.now();
    moveColumn(key, sobre, antes);
  });

  grid.addEventListener('dragend', () => {
    clearDropHint();
    drag = null;
    arrastroReciente = Date.now();
  });

  // Soltar fuera de una cabecera no debe dejar la línea colgada.
  grid.addEventListener('dragleave', (e) => {
    if (drag && !e.relatedTarget?.closest?.('.ghead')) {
      document.querySelectorAll('.gh.drop-target').forEach((el) => el.classList.remove('drop-target'));
    }
  });
}

// ─────────────────────── selector de columnas ───────────────────────

export function openColumnPicker(anchorEl) {
  document.getElementById('colMenu')?.remove();
  const cols = allColumns();
  const visible = visibleColumns().map((c) => c.key);
  const order = [...visible, ...cols.map((c) => c.key).filter((k) => !visible.includes(k))];

  const menu = document.createElement('div');
  menu.id = 'colMenu';
  menu.className = 'fmenu colmenu';
  menu.innerHTML = `
    <div class="fmenu-head"><strong>Columnas</strong>
      <button class="fmenu-clear" type="button" data-reset>Restablecer</button></div>
    <div class="fmenu-list">
      ${order.map((k) => {
        const c = cols.find((x) => x.key === k);
        if (!c) return '';
        return `<div class="colrow" data-k="${escHtml(k)}">
          <label><input type="checkbox" ${visible.includes(k) ? 'checked' : ''} ${c.fixed ? 'disabled' : ''}>
            <span>${escHtml(c.label)}</span></label>
          <span class="colmove">
            <button type="button" data-up title="Subir">↑</button>
            <button type="button" data-down title="Bajar">↓</button>
          </span></div>`;
      }).join('')}
    </div>`;
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  menu.style.left = `${Math.round(Math.min(r.left, window.innerWidth - menu.offsetWidth - 12))}px`;

  function collect() {
    const rows = [...menu.querySelectorAll('.colrow')];
    return {
      order: rows.map((el) => el.dataset.k),
      hidden: rows.filter((el) => !el.querySelector('input').checked).map((el) => el.dataset.k),
    };
  }

  menu.addEventListener('change', () => setPrefs(collect()));
  menu.addEventListener('click', (e) => {
    const row = e.target.closest('.colrow');
    if (!row) return;
    if (e.target.closest('[data-up]') && row.previousElementSibling) {
      row.parentNode.insertBefore(row, row.previousElementSibling);
      setPrefs(collect());
    }
    if (e.target.closest('[data-down]') && row.nextElementSibling) {
      row.parentNode.insertBefore(row.nextElementSibling, row);
      setPrefs(collect());
    }
  });
  // Restablecer = borrar las preferencias, no guardar "todo visible".
  menu.querySelector('[data-reset]').addEventListener('click', () => {
    menu.remove();
    setPrefs({});
  });

  setTimeout(() => document.addEventListener('mousedown', outside), 0);
  function outside(e) {
    if (menu.contains(e.target) || anchorEl.contains(e.target)) return;
    document.removeEventListener('mousedown', outside);
    menu.remove();
  }
}

// ─────────────────────────── enganches ───────────────────────────

export function initGrid() {
  const grid = document.getElementById('grid');
  initColumnDrag(grid);
  initBulkBar();

  grid.addEventListener('click', (e) => {
    if (e.target.closest('[data-stop]')) return;    // enlaces de HubSpot

    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      // Red de seguridad: si el navegador emitiera un clic justo después de un
      // arrastre, mover una columna cambiaría además el orden de las filas.
      if (Date.now() - arrastroReciente < 250) return;
      const k = sortBtn.dataset.sort;
      if (sort.key === k) sort.dir *= -1; else { sort.key = k; sort.dir = 1; }
      render();
      return;
    }
    const filterBtn = e.target.closest('[data-filter]');
    if (filterBtn) {
      openFilterMenu(filterBtn.dataset.filter, filterBtn, render);
      return;
    }

    // Las casillas de selección viven en una celda, pero no son un campo que
    // editar: se atienden antes de que la celda haga nada.
    if (e.target.closest('[data-sel-all]')) {
      const rows = visibleRows();
      const todas = rows.length > 0 && selected.size >= rows.length;
      selected.clear();
      if (!todas) rows.forEach((r) => selected.add(r.id));
      lastSelId = null;
      refreshSelUi();
      return;
    }
    // Vale toda la celda, no solo la casilla: apuntar a 13 píxeles para marcar
    // una fila es pedir puntería.
    if (e.target.closest('.gsel')) {
      const id = e.target.closest('.grow').dataset.id;
      const rows = visibleRows();
      // Shift marca el rango desde la última que tocaste, como en cualquier
      // lista: marcar treinta filas seguidas no puede ser treinta clics.
      const desde = e.shiftKey && lastSelId ? rows.findIndex((r) => r.id === lastSelId) : -1;
      const hasta = rows.findIndex((r) => r.id === id);
      if (desde >= 0 && hasta >= 0) {
        for (let i = Math.min(desde, hasta); i <= Math.max(desde, hasta); i++) selected.add(rows[i].id);
      } else if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      lastSelId = id;
      refreshSelUi();
      return;
    }

    const cell = e.target.closest('.gc');
    const row = e.target.closest('.grow:not(.ghead)');
    if (!cell || !row) return;
    const acc = state.byId.get(row.dataset.id);
    if (!acc) return;

    // Un solo clic en «Notas» abre el historial. Va antes que la edición en
    // celda para que el botón no dispare además el editor.
    if (e.target.closest('[data-notes]')) { openNotes(acc.id); return; }

    // La estrella vive dentro de la celda del nombre, así que tiene que cortar
    // aquí o el mismo clic abriría además el renombrado.
    if (e.target.closest('[data-fav]')) { marcarFavorita(acc); return; }

    const col = allColumns().find((c) => c.key === cell.dataset.k);
    if (!col) return;

    // La última nota se edita con un clic sobre ella, como cualquier otra celda.
    // Si es de otro, no hay nada que abrir: el clic lleva al historial, que es
    // donde sí puede añadir la suya.
    if (col.type === 'note') {
      if (noteEditable(acc)) startNoteEdit(cell, acc, col);
      else openNotes(acc.id);
      return;
    }

    if (EDITABLE_TYPES.has(col.type)) startEdit(cell, acc, col);
  });

  // La ficha se abre solo con doble clic sobre el nombre de la cuenta: en el
  // resto de celdas el doble clic es parte de editar, no de navegar.
  grid.addEventListener('dblclick', (e) => {
    const cell = e.target.closest('.gc');
    const row = e.target.closest('.grow:not(.ghead)');
    if (!cell || !row || cell.dataset.k !== 'name') return;
    cancelEdit();   // el primer clic del par abrió el renombrado
    openPanel(row.dataset.id);
  });

  document.getElementById('q').addEventListener('input', (e) => {
    filters.search = e.target.value.trim();
    render();
  });
  document.getElementById('btnClear').addEventListener('click', () => {
    clearFilters();
    document.getElementById('q').value = '';
    closeFilterMenu();
    render();
  });
  document.getElementById('btnCols').addEventListener('click', (e) => openColumnPicker(e.currentTarget));

  // Repintar cuando algo cambie por debajo (Realtime, guardados, notas…),
  // salvo mientras se está editando una celda: no se le puede quitar el foco
  // al usuario a mitad de escribir. El repintado no se descarta, se aplaza:
  // closeEditor lo aplica al cerrar. Antes, un cambio llegado por Realtime
  // mientras alguien editaba se perdía y la fila se quedaba con el dato viejo.
  onChange(() => {
    if (editing) { pendingRender = true; return; }
    render();
  });

  window.addEventListener('resize', () => {
    closeFilterMenu();
    document.getElementById('bulkMenu')?.remove();
  });
}
