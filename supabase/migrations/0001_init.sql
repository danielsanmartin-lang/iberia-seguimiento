-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  IBERIA — Seguimiento · esquema inicial                              ║
-- ║  Base ÚNICA y COMPARTIDA: cualquier miembro activo lee y escribe     ║
-- ║  cualquier cuenta. El aislamiento es solo frente al exterior.        ║
-- ║  RLS deny-by-default; helpers en esquema `private` (no expuesto por  ║
-- ║  PostgREST) para que no sean invocables como RPC.                    ║
-- ╚══════════════════════════════════════════════════════════════════════╝

create extension if not exists pgcrypto;

-- ─────────────────────────── perfiles ───────────────────────────
-- El rol NUNCA se toma del metadata del signup: así nadie puede
-- auto-asignarse 'admin'. Nacen INACTIVOS (defensa en profundidad: aunque
-- se habilitara el registro público por error, un alta no da acceso).
create table public.profiles (
  id                    uuid primary key references auth.users(id) on delete cascade,
  email                 text,
  full_name             text not null default '',
  role                  text not null default 'user' check (role in ('user','admin')),
  must_change_password  boolean not null default true,
  is_active             boolean not null default false,
  column_prefs          jsonb   not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- SECURITY DEFINER para poder leer profiles sin disparar sus propias
-- políticas RLS (evita recursión infinita).
create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active
  );
$$;

-- Cualquier usuario dado de alta y activo. Es la puerta de toda la app:
-- la base es compartida, así que "miembro" ya implica acceso total a datos.
create or replace function private.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and is_active
  );
$$;

revoke execute on function private.is_admin(), private.is_member() from public, anon;
grant  execute on function private.is_admin(), private.is_member() to authenticated;

-- ─────────────────────────── cuentas ───────────────────────────
-- owner_name se conserva junto a owner_id porque los datos vienen del Excel
-- con nombres sueltos ("Alberto") y los perfiles todavía no existen al migrar.
create table public.accounts (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  region       text,
  sector       text,
  owner_id     uuid references public.profiles(id) on delete set null,
  owner_name   text,
  next_touch   date,
  deal_stage   text check (deal_stage in ('SQL','Demo','PoC','Negotiation','Verbal Agreement','Win')),
  hubspot_url  text,
  next_step    text,
  custom       jsonb not null default '{}'::jsonb,   -- valores de las columnas personalizadas
  created_at   timestamptz not null default now(),
  created_by   uuid references public.profiles(id) on delete set null default auth.uid(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.profiles(id) on delete set null default auth.uid()
);
create index accounts_owner_idx      on public.accounts(owner_id);
create index accounts_next_touch_idx on public.accounts(next_touch);
create index accounts_name_idx       on public.accounts(lower(name));

-- ──────────────────── historial de notas (timeline) ────────────────────
-- is_legacy marca el bloque importado del Excel, que mezcla autores y no se
-- puede atribuir a una persona concreta.
create table public.account_notes (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts(id) on delete cascade,
  body         text not null,
  author_id    uuid references public.profiles(id) on delete set null default auth.uid(),
  author_name  text,
  is_legacy    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index account_notes_account_idx on public.account_notes(account_id, created_at desc);

-- ──────── catálogos de los desplegables (editables sin migración) ────────
-- El Excel ya tenía valores fuera de su propia lista ("España"), así que las
-- opciones tienen que poder ampliarse desde la app.
create table public.catalog_options (
  id       uuid primary key default gen_random_uuid(),
  kind     text not null check (kind in ('region','sector')),
  value    text not null,
  position int  not null default 0,
  unique (kind, value)
);

-- ───────────── columnas personalizadas definidas por el admin ─────────────
create table public.field_defs (
  id         uuid primary key default gen_random_uuid(),
  key        text not null unique check (key ~ '^[a-z][a-z0-9_]{0,30}$'),
  label      text not null,
  type       text not null check (type in ('text','number','date','select')),
  options    text[] not null default '{}',
  position   int not null default 0,
  created_at timestamptz not null default now()
);

-- ─────────────────────────── triggers ───────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Sella quién tocó la fila por última vez. Solo cuando hay sesión real:
-- las cargas por SQL (migración del Excel) tienen auth.uid() nulo.
create or replace function public.stamp_updated_by()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  if auth.uid() is not null then new.updated_by = auth.uid(); end if;
  return new;
end;
$$;

create trigger accounts_stamp_update
  before update on public.accounts
  for each row execute function public.stamp_updated_by();

create trigger account_notes_set_updated_at
  before update on public.account_notes
  for each row execute function public.set_updated_at();

-- Alta de usuario → alta de perfil. El rol se fuerza a 'user'.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role, must_change_password)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    'user',
    coalesce((new.raw_user_meta_data->>'must_change_password')::boolean, true)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Impide la escalada de privilegios: un no-admin no puede cambiar su rol ni
-- reactivarse. La condición `auth.uid() is not null` deja pasar las
-- operaciones server-side (service_role / editor SQL), que es lo que permite
-- el bootstrap del primer admin sin desactivar triggers.
create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not private.is_admin() then
    new.role      := old.role;
    new.is_active := old.is_active;
  end if;
  return new;
end;
$$;
create trigger profiles_guard_update
  before update on public.profiles
  for each row execute function public.guard_profile_update();

-- Las funciones de trigger no deben poder invocarse por la API.
revoke execute on function public.handle_new_user()     from public, anon, authenticated;
revoke execute on function public.guard_profile_update() from public, anon, authenticated;
revoke execute on function public.set_updated_at()       from public, anon, authenticated;
revoke execute on function public.stamp_updated_by()     from public, anon, authenticated;

-- ─────────────────────── RLS · deny by default ───────────────────────
alter table public.profiles        enable row level security;
alter table public.accounts        enable row level security;
alter table public.account_notes   enable row level security;
alter table public.catalog_options enable row level security;
alter table public.field_defs      enable row level security;

-- profiles: cada uno el suyo; el admin, todos. Las escrituras del admin sobre
-- OTROS perfiles no pasan por aquí, van por Edge Function (service_role).
-- (La 0004 amplía el SELECT a cualquier miembro.)
create policy profiles_select_self_or_admin on public.profiles
  for select using (id = auth.uid() or private.is_admin());
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- accounts: base compartida — cualquier miembro activo hace de todo.
create policy accounts_select on public.accounts for select using (private.is_member());
create policy accounts_insert on public.accounts for insert with check (private.is_member());
create policy accounts_update on public.accounts for update using (private.is_member()) with check (private.is_member());
create policy accounts_delete on public.accounts for delete using (private.is_member());

-- notas: todos leen y añaden; solo el autor (o un admin) reescribe o borra.
-- El historial pierde su valor si cualquiera puede editar lo que firmó otro.
create policy account_notes_select on public.account_notes for select using (private.is_member());
create policy account_notes_insert on public.account_notes for insert with check (private.is_member() and author_id = auth.uid());
create policy account_notes_update on public.account_notes for update
  using (author_id = auth.uid() or private.is_admin())
  with check (author_id = auth.uid() or private.is_admin());
create policy account_notes_delete on public.account_notes for delete
  using (author_id = auth.uid() or private.is_admin());

-- catálogos: cualquiera amplía la lista; solo el admin la poda.
create policy catalog_select on public.catalog_options for select using (private.is_member());
create policy catalog_insert on public.catalog_options for insert with check (private.is_member());
create policy catalog_update on public.catalog_options for update using (private.is_member()) with check (private.is_member());
create policy catalog_delete on public.catalog_options for delete using (private.is_admin());

-- definición de columnas: la estructura la manda el admin.
create policy field_defs_select on public.field_defs for select using (private.is_member());
create policy field_defs_write  on public.field_defs for all
  using (private.is_admin()) with check (private.is_admin());

-- ─────── keep-alive (Supabase pausa proyectos Free a los 7 días) ───────
-- Tabla con RLS y CERO políticas: invisible por la API. Solo ping() la toca.
create table public.heartbeat (
  id         smallint primary key default 1,
  last_ping  timestamptz not null default now(),
  ping_count bigint      not null default 0,
  constraint heartbeat_una_sola_fila check (id = 1)
);
insert into public.heartbeat (id) values (1);
alter table public.heartbeat enable row level security;

-- Sin argumentos y solo devuelve un timestamp: lo peor que puede hacer
-- alguien con la clave pública es incrementar un contador.
create or replace function public.ping()
returns timestamptz language sql volatile security definer set search_path = public as $$
  update public.heartbeat set last_ping = now(), ping_count = ping_count + 1
   where id = 1
  returning last_ping;
$$;
revoke execute on function public.ping() from public, authenticated;
grant  execute on function public.ping() to anon;

-- ─────────── Realtime: los tres ven los cambios de los otros ───────────
alter publication supabase_realtime add table public.accounts;
alter publication supabase_realtime add table public.account_notes;
