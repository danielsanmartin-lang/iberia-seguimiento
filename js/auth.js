// Autenticación y perfil del usuario en sesión.
import { sb } from './supabaseClient.js';

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
    .select('id, email, full_name, role, must_change_password, is_active, column_prefs')
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
  await sb.from('profiles').update({ column_prefs: prefs }).eq('id', _profile.id);
}

export function onAuthChange(cb) {
  sb.auth.onAuthStateChange((event) => cb(event));
}
