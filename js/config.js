// Configuración pública del cliente.
//
// Estas dos claves son PÚBLICAS por diseño: viajan al navegador de cualquiera
// que abra la app. La seguridad real está en RLS + Auth + las Edge Functions,
// nunca en ocultarlas. NUNCA pongas aquí la service_role key.
export const SUPABASE_URL = 'https://ppklcfsudukieqyaloze.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_dDlkNDaWmCTg3mXLLbsacw_yXLuHDfE';

// Cierre de sesión tras 30 min sin actividad.
export const IDLE_MS = 30 * 60 * 1000;
