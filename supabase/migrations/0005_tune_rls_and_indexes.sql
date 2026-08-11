-- Ajustes que señaló el advisor de rendimiento. Ninguno cambia el
-- comportamiento: mismas reglas, ejecutadas mejor.

-- 1) auth.uid() dentro de una política se re-evalúa por fila. Envuelto en un
--    SELECT, Postgres lo trata como InitPlan y lo calcula una sola vez.
drop policy profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy profiles_select_members on public.profiles;
create policy profiles_select_members on public.profiles
  for select using (id = (select auth.uid()) or private.is_member());

drop policy account_notes_insert on public.account_notes;
create policy account_notes_insert on public.account_notes
  for insert with check (private.is_member() and author_id = (select auth.uid()));

drop policy account_notes_update on public.account_notes;
create policy account_notes_update on public.account_notes
  for update using (author_id = (select auth.uid()) or private.is_admin())
             with check (author_id = (select auth.uid()) or private.is_admin());

drop policy account_notes_delete on public.account_notes;
create policy account_notes_delete on public.account_notes
  for delete using (author_id = (select auth.uid()) or private.is_admin());

-- 2) field_defs tenía una política FOR ALL que solapaba con la de SELECT, así
--    que cada lectura evaluaba las dos. Se separa la escritura por acción.
drop policy field_defs_write on public.field_defs;
create policy field_defs_insert on public.field_defs for insert with check (private.is_admin());
create policy field_defs_update on public.field_defs for update using (private.is_admin()) with check (private.is_admin());
create policy field_defs_delete on public.field_defs for delete using (private.is_admin());

-- 3) Claves ajenas sin índice: sin ellos, borrar un perfil obliga a recorrer
--    entera cada tabla que le apunta.
create index if not exists account_notes_author_idx on public.account_notes(author_id);
create index if not exists accounts_created_by_idx  on public.accounts(created_by);
create index if not exists accounts_updated_by_idx  on public.accounts(updated_by);
