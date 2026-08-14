// Menciones @Nombre dentro de las notas.
//
// A quién menciona una nota NO se guarda en ninguna parte: se deduce de su
// texto, que es la única fuente de verdad. Así, si alguien edita la nota y
// quita el @, la mención desaparece sola y no hay nada que sincronizar. Lo
// único que se persiste es lo que no está escrito en el texto: si tú ya la has
// atendido (tabla `mention_states`, una fila por mención hecha).
import { state, markMentionDone, undoMentionDone, onNoteArrived, onChange } from './store.js';
import { getProfile } from './auth.js';
import { escHtml, fmtDateTime, toast } from './util.js';
import { writeFailed } from './net.js';

// Lo pone main.js: qué hacer al pulsar «Ver» en la bandeja. Se inyecta en vez de
// importar panel.js para no cerrar un ciclo entre los dos módulos.
let abrirNota = () => {};

// ───────────────────── a quién se puede mencionar ─────────────────────

const displayName = (p) => p.full_name || p.email || '';

// Nombre completo y, además, el nombre de pila cuando no lo comparte nadie:
// «@Ana» tiene que funcionar, que es como se llaman entre ellos. Se ordenan de
// más largo a más corto para que «@Ana Ruiz» gane a «@Ana» y no quede media
// mención suelta detrás.
//
// La comparación es exacta salvo mayúsculas: el autocompletado inserta el
// nombre tal cual, así que el camino normal siempre casa.
function candidates() {
  const activos = state.profiles.filter((p) => p.is_active && displayName(p));
  const pilas = new Map();
  for (const p of activos) {
    const pila = displayName(p).trim().split(/\s+/)[0].toLowerCase();
    pilas.set(pila, (pilas.get(pila) || 0) + 1);
  }

  const out = [];
  for (const p of activos) {
    out.push({ p, alias: displayName(p) });
    const pila = displayName(p).trim().split(/\s+/)[0];
    if (pila.toLowerCase() !== displayName(p).toLowerCase() && pilas.get(pila.toLowerCase()) === 1) {
      out.push({ p, alias: pila });
    }
  }
  return out.sort((a, b) => b.alias.length - a.alias.length);
}

// Perfiles nombrados en un texto.
export function parseMentions(body) {
  if (!body || !body.includes('@')) return [];
  const hay = body.toLowerCase();
  const cands = candidates().map((c) => ({ ...c, n: c.alias.toLowerCase() }));
  const out = [];
  for (let at = hay.indexOf('@'); at >= 0; at = hay.indexOf('@', at + 1)) {
    const hit = cands.find((c) => hay.startsWith(c.n, at + 1));
    if (hit && !out.includes(hit.p)) out.push(hit.p);
  }
  return out;
}

export function mentionsMe(note) {
  const me = getProfile()?.id;
  return !!me && parseMentions(note.body).some((p) => p.id === me);
}

// ───────────────────────── pintado ─────────────────────────

// Cuerpo de una nota listo para insertar: escapado primero y con las menciones
// resaltadas después. El resaltado trabaja SOBRE el texto ya escapado y solo
// envuelve trozos de él, así que nada de lo que escribe el usuario vuelve a
// interpretarse como HTML.
export function renderNoteBody(body) {
  const html = escHtml(body);
  if (!html.includes('@')) return html;

  const me = getProfile()?.id;
  const hay = html.toLowerCase();
  const cands = candidates().map((c) => ({ p: c.p, n: escHtml(c.alias).toLowerCase() }));

  let out = '';
  let i = 0;
  for (let at = hay.indexOf('@'); at >= 0; at = hay.indexOf('@', at + 1)) {
    if (at < i) continue;   // ya está dentro de una mención pintada
    const hit = cands.find((c) => hay.startsWith(c.n, at + 1));
    if (!hit) continue;
    const fin = at + 1 + hit.n.length;
    out += html.slice(i, at)
      + `<span class="mention${hit.p.id === me ? ' me' : ''}">${html.slice(at, fin)}</span>`;
    i = fin;
  }
  return out + html.slice(i);
}

// ───────────────────── bandeja de pendientes ─────────────────────

// Recorrer todas las notas por cada repintado sería tirar el trabajo; el caché
// se invalida cuando cambia algo, que es justo cuando deja de valer.
let cache = null;
onChange(() => { cache = null; });

// Menciones mías sin atender, de la más reciente a la más antigua.
export function pendingMentions() {
  if (cache) return cache;
  const me = getProfile();
  if (!me) return [];

  const out = [];
  for (const [accountId, notas] of state.notes) {
    const acc = state.byId.get(accountId);
    if (!acc) continue;
    for (const n of notas) {
      // La nota propia no genera recado aunque te nombres en ella.
      if (n.author_id === me.id) continue;
      if (state.mentionsDone.has(n.id)) continue;
      if (!mentionsMe(n)) continue;
      out.push({ note: n, account: acc });
    }
  }
  out.sort((a, b) => (a.note.created_at < b.note.created_at ? 1 : -1));
  cache = out;
  return out;
}

// Cuentas con alguna mención mía pendiente. Lo usa el filtro de la tabla.
export function pendingAccountIds() {
  return new Set(pendingMentions().map((m) => m.account.id));
}

async function marcarHecha(noteId) {
  const me = getProfile();
  if (!me) return;
  const { error } = await markMentionDone(noteId, me.id);
  if (error) { await writeFailed(error, 'marcar la mención'); return; }
  toast('Mención hecha.', 'ok', {
    label: 'Deshacer',
    fn: async () => {
      const r = await undoMentionDone(noteId);
      if (r.error) await writeFailed(r.error, 'deshacer');
    },
  });
}

// ───────────────────── autocompletado al escribir @ ─────────────────────
//
// OJO con el editor en celda de la tabla: usa Escape para cancelar la edición,
// Ctrl/⌘+Enter para guardar y `blur` para confirmar. Con la lista abierta esas
// teclas son de la lista, así que se para la propagación INMEDIATA (los dos
// listeners viven en el mismo textarea, y stopPropagation a secas no basta) y
// la lista se maneja con mousedown+preventDefault para no provocar el blur.

let lista = null;
let listaCtx = null;   // { ta, desde, opciones, activo }

function cerrarLista() {
  lista?.remove();
  lista = null;
  listaCtx = null;
}

function pintarLista() {
  if (!listaCtx) return;
  lista.innerHTML = listaCtx.opciones.map((o, i) => `
    <button type="button" class="mn-opt${i === listaCtx.activo ? ' on' : ''}" data-i="${i}">
      ${escHtml(displayName(o))}</button>`).join('');

  const r = listaCtx.ta.getBoundingClientRect();
  lista.style.top = `${Math.round(r.bottom + 4)}px`;
  lista.style.left = `${Math.round(Math.min(r.left, window.innerWidth - 220))}px`;
}

function elegir(i) {
  const ctx = listaCtx;
  if (!ctx || !ctx.opciones[i]) return;
  const { ta, desde } = ctx;
  const nombre = displayName(ctx.opciones[i]);
  const fin = ta.selectionStart;
  ta.value = `${ta.value.slice(0, desde)}@${nombre} ${ta.value.slice(fin)}`;
  const cursor = desde + nombre.length + 2;
  cerrarLista();
  ta.focus();
  ta.setSelectionRange(cursor, cursor);
  // El editor en celda crece con el texto escuchando 'input'.
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function buscar(ta) {
  const hasta = ta.selectionStart;
  const antes = ta.value.slice(0, hasta);
  // Una mención no cruza líneas ni otro @, y dos palabras son de sobra para un
  // nombre y un apellido.
  const m = /@([^\n@]{0,24})$/.exec(antes);
  if (!m || m[1].split(' ').length > 2) { cerrarLista(); return; }

  const q = m[1].toLowerCase();
  const opciones = state.profiles.filter((p) => p.is_active && displayName(p)
    && displayName(p).toLowerCase().includes(q));
  if (!opciones.length) { cerrarLista(); return; }

  if (!lista) {
    lista = document.createElement('div');
    lista.className = 'mn-list';
    // mousedown y no click: el click llega después del blur, y el blur del
    // editor en celda guarda y desmonta el textarea antes de tiempo.
    lista.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const b = e.target.closest('[data-i]');
      if (b) elegir(Number(b.dataset.i));
    });
    document.body.appendChild(lista);
  }
  listaCtx = { ta, desde: hasta - m[0].length, opciones, activo: 0 };
  pintarLista();
}

// Engancha el autocompletado a un textarea. Debe llamarse ANTES de que el
// editor registre sus propias teclas: con los dos listeners en el mismo
// elemento, manda el orden de registro.
export function attachMentions(ta) {
  ta.addEventListener('input', () => buscar(ta));
  ta.addEventListener('blur', () => setTimeout(cerrarLista, 0));
  ta.addEventListener('keydown', (e) => {
    if (!listaCtx || listaCtx.ta !== ta) return;
    const n = listaCtx.opciones.length;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      listaCtx.activo = (listaCtx.activo + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      pintarLista();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      elegir(listaCtx.activo);
    } else if (e.key === 'Escape') {
      cerrarLista();   // primer Escape: cierra la lista, no la edición
    } else {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  });
}

// ───────────────────── botón, insignia y bandeja ─────────────────────

let menu = null;

export function refreshBadge() {
  const btn = document.getElementById('btnMentions');
  if (!btn) return;
  const n = pendingMentions().length;
  btn.querySelector('.mn-badge').textContent = n;
  btn.querySelector('.mn-badge').hidden = n === 0;
  btn.title = n ? `${n} mención${n === 1 ? '' : 'es'} sin atender` : 'No tienes menciones pendientes';
  if (menu) pintarBandeja();
}

function pintarBandeja() {
  const items = pendingMentions();
  menu.innerHTML = `
    <div class="fmenu-head"><strong>Menciones</strong>
      <span class="muted">${items.length ? `${items.length} sin atender` : 'al día'}</span></div>
    <div class="mn-inbox">
      ${items.length ? items.map((m) => `
        <article class="mn-item" data-note="${escHtml(m.note.id)}" data-acc="${escHtml(m.account.id)}">
          <header><strong>${escHtml(m.account.name)}</strong>
            <span class="muted">${escHtml(m.note.author_name || 'Anónimo')} · ${fmtDateTime(m.note.created_at)}</span>
          </header>
          <p>${renderNoteBody(m.note.body)}</p>
          <div class="mn-acts">
            <button type="button" data-ver>Ver</button>
            <button type="button" data-hecha>Hecho</button>
          </div>
        </article>`).join('')
      : '<p class="muted mn-vacio">Nadie te ha mencionado. Cuando lo hagan, aparecerá aquí.</p>'}
    </div>`;
}

function cerrarBandeja() {
  menu?.remove();
  menu = null;
}

function abrirBandeja(anchorEl) {
  if (menu) { cerrarBandeja(); return; }
  menu = document.createElement('div');
  menu.className = 'fmenu mn-menu';
  document.body.appendChild(menu);
  pintarBandeja();

  const r = anchorEl.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.left - 260, window.innerWidth - menu.offsetWidth - 12)))}px`;

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.mn-item');
    if (!item) return;
    if (e.target.closest('[data-ver]')) {
      cerrarBandeja();
      abrirNota(item.dataset.acc, item.dataset.note);
    } else if (e.target.closest('[data-hecha]')) {
      marcarHecha(item.dataset.note);
    }
  });

  setTimeout(() => document.addEventListener('mousedown', fuera), 0);
  function fuera(e) {
    if (menu?.contains(e.target) || anchorEl.contains(e.target)) return;
    document.removeEventListener('mousedown', fuera);
    cerrarBandeja();
  }
}

export function initMentions({ onOpen }) {
  abrirNota = onOpen || (() => {});
  const btn = document.getElementById('btnMentions');
  btn.addEventListener('click', () => abrirBandeja(btn));

  // Aviso en vivo: la nota de otro llega por Realtime, así que enterarse de que
  // te han mencionado no debería exigir recargar ni mirar la insignia.
  onNoteArrived((note) => {
    if (!mentionsMe(note)) return;
    const acc = state.byId.get(note.account_id);
    toast(`${note.author_name || 'Alguien'} te ha mencionado en «${acc?.name || 'una cuenta'}».`, 'ok', {
      label: 'Ver',
      fn: () => abrirNota(note.account_id, note.id),
    });
  });

  onChange(refreshBadge);
  refreshBadge();
}
