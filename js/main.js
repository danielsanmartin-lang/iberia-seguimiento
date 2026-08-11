// Arranque de la aplicación: sesión, formularios de acceso y cableado general.
import { IDLE_MS } from './config.js';
import {
  getProfile, isAdmin, loadProfile, signIn, signOut, changePassword, onAuthChange,
} from './auth.js';
import { loadAll, startRealtime, stopRealtime } from './store.js';
import { initRouter, route } from './router.js';
import { initGrid, render as renderGrid } from './grid.js';
import { initPanel } from './panel.js';
import { initImportExport } from './importexport.js';
import { initAdmin } from './admin.js';
import { initTheme } from './theme.js';
import { startIdleTimer, idleExpired, clearIdle } from './idle.js';
import { toast } from './util.js';

let idleWatch = null;

function startIdleWatch() {
  stopIdleWatch();
  if (!getProfile()) return;
  idleWatch = startIdleTimer(IDLE_MS, async () => {
    await signOut();
    clearIdle();
    updateChrome();
    route();
    toast('Sesión cerrada por inactividad.');
  });
}
function stopIdleWatch() {
  idleWatch?.stop();
  idleWatch = null;
}

function updateChrome() {
  const p = getProfile();
  document.getElementById('userName').textContent = p?.full_name || p?.email || '';
  document.getElementById('navAdmin').hidden = !isAdmin();
}

// Datos + Realtime. Se llama tras iniciar sesión y al cargar con sesión previa.
async function bootData() {
  try {
    await loadAll();
    startRealtime();
  } catch (e) {
    toast(`No se pudieron cargar los datos: ${e.message}`, 'err');
  }
}

const EYE = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18M10.6 10.7a3 3 0 0 0 4.2 4.2M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10.5 7 10.5 7a17 17 0 0 1-3.4 4.2M6.2 6.7A17 17 0 0 0 1.5 12S5.5 19 12 19c1.3 0 2.4-.2 3.5-.6"/></svg>';

function wirePasswordToggles() {
  document.querySelectorAll('[data-pwtoggle]').forEach((btn) => {
    btn.innerHTML = EYE;
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.pwtoggle);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = show ? EYE_OFF : EYE;
      input.focus();
    });
  });
}

function wireAuthForms() {
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('loginErr');
    const btn = document.getElementById('loginBtn');
    err.hidden = true;
    btn.disabled = true;
    const { error } = await signIn(
      document.getElementById('loginEmail').value.trim(),
      document.getElementById('loginPassword').value,
    );
    btn.disabled = false;
    if (error || !getProfile()) {
      // Mensaje único a propósito: distinguir "no existe" de "contraseña mal"
      // regalaría a cualquiera una forma de averiguar quién tiene cuenta.
      err.textContent = 'Correo o contraseña incorrectos, o la cuenta está desactivada.';
      err.hidden = false;
      return;
    }
    document.getElementById('loginPassword').value = '';
    await bootData();
    updateChrome();
    route();
    startIdleWatch();
  });

  document.getElementById('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('pwErr');
    const btn = document.getElementById('pwBtn');
    err.hidden = true;
    const p1 = document.getElementById('pwNew').value;
    const p2 = document.getElementById('pwConfirm').value;
    if (p1.length < 8) { err.textContent = 'Mínimo 8 caracteres.'; err.hidden = false; return; }
    if (p1 !== p2) { err.textContent = 'Las contraseñas no coinciden.'; err.hidden = false; return; }
    btn.disabled = true;
    const { error } = await changePassword(p1);
    btn.disabled = false;
    if (error) { err.textContent = error.message; err.hidden = false; return; }
    await loadProfile();
    document.getElementById('pwNew').value = '';
    document.getElementById('pwConfirm').value = '';
    await bootData();
    updateChrome();
    route();
    toast('Contraseña cambiada. Ya puedes empezar.');
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    stopIdleWatch();
    stopRealtime();
    clearIdle();
    await signOut();
    updateChrome();
    route();
  });
}

async function init() {
  initTheme();
  wirePasswordToggles();
  wireAuthForms();
  initRouter();
  initGrid();
  initPanel(renderGrid);
  initImportExport(renderGrid);
  initAdmin(renderGrid);

  onAuthChange((event) => {
    if (event === 'SIGNED_OUT') {
      stopIdleWatch();
      stopRealtime();
      updateChrome();
      route();
    }
  });

  await loadProfile();
  // Si la sesión persistía pero la pestaña estuvo cerrada más del límite de
  // inactividad, se cierra antes de mostrar nada.
  if (getProfile() && idleExpired(IDLE_MS)) {
    clearIdle();
    await signOut();
  }
  if (getProfile()) await bootData();

  updateChrome();
  route();
  startIdleWatch();
  document.getElementById('boot').remove();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
