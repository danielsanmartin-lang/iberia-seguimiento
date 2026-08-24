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

**Tabla** — Cuenta, Región, Sector, Owner, Fecha, **Última nota** e **Histórico
de notas**. «Actualizado» está disponible pero oculta por defecto.

- **Edición en la celda**: un clic, se guarda al salir, `Esc` cancela.
- **La última nota se lee entera** en su celda: la fila crece hasta que cabe.
- **Y se edita ahí mismo**, con un clic, como cualquier otra celda: se abre un
  editor multilínea que crece con el texto (`Esc` cancela, `Ctrl`/`⌘`+`Enter`
  guarda sin salir). Corrige *esa* entrada del historial, no crea una nueva —
  para eso está el botón «Notas». Rige la misma regla que el historial: edita
  quien la firmó, o un admin; si es de otro, el clic abre el historial, que es
  donde puede añadir la suya. Sobre una celda vacía se escribe la primera nota.
- **Histórico de notas**: un botón abre un popup con solo el historial.
- **Menciones**: escribe `@` en cualquier nota y sale la lista de compañeros.
  Vale el nombre completo o el de pila. Ver más abajo.
- **Favoritas**: la estrella junto al nombre marca una cuenta como tuya de
  seguimiento cercano, y el tile «Favoritas» las saca de un clic. Son privadas:
  las tuyas no las ve nadie más.
- **Filtro por columna** con recuentos, igual que el autofiltro de Excel. La
  columna de fecha agrupa por mes («ago 2026»), no por día.
- **Buscador global** que entra también dentro de todas las notas, no solo de
  la última: un contacto suele estar enterrado en una entrada antigua.
- **Columnas a la carta**: arrastra una cabecera para moverla de sitio, o usa el
  botón «Columnas» para mostrar/ocultar. Se guarda en el perfil, no en el
  navegador, así que te sigue entre dispositivos.
- **Realtime**: los cambios de uno aparecen en la pantalla de los otros sin
  recargar. Es una hoja compartida; hace falta.
- Las filas con fecha de seguimiento pasada salen en rojo.

**Ficha lateral** (doble clic en el nombre) — Cuenta, Región, Sector, Owner y
URL de HubSpot. Nada más: el historial tiene su propio popup y la fecha se edita
en su columna, así que no se repiten aquí.

**Alta de cuenta** — Además de esos campos, el diálogo pide **fecha de
seguimiento** y **primera nota**. Sí se repiten aquí, al revés que en la ficha, y
es a propósito: cuando das de alta una cuenta acabas de hablar con alguien, sabes
cuándo toca volver y tienes algo que contar. Dejarlo para después significaba
crear, abrir la ficha, cerrar, buscar la fila, poner la fecha y abrir las notas.
La nota entra como una entrada normal del historial, firmada y fechada.

**Historial** — Entradas con autor y fecha automáticos; cada uno edita solo lo
que ha firmado él. Las notas que venían del Excel están marcadas como importadas.

Editar una entrada la corrige, no la duplica, así que **el texto anterior se
archiva**: la entrada queda marcada como «editada por … · ver versiones» y
desde ahí se leen los cuerpos anteriores, cada uno con quién lo cambió y cuándo.
Se guardan **las tres últimas**; a partir de ahí se va tirando la más antigua.
La marca no cuesta ninguna consulta —una nota editada tiene `updated_at` por
delante de `created_at`, y eso ya está en memoria—; los textos solo se piden al
desplegarlos, así que el popup sigue abriéndose sin esperar a la red.

**Menciones** — `@Nombre` dentro de una nota. A quién menciona una nota no se
guarda en ninguna parte: se deduce de su texto, que es la única fuente de
verdad, de modo que editar la nota y quitar el `@` retira la mención sola. Lo
único que se persiste es si tú ya la has atendido.

Quien es mencionado la ve por tres sitios, cada uno con su papel: el **tile
«Menciones»** filtra la tabla a esas cuentas, la **bandeja** de la cabecera
—con su insignia— es donde se acciona («Ver» abre el historial por esa entrada
exacta, «Hecho» la retira, con «Deshacer» de cortesía), y el **chip de color**
dentro del texto la hace visible desde la propia tabla, resaltada si eres tú.
Si la mención llega mientras tienes la app abierta, salta un aviso: la nota de
otro ya viaja por Realtime, así que enterarse no debería exigir recargar. No hay
correos ni notificaciones del navegador, a propósito.

**Panel superior** — Cuentas, Hoy, Esta semana, Próxima semana, Mes actual,
Próximo mes, Vencidos, Sin fecha, Mías, Favoritas, Menciones y recuentos por Owner. Todo
clicable: filtra la tabla. Cada número se recalcula con los filtros puestos e
ignora solo el suyo, así que dice cuántas filas verás al pulsarlo (con Owner =
Ana, «Vencidos» son las vencidas de Ana) sin que los demás se muevan bajo el dedo
al usarlos. Los tramos de fecha se solapan a propósito: «Esta semana» va de hoy al
domingo y «Próxima semana» es la semana natural siguiente, mientras que «Mes
actual» y «Próximo mes» son meses naturales enteros —así que el primero incluye
también lo que ya venció este mes—. Pasando el ratón por encima, cada tile de
fecha enseña su tramo real («31 Agosto – 6 Septiembre», «Septiembre»), calculado
en cada pintado; el rótulo lo dibuja el CSS y no el `title` del navegador, que
tarda casi un segundo en aparecer.

**Export** — A `.xlsx` o CSV, exactamente lo que estés viendo (columnas visibles
× filas filtradas). **No hay importación**: los datos entran por la tabla o por
el historial, que llevan autor y fecha; traerlos de un fichero los dejaría sin
firma.

**Duplicados** — Compara nombres normalizados (sin acentos, sin `S.A.`/`Grupo`…)
y lista las parejas sospechosas. No fusiona nada por su cuenta.

**Administración** (solo admin) — Crear usuarios con contraseña provisional,
resetear contraseñas, activar/desactivar, borrar, dar o quitar admin; gestionar
los catálogos de Región y Sector; definir columnas personalizadas.

## Acceso

No hay registro público. El admin crea las cuentas y entrega una contraseña
provisional que el usuario está obligado a cambiar en su primer acceso. No se
envía ningún correo: la contraseña se copia de la pantalla y se comparte por un
canal seguro. La sesión se cierra sola a las 12 horas de inactividad.

Los tres usuarios ven y editan **todo**. La única diferencia por rol es el panel
de administración.

## Qué pasa si se cae la conexión (o la sesión)

**No hay cola offline.** Lo que no llega a Supabase no se guarda, y no se sube
solo más tarde. La app está construida para que eso nunca pase en silencio:

- **Aviso en la cabecera.** «Sin conexión» (rojo) cuando la base de datos no
  responde; «Sesión caducada. Refresca la página.» (ámbar) cuando lo que se ha
  caído es Realtime y puede que no estés viendo los cambios de los demás — el
  caso típico es volver al portátil después de horas, y recargar lo arregla. Si
  no hay aviso, no hay problema.
- **Lo escrito no se pierde de vista.** Una celda que no se ha podido guardar se
  queda marcada en ámbar mostrando el valor que hay en la base de datos —lo que
  no está guardado no puede aparentar estarlo— y un clic reabre el editor con lo
  que habías escrito. Las notas y el alta de cuentas conservan el texto en su
  formulario. Nada de esto sobrevive a recargar la página: el reintento es
  manual y hay que hacerlo antes de cerrar.
- **Recarga al recuperar la conexión.** Realtime no reproduce los eventos que se
  perdieron mientras estaba caído, así que al volver se recargan los datos. Sin
  eso la pantalla se quedaba con datos viejos sin avisar de nada.
- **Sesión muerta ≠ sin red.** Si el token ha caducado o el usuario ha sido
  desactivado, seguir en la app solo sirve para escribir al vacío: se cierra la
  sesión y se explica por qué en la pantalla de acceso. Antes la app te dejaba
  dentro, aparentemente normal, devolviendo un `permission denied for function
  is_member` por cada cambio.

La distinción se hace con el status que devuelve PostgREST (`0` = la petición no
salió del navegador, `401`/`403` = rechazada) y, cuando el código no es
concluyente, con una petición mínima que pasa por RLS y responde tanto al token
caducado como al usuario desactivado. Todo esto vive en `js/net.js`.

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
  net.js                  estado de la conexión y lectura de los fallos de escritura
  store.js                datos en memoria + escrituras + Realtime
  data.js                 definición de columnas y constantes de dominio
  grid.js                 tabla: orden, filtros, edición en celda, selector de columnas
  filters.js              estado de filtrado, KPIs y menú de filtro por columna
  panel.js                ficha lateral, historial de notas y alta de cuentas
  mentions.js             @menciones: parseo, autocompletado, chips y bandeja
  importexport.js         exportación XLSX/CSV y detector de duplicados
  admin.js                usuarios, catálogos y columnas personalizadas
  util.js                 fechas, escapado, normalización de nombres, avisos
supabase/
  migrations/             esquema, RLS y catálogos (0001-0007)
  bootstrap-primer-admin.sql   se ejecuta UNA vez, a mano
  functions/              _shared/auth.ts + admin-create-user + admin-user-action
```

### Modelo de datos

`profiles` · `accounts` · `account_notes` · `account_note_versions` ·
`mention_states` · `catalog_options` · `field_defs` · `heartbeat`.

Las favoritas no tienen tabla: son un `jsonb` en `profiles`, como
`column_prefs`. Son de una persona y no las lee nadie más, así que no hay nada
que compartir ni que sincronizar.

RLS deny-by-default con dos helpers en el esquema `private` (no expuesto por
PostgREST, así que no son invocables como RPC):

| Tabla | Lectura | Escritura |
|---|---|---|
| `accounts` | miembro activo | miembro activo (todo) |
| `account_notes` | miembro activo | añadir: miembro · editar/borrar: autor o admin |
| `account_note_versions` | miembro activo | **nadie**: solo entra por trigger |
| `mention_states` | solo las tuyas | solo las tuyas (insert/delete) |
| `catalog_options` | miembro activo | añadir/renombrar: miembro · borrar: admin |
| `field_defs` | miembro activo | solo admin |
| `profiles` | miembro activo | su propia fila; el resto vía Edge Function |
| `heartbeat` | nadie | nadie (RLS sin políticas) |

`account_note_versions` no tiene ninguna política de escritura a propósito: el
archivado lo hace un trigger `security definer` al editar la nota, y la limpieza
sale por el `on delete cascade`. Ninguno de los dos pasa por RLS, así que el
archivo histórico no se puede tocar desde el navegador — ni siquiera por quien
firmó la nota.

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
