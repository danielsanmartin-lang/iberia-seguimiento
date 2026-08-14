// Arranque de la aplicación: sesión, formularios de acceso y cableado general.
import { IDLE_MS } from './config.js';
import {
  getProfile, isAdmin, loadProfile, signIn, signOut, changePassword, onAuthChange,
} from './auth.js';
import { loadAll, startRealtime, stopRealtime } from './store.js';
import { initNet, netReset, onAuthLost, onReconnect, loadFailed } from './net.js';
import { initRouter, route } from './router.js';
import { initGrid, render as renderGrid } from './grid.js';
import { initPanel, openNotes } from './panel.js';
import { initMentions } from './mentions.js';
import { initImportExport } from './importexport.js';
import { initAdmin } from './admin.js';
import { initTheme } from './theme.js';
import { startIdleTimer, idleExpired, clearIdle } from './idle.js';
import { toast } from './util.js';

let idleWatch = null;
let deliberateSignOut = false;   // ¿este cierre de sesión lo hemos pedido nosotros?

function startIdleWatch() {
  stopIdleWatch();
  if (!getProfile()) return;
  idleWatch = startIdleTimer(IDLE_MS, async () => {
    deliberateSignOut = true;
    await signOut();
    clearIdle();
    updateChrome();
    route();
    loginNotice('Sesión cerrada por inactividad. Vuelve a entrar.');
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

// Aviso en la pantalla de acceso. Un toast no sirve para esto: desaparece en unos
// segundos y quien vuelve a encontrarse el login sin explicación piensa que la
// app le ha echado sin motivo.
function loginNotice(msg) {
  const err = document.getElementById('loginErr');
  err.textContent = msg;
  err.hidden = false;
}

// Datos + Realtime. Se llama tras iniciar sesión y al cargar con sesión previa.
async function bootData() {
  try {
    await loadAll();
    startRealtime();
  } catch (e) {
    await loadFailed(e);
  }
}

// La sesión ha muerto por debajo (token revocado o caducado, usuario
// desactivado). Hay que sacar al usuario: seguir dentro solo sirve para que
// escriba cosas que se caen una a una.
function wireSessionLoss() {
  onAuthLost(async () => {
    if (!getProfile()) return;   // ya estaba fuera
    stopIdleWatch();
    stopRealtime();
    clearIdle();
    await signOut();
    updateChrome();
    route();
    loginNotice('Tu sesión ha caducado o tu usuario ya no está activo. Vuelve a entrar.');
  });
}

// Vuelta de la conexión. Recargar no es opcional: Realtime no reproduce los
// eventos que se perdieron mientras el canal estaba caído, así que sin esto la
// pantalla se queda con datos viejos y sin ninguna pista de que lo están.
let resyncing = false;
function wireResync() {
  onReconnect(async () => {
    if (resyncing || !getProfile()) return;
    resyncing = true;
    try {
      stopRealtime();          // suscripción nueva: la vieja puede estar muerta
      await loadAll();
      startRealtime();
      toast('Conexión recuperada: datos actualizados.');
    } catch (e) {
      await loadFailed(e);
    } finally {
      resyncing = false;
    }
  });
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
    netReset();   // sesión nueva: se olvida lo que sabíamos de la anterior
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
    deliberateSignOut = true;
    await signOut();
    updateChrome();
    route();
  });
}

async function init() {
  initTheme();
  initNet();
  wirePasswordToggles();
  wireAuthForms();
  wireSessionLoss();
  wireResync();
  initRouter();
  initGrid();
  initPanel(renderGrid);
  // La bandeja necesita abrir el historial por la nota exacta. Se le pasa como
  // función en vez de que mentions.js importe panel.js: panel.js ya importa
  // mentions.js para pintar los @, y el ciclo se evita mejor que se explica.
  initMentions({ onOpen: (accountId, noteId) => openNotes(accountId, '', noteId) });
  initImportExport();
  initAdmin(renderGrid);

  onAuthChange((event) => {
    if (event !== 'SIGNED_OUT') return;
    stopIdleWatch();
    stopRealtime();
    updateChrome();
    route();
    // Cierre que no hemos pedido: lo ha decidido el SDK porque el refresh token
    // ya no vale. Sin este aviso el usuario aparece de golpe en el login sin
    // saber por qué, que es exactamente cuando se pierden cosas escritas.
    if (!deliberateSignOut) loginNotice('Tu sesión ha caducado. Vuelve a entrar.');
    deliberateSignOut = false;
  });

  await loadProfile();
  // Si la sesión persistía pero la pestaña estuvo cerrada más del límite de
  // inactividad, se cierra antes de mostrar nada.
  if (getProfile() && idleExpired(IDLE_MS)) {
    clearIdle();
    deliberateSignOut = true;
    await signOut();
    loginNotice('Sesión cerrada por inactividad. Vuelve a entrar.');
  }
  if (getProfile()) await bootData();

  updateChrome();
  route();
  startIdleWatch();
  document.getElementById('boot').remove();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
