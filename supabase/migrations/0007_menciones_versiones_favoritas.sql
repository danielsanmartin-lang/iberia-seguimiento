-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  Menciones, versiones de nota y cuentas favoritas                    ║
-- ║  Todo aditivo: ninguna columna cambia de tipo ni se retira.          ║
-- ╚══════════════════════════════════════════════════════════════════════╝

-- ───────────────── 1 · quién editó una nota ─────────────────
-- account_notes sellaba `updated_at` pero no quién. Desde que la última nota se
-- edita con un clic en su celda —y un admin puede editar la de otro— «editada»
-- sin firma no dice lo suficiente.
alter table public.account_notes
  add column if not exists updated_by uuid references public.profiles(id) on delete set null;
create index if not exists account_notes_updated_by_idx on public.account_notes(updated_by);

-- stamp_updated_by() ya existe y hace exactamente esto: sella fecha y autor.
-- El trigger anterior usaba set_updated_at(), que solo sella la fecha.
drop trigger if exists account_notes_set_updated_at on public.account_notes;
create trigger account_notes_stamp_update
  before update on public.account_notes
  for each row execute function public.stamp_updated_by();

-- ───────────────── 2 · versiones de una nota ─────────────────
-- Editar la última nota corrige ESA entrada del historial, no crea otra. Para
-- que corregir no sea perder, el texto anterior se archiva aquí.
create table public.account_note_versions (
  id         uuid primary key default gen_random_uuid(),
  note_id    uuid not null references public.account_notes(id) on delete cascade,
  body       text not null,
  edited_by  uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index account_note_versions_note_idx
  on public.account_note_versions(note_id, created_at desc);
create index account_note_versions_editor_idx
  on public.account_note_versions(edited_by);

-- Se guardan las 3 últimas y se poda el resto. La poda vive aquí y no en el
-- cliente porque es una regla de retención del dato: da igual que la edición
-- venga de la celda, del popup o de un script.
--
-- SECURITY DEFINER porque la tabla no tiene política de INSERT: nadie escribe
-- en ella por la API, solo este trigger.
create or replace function public.archive_note_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.body is distinct from old.body then
    insert into public.account_note_versions (note_id, body, edited_by)
    values (old.id, old.body, auth.uid());

    delete from public.account_note_versions
     where note_id = old.id
       and id not in (
         select id from public.account_note_versions
          where note_id = old.id
          order by created_at desc
          limit 3
       );
  end if;
  return null;   -- AFTER trigger: el valor de retorno se ignora
end;
$$;
revoke execute on function public.archive_note_version() from public, anon, authenticated;

create trigger account_notes_archive_version
  after update on public.account_notes
  for each row execute function public.archive_note_version();

alter table public.account_note_versions enable row level security;

-- Solo lectura, y solo para miembros. Sin políticas de insert/update/delete:
-- el archivado entra por el trigger y la limpieza sale por el ON DELETE CASCADE
-- de la nota, y ninguno de los dos pasa por RLS.
create policy account_note_versions_select on public.account_note_versions
  for select using (private.is_member());

-- ───────────────── 3 · estado de las menciones ─────────────────
-- A quién menciona una nota NO se guarda: se deduce de su texto, que es la
-- única fuente de verdad (si alguien edita la nota y quita el @, la mención
-- desaparece sola). Lo único que se persiste es lo que no está en el texto:
-- si tú ya la has atendido.
--
-- La fila existe SOLO cuando se marca «Hecho». Ausencia = pendiente.
create table public.mention_states (
  note_id uuid not null references public.account_notes(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  done_at timestamptz not null default now(),
  primary key (note_id, user_id)
);
create index mention_states_user_idx on public.mention_states(user_id);

alter table public.mention_states enable row level security;

-- Cada uno gestiona lo suyo y no ve lo de los demás: es una lista de recados
-- personal, no información compartida. Sin UPDATE: marcar es insert y
-- deshacer es delete.
create policy mention_states_select on public.mention_states
  for select using (user_id = (select auth.uid()));
create policy mention_states_insert on public.mention_states
  for insert with check (private.is_member() and user_id = (select auth.uid()));
create policy mention_states_delete on public.mention_states
  for delete using (user_id = (select auth.uid()));

-- ───────────────── 4 · cuentas favoritas ─────────────────
-- Privadas de cada usuario. Van en el perfil, como column_prefs: no hacen falta
-- tabla ni políticas nuevas (profiles_update_self ya deja escribir la fila
-- propia, y guard_profile_update solo revierte role e is_active).
alter table public.profiles
  add column if not exists favorites jsonb not null default '[]'::jsonb;
