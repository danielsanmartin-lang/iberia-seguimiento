// Autenticación y perfil del usuario en sesión.
import { sb } from './supabaseClient.js';
import { writeFailed, withStatus } from './net.js';

let _profile = null;

export function getProfile() { return _profile; }
export function isAdmin() { return !!_profile && _profile.role === 'admin'; }

// Carga (o recarga) el perfil del usuario en sesión. Devuelve null tanto si no
// hay sesión como si el usuario está desactivado: así el router cubre ambos
// casos con una sola comprobación.
export async function loadProfile() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { _profile = null; return null; }
  const { data, error } = await sb
    .from('profiles')
    .select('id, email, full_name, role, must_change_password, is_active, column_prefs, favorites')
    .eq('id', user.id)
    .single();
  if (error || !data || data.is_active === false) { _profile = null; return null; }
  _profile = data;
  return _profile;
}

export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return { error };
  await loadProfile();
  return {};
}

export async function signOut() {
  _profile = null;
  await sb.auth.signOut();
}

// Cambia la contraseña y baja el flag que fuerza el cambio.
export async function changePassword(newPassword) {
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) return { error };
  const { data: { user } } = await sb.auth.getUser();
  if (user) {
    await sb.from('profiles').update({ must_change_password: false }).eq('id', user.id);
    if (_profile) _profile.must_change_password = false;
  }
  return {};
}

// Preferencias de columnas: qué se ve y en qué orden. Van en el perfil (no en
// localStorage) para que acompañen al usuario entre dispositivos.
export async function saveColumnPrefs(prefs) {
  if (!_profile) return;
  _profile.column_prefs = prefs;
  const { error, status } = await sb.from('profiles')
    .update({ column_prefs: prefs }).eq('id', _profile.id);
  // Antes esto era fire-and-forget: si fallaba, el usuario colocaba sus columnas,
  // se iba tan contento y las encontraba desordenadas al día siguiente.
  if (error) await writeFailed(withStatus(error, status), 'guardar el orden de las columnas');
}

// Cuentas favoritas: privadas de cada usuario. Viven en el perfil, como las
// preferencias de columnas, y por el mismo motivo — te siguen entre
// dispositivos y no ensucian la tabla compartida con datos de uno solo.
export function favorites() {
  return Array.isArray(_profile?.favorites) ? _profile.favorites : [];
}

export function isFavorite(accountId) {
  return favorites().includes(accountId);
}

export async function toggleFavorite(accountId) {
  if (!_profile) return {};
  const antes = favorites();
  const next = antes.includes(accountId)
    ? antes.filter((id) => id !== accountId)
    : [...antes, accountId];

  // Optimista: la estrella no puede tardar en encenderse.
  _profile.favorites = next;
  const { error, status } = await sb.from('profiles')
    .update({ favorites: next }).eq('id', _profile.id);
  if (error) {
    _profile.favorites = antes;
    return { error: withStatus(error, status) };
  }
  return {};
}

export function onAuthChange(cb) {
  sb.auth.onAuthStateChange((event) => {
    // El SDK también cierra la sesión por su cuenta: refresh token caducado o
    // revocado, o sesión invalidada desde otro dispositivo. Si el perfil no se
    // limpia aquí, getProfile() sigue devolviendo el de antes, el router deja al
    // usuario dentro de una app que ya no puede escribir, y todo lo que edite se
    // pierde. Se hace en este módulo, que es el dueño de _profile, para que no
    // dependa de que cada oyente se acuerde.
    if (event === 'SIGNED_OUT') _profile = null;
    cb(event);
  });
}
