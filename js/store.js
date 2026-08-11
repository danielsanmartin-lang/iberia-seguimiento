// Estado en memoria y acceso a datos.
//
// Se descarga TODO una vez (397 filas hoy, y no va a crecer un orden de
// magnitud) y a partir de ahí filtrar, ordenar y calcular KPIs es trabajo en
// memoria: ninguna interacción de la tabla vuelve a consultar la red.
//
// Encima va Realtime: al ser una hoja compartida por tres personas, un cambio
// de uno tiene que aparecer en la pantalla de los otros sin recargar.
import { sb } from './supabaseClient.js';
import { CORE_COLUMNS } from './data.js';

export const state = {
  accounts: [],
  byId: new Map(),
  profiles: [],          // los tres usuarios, para el desplegable de Owner
  catalogs: { region: [], sector: [] },
  fields: [],            // columnas personalizadas definidas por el admin
  notes: new Map(),      // account_id -> [notas] (se cargan al abrir la ficha)
};

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(reason) { listeners.forEach((fn) => fn(reason)); }

function index() {
  state.byId = new Map(state.accounts.map((a) => [a.id, a]));
}

// Todas las columnas activas: las del código más las que haya definido el admin.
export function allColumns() {
  return [
    ...CORE_COLUMNS,
    ...state.fields.map((f) => ({
      key: `custom.${f.key}`,
      label: f.label,
      type: f.type === 'select' ? 'select' : f.type,
      options: f.options || [],
      custom: true,
      width: '1fr',
      min: 110,
    })),
  ];
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

export async function loadAll() {
  const [accs, profs, cats, flds] = await Promise.all([
    // El agregado embebido evita traerse los cuerpos de las notas solo para
    // pintar el contador de la tabla.
    sb.from('accounts').select('*, notes:account_notes(count)').order('name'),
    sb.from('profiles').select('id, full_name, email, role, is_active').order('full_name'),
    sb.from('catalog_options').select('kind, value, position').order('position'),
    sb.from('field_defs').select('*').order('position'),
  ]);
  if (accs.error) throw accs.error;

  state.accounts = (accs.data || []).map((a) => ({
    ...a,
    notes_count: a.notes?.[0]?.count ?? 0,
    custom: a.custom || {},
  }));
  index();
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

  const { data, error } = await sb.from('accounts').update(patch).eq('id', id).select().single();
  if (error) {
    Object.assign(acc, prev);
    emit('revert');
    return { error };
  }
  Object.assign(acc, data, { custom: data.custom || {}, notes_count: acc.notes_count });
  emit('save');
  return {};
}

export async function createAccount(fields) {
  const { data, error } = await sb.from('accounts').insert(fields).select().single();
  if (error) return { error };
  const acc = { ...data, custom: data.custom || {}, notes_count: 0 };
  state.accounts.push(acc);
  index();
  emit('insert');
  return { account: acc };
}

// Alta masiva (importación). Devuelve las filas creadas.
export async function createAccounts(rows) {
  const { data, error } = await sb.from('accounts').insert(rows).select();
  if (error) return { error };
  const created = (data || []).map((d) => ({ ...d, custom: d.custom || {}, notes_count: 0 }));
  state.accounts.push(...created);
  index();
  emit('insert');
  return { created };
}

export async function deleteAccount(id) {
  const { error } = await sb.from('accounts').delete().eq('id', id);
  if (error) return { error };
  state.accounts = state.accounts.filter((a) => a.id !== id);
  state.notes.delete(id);
  index();
  emit('delete');
  return {};
}

// ─────────────────────────── notas ───────────────────────────

export async function loadNotes(accountId) {
  const { data, error } = await sb
    .from('account_notes')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false });
  if (error) return { error };
  state.notes.set(accountId, data || []);
  return { notes: data || [] };
}

export async function addNote(accountId, body, author) {
  const { data, error } = await sb.from('account_notes').insert({
    account_id: accountId,
    body,
    author_id: author.id,
    author_name: author.full_name || author.email,
  }).select().single();
  if (error) return { error };
  const list = state.notes.get(accountId) || [];
  state.notes.set(accountId, [data, ...list]);
  const acc = state.byId.get(accountId);
  if (acc) acc.notes_count = (acc.notes_count || 0) + 1;
  emit('note');
  return { note: data };
}

export async function updateNote(noteId, body) {
  const { data, error } = await sb.from('account_notes').update({ body }).eq('id', noteId).select().single();
  if (error) return { error };
  const list = state.notes.get(data.account_id) || [];
  state.notes.set(data.account_id, list.map((n) => (n.id === noteId ? data : n)));
  return { note: data };
}

export async function deleteNote(noteId, accountId) {
  const { error } = await sb.from('account_notes').delete().eq('id', noteId);
  if (error) return { error };
  state.notes.set(accountId, (state.notes.get(accountId) || []).filter((n) => n.id !== noteId));
  const acc = state.byId.get(accountId);
  if (acc) acc.notes_count = Math.max(0, (acc.notes_count || 0) - 1);
  emit('note');
  return {};
}

// ─────────────────────── catálogos y campos ───────────────────────

export async function addCatalogOption(kind, value) {
  const pos = state.catalogs[kind].length;
  const { error } = await sb.from('catalog_options').insert({ kind, value, position: pos });
  if (error) return { error };
  state.catalogs[kind] = [...state.catalogs[kind], value].sort((a, b) => a.localeCompare(b, 'es'));
  emit('catalog');
  return {};
}

export async function removeCatalogOption(kind, value) {
  const { error } = await sb.from('catalog_options').delete().eq('kind', kind).eq('value', value);
  if (error) return { error };
  state.catalogs[kind] = state.catalogs[kind].filter((v) => v !== value);
  emit('catalog');
  return {};
}

export async function addFieldDef(def) {
  const { data, error } = await sb.from('field_defs')
    .insert({ ...def, position: state.fields.length }).select().single();
  if (error) return { error };
  state.fields.push(data);
  emit('fields');
  return { field: data };
}

export async function removeFieldDef(id) {
  const { error } = await sb.from('field_defs').delete().eq('id', id);
  if (error) return { error };
  state.fields = state.fields.filter((f) => f.id !== id);
  emit('fields');
  return {};
}

// ─────────────────────────── Realtime ───────────────────────────
let channel = null;

export function startRealtime() {
  if (channel) return;
  channel = sb.channel('iberia-seguimiento')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts' }, (payload) => {
      if (payload.eventType === 'DELETE') {
        state.accounts = state.accounts.filter((a) => a.id !== payload.old.id);
      } else {
        const row = { ...payload.new, custom: payload.new.custom || {} };
        const prev = state.byId.get(row.id);
        // El contador de notas no viaja en el payload de Realtime: se conserva.
        row.notes_count = prev?.notes_count ?? 0;
        if (prev) Object.assign(prev, row);
        else state.accounts.push(row);
      }
      index();
      emit('realtime');
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'account_notes' }, (payload) => {
      const accId = payload.new?.account_id || payload.old?.account_id;
      // Se invalida la caché de esa ficha; se recargará al abrirla.
      state.notes.delete(accId);
      const acc = state.byId.get(accId);
      if (acc) {
        if (payload.eventType === 'INSERT') acc.notes_count = (acc.notes_count || 0) + 1;
        if (payload.eventType === 'DELETE') acc.notes_count = Math.max(0, (acc.notes_count || 0) - 1);
      }
      emit('realtime');
    })
    .subscribe();
}

export function stopRealtime() {
  if (!channel) return;
  sb.removeChannel(channel);
  channel = null;
}
