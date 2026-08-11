// Exportar a Excel/CSV y revisar duplicados.
//
// La exportación saca exactamente lo que se está viendo (columnas visibles ×
// filas filtradas), para que "filtrar → exportar" sea previsible.
//
// No hay importación: los datos entran por la tabla o por el historial de
// notas, que llevan autor y fecha. Traerlos de un fichero los dejaría sin firma.
import { state, ownerName } from './store.js';
import { visibleColumns } from './grid.js';
import { visibleRows, cellValue } from './filters.js';
import { escHtml, looksLikeDuplicate, toast, fmtDate } from './util.js';
import { openPanel } from './panel.js';

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
  // El botón de historial no es un dato exportable; la última nota sí.
  const cols = visibleColumns().filter((c) => c.type !== 'noteslog');
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

export function initImportExport() {
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

  document.getElementById('btnDup').addEventListener('click', reviewDuplicates);
}
