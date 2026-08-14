-- La poda a 3 versiones ordena por created_at, y con now() eso no siempre
-- ordena nada: now() devuelve la hora de la TRANSACCIÓN, así que dos versiones
-- archivadas dentro de la misma transacción nacen con el mismo instante y el
-- `limit 3` se queda tres cualesquiera. Se vio al probar el trigger: cinco
-- ediciones seguidas dejaron v1, v2 y v3 en vez de las tres últimas.
--
-- Editando desde la app cada cambio es su propia transacción y no se nota,
-- pero «casi siempre ordenado» no es una regla de retención: si se poda por
-- antigüedad, la antigüedad tiene que estar bien definida siempre.
--
-- clock_timestamp() es la hora real de reloj y avanza también dentro de una
-- transacción, así que dos filas de la misma nunca empatan.
alter table public.account_note_versions
  alter column created_at set default clock_timestamp();
