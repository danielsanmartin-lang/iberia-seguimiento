# IBERIA · Seguimiento

Seguimiento comercial compartido de cuentas de Iberia. Sustituye al Excel
`IBERIA - Seguimiento.xlsx` que se pasaba de mano en mano: una sola base de
datos, los tres comerciales escribiendo sobre las mismas filas y trazabilidad de
quién escribió qué.

**App:** https://danielsanmartin-lang.github.io/iberia-seguimiento/

## ⚠️ Este repo es público, los datos no

El repositorio es público porque GitHub Pages lo necesita en cuenta gratuita.
**Aquí no hay ni un solo dato de negocio**: ni nombres de empresa, ni contactos,
ni notas. Todo eso vive únicamente en Supabase, detrás de autenticación y RLS.

Lo único que se versiona son las dos claves *públicas por diseño*
(`SUPABASE_URL` y `sb_publishable_...`), que viajan al navegador de cualquier
usuario de todos modos. La seguridad real es RLS + Auth + Edge Functions.
La `service_role` key **nunca** se versiona: vive como secret del runtime de
Supabase. `.gitignore` bloquea `*.xlsx`, `*.csv` y cualquier `seed*.sql`.

Sin sesión, la API no devuelve nada:

```bash
curl -s "https://ppklcfsudukieqyaloze.supabase.co/rest/v1/accounts?select=name" \
  -H "apikey: sb_publishable_dDlkNDaWmCTg3mXLLbsacw_yXLuHDfE"
# → {"code":"42501","message":"permission denied for function is_member"}
```

## Qué hace

**Tabla** — Las 6 columnas del Excel (Cuenta, Región, Sector, Owner, Fecha,
Notas) más `Deal`, `URL de HubSpot`, `Próximo paso` y contador de notas.

- **Edición en la celda**: un clic, se guarda al salir, `Esc` cancela.
- **Filtro por columna** con recuentos, igual que el autofiltro de Excel, más
  buscador global y presets de fecha (hoy · esta semana · vencidos · sin fecha).
- **Columnas a la carta**: cada usuario elige qué ve y en qué orden; se guarda en
  su perfil, no en el navegador, así que le sigue entre dispositivos.
- **Realtime**: los cambios de uno aparecen en la pantalla de los otros sin
  recargar. Es una hoja compartida; hace falta.
- Las filas con fecha de seguimiento pasada salen en rojo.

**Ficha lateral** — Todos los campos más el **historial**: entradas con autor y
fecha automáticos. Cada uno edita solo lo que ha firmado él. El bloque de notas
que venía del Excel entra como primera entrada, marcada como importada.

**Panel superior** — Cuentas, Hoy, Esta semana, Vencidos, Sin fecha, Mías y
recuentos por Owner y Deal. Todo clicable: filtra la tabla.

**Import / Export** — Exporta a `.xlsx` o CSV exactamente lo que estés viendo
(columnas visibles × filas filtradas). Importa Excel o CSV con previsualización;
encuentra la cabecera aunque no esté en la primera fila y avisa de las filas que
se parecen a cuentas ya existentes.

**Duplicados** — Compara nombres normalizados (sin acentos, sin `S.A.`/`Grupo`…)
y lista las parejas sospechosas. No fusiona nada por su cuenta.

**Administración** (solo admin) — Crear usuarios con contraseña provisional,
resetear contraseñas, activar/desactivar, borrar, dar o quitar admin; gestionar
los catálogos de Región y Sector; definir columnas personalizadas.

## Acceso

No hay registro público. El admin crea las cuentas y entrega una contraseña
provisional que el usuario está obligado a cambiar en su primer acceso. No se
envía ningún correo: la contraseña se copia de la pantalla y se comparte por un
canal seguro. La sesión se cierra sola a los 30 minutos de inactividad.

Los tres usuarios ven y editan **todo**. La única diferencia por rol es el panel
de administración.

## Arquitectura

Sin build step, a propósito: HTML + CSS + módulos ES nativos, `supabase-js` y
SheetJS vendorizados, router por hash y rutas relativas. Eso es justo lo que
permite servir desde la raíz de `main` en GitHub Pages sin `base`, sin Actions de
build y sin fallback de SPA. Un `git push` publica.

```
index.html                todas las vistas (login, cambio de contraseña, tabla, admin, perfil)
css/styles.css            hoja única, variables CSS, temas día/noche
js/
  config.js               URL y clave publishable (públicas)
  supabaseClient.js       el cliente único
  auth.js  router.js  idle.js  theme.js  profile.js
  store.js                datos en memoria + escrituras + Realtime
  data.js                 definición de columnas y constantes de dominio
  grid.js                 tabla: orden, filtros, edición en celda, selector de columnas
  filters.js              estado de filtrado, KPIs y menú de filtro por columna
  panel.js                ficha lateral, historial de notas y alta de cuentas
  importexport.js         XLSX/CSV y detector de duplicados
  admin.js                usuarios, catálogos y columnas personalizadas
  util.js                 fechas, escapado, normalización de nombres, avisos
supabase/
  migrations/             esquema, RLS y catálogos (0001-0004)
  bootstrap-primer-admin.sql   se ejecuta UNA vez, a mano
  functions/              _shared/auth.ts + admin-create-user + admin-user-action
```

### Modelo de datos

`profiles` · `accounts` · `account_notes` · `catalog_options` · `field_defs` ·
`heartbeat`.

RLS deny-by-default con dos helpers en el esquema `private` (no expuesto por
PostgREST, así que no son invocables como RPC):

| Tabla | Lectura | Escritura |
|---|---|---|
| `accounts` | miembro activo | miembro activo (todo) |
| `account_notes` | miembro activo | añadir: miembro · editar/borrar: autor o admin |
| `catalog_options` | miembro activo | añadir/renombrar: miembro · borrar: admin |
| `field_defs` | miembro activo | solo admin |
| `profiles` | miembro activo | su propia fila; el resto vía Edge Function |
| `heartbeat` | nadie | nadie (RLS sin políticas) |

Tres capas impiden la escalada de privilegios: el trigger de alta fuerza el rol
`user` ignorando el metadata, `guard_profile_update` revierte `role` e
`is_active` para sesiones no admin, y las escrituras de admin sobre otros
perfiles van por Edge Function con `service_role`. Los perfiles nacen
**inactivos**: aunque alguien habilitara el registro público por error, un
auto-registro no daría acceso a nada.

### Edge Functions

`admin-create-user` y `admin-user-action`, desplegadas con `verify_jwt=false` (si
la plataforma verificara el JWT, el preflight `OPTIONS` de CORS se bloquearía
antes de llegar al código). La identidad y el rol se comprueban dentro, en
`_shared/auth.ts`, que también centraliza la lista de orígenes permitidos.

Al crear un usuario se le asignan automáticamente las cuentas que en el Excel
llevaban su nombre: los datos se migraron antes de que existieran los perfiles,
así que `accounts` guarda `owner_name` (texto) junto a `owner_id`.

## Desarrollo

```bash
python3 -m http.server 8765
```

Y abrir http://127.0.0.1:8765. No hay nada que instalar ni compilar.

Si se añade un origen nuevo (otro puerto, otro dominio), hay que añadirlo a
`ALLOWED_ORIGINS` en `supabase/functions/_shared/auth.ts` y volver a desplegar
las dos funciones.

## Mantenimiento

`.github/workflows/supabase-keepalive.yml` hace cuatro pings al día a
`rpc/ping`. Supabase pausa los proyectos Free tras 7 días sin tráfico entrante
por la API, y el SQL que corre dentro no cuenta.
