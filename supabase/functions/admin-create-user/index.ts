// Edge Function: admin-create-user
//
// Da de alta un usuario con contraseña provisional. Solo un admin activo puede
// llamarla. No se envía ningún correo: el admin lee la contraseña en pantalla y
// la comparte por un canal seguro; el usuario está obligado a cambiarla en su
// primer acceso (must_change_password).
import { adminClient, HttpError, json, requireAdmin, serve } from '../_shared/auth.ts';

serve(async (req, origin) => {
  const caller = await requireAdmin(req);

  const body = await req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const full_name = String(body.full_name || '').trim();
  const role = body.role === 'admin' ? 'admin' : 'user';
  const password = String(body.password || '');

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Correo no válido');
  if (password.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres');

  const admin = adminClient();
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, must_change_password: true },
  });
  if (cErr) throw new HttpError(400, cErr.message);

  // El trigger on_auth_user_created ya insertó el perfil como 'user' e INACTIVO
  // (así un auto-registro no daría acceso). Aquí lo activamos y, si procede, lo
  // promovemos: son escrituras con service_role, fuera de RLS.
  const { error: pErr } = await admin
    .from('profiles')
    .update({ full_name, is_active: true, role })
    .eq('id', created.user.id);
  if (pErr) throw new HttpError(500, 'Usuario creado pero falló el perfil: ' + pErr.message);

  // Las 397 cuentas migradas del Excel traen el owner como texto suelto
  // ("Alberto"), porque al importarlas los perfiles todavía no existían. Al dar
  // de alta a esa persona se adoptan automáticamente sus cuentas huérfanas.
  const firstName = full_name.split(/\s+/)[0];
  const candidates = [...new Set([full_name, firstName].filter(Boolean))];
  let adopted = 0;
  if (candidates.length) {
    const { data: linked } = await admin
      .from('accounts')
      .update({ owner_id: created.user.id })
      .is('owner_id', null)
      .in('owner_name', candidates)
      .select('id');
    adopted = linked?.length ?? 0;
  }

  return json(200, { ok: true, id: created.user.id, email, adopted, created_by: caller.email }, origin);
});
