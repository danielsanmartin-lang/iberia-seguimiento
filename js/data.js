// Modelo de columnas y constantes de dominio.
//
// La tabla se pinta a partir de esta lista: cambiar el orden o la visibilidad
// aquí (o en las preferencias del usuario) basta para cambiar la vista. Las
// columnas personalizadas que defina el admin se añaden al final en runtime.

export const DEAL_STAGES = ['SQL', 'Demo', 'PoC', 'Negotiation', 'Verbal Agreement', 'Win'];

// type gobierna cómo se pinta y cómo se edita la celda:
//   text | date | select | catalog (lista editable en BD) | owner | meta (solo lectura)
export const CORE_COLUMNS = [
  { key: 'name',        label: 'Cuenta',       type: 'text',    width: '2fr',    min: 170, fixed: true },
  { key: 'region',      label: 'Región',       type: 'catalog', catalog: 'region', width: '1.1fr', min: 108 },
  { key: 'sector',      label: 'Sector',       type: 'catalog', catalog: 'sector', width: '1fr',  min: 100 },
  // Owner necesita algo más de sitio que el resto: los nombres completos
  // ("Daniel San Martín") no caben en una columna estrecha.
  { key: 'owner_id',    label: 'Owner',        type: 'owner',   width: '1fr',    min: 125 },
  { key: 'next_touch',  label: 'Fecha',        type: 'date',    width: '.85fr',  min: 100 },
  { key: 'deal_stage',  label: 'Deal',         type: 'select',  options: DEAL_STAGES, width: '.95fr', min: 108 },
  { key: 'next_step',   label: 'Próximo paso', type: 'text',    width: '2.6fr',  min: 170 },
  // Estas dos llevan cabecera corta pero necesitan sitio para el título más el
  // botón de filtro; por debajo de esto el encabezado sale recortado.
  { key: 'hubspot_url', label: 'HubSpot',      type: 'link',    width: '104px',  min: 104 },
  { key: 'notes_count', label: 'Notas',        type: 'meta',    width: '82px',   min: 82 },
  { key: 'updated_at',  label: 'Actualizado',  type: 'meta',    width: '1fr',    min: 128 },
];

// Vista por defecto: todo menos "Actualizado", que interesa poco a diario.
export const DEFAULT_VISIBLE = CORE_COLUMNS
  .filter((c) => c.key !== 'updated_at')
  .map((c) => c.key);

// Los campos que se editan en la celda (el resto se toca en el panel).
export const EDITABLE_TYPES = new Set(['text', 'date', 'select', 'catalog', 'owner']);

// Cabeceras del CSV/Excel de exportación e importación. Las claves son las
// mismas que en BD para que exportar → editar → reimportar sea simétrico.
export const EXPORT_HEADERS = [
  ['name', 'Cuenta'],
  ['region', 'Región'],
  ['sector', 'Sector'],
  ['owner_name', 'Owner'],
  ['next_touch', 'Fecha'],
  ['deal_stage', 'Deal'],
  ['next_step', 'Próximo paso'],
  ['hubspot_url', 'HubSpot'],
];
