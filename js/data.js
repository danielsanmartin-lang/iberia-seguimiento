// Modelo de campos y de columnas.
//
// Un único registro de campos (F) alimenta dos listas que ya no coinciden:
//   · GRID_COLUMNS  — lo que puede mostrar la tabla
//   · PANEL_FIELDS  — lo que se edita en la ficha de la cuenta
// Deal y la URL de HubSpot viven solo en la ficha: en la tabla ocupaban sitio
// sin aportar, y la URL se ve igual en el icono que va junto al nombre.

export const DEAL_STAGES = ['SQL', 'Demo', 'PoC', 'Negotiation', 'Verbal Agreement', 'Win'];

// type gobierna cómo se pinta y cómo se edita:
//   text | url | date | select | catalog (lista editable en BD) | owner
//   note (última nota, multilínea) | noteslog (botón al historial) | meta (solo lectura)
const F = {
  name:        { key: 'name',        label: 'Cuenta',         type: 'text' },
  region:      { key: 'region',      label: 'Región',         type: 'catalog', catalog: 'region' },
  sector:      { key: 'sector',      label: 'Sector',         type: 'catalog', catalog: 'sector' },
  owner_id:    { key: 'owner_id',    label: 'Owner',          type: 'owner' },
  next_touch:  { key: 'next_touch',  label: 'Fecha',          type: 'date' },
  deal_stage:  { key: 'deal_stage',  label: 'Deal',           type: 'select', options: DEAL_STAGES },
  hubspot_url: { key: 'hubspot_url', label: 'URL de HubSpot', type: 'url' },
};

export const GRID_COLUMNS = [
  { ...F.name,       width: '2fr',    min: 170, fixed: true },
  { ...F.region,     width: '1.1fr',  min: 108 },
  { ...F.sector,     width: '1fr',    min: 100 },
  // Owner necesita algo más de sitio: los nombres completos ("Daniel San
  // Martín") no caben en una columna estrecha.
  { ...F.owner_id,   width: '1fr',    min: 125 },
  { ...F.next_touch, width: '.85fr',  min: 100 },
  // La columna ancha: la nota se lee entera, sin abrir nada. Filtrar por su
  // texto listaría un valor distinto por cuenta, así que no lleva embudo.
  { key: 'last_note', label: 'Última nota', type: 'note',
    width: '3.2fr', min: 240, noFilter: true },
  { key: 'notes_log', label: 'Histórico de notas', type: 'noteslog',
    width: '150px', min: 150, noFilter: true, noSort: true },
  { key: 'updated_at', label: 'Actualizado', type: 'meta', width: '1fr', min: 128 },
];

// Campos de la ficha, en el orden en que se pintan.
export const PANEL_FIELDS = [
  F.region, F.sector, F.owner_id, F.next_touch, F.deal_stage, F.hubspot_url,
];

// Vista por defecto: todo menos "Actualizado", que interesa poco a diario.
export const DEFAULT_VISIBLE = GRID_COLUMNS
  .filter((c) => c.key !== 'updated_at')
  .map((c) => c.key);

// Los tipos que se editan haciendo clic en la celda. La nota y el botón de
// historial quedan fuera a propósito: se tocan desde la ficha o el popup.
export const EDITABLE_TYPES = new Set(['text', 'date', 'select', 'catalog', 'owner']);
