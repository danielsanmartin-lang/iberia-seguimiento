// Configuración pública del cliente.
//
// Estas dos claves son PÚBLICAS por diseño: viajan al navegador de cualquiera
// que abra la app. La seguridad real está en RLS + Auth + las Edge Functions,
// nunca en ocultarlas. NUNCA pongas aquí la service_role key.
export const SUPABASE_URL = 'https://ppklcfsudukieqyaloze.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_dDlkNDaWmCTg3mXLLbsacw_yXLuHDfE';

// Cierre de sesión tras 12 h sin actividad: una jornada entera. Con 30 min había
// que volver a entrar cada vez que la pestaña se quedaba un rato quieta, y eso
// pasa continuamente en una hoja que se consulta a ratos durante todo el día.
export const IDLE_MS = 12 * 60 * 60 * 1000;
