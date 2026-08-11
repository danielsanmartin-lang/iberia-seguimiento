// Tema claro / oscuro. El atributo se fija antes del primer pintado con el
// script en línea del <head>; aquí solo se gestiona el botón.
const KEY = 'iberia_theme';

const SUN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'noche' ? 'noche' : 'dia';
}

function apply(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(KEY, t); } catch (_e) { /* sin storage */ }
  const btn = document.getElementById('themeBtn');
  if (btn) {
    btn.innerHTML = t === 'noche' ? SUN : MOON;
    btn.title = t === 'noche' ? 'Cambiar a modo día' : 'Cambiar a modo noche';
  }
}

export function initTheme() {
  apply(currentTheme());
  document.getElementById('themeBtn')?.addEventListener('click', () => {
    apply(currentTheme() === 'noche' ? 'dia' : 'noche');
  });
}
