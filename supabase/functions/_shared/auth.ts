// Utilidades compartidas por las Edge Functions de administración.
//
// Todo lo que necesita más permisos que los del usuario en sesión vive aquí:
// la service_role key NUNCA sale del runtime de Supabase, jamás del navegador.
//
// Las funciones se despliegan con verify_jwt=false a propósito: si la
// plataforma verificara el JWT, el preflight OPTIONS de CORS (que va sin
// cabecera Authorization) sería rechazado antes de llegar al código. La
// identidad se comprueba aquí dentro, en requireUser().
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

// Un único sitio donde mantener los orígenes permitidos (en el proyecto de
// referencia esta lista estaba duplicada en tres ficheros y se desincronizaba).
const ALLOWED_ORIGINS = [
  'http://127.0.0.1:8765',
  'http://localhost:8765',
  'https://danielsanmartin-lang.github.io',
];

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

export function json(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new HttpError(500, `Falta la variable de entorno ${name}`);
  return v;
}

// Cliente con service_role: salta RLS. Solo después de validar al llamante.
export function adminClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface Caller {
  id: string;
  email: string | null;
  full_name: string;
  role: 'user' | 'admin';
  is_active: boolean;
}

// Identifica al llamante reenviando su propio JWT: el perfil se lee con SUS
// permisos, no con los de service_role. Rechaza sesiones inválidas e inactivas.
export async function requireUser(req: Request): Promise<Caller> {
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) throw new HttpError(401, 'Falta la cabecera Authorization');

  const caller = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error } = await caller.auth.getUser();
  if (error || !user) throw new HttpError(401, 'Sesión no válida');

  const { data: prof } = await caller
    .from('profiles')
    .select('id, email, full_name, role, is_active')
    .eq('id', user.id)
    .single();
  if (!prof || prof.is_active === false) throw new HttpError(403, 'Usuario inactivo o desconocido');
  return prof as Caller;
}

export async function requireAdmin(req: Request): Promise<Caller> {
  const caller = await requireUser(req);
  if (caller.role !== 'admin') throw new HttpError(403, 'Solo administradores');
  return caller;
}

// Envuelve el handler: CORS, método y traducción de HttpError a respuesta.
export function serve(handler: (req: Request, origin: string | null) => Promise<Response>) {
  Deno.serve(async (req: Request) => {
    const origin = req.headers.get('Origin');
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
    if (req.method !== 'POST') return json(405, { error: 'Método no permitido' }, origin);
    try {
      return await handler(req, origin);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message }, origin);
      return json(500, { error: String((e as Error)?.message || e) }, origin);
    }
  });
}
