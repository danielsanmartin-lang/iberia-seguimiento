// Exportar a Excel/CSV, importar desde Excel/CSV y revisar duplicados.
//
// La exportación saca exactamente lo que se está viendo (columnas visibles ×
// filas filtradas), para que "filtrar → exportar" sea previsible.
import { state, createAccounts, updateField, ownerName } from './store.js';
import { visibleColumns } from './grid.js';
import { visibleRows, cellValue } from './filters.js';
import { escHtml, normalizeName, looksLikeDuplicate, toast, fmtDate } from './util.js';
import { openPanel } from './panel.js';

let afterChange = () => {};

// Cabeceras que el importador sabe reconocer → campo en BD.
const HEADER_MAP = new Map([
  ['cuenta', 'name'], ['empresa', 'name'], ['name', 'name'], ['account', 'name'],
  ['region', 'region'], ['región', 'region'],
  ['sector', 'sector'],
  ['owner', 'owner_name'], ['propietario', 'owner_name'], ['responsable', 'owner_name'],
  ['fecha', 'next_touch'], ['próximo seguimiento', 'next_touch'], ['next_touch', 'next_touch'],
  ['deal', 'deal_stage'], ['etapa', 'deal_stage'], ['deal_stage', 'deal_stage'],
  ['próximo paso', 'next_step'], ['proximo paso', 'next_step'], ['next_step', 'next_step'],
  ['hubspot', 'hubspot_url'], ['url hubspot', 'hubspot_url'], ['hubspot_url', 'hubspot_url'],
]);

const IMPORTABLE = ['name', 'region', 'sector', 'owner_name', 'next_touch', 'deal_stage', 'next_step', 'hubspot_url'];

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function matrix() {
  const cols = visibleColumns().filter((c) => c.key !== 'notes_count');
  const head = cols.map((c) => c.label);
  const rows = visibleRows().map((a) => cols.map((c) => {
    const v = cellValue(a, c.key);
    if (v === null || v === undefined) return '';
    if (c.key === 'next_touch') return fmtDate(v);
    return String(v);
  }));
  return [head, ...rows];
}

// ─────────────────────────── exportar ───────────────────────────

export function exportCsv() {
  const data = matrix();
  const esc = (s) => (/[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  // BOM UTF-8: sin él Excel abre los acentos como mojibake. Separador ';'
  // porque es lo que espera Excel en configuración regional española.
  const csv = '﻿' + data.map((r) => r.map(esc).join(';')).join('\r\n');
  download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `iberia-seguimiento-${stamp()}.csv`);
  toast(`${data.length - 1} filas exportadas a CSV.`);
}

export function exportXlsx() {
  if (!window.XLSX) { toast('No se pudo cargar el generador de Excel.', 'err'); return; }
  const data = matrix();
  const ws = window.XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = data[0].map((h, i) => ({
    wch: Math.min(60, Math.max(12, ...data.map((r) => String(r[i] || '').length + 2))),
  }));
  ws['!autofilter'] = { ref: window.XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length - 1, c: data[0].length - 1 } }) };
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Seguimiento');
  window.XLSX.writeFile(wb, `iberia-seguimiento-${stamp()}.xlsx`);
  toast(`${data.length - 1} filas exportadas a Excel.`);
}

// ─────────────────────────── importar ───────────────────────────

// Excel entrega las fechas como serial numérico o como texto; se normaliza a
// 'YYYY-MM-DD' y lo que no se entienda se descarta (mejor vacío que mal).
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, sept: 9, oct: 10, nov: 11, dic: 12 };
  let m = s.match(/^(\d{1,2})[/\-\s]([A-Za-zÁ-úñ]+)[/\-\s](\d{4})$/);
  if (m) {
    const mm = MESES[m[2].toLowerCase().slice(0, 4)] ?? MESES[m[2].toLowerCase().slice(0, 3)];
    if (mm) return `${m[3]}-${String(mm).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('No se pudo leer el fichero'));
    fr.onload = () => {
      try {
        const wb = window.XLSX.read(fr.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        resolve(window.XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, raw: true }));
      } catch (e) { reject(e); }
    };
    fr.readAsArrayBuffer(file);
  });
}

// La cabecera no siempre está en la primera fila (el Excel original la tenía en
// la segunda): se busca la primera fila que contenga alguna columna conocida.
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const hits = rows[i].filter((c) => HEADER_MAP.has(String(c || '').trim().toLowerCase()));
    if (hits.length >= 2) return i;
  }
  return -1;
}

async function handleFile(file) {
  const dlg = document.getElementById('dlgImport');
  const out = document.getElementById('impBody');
  out.innerHTML = '<p class="muted">Leyendo…</p>';

  let rows;
  try { rows = await readFile(file); } catch (e) {
    out.innerHTML = `<p class="err-box">No se pudo leer el fichero: ${escHtml(e.message)}</p>`;
    return;
  }

  const hi = findHeader(rows);
  if (hi < 0) {
    out.innerHTML = `<p class="err-box">No encuentro la cabecera. Necesito al menos dos columnas
      reconocibles (Cuenta, Región, Sector, Owner, Fecha, Deal, Próximo paso, HubSpot).</p>`;
    return;
  }

  const cols = rows[hi].map((c) => HEADER_MAP.get(String(c || '').trim().toLowerCase()) || null);
  if (!cols.includes('name')) {
    out.innerHTML = '<p class="err-box">Falta la columna «Cuenta»: sin nombre no se puede importar nada.</p>';
    return;
  }

  const byName = new Map(state.accounts.map((a) => [normalizeName(a.name), a]));
  const nuevas = [];
  const existentes = [];
  for (const r of rows.slice(hi + 1)) {
    const rec = {};
    cols.forEach((key, i) => {
      if (!key || !IMPORTABLE.includes(key)) return;
      let v = r[i];
      if (v === undefined || v === null || String(v).trim() === '') return;
      if (key === 'next_touch') { v = parseDate(v); if (!v) return; }
      else v = String(v).trim();
      rec[key] = v;
    });
    if (!rec.name) continue;
    const hit = byName.get(normalizeName(rec.name));
    if (hit) existentes.push({ rec, acc: hit }); else nuevas.push(rec);
  }

  if (!nuevas.length && !existentes.length) {
    out.innerHTML = '<p class="err-box">El fichero no tiene ninguna fila con nombre de cuenta.</p>';
    return;
  }

  // Duplicados "blandos": nombre distinto pero muy parecido a uno que ya existe.
  const sospechosas = nuevas.filter((n) => state.accounts.some((a) => looksLikeDuplicate(a.name, n.name)));

  out.innerHTML = `
    <p>Cabecera detectada en la fila ${hi + 1}. Columnas reconocidas:
       <b>${cols.filter(Boolean).map((c) => escHtml(c)).join(', ')}</b>.</p>
    <ul class="imp-sum">
      <li><b>${nuevas.length}</b> cuentas nuevas se crearán.</li>
      <li><b>${existentes.length}</b> ya existen (mismo nombre).</li>
      ${sospechosas.length ? `<li class="warn"><b>${sospechosas.length}</b> nuevas se parecen a cuentas
        existentes: ${sospechosas.slice(0, 5).map((s) => escHtml(s.name)).join(', ')}${sospechosas.length > 5 ? '…' : ''}</li>` : ''}
    </ul>
    <label class="chk"><input type="checkbox" id="impUpdate" ${existentes.length ? '' : 'disabled'}>
      Actualizar también las que ya existen (solo los campos que traiga el fichero)</label>
    <label class="chk"><input type="checkbox" id="impSkipDup" ${sospechosas.length ? 'checked' : 'disabled'}>
      Omitir las ${sospechosas.length} nuevas que parecen duplicadas</label>
    <div class="dlg-acts">
      <button class="btn" type="button" id="impCancel">Cancelar</button>
      <button class="btn primary" type="button" id="impRun">Importar</button>
    </div>`;

  out.querySelector('#impCancel').onclick = () => dlg.close();
  out.querySelector('#impRun').onclick = async () => {
    const doUpdate = out.querySelector('#impUpdate').checked;
    const skipDup = out.querySelector('#impSkipDup').checked;
    const sosp = new Set(sospechosas.map((s) => s.name));
    const toCreate = skipDup ? nuevas.filter((n) => !sosp.has(n.name)) : nuevas;

    out.querySelector('#impRun').disabled = true;
    let creadas = 0;
    let actualizadas = 0;

    if (toCreate.length) {
      const { created, error } = await createAccounts(toCreate);
      if (error) { toast(`Error al crear: ${error.message}`, 'err'); out.querySelector('#impRun').disabled = false; return; }
      creadas = created.length;
    }
    if (doUpdate) {
      for (const { rec, acc } of existentes) {
        for (const [k, v] of Object.entries(rec)) {
          if (k === 'name') continue;
          if (String(acc[k] ?? '') === String(v)) continue;
          await updateField(acc.id, k, v);
          actualizadas++;
        }
      }
    }
    dlg.close();
    toast(`Importación terminada: ${creadas} cuentas creadas, ${actualizadas} campos actualizados.`);
    afterChange();
  };
}

// ─────────────────────── revisión de duplicados ───────────────────────

export function reviewDuplicates() {
  const dlg = document.getElementById('dlgDup');
  const out = document.getElementById('dupBody');
  const accs = state.accounts;
  const pares = [];
  for (let i = 0; i < accs.length; i++) {
    for (let j = i + 1; j < accs.length; j++) {
      if (looksLikeDuplicate(accs[i].name, accs[j].name)) pares.push([accs[i], accs[j]]);
    }
  }
  out.innerHTML = pares.length
    ? `<p>${pares.length} pareja${pares.length === 1 ? '' : 's'} de cuentas que podrían ser la misma empresa.
        Ábrelas y decide: la app no fusiona nada por su cuenta.</p>
       <div class="dup-list">${pares.map(([a, b]) => `
         <div class="dup-pair">
           <button type="button" data-open="${a.id}">${escHtml(a.name)}<small>${escHtml(ownerName(a) || 'sin owner')} · ${a.notes_count || 0} notas</small></button>
           <span class="dup-vs">≈</span>
           <button type="button" data-open="${b.id}">${escHtml(b.name)}<small>${escHtml(ownerName(b) || 'sin owner')} · ${b.notes_count || 0} notas</small></button>
         </div>`).join('')}</div>`
    : '<p>No hay cuentas que parezcan duplicadas. 👌</p>';
  out.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
    dlg.close();
    openPanel(b.dataset.open);
  }));
  dlg.showModal();
}

// ─────────────────────────── enganches ───────────────────────────

export function initImportExport(onChange) {
  afterChange = onChange || (() => {});

  document.getElementById('btnExport').addEventListener('click', (e) => {
    const menu = document.createElement('div');
    menu.className = 'fmenu mini';
    menu.innerHTML = `<button type="button" data-x="xlsx">Excel (.xlsx)</button>
                      <button type="button" data-x="csv">CSV (para Excel)</button>`;
    document.body.appendChild(menu);
    const r = e.currentTarget.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.left = `${Math.round(Math.min(r.left, window.innerWidth - 200))}px`;
    menu.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-x]');
      if (!b) return;
      menu.remove();
      if (b.dataset.x === 'csv') exportCsv(); else exportXlsx();
    });
    setTimeout(() => document.addEventListener('mousedown', function off(ev) {
      if (menu.contains(ev.target)) return;
      document.removeEventListener('mousedown', off);
      menu.remove();
    }), 0);
  });

  const fileInput = document.getElementById('impFile');
  document.getElementById('btnImport').addEventListener('click', () => {
    document.getElementById('impBody').innerHTML =
      '<p>Elige un Excel o CSV. Se reconocen las columnas Cuenta, Región, Sector, Owner, Fecha, Deal, Próximo paso y HubSpot; el resto se ignora.</p>' +
      '<div class="dlg-acts"><button class="btn" type="button" onclick="this.closest(\'dialog\').close()">Cancelar</button>' +
      '<button class="btn primary" type="button" id="impPick">Elegir fichero…</button></div>';
    document.getElementById('impPick').onclick = () => fileInput.click();
    document.getElementById('dlgImport').showModal();
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
    fileInput.value = '';
  });

  document.getElementById('btnDup').addEventListener('click', reviewDuplicates);
}
