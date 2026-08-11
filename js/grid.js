// La tabla: cabecera con orden y filtro, filas con edición en celda, tiles de
// KPI y selector de columnas. Todo se repinta desde memoria.
import { state, allColumns, updateField, ownerName, getValue, onChange } from './store.js';
import { getProfile, saveColumnPrefs } from './auth.js';
import { DEFAULT_VISIBLE, EDITABLE_TYPES } from './data.js';
import {
  filters, sort, visibleRows, computeKpis, breakdown, hasActiveFilters,
  clearFilters, isFiltered, openFilterMenu, closeFilterMenu, cellValue,
} from './filters.js';
import { escHtml, fmtDate, fmtDateTime, daysFromToday, toast } from './util.js';
import { openPanel } from './panel.js';

const HS_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="18" cy="6" r="2.6"/><circle cx="6" cy="12" r="3"/><circle cx="17" cy="17.5" r="2.6"/><path d="M8.6 10.6 15.6 7M8.7 13.6l6 3.2"/></svg>';

let editing = null;   // { id, key } de la celda abierta

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

function kpiTile(value, label, active, attr) {
  return `<button class="kpi${active ? ' on' : ''}" ${attr} type="button">
    <span class="kpi-v">${value}</span><span class="kpi-l">${escHtml(label)}</span></button>`;
}

function renderKpis() {
  const k = computeKpis();
  const el = document.getElementById('kpis');
  // Grupo de pastillas con su etiqueta. Si la columna está vacía en toda la
  // tabla (p. ej. nadie ha puesto Deal todavía) no se pinta el grupo: una
  // etiqueta suelta sin nada al lado solo genera dudas.
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
  const deals = grupo('Deal', 'deal_stage');

  el.innerHTML = `
    <div class="kpi-row">
      ${kpiTile(k.total, 'Cuentas', !hasActiveFilters(), 'data-kpi="todo"')}
      ${kpiTile(k.hoy, 'Hoy', filters.datePreset === 'hoy', 'data-kpi="hoy"')}
      ${kpiTile(k.semana, 'Esta semana', filters.datePreset === 'semana', 'data-kpi="semana"')}
      ${kpiTile(k.vencidos, 'Vencidos', filters.datePreset === 'vencidos', 'data-kpi="vencidos"')}
      ${kpiTile(k.sinfecha, 'Sin fecha', filters.datePreset === 'sinfecha', 'data-kpi="sinfecha"')}
      ${kpiTile(k.mias, 'Mías', filters.mine, 'data-kpi="mias"')}
    </div>
    <div class="chip-row"${owners || deals ? '' : ' hidden'}>
      ${owners}${owners && deals ? '<span class="chip-sep"></span>' : ''}${deals}
    </div>`;

  el.querySelectorAll('[data-kpi]').forEach((b) => b.addEventListener('click', () => {
    const k2 = b.dataset.kpi;
    if (k2 === 'todo') clearFilters();
    else if (k2 === 'mias') { filters.mine = !filters.mine; }
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

function cellHtml(acc, col) {
  const v = cellValue(acc, col.key);

  if (col.key === 'name') {
    const link = acc.hubspot_url
      ? `<a class="hs-dot" href="${escHtml(acc.hubspot_url)}" target="_blank" rel="noopener"
            title="Abrir en HubSpot" data-stop>${HS_ICON}</a>` : '';
    return `<span class="gname">${escHtml(acc.name)}</span>${link}`;
  }
  if (col.type === 'link') {
    return acc.hubspot_url
      ? `<a class="hs-chip" href="${escHtml(acc.hubspot_url)}" target="_blank" rel="noopener" data-stop>${HS_ICON} Abrir</a>`
      : '<span class="muted">—</span>';
  }
  if (col.key === 'next_touch') {
    if (!v) return '<span class="muted">—</span>';
    const d = daysFromToday(v);
    const cls = d < 0 ? 'due late' : d === 0 ? 'due today' : '';
    return `<span class="${cls}">${fmtDate(v)}</span>`;
  }
  if (col.key === 'updated_at') return `<span class="muted">${fmtDateTime(v)}</span>`;
  if (col.key === 'notes_count') {
    return v ? `<span class="ncount">${v}</span>` : '<span class="muted">—</span>';
  }
  if (col.key === 'deal_stage' && v) return `<span class="deal d-${escHtml(String(v).replace(/\s+/g, '-'))}">${escHtml(v)}</span>`;
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
  const tpl = cols.map((c) => `minmax(${c.min}px, ${c.width})`).join(' ');

  const head = cols.map((c) => `
    <div class="gc gh${isFiltered(c.key) ? ' filtered' : ''}" data-k="${escHtml(c.key)}">
      <button class="gh-sort" type="button" data-sort="${escHtml(c.key)}">
        ${escHtml(c.label)}${sort.key === c.key ? `<i class="arr">${sort.dir > 0 ? '▲' : '▼'}</i>` : ''}
      </button>
      <button class="gh-filter" type="button" data-filter="${escHtml(c.key)}" title="Filtrar">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4"
             stroke-linecap="round"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>
      </button>
    </div>`).join('');

  const body = rows.map((a) => {
    const d = a.next_touch ? daysFromToday(a.next_touch) : null;
    const cls = d !== null && d < 0 ? ' overdue' : '';
    return `<div class="grow${cls}" data-id="${a.id}">${cols.map((c) => `
      <div class="gc${EDITABLE_TYPES.has(c.type) ? ' editable' : ''}" data-k="${escHtml(c.key)}">${cellHtml(a, c)}</div>`).join('')}</div>`;
  }).join('');

  document.getElementById('grid').innerHTML = `
    <div class="gtable" style="--cols:${tpl}">
      <div class="grow ghead">${head}</div>
      <div class="gbody">${body || '<div class="gempty">Ninguna cuenta cumple los filtros.</div>'}</div>
    </div>`;

  document.getElementById('rowCount').textContent =
    rows.length === state.accounts.length
      ? `${rows.length} cuentas`
      : `${rows.length} de ${state.accounts.length} cuentas`;
  document.getElementById('btnClear').hidden = !hasActiveFilters();
}

// ─────────────────────── edición en celda ───────────────────────

function closeEditor(cellEl, acc, col) {
  editing = null;
  cellEl.classList.remove('editing');
  cellEl.innerHTML = cellHtml(acc, col);
}

function startEdit(cellEl, acc, col) {
  if (editing) return;
  editing = { id: acc.id, key: col.key };
  cellEl.classList.add('editing');

  const raw = col.key === 'owner_id' ? (acc.owner_id || '') : (getValue(acc, col.key) ?? '');
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
    done = true;
    const next = ctrl.value === '' ? null : ctrl.value;
    const before = col.key === 'owner_id' ? (acc.owner_id || null) : (getValue(acc, col.key) ?? null);
    if (String(next ?? '') === String(before ?? '')) { closeEditor(cellEl, acc, col); return; }
    if (col.key === 'name' && !next) {
      toast('La cuenta necesita un nombre.', 'err');
      closeEditor(cellEl, acc, col);
      return;
    }
    closeEditor(cellEl, acc, col);
    const { error } = await updateField(acc.id, col.key, next);
    if (error) toast(`No se pudo guardar: ${error.message}`, 'err');
  }
  function cancel() {
    if (done) return;
    done = true;
    closeEditor(cellEl, acc, col);
  }

  ctrl.addEventListener('blur', commit);
  ctrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); ctrl.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  if (ctrl.tagName === 'SELECT') ctrl.addEventListener('change', () => ctrl.blur());
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

  grid.addEventListener('click', (e) => {
    if (e.target.closest('[data-stop]')) return;    // enlaces de HubSpot

    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
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

    const cell = e.target.closest('.gc');
    const row = e.target.closest('.grow:not(.ghead)');
    if (!cell || !row) return;
    const acc = state.byId.get(row.dataset.id);
    if (!acc) return;
    const col = allColumns().find((c) => c.key === cell.dataset.k);
    if (!col) return;

    if (EDITABLE_TYPES.has(col.type)) startEdit(cell, acc, col);
  });

  // Doble clic en cualquier parte de la fila (o clic en una celda no editable):
  // abre la ficha completa.
  grid.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.grow:not(.ghead)');
    if (row) openPanel(row.dataset.id);
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
  // al usuario a mitad de escribir.
  onChange((reason) => {
    if (editing && reason !== 'load') return;
    render();
  });

  window.addEventListener('resize', closeFilterMenu);
}
