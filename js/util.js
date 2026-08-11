// Utilidades compartidas: escapado, fechas, normalización de nombres y avisos.

export function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ─────────────────────────── fechas ───────────────────────────
// Todo se maneja como 'YYYY-MM-DD' en hora local: son fechas de agenda, no
// instantes, y convertirlas a UTC provocaría desfases de un día.

export function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${d}/${MESES[Number(m) - 1]}/${y}`;
}

export function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Días desde hoy: negativo = pasado (vencido), 0 = hoy.
export function daysFromToday(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

// Fin de la semana natural en curso (domingo), para el KPI "esta semana".
export function endOfWeekISO() {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7;       // 0 = lunes
  d.setDate(d.getDate() + (6 - dow));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ───────────────────── nombres de empresa ─────────────────────
// Para detectar duplicados: "Allianz España, S.A." y "allianz espana sa" deben
// colapsar en la misma clave.
const SUFIJOS = /\b(s\.?a\.?u?|s\.?l\.?u?|sociedad anonima|sociedad limitada|inc|ltd|llc|gmbh|bv|nv|plc|group|grupo|holding|iberia|espana|spain|portugal)\b/g;

export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // quita acentos
    .replace(/[.,&/\\'"()-]/g, ' ')
    .replace(SUFIJOS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Distancia de Levenshtein acotada: si supera max, corta y devuelve max+1.
export function levenshtein(a, b, max = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// ¿Son "la misma empresa" a ojos del detector de duplicados?
export function looksLikeDuplicate(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const [corto, largo] = na.length <= nb.length ? [na, nb] : [nb, na];

  // Prefijo por palabra completa: "Aena" ≈ "Aena Internacional". Se exige que
  // el nombre corto sea sustancial y el corte caiga en un espacio; con
  // subcadenas a secas, "Eurocaja Rural" contiene "Caja Rural" y no lo son.
  if (corto.length >= 5 && largo.startsWith(corto + ' ')) return true;

  // Erratas: solo en nombres largos, donde una letra de diferencia delata un
  // typo. En nombres cortos es simplemente otra empresa ("Sesé" y "SEPE").
  if (corto.length < 7) return false;
  const tol = corto.length >= 12 ? 2 : 1;
  return levenshtein(na, nb, tol) <= tol;
}

// ─────────────────────────── avisos ───────────────────────────
let toastTimer = null;
export function toast(msg, kind = 'ok') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'err' ? 6000 : 3200);
}

// Contraseña provisional legible: sin I/O/l/o/0/1 para poder dictarla.
export function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const specials = '!@#$%&*?';
  const buf = new Uint32Array(14);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < 12; i++) out += chars[buf[i] % chars.length];
  out += specials[buf[12] % specials.length];
  out += (buf[13] % 90) + 10;
  return out;
}
