// Estado de la conexión y lectura de los fallos de escritura.
//
// La app no tiene cola offline: lo que no llega a Supabase, no se guarda. Este
// módulo existe para que eso no ocurra nunca en silencio, y para no confundir
// tres situaciones que el usuario vive de forma muy distinta:
//
//   · sin red       → el cambio no ha salido de aquí; reintentar sirve
//   · sesión muerta → hay que volver a entrar; reintentar no sirve de nada
//   · sin permiso   → la sesión vale, pero eso no se puede hacer
//
// La diferencia no es cosmética. Antes, una sesión caducada devolvía un
// «permission denied for function is_member» y el usuario seguía escribiendo
// notas que se caían una a una sin entender por qué.
//
// También vigila la vuelta de la conexión: Realtime no reproduce los eventos
// que se perdieron mientras estaba caído, así que sin recargar la pantalla se
// queda desincronizada de la base de datos sin avisar de nada.
import { sb } from './supabaseClient.js';
import { toast } from './util.js';

// Cada cuánto se pregunta si ha vuelto la conexión. Solo corre cuando ya sabemos
// que está caída: en marcha normal no hay ningún sondeo de fondo.
const PROBE_MS = 10000;
const PROBE_FIRST_MS = 1500;   // el primer intento, pronto: los cortes suelen ser breves

const net = { down: false, stale: false };

let probeTimer = null;
let rtExpected = false;    // ¿debería haber una suscripción de Realtime viva?
let authLostFired = false; // el aviso de sesión muerta se da una sola vez

const authLostFns = new Set();
const reconnectFns = new Set();

// La sesión ha muerto (token caducado o revocado, usuario desactivado).
export function onAuthLost(fn) { authLostFns.add(fn); }
// Ha vuelto la conexión y hay que recargar: falta lo que pasó mientras no estaba.
export function onReconnect(fn) { reconnectFns.add(fn); }

// ─────────────────────── clasificación de errores ───────────────────────
//
// PostgREST no lanza excepciones: devuelve status 0 cuando la petición no llegó
// a salir del navegador, y 401/403 cuando el servidor la rechazó. store.js pega
// ese status al objeto de error (withStatus) justo para poder decidir aquí sin
// adivinar a partir del texto, que cambia con el navegador y con el idioma.

// Sesión o permisos: reintentar no va a arreglar nada.
const AUTH_CODES = new Set([
  'PGRST301',   // JWT caducado o inválido
  'PGRST302',   // acceso anónimo deshabilitado
  '42501',      // permission denied (RLS, o is_member() sin EXECUTE para anon)
]);

// «El servidor contestó, pero la escritura no cuajó y puede ser cosa de la
// sesión». Un UPDATE bloqueado por RLS no da error: afecta a cero filas, y es
// el .single() el que se queja. Hay que preguntar antes de dar un mensaje.
const DOUBTFUL_CODES = new Set([
  'PGRST116',   // .single() sobre cero filas
  'APP_NO_ROW', // nuestro: un DELETE que no borró nada (ver store.js)
]);

const NET_RE = /failed to fetch|networkerror|network request failed|load failed|fetcherror/i;

// Pega al error el status que PostgREST devuelve por fuera. Lo llama todo el que
// haga una escritura, antes de pasar el error a writeFailed.
export function withStatus(error, status) {
  if (error && error.status === undefined) error.status = status;
  return error;
}

export function errorKind(error) {
  if (!error) return null;
  if (error.status === 0) return 'net';
  if (error.status === 401 || error.status === 403) return 'auth';
  if (AUTH_CODES.has(error.code)) return 'auth';
  if (DOUBTFUL_CODES.has(error.code)) return 'doubtful';
  if (NET_RE.test(error.message || '')) return 'net';
  return 'other';
}

// ¿Sigue viva la sesión? Una petición mínima que pasa por RLS: responde tanto
// al token caducado (401) como al usuario desactivado, que devuelve false en
// is_member() y que sb.auth.getUser() no vería, porque para Auth ese usuario
// sigue siendo perfectamente válido.
//
// true = viva · false = muerta · null = no se sabe (sigue sin haber red)
async function sessionAlive() {
  if (navigator.onLine === false) return null;
  const { error, status } = await sb
    .from('catalog_options').select('kind', { head: true, count: 'exact' });
  if (!error) return true;
  const kind = errorKind({ ...error, status });
  if (kind === 'auth') return false;
  if (kind === 'net') return null;
  return true;   // contestó otra cosa: la sesión no es el problema
}

// ─────────────────────────── indicador ───────────────────────────

// El rótulo de 'stale' habla de la sesión aunque el estado sea "el canal de
// Realtime no está vivo", y es a propósito: la causa habitual es volver al
// portátil después de horas con el token caducado, y ahí lo único que hay que
// hacer es recargar. Decir «Sin sincronizar» describía el síntoma y no la salida.
// En un corte pasajero del canal el cartel exagera, pero ese se recupera solo en
// segundos (SUBSCRIBED → recovered) y el tooltip matiza mientras dura.
function paint() {
  const el = document.getElementById('netState');
  if (!el) return;
  const mode = net.down ? 'down' : net.stale ? 'stale' : null;
  el.hidden = !mode;
  if (!mode) return;
  el.dataset.state = mode;
  el.innerHTML = `<i></i><span>${mode === 'down' ? 'Sin conexión' : 'Sesión caducada. Refresca la página.'}</span>`;
  el.title = mode === 'down'
    ? 'No hay conexión con la base de datos: lo que edites ahora no se guardará.'
    : 'Los cambios en directo no están llegando: puede que no estés viendo lo último '
      + 'de los demás. Recargar la página lo restablece.';
}

// ─────────────────────── caída y recuperación ───────────────────────

export function markOffline() {
  if (net.down) return;
  net.down = true;
  paint();
  scheduleProbe(PROBE_FIRST_MS);
}

function recovered() {
  clearTimeout(probeTimer);
  probeTimer = null;
  const wasDown = net.down || net.stale;
  net.down = false;
  net.stale = false;
  paint();
  // Aplazado: esto puede dispararse desde dentro del callback de estado del
  // canal de Realtime, y el oyente lo primero que hace es cerrar ese canal.
  if (wasDown) reconnectFns.forEach((fn) => setTimeout(fn, 0));
}

function scheduleProbe(ms = PROBE_MS) {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(async () => {
    if (!net.down) return;
    const alive = await sessionAlive();
    if (alive === true) { recovered(); return; }
    if (alive === false) { fireAuthLost(); return; }
    scheduleProbe();
  }, ms);
}

function fireAuthLost() {
  if (authLostFired) return;
  authLostFired = true;
  clearTimeout(probeTimer);
  probeTimer = null;
  net.down = false;
  net.stale = false;
  paint();
  authLostFns.forEach((fn) => fn());
}

// Al entrar de nuevo: la sesión es otra, así que vuelve a poder avisarse.
export function netReset() {
  authLostFired = false;
  net.down = false;
  net.stale = false;
  clearTimeout(probeTimer);
  probeTimer = null;
  paint();
}

// Estado del canal de Realtime, que store.js reporta al suscribirse. Es la
// única señal de que los cambios de los demás han dejado de llegar; sin ella la
// tabla se queda tan tranquila mostrando datos viejos.
export function realtimeStarted() { rtExpected = true; }

// Al cerrar el canal a propósito (logout, resincronización): el CLOSED que
// llega después es esperado y no debe pintar ninguna alarma.
export function realtimeStopped() {
  rtExpected = false;
  net.stale = false;
  paint();
}

export function noteRealtimeStatus(status) {
  if (!rtExpected) return;
  if (status === 'SUBSCRIBED') { recovered(); return; }
  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
    if (net.down) return;   // sin red ya hay un aviso más claro que este
    net.stale = true;
    paint();
  }
}

// ─────────────────────── mensajes al usuario ───────────────────────

// Traduce el fallo de una escritura y, si la sesión ha muerto, saca al usuario
// de la app en vez de dejarle seguir escribiendo al vacío.
//
// El verbo entra desde quien llama y va en infinitivo, con su complemento si
// hace falta ('guardar', 'borrar', 'guardar la nota', 'crear la cuenta'). Todos
// los mensajes de aquí lo encajan tal cual, así que no puede llevar nada
// pegado detrás.
export async function writeFailed(error, verb = 'guardar') {
  const kind = errorKind(error);

  if (kind === 'net') {
    markOffline();
    toast(`Sin conexión: no se pudo ${verb}. Vuelve a intentarlo cuando se recupere.`, 'err');
    return;
  }

  if (kind === 'auth' || kind === 'doubtful') {
    const alive = await sessionAlive();
    if (alive === false) {
      toast(`Tu sesión ha caducado: no se pudo ${verb}. Vuelve a entrar.`, 'err');
      fireAuthLost();
      return;
    }
    if (alive === null) {
      markOffline();
      toast(`Sin conexión: no se pudo ${verb}. Vuelve a intentarlo cuando se recupere.`, 'err');
      return;
    }
    toast(kind === 'auth'
      ? `No tienes permiso para ${verb}.`
      : `No se pudo ${verb}: la fila ya no existe o no tienes permiso.`, 'err');
    return;
  }

  toast(`No se pudo ${verb}: ${error.message}`, 'err');
}

// El fallo de la carga inicial (o de una resincronización), que no es una
// escritura pero se lee igual de mal si se suelta el mensaje crudo.
export async function loadFailed(error) {
  const kind = errorKind(error);
  if (kind === 'net') {
    markOffline();
    toast('Sin conexión: no se pudieron cargar los datos. Se reintentará solo.', 'err');
    return;
  }
  if (kind === 'auth' || kind === 'doubtful') {
    if (await sessionAlive() === false) {
      toast('Tu sesión ha caducado. Vuelve a entrar.', 'err');
      fireAuthLost();
      return;
    }
  }
  toast(`No se pudieron cargar los datos: ${error.message}`, 'err');
}

// ─────────────────────────── arranque ───────────────────────────

export function initNet() {
  // navigator.onLine miente por exceso de optimismo (dice "sí" con el wifi
  // conectado a un router sin salida), así que sirve para detectar la caída,
  // pero la vuelta la confirma siempre una petición de verdad.
  window.addEventListener('offline', () => markOffline());
  window.addEventListener('online', () => { if (net.down) scheduleProbe(PROBE_FIRST_MS); });
  if (navigator.onLine === false) markOffline();
  paint();
}
