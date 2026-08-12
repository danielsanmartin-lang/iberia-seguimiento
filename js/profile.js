// Perfil propio: nombre y contraseña. El correo y el rol los gestiona un
// administrador (guard_profile_update revierte cualquier intento por RLS).
import { sb } from './supabaseClient.js';
import { getProfile, changePassword, loadProfile } from './auth.js';
import { state } from './store.js';
import { writeFailed, withStatus } from './net.js';
import { escHtml, toast } from './util.js';

export function renderProfile() {
  const p = getProfile();
  if (!p) return;
  const mias = state.accounts.filter((a) => a.owner_id === p.id).length;

  document.getElementById('profBody').innerHTML = `
    <div class="card">
      <h2>Tu cuenta</h2>
      <label class="fld wide"><span>Nombre</span>
        <input id="pfName" type="text" value="${escHtml(p.full_name || '')}"></label>
      <label class="fld wide"><span>Correo</span>
        <input type="email" value="${escHtml(p.email || '')}" disabled></label>
      <p class="muted">Rol: <b>${p.role === 'admin' ? 'Administrador' : 'Usuario'}</b> ·
        ${mias} cuenta${mias === 1 ? '' : 's'} a tu nombre.
        Para cambiar el correo o el rol, pídeselo a un administrador.</p>
      <button id="pfSave" class="btn primary" type="button">Guardar nombre</button>
    </div>

    <div class="card">
      <h2>Cambiar contraseña</h2>
      <label class="fld wide"><span>Nueva contraseña</span>
        <input id="pfPw1" type="password" autocomplete="new-password"></label>
      <label class="fld wide"><span>Repítela</span>
        <input id="pfPw2" type="password" autocomplete="new-password"></label>
      <button id="pfPwSave" class="btn primary" type="button">Cambiar contraseña</button>
    </div>`;

  document.getElementById('pfSave').addEventListener('click', async () => {
    const name = document.getElementById('pfName').value.trim();
    if (!name) { toast('El nombre no puede quedar vacío.', 'err'); return; }
    const { error, status } = await sb.from('profiles').update({ full_name: name }).eq('id', p.id);
    if (error) { await writeFailed(withStatus(error, status), 'guardar el nombre'); return; }
    await loadProfile();
    document.getElementById('userName').textContent = name;
    toast('Nombre actualizado.');
  });

  document.getElementById('pfPwSave').addEventListener('click', async () => {
    const a = document.getElementById('pfPw1').value;
    const b = document.getElementById('pfPw2').value;
    if (a.length < 8) { toast('Mínimo 8 caracteres.', 'err'); return; }
    if (a !== b) { toast('Las contraseñas no coinciden.', 'err'); return; }
    const { error } = await changePassword(a);
    if (error) { toast(error.message, 'err'); return; }
    document.getElementById('pfPw1').value = '';
    document.getElementById('pfPw2').value = '';
    toast('Contraseña cambiada.');
  });
}
