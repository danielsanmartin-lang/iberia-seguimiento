// Edge Function: admin-user-action
//
// Acciones del panel de administración sobre otros usuarios:
// reset_password · set_active · delete_user · update_profile
//
// Salvaguardas: nadie puede desactivarse, borrarse ni cambiarse el rol a sí
// mismo (evita quedarse sin ningún admin), y solo se borra a quien ya está
// desactivado (borrado en dos pasos, para que no sea un clic accidental).
import { adminClient, HttpError, json, requireAdmin, serve } from '../_shared/auth.ts';

serve(async (req, origin) => {
  const caller = await requireAdmin(req);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');
  const userId = String(body.user_id || '');
  if (!userId) throw new HttpError(400, 'Falta user_id');

  const admin = adminClient();

  if (action === 'reset_password') {
    const password = String(body.password || '');
    if (password.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres');
    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    if (error) throw new HttpError(400, error.message);
    // Vuelve a exigir el cambio en el siguiente acceso.
    await admin.from('profiles').update({ must_change_password: true }).eq('id', userId);
    return json(200, { ok: true }, origin);
  }

  if (action === 'set_active') {
    const isActive = body.is_active !== false;
    if (userId === caller.id && !isActive) throw new HttpError(400, 'No puedes desactivarte a ti mismo');
    const { error } = await admin.from('profiles').update({ is_active: isActive }).eq('id', userId);
    if (error) throw new HttpError(400, error.message);
    // Banear en Auth además de marcar el perfil: sin esto el usuario seguiría
    // obteniendo un JWT válido, aunque la app le cerrara la puerta.
    await admin.auth.admin.updateUserById(userId, { ban_duration: isActive ? 'none' : '876000h' });
    return json(200, { ok: true }, origin);
  }

  if (action === 'delete_user') {
    if (userId === caller.id) throw new HttpError(400, 'No puedes borrarte a ti mismo');
    const { data: target } = await admin.from('profiles').select('is_active').eq('id', userId).single();
    if (!target) throw new HttpError(404, 'Usuario no encontrado');
    if (target.is_active !== false) throw new HttpError(400, 'Desactiva al usuario antes de borrarlo');
    // Al borrar de Auth, la cascada elimina su perfil. Sus cuentas NO se borran
    // (owner_id queda a null) y sus notas conservan el nombre del autor.
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw new HttpError(400, error.message);
    return json(200, { ok: true }, origin);
  }

  if (action === 'update_profile') {
    // Actualización PARCIAL: solo se tocan los campos presentes en el body, así
    // el panel de admin y la edición del propio perfil conviven sin pisarse.
    const upd: Record<string, unknown> = {};

    if ('full_name' in body) {
      const fn = String(body.full_name || '').trim();
      if (fn) upd.full_name = fn;
    }
    if ('role' in body && userId !== caller.id) {
      upd.role = body.role === 'admin' ? 'admin' : 'user';
    }
    if ('email' in body) {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Correo no válido');
      const { error } = await admin.auth.admin.updateUserById(userId, { email, email_confirm: true });
      if (error) throw new HttpError(400, error.message);
      upd.email = email;
    }

    if (Object.keys(upd).length === 0) return json(200, { ok: true }, origin);
    const { error } = await admin.from('profiles').update(upd).eq('id', userId);
    if (error) throw new HttpError(400, error.message);
    return json(200, { ok: true }, origin);
  }

  throw new HttpError(400, 'Acción desconocida');
});
