// Estado de filtrado y ordenación, KPIs y el desplegable de filtro por columna
// (el equivalente al autofiltro que tenía el Excel).
import { state, getValue, ownerName, columnByKey, notesFor } from './store.js';
import { getProfile } from './auth.js';
import { escHtml, todayISO, endOfWeekISO, fmtMonth } from './util.js';

export const filters = {
  search: '',
  values: {},        // clave de columna -> Set de valores marcados ('' = vacío)
  datePreset: null,  // 'hoy' | 'semana' | 'vencidos' | 'sinfecha'
  mine: false,
};

export const sort = { key: 'name', dir: 1 };

// Centinela de "sin valor". Es un Symbol, no una cadena, por dos razones:
// no puede colisionar con un valor real de la tabla, y no se puede colar en
// un atributo del DOM (que es justo lo que rompía el filtro de vacíos).
const VACIO = Symbol('vacio');

// Valor comparable/mostrable de una celda, ya resuelto (owner → nombre,
// última nota → su texto). Es lo que ven la búsqueda, el orden y la exportación.
export function cellValue(acc, key) {
  if (key === 'owner_id') return ownerName(acc);
  if (key === 'last_note') return acc.last_note?.body || '';
  if (key === 'notes_log') return acc.notes_count || 0;
  return getValue(acc, key);
}

// Valor por el que agrupa el embudo de una columna. Las fechas se agrupan por
// mes ('2026-08'): marcar día a día no es filtrar, es transcribir el calendario.
function filterKey(acc, key) {
  const raw = cellValue(acc, key);
  if (raw === null || raw === undefined || raw === '') return VACIO;
  if (columnByKey(key)?.filterBy === 'month') return String(raw).slice(0, 7);
  return String(raw);
}

function filterLabel(key, value) {
  if (value === VACIO) return '(vacío)';
  return columnByKey(key)?.filterBy === 'month' ? fmtMonth(value) : value;
}

export function hasActiveFilters() {
  return !!(filters.search || filters.datePreset || filters.mine ||
    Object.values(filters.values).some((s) => s && s.size));
}

export function clearFilters() {
  filters.search = '';
  filters.values = {};
  filters.datePreset = null;
  filters.mine = false;
}

// ¿Esta cuenta cae en uno de los cuatro presets de fecha? Un solo juez para el
// filtro y para los KPIs: el número del tile tiene que salir del mismo cálculo
// que las filas que salen al pulsarlo, no de otro que dé lo mismo por poco.
// 'hoy' y 'finSemana' entran como parámetros porque el bucle de KPIs los calcula
// una vez, mientras que aquí se llamaría una vez por cuenta.
function enPreset(acc, preset, hoy, finSemana) {
  const d = acc.next_touch;
  if (preset === 'sinfecha') return !d;
  if (!d) return false;
  if (preset === 'vencidos') return d < hoy;
  if (preset === 'hoy') return d === hoy;
  if (preset === 'semana') return d >= hoy && d <= finSemana;
  return true;
}

function matchesDate(acc) {
  if (!filters.datePreset) return true;
  return enPreset(acc, filters.datePreset, todayISO(), endOfWeekISO());
}

// Un solo juez de "cuenta mía", que comparten el filtro y el tile «Mías». Con dos
// predicados distintos el número del tile podía dejar de cuadrar con las filas.
const esMia = (acc) => !!acc.owner_id && acc.owner_id === getProfile()?.id;

// `omitir`: Set opcional de dimensiones que NO se aplican ('search' | 'mine' |
// 'date' | clave de columna). Lo usan los recuentos, porque cada mando de la
// interfaz cuenta ignorando solo el suyo (ver computeKpis y breakdown). Ninguna
// columna puede llamarse como esos tres centinelas: las de serie son fijas y las
// que crea el admin van siempre namespaced a 'custom.<clave>'.
//
// OJO al llamarlo: `.filter(matches)` NO vale. filter pasa (elemento, índice) y
// ese índice llegaría aquí como `omitir`.
export function matches(acc, omitir) {
  if (filters.search && !omitir?.has('search')) {
    const q = filters.search.toLowerCase();
    const campos = [acc.name, acc.region, acc.sector, ownerName(acc)]
      .some((v) => String(v || '').toLowerCase().includes(q));
    // La búsqueda entra en TODO el historial, no solo en la última nota: es lo
    // que hace útil el buscador (un nombre de contacto suele estar enterrado
    // en una entrada antigua). Las notas ya están en memoria, así que es gratis.
    if (!campos && !notesFor(acc.id).some((n) => n.body.toLowerCase().includes(q))) return false;
  }
  if (filters.mine && !omitir?.has('mine') && !esMia(acc)) return false;
  if (!omitir?.has('date') && !matchesDate(acc)) return false;

  for (const [key, set] of Object.entries(filters.values)) {
    if (!set || !set.size || omitir?.has(key)) continue;
    if (!set.has(filterKey(acc, key))) return false;
  }
  return true;
}

export function visibleRows() {
  const rows = state.accounts.filter((a) => matches(a));
  rows.sort((a, b) => {
    // Ordenar textos libres por su primera letra no dice nada; lo que se quiere
    // saber de la última nota es cuál se escribió más recientemente.
    if (sort.key === 'last_note') {
      const x = a.last_note?.created_at || '';
      const y = b.last_note?.created_at || '';
      if (!x && !y) return a.name.localeCompare(b.name, 'es');
      if (!x) return 1;
      if (!y) return -1;
      return (x < y ? 1 : x > y ? -1 : 0) * sort.dir;   // más reciente primero
    }

    const x = cellValue(a, sort.key);
    const y = cellValue(b, sort.key);
    // Los vacíos siempre al final, se ordene como se ordene: una fila sin dato
    // no es "la más pequeña", es la que menos interesa mirar.
    const ex = x === null || x === undefined || x === '';
    const ey = y === null || y === undefined || y === '';
    if (ex && ey) return a.name.localeCompare(b.name, 'es');
    if (ex) return 1;
    if (ey) return -1;
    if (sort.key === 'next_touch' || sort.key === 'updated_at') {
      return (String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0) * sort.dir;
    }
    return String(x).localeCompare(String(y), 'es', { numeric: true }) * sort.dir;
  });
  return rows;
}

// Valores distintos de una columna con su recuento, para el desplegable.
// Se calculan sobre las filas que pasan TODOS los demás filtros, como en Excel:
// así los recuentos reflejan lo que realmente vas a ver al marcar.
export function distinctFor(key) {
  const base = state.accounts.filter((a) => matches(a, new Set([key])));

  const counts = new Map();
  for (const acc of base) {
    const v = filterKey(acc, key);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  // Se ordena por el valor de agrupación, no por la etiqueta: en los meses
  // 'YYYY-MM' eso ya da orden cronológico, mientras que 'ago 2026' daría
  // alfabético (abr, ago, dic…).
  const out = [...counts.entries()]
    .filter(([v]) => v !== VACIO)
    .sort((a, b) => a[0].localeCompare(b[0], 'es', { numeric: true }))
    .map(([value, count]) => ({ value, label: filterLabel(key, value), count }));
  if (counts.has(VACIO)) out.push({ value: VACIO, label: '(vacío)', count: counts.get(VACIO) });
  return out;
}

export function isFiltered(key) {
  return !!(filters.values[key] && filters.values[key].size);
}

// ─────────────────────────── KPIs ───────────────────────────
// Cada tile dice cuántas filas verás al pulsarlo: respeta los demás filtros e
// ignora solo el suyo. Contar sobre el total dejaba los seis números clavados al
// filtrar por owner (el tile decía 10 vencidas y en la tabla había una); contar
// sobre lo filtrado los movería bajo el dedo, porque pulsar «Vencidos» dejaría
// «Hoy» en 0 y no quedaría desde dónde volver.
// Las cuatro fechas son un mismo mando, así que comparten base.
const OMITE_FECHA = new Set(['date']);
const OMITE_MIAS = new Set(['mine']);

export function computeKpis() {
  const hoy = todayISO();
  const finSemana = endOfWeekISO();
  const base = state.accounts.filter((a) => matches(a, OMITE_FECHA));
  const k = { total: base.length, hoy: 0, semana: 0, vencidos: 0, sinfecha: 0, mias: 0 };
  for (const a of base) {
    if (enPreset(a, 'sinfecha', hoy, finSemana)) { k.sinfecha++; continue; }
    if (enPreset(a, 'hoy', hoy, finSemana)) k.hoy++;
    if (enPreset(a, 'semana', hoy, finSemana)) k.semana++;
    if (enPreset(a, 'vencidos', hoy, finSemana)) k.vencidos++;
  }
  // «Mías» es otro mando: respeta el preset de fecha y solo ignora su propio
  // interruptor, así que lleva pasada propia. Y hay que forzar la condición
  // además de omitirla: un interruptor ignorado no cuenta a los míos, cuenta a
  // todo el mundo. esMia va delante porque corta antes de recorrer las notas de
  // las cuentas ajenas.
  for (const a of state.accounts) if (esMia(a) && matches(a, OMITE_MIAS)) k.mias++;
  return k;
}

// Recuentos por columna para las pastillas clicables (Owner, Deal, Sector…).
// Como los tiles: se cuentan sobre las filas que pasan todos los filtros MENOS
// el de esta columna, así que «Daniel San Martín 6» son las seis que verías al
// pulsarla, no las que tiene en toda la tabla.
export function breakdown(key, limit = 8) {
  const base = state.accounts.filter((a) => matches(a, new Set([key])));
  const counts = new Map();
  for (const a of base) {
    // El mismo agrupador que el embudo, no el valor crudo: en una columna con
    // filterBy:'month' la pastilla guardaría '2026-08-14' mientras el filtro
    // compara contra '2026-08', y no casaría nunca.
    const v = filterKey(a, key);
    if (v === VACIO) continue;   // los huecos se acotan desde el embudo, no con pastilla
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const out = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

  // Una pastilla marcada no puede desaparecer: si otro filtro deja su recuento a
  // 0 o la echa del top, seguiría filtrando y es el único sitio donde se apaga.
  for (const v of filters.values[key] || []) {
    // El embudo mete el centinela VACIO (un Symbol) en este mismo Set, y de aquí
    // el valor sale hacia un atributo del DOM, por donde un Symbol no viaja.
    if (typeof v !== 'string' || out.some(([w]) => w === v)) continue;
    out.push([v, counts.get(v) || 0]);
  }
  return out;
}

// ──────────────── desplegable de filtro por columna ────────────────
let openKey = null;

export function closeFilterMenu() {
  document.getElementById('filterMenu')?.remove();
  openKey = null;
}

export function openFilterMenu(key, anchorEl, onApply) {
  const col = columnByKey(key);
  if (col?.noFilter) return;   // texto libre: la lista de valores no filtra nada
  if (openKey === key) { closeFilterMenu(); return; }
  closeFilterMenu();
  openKey = key;

  const opts = distinctFor(key);
  const sel = filters.values[key] || new Set();

  const menu = document.createElement('div');
  menu.id = 'filterMenu';
  menu.className = 'fmenu';
  menu.innerHTML = `
    <div class="fmenu-head">
      <strong>${escHtml(col?.label || key)}</strong>
      <button class="fmenu-clear" type="button">Quitar filtro</button>
    </div>
    <input class="fmenu-search" type="text" placeholder="Buscar valor…" autocomplete="off">
    <div class="fmenu-actions">
      <button type="button" data-all>Todo</button>
      <button type="button" data-none>Nada</button>
    </div>
    <div class="fmenu-list">
      ${opts.map((o, i) => `
        <label class="fmenu-opt" data-i="${i}">
          <input type="checkbox" ${sel.has(o.value) ? 'checked' : ''}>
          <span class="fmenu-lbl">${escHtml(o.label)}</span>
          <span class="fmenu-n">${o.count}</span>
        </label>`).join('') || '<div class="fmenu-empty">Sin valores</div>'}
    </div>`;
  document.body.appendChild(menu);

  const r = anchorEl.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  // Si el menú se saliera por la derecha, se alinea con el borde derecho.
  const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 12);
  menu.style.left = `${Math.round(Math.max(8, left))}px`;

  function apply() {
    const set = new Set();
    menu.querySelectorAll('.fmenu-opt').forEach((el) => {
      if (el.querySelector('input').checked) set.add(opts[Number(el.dataset.i)].value);
    });
    // Marcar todo equivale a no filtrar: evita dejar el embudo encendido
    // cuando en realidad no se está descartando nada.
    if (set.size === 0 || set.size === opts.length) delete filters.values[key];
    else filters.values[key] = set;
    onApply();
  }

  menu.addEventListener('change', apply);
  menu.querySelector('[data-all]').addEventListener('click', () => {
    menu.querySelectorAll('.fmenu-opt input').forEach((i) => { i.checked = true; });
    apply();
  });
  menu.querySelector('[data-none]').addEventListener('click', () => {
    menu.querySelectorAll('.fmenu-opt input').forEach((i) => { i.checked = false; });
    apply();
  });
  menu.querySelector('.fmenu-clear').addEventListener('click', () => {
    delete filters.values[key];
    closeFilterMenu();
    onApply();
  });
  menu.querySelector('.fmenu-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    menu.querySelectorAll('.fmenu-opt').forEach((el) => {
      el.style.display = el.querySelector('.fmenu-lbl').textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  menu.querySelector('.fmenu-search').focus();

  setTimeout(() => {
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', onEsc);
  }, 0);
  function outside(e) {
    if (menu.contains(e.target) || anchorEl.contains(e.target)) return;
    cleanup();
  }
  function onEsc(e) { if (e.key === 'Escape') cleanup(); }
  function cleanup() {
    document.removeEventListener('mousedown', outside);
    document.removeEventListener('keydown', onEsc);
    closeFilterMenu();
  }
}
