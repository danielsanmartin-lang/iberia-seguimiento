// Cliente Supabase único para toda la app.
//
// El SDK se carga como bundle UMD vendorizado (js/vendor/supabase.js) desde un
// <script> clásico en index.html, que expone window.supabase antes de que se
// ejecuten los módulos (que son defer por defecto).
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

if (!window.supabase || !window.supabase.createClient) {
  throw new Error('SDK de Supabase no cargado: revisa js/vendor/supabase.js en index.html');
}

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // La app usa router por hash (#/tabla): con detectSessionInUrl activo,
    // supabase-js intentaría interpretar el fragmento como callback de auth.
    detectSessionInUrl: false,
  },
});
