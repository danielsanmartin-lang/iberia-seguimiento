// Cierre de sesión automático por inactividad.
//
// Supabase mantiene la sesión viva indefinidamente (persistSession +
// autoRefreshToken), así que este módulo impone un límite por encima: tras N ms
// sin interacción se llama a onTimeout (que cierra sesión).
//
// La "última actividad" se guarda en localStorage para que:
//  · todas las pestañas compartan el mismo contador (actividad en una las
//    reinicia todas);
//  · si se cierra la pestaña y se reabre pasado el tiempo, se detecte la
//    caducidad al cargar (idleExpired), en vez de resucitar la sesión.

const KEY = 'iberia_last_activity';
const EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
const WRITE_THROTTLE = 5000; // no escribir en localStorage más de 1 vez / 5 s
const MAX_TICK = 60000;      // re-comprobar al menos cada minuto (throttling/sleep)

function readLast() {
  const v = parseInt(localStorage.getItem(KEY) || '0', 10);
  return Number.isFinite(v) ? v : 0;
}
function writeNow() {
  try { localStorage.setItem(KEY, String(Date.now())); } catch (_e) { /* sin storage */ }
}

// ¿La sesión ya ha caducado por inactividad? (comprobación al cargar la página)
export function idleExpired(timeoutMs) {
  const last = readLast();
  return last > 0 && (Date.now() - last) >= timeoutMs;
}

// Borra la marca de actividad (al cerrar sesión de forma explícita).
export function clearIdle() {
  try { localStorage.removeItem(KEY); } catch (_e) { /* sin storage */ }
}

// Arranca la vigilancia. Llama a onTimeout una sola vez al agotarse el tiempo.
// Devuelve { stop } para detenerla al cerrar sesión.
export function startIdleTimer(timeoutMs, onTimeout) {
  let timer = null;
  let lastWrite = 0;
  let fired = false;

  function schedule() {
    clearTimeout(timer);
    const remaining = timeoutMs - (Date.now() - readLast());
    if (remaining <= 0) { fire(); return; }
    timer = setTimeout(tick, Math.min(remaining, MAX_TICK) + 250);
  }
  function tick() {
    if (fired) return;
    if ((Date.now() - readLast()) >= timeoutMs) fire();
    else schedule(); // otra pestaña registró actividad → reprograma
  }
  function fire() {
    if (fired) return;
    fired = true;
    clearTimeout(timer);
    detach();
    onTimeout();
  }
  function onActivity() {
    if (fired) return;
    const t = Date.now();
    if (t - lastWrite > WRITE_THROTTLE) { lastWrite = t; writeNow(); }
    schedule();
  }
  function onStorage(e) {
    if (e.key !== KEY || fired) return;
    if (e.newValue === null) return; // limpieza por logout → lo gestiona el evento de auth
    schedule();
  }
  function onVisible() {
    if (!fired && document.visibilityState === 'visible') tick();
  }
  function detach() {
    EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity));
    window.removeEventListener('storage', onStorage);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
  }

  writeNow();
  lastWrite = Date.now();
  EVENTS.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
  window.addEventListener('storage', onStorage);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  schedule();

  return { stop() { fired = true; clearTimeout(timer); detach(); } };
}
