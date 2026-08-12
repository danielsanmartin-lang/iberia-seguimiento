// Estado en memoria y acceso a datos.
//
// Se descarga TODO una vez (397 filas hoy, y no va a crecer un orden de
// magnitud) y a partir de ahí filtrar, ordenar y calcular KPIs es trabajo en
// memoria: ninguna interacción de la tabla vuelve a consultar la red.
//
// Encima va Realtime: al ser una hoja compartida por tres personas, un cambio
// de uno tiene que aparecer en la pantalla de los otros sin recargar.
import { sb } from './supabaseClient.js';
import { GRID_COLUMNS, PANEL_FIELDS } from './data.js';
import {
  realtimeStarted, realtimeStopped, noteRealtimeStatus, withStatus,
} from './net.js';

// Un DELETE bloqueado por RLS no da error: borra cero filas y responde que todo
// ha ido bien. Sin esto, la app se cree el borrado, lo quita de la pantalla y la
// fila sigue en la base de datos hasta que alguien recarga.
const NO_ROW = () => ({
  message: 'No se ha borrado nada: la fila ya no existe o no tienes permiso.',
  code: 'APP_NO_ROW',
});

export const state = {
  accounts: [],
  byId: new Map(),
  profiles: [],          // los tres usuarios, para el desplegable de Owner
  catalogs: { region: [], sector: [] },
  fields: [],            // columnas personalizadas definidas por el admin
  notes: new Map(),      // account_id -> [notas], la más reciente primero
};

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(reason) { listeners.forEach((fn) => fn(reason)); }

function index() {
  state.byId = new Map(state.accounts.map((a) => [a.id, a]));
}

// Las columnas personalizadas del admin, en formato de columna/campo.
function customFields() {
  return state.fields.map((f) => ({
    key: `custom.${f.key}`,
    label: f.label,
    type: f.type === 'select' ? 'select' : f.type,
    options: f.options || [],
    custom: true,
    width: '1fr',
    min: 110,
  }));
}

// Todas las columnas que puede mostrar la tabla.
export function allColumns() {
  return [...GRID_COLUMNS, ...customFields()];
}

// Todos los campos que edita la ficha (Deal y HubSpot solo están aquí).
export function panelFields() {
  return [...PANEL_FIELDS, ...customFields()];
}

export function columnByKey(key) {
  return allColumns().find((c) => c.key === key) || null;
}

// Lee un valor de cuenta admitiendo la notación "custom.<clave>".
export function getValue(acc, key) {
  if (key.startsWith('custom.')) return acc.custom?.[key.slice(7)] ?? null;
  return acc[key] ?? null;
}

export function ownerName(acc) {
  if (acc.owner_id) {
    const p = state.profiles.find((x) => x.id === acc.owner_id);
    if (p) return p.full_name || p.email || '—';
  }
  // Cuentas migradas cuyo owner todavía no tiene cuenta en la app.
  return acc.owner_name || '';
}

// Notas de una cuenta, la más reciente primero.
export function notesFor(accountId) {
  return state.notes.get(accountId) || [];
}

// Recalcula lo que la tabla necesita de las notas de una cuenta. Se llama tras
// cualquier cambio (propio o llegado por Realtime): la celda "Última nota"
// muestra el cuerpo, así que no basta con llevar la cuenta de cuántas hay.
export function resyncNotes(accountId) {
  const acc = state.byId.get(accountId);
  if (!acc) return;
  const list = notesFor(accountId);
  acc.notes_count = list.length;
  acc.last_note = list[0] || null;
}

export async function loadAll() {
  const [accs, notes, profs, cats, flds] = await Promise.all([
    sb.from('accounts').select('*').order('name'),
    // Se traen los cuerpos completos, no solo el recuento: la tabla muestra el
    // texto de la última nota de cada cuenta. Son ~250 notas y ~30 KB, y de
    // paso la ficha se abre sin esperar a la red.
    sb.from('account_notes').select('*').order('created_at', { ascending: false }),
    sb.from('profiles').select('id, full_name, email, role, is_active').order('full_name'),
    sb.from('catalog_options').select('kind, value, position').order('position'),
    sb.from('field_defs').select('*').order('position'),
  ]);
  if (accs.error) throw withStatus(accs.error, accs.status);
  if (notes.error) throw withStatus(notes.error, notes.status);

  state.accounts = (accs.data || []).map((a) => ({ ...a, custom: a.custom || {} }));
  index();

  state.notes = new Map();
  for (const n of notes.data || []) {
    const list = state.notes.get(n.account_id);
    if (list) list.push(n); else state.notes.set(n.account_id, [n]);
  }
  state.accounts.forEach((a) => resyncNotes(a.id));

  state.profiles = profs.data || [];
  state.catalogs = {
    region: (cats.data || []).filter((c) => c.kind === 'region').map((c) => c.value),
    sector: (cats.data || []).filter((c) => c.kind === 'sector').map((c) => c.value),
  };
  state.fields = flds.data || [];
  emit('load');
}

// ─────────────────────────── escrituras ───────────────────────────

// Guarda un solo campo. Actualiza la memoria antes de que responda el servidor
// (la tabla no puede parpadear al teclear) y revierte si falla.
export async function updateField(id, key, value) {
  const acc = state.byId.get(id);
  if (!acc) return { error: new Error('Cuenta no encontrada') };

  let patch;
  let prev;
  if (key.startsWith('custom.')) {
    const ck = key.slice(7);
    prev = { custom: { ...acc.custom } };
    const custom = { ...acc.custom };
    if (value === null || value === '') delete custom[ck]; else custom[ck] = value;
    patch = { custom };
  } else {
    prev = { [key]: acc[key] };
    patch = { [key]: value === '' ? null : value };
    // owner_id y owner_name viajan juntos: owner_name es el rastro legible que
    // sobrevive aunque más adelante se borre el usuario.
    if (key === 'owner_id') {
      const p = state.profiles.find((x) => x.id === value);
      prev.owner_name = acc.owner_name;
      patch.owner_name = p ? (p.full_name || p.email) : null;
    }
  }

  Object.assign(acc, patch);
  emit('optimistic');

  const { data, error, status } = await sb.from('accounts').update(patch).eq('id', id).select().single();
  if (error) {
    Object.assign(acc, prev);
    emit('revert');
    return { error: withStatus(error, status) };
  }
  // La respuesta no trae los campos derivados de las notas: se preservan.
  Object.assign(acc, data, {
    custom: data.custom || {},
    notes_count: acc.notes_count,
    last_note: acc.last_note,
  });
  emit('save');
  return {};
}

export async function createAccount(fields) {
  const { data, error, status } = await sb.from('accounts').insert(fields).select().single();
  if (error) return { error: withStatus(error, status) };
  const acc = { ...data, custom: data.custom || {}, notes_count: 0, last_note: null };
  state.accounts.push(acc);
  index();
  emit('insert');
  return { account: acc };
}

// Alta masiva (importación). Devuelve las filas creadas.
export async function createAccounts(rows) {
  const { data, error, status } = await sb.from('accounts').insert(rows).select();
  if (error) return { error: withStatus(error, status) };
  const created = (data || []).map((d) => ({
    ...d, custom: d.custom || {}, notes_count: 0, last_note: null,
  }));
  state.accounts.push(...created);
  index();
  emit('insert');
  return { created };
}

export async function deleteAccount(id) {
  // El .select() no es decorativo: es la única forma de saber si el DELETE ha
  // borrado algo de verdad (ver NO_ROW).
  const { data, error, status } = await sb.from('accounts').delete().eq('id', id).select('id');
  if (error) return { error: withStatus(error, status) };
  if (!data || !data.length) return { error: NO_ROW() };
  state.accounts = state.accounts.filter((a) => a.id !== id);
  state.notes.delete(id);
  index();
  emit('delete');
  return {};
}

// ─────────────────────────── notas ───────────────────────────
// Todas están ya en memoria desde loadAll(); estas funciones solo escriben y
// mantienen la lista local en orden (la más reciente primero).

export async function addNote(accountId, body, author) {
  const { data, error, status } = await sb.from('account_notes').insert({
    account_id: accountId,
    body,
    author_id: author.id,
    author_name: author.full_name || author.email,
  }).select().single();
  if (error) return { error: withStatus(error, status) };
  state.notes.set(accountId, [data, ...notesFor(accountId)]);
  resyncNotes(accountId);
  emit('note');
  return { note: data };
}

export async function updateNote(noteId, body) {
  const { data, error, status } = await sb.from('account_notes').update({ body }).eq('id', noteId).select().single();
  if (error) return { error: withStatus(error, status) };
  state.notes.set(data.account_id, notesFor(data.account_id).map((n) => (n.id === noteId ? data : n)));
  resyncNotes(data.account_id);
  emit('note');
  return { note: data };
}

export async function deleteNote(noteId, accountId) {
  const { data, error, status } = await sb.from('account_notes').delete().eq('id', noteId).select('id');
  if (error) return { error: withStatus(error, status) };
  if (!data || !data.length) return { error: NO_ROW() };
  state.notes.set(accountId, notesFor(accountId).filter((n) => n.id !== noteId));
  resyncNotes(accountId);
  emit('note');
  return {};
}

// ─────────────────────── catálogos y campos ───────────────────────

export async function addCatalogOption(kind, value) {
  const pos = state.catalogs[kind].length;
  const { error, status } = await sb.from('catalog_options').insert({ kind, value, position: pos });
  if (error) return { error: withStatus(error, status) };
  state.catalogs[kind] = [...state.catalogs[kind], value].sort((a, b) => a.localeCompare(b, 'es'));
  emit('catalog');
  return {};
}

export async function removeCatalogOption(kind, value) {
  const { data, error, status } = await sb.from('catalog_options')
    .delete().eq('kind', kind).eq('value', value).select('value');
  if (error) return { error: withStatus(error, status) };
  if (!data || !data.length) return { error: NO_ROW() };
  state.catalogs[kind] = state.catalogs[kind].filter((v) => v !== value);
  emit('catalog');
  return {};
}

export async function addFieldDef(def) {
  const { data, error, status } = await sb.from('field_defs')
    .insert({ ...def, position: state.fields.length }).select().single();
  if (error) return { error: withStatus(error, status) };
  state.fields.push(data);
  emit('fields');
  return { field: data };
}

export async function removeFieldDef(id) {
  const { data, error, status } = await sb.from('field_defs').delete().eq('id', id).select('id');
  if (error) return { error: withStatus(error, status) };
  if (!data || !data.length) return { error: NO_ROW() };
  state.fields = state.fields.filter((f) => f.id !== id);
  emit('fields');
  return {};
}

// ─────────────────────────── Realtime ───────────────────────────
let channel = null;

export function startRealtime() {
  if (channel) return;
  realtimeStarted();   // antes de suscribirse: el primer estado ya cuenta
  channel = sb.channel('iberia-seguimiento')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts' }, (payload) => {
      if (payload.eventType === 'DELETE') {
        state.accounts = state.accounts.filter((a) => a.id !== payload.old.id);
      } else {
        const row = { ...payload.new, custom: payload.new.custom || {} };
        const prev = state.byId.get(row.id);
        // Lo derivado de las notas no viaja en el payload: se conserva.
        row.notes_count = prev?.notes_count ?? 0;
        row.last_note = prev?.last_note ?? null;
        if (prev) Object.assign(prev, row);
        else state.accounts.push(row);
      }
      index();
      emit('realtime');
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'account_notes' }, (payload) => {
      const accId = payload.new?.account_id || payload.old?.account_id;
      if (!accId) return;
      // Se parchea la lista en memoria en vez de invalidarla: la tabla muestra
      // el cuerpo de la última nota, así que si solo borrásemos la caché la
      // celda se quedaría con el texto viejo hasta recargar la página.
      const list = notesFor(accId);
      if (payload.eventType === 'DELETE') {
        state.notes.set(accId, list.filter((n) => n.id !== payload.old.id));
      } else if (payload.eventType === 'UPDATE') {
        state.notes.set(accId, list.map((n) => (n.id === payload.new.id ? payload.new : n)));
      } else if (!list.some((n) => n.id === payload.new.id)) {
        // Las propias ya se insertaron de forma optimista en addNote().
        state.notes.set(accId, [payload.new, ...list]);
      }
      resyncNotes(accId);
      emit('realtime');
    })
    // El estado del canal se reporta a net.js: si esto se cae, los cambios de
    // los demás dejan de llegar y la tabla no tiene forma de saberlo.
    .subscribe((status) => noteRealtimeStatus(status));
}

export function stopRealtime() {
  if (!channel) return;
  realtimeStopped();
  sb.removeChannel(channel);
  channel = null;
}
