// Router por hash: #/tabla · #/admin · #/perfil
//
// Los tres controles de acceso se evalúan ANTES de mirar la URL: sin sesión →
// login; con contraseña provisional → cambio obligatorio. Así, escribir
// "#/admin" a mano sin sesión no lleva a ningún sitio.
import { getProfile, isAdmin } from './auth.js';
import { renderAdmin } from './admin.js';
import { renderProfile } from './profile.js';
import { render as renderGrid } from './grid.js';
import { closePanel } from './panel.js';

const VIEWS = ['login', 'pwchange', 'tabla', 'admin', 'perfil'];
const SIN_CHROME = ['login', 'pwchange'];

function show(view) {
  VIEWS.forEach((v) => {
    const el = document.getElementById('view-' + v);
    if (el) el.hidden = v !== view;
  });
  document.getElementById('topbar').hidden = SIN_CHROME.includes(view);
  document.body.dataset.view = view;
}

export function route() {
  const profile = getProfile();
  if (!profile) { show('login'); return; }
  if (profile.must_change_password) { show('pwchange'); return; }

  const h = location.hash || '#/tabla';
  closePanel();

  if (h === '#/admin') {
    // Comodidad de interfaz: el bloqueo real está en las Edge Functions y RLS.
    if (!isAdmin()) { location.hash = '#/tabla'; return; }
    show('admin');
    renderAdmin();
    return;
  }
  if (h === '#/perfil') {
    show('perfil');
    renderProfile();
    return;
  }
  show('tabla');
  renderGrid();
}

export function initRouter() {
  window.addEventListener('hashchange', route);
}
