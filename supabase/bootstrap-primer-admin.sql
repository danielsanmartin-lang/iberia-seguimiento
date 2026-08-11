-- Bootstrap del primer administrador.
--
-- NO es una migración: se ejecuta UNA vez, a mano, desde el editor SQL de
-- Supabase. Hace falta porque no hay registro público y los perfiles nacen
-- inactivos: sin esto no existiría nadie capaz de invitar a los demás.
--
-- Funciona porque guard_profile_update() solo bloquea la escalada cuando
-- auth.uid() no es nulo, y en el editor SQL (service_role) es nulo.
--
-- Sustituye el correo, el nombre y la contraseña antes de ejecutarlo. A partir
-- de aquí, los demás usuarios se crean desde el panel de administración.

do $$
declare
  uid  uuid := gen_random_uuid();
  mail text := 'CAMBIAME@ejemplo.com';
  nom  text := 'Nombre Apellido';
  pw   text := 'CAMBIAME-contrasena-provisional';
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    -- GoTrue escanea estas columnas como string en Go: un NULL rompe el login
    -- con "Database error querying schema". La API siempre las escribe como '',
    -- pero un INSERT manual las dejaría nulas.
    confirmation_token, recovery_token, email_change, email_change_token_new,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token
  ) values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
    mail, crypt(pw, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', nom, 'must_change_password', true),
    now(), now(),
    '', '', '', '', '', '', '', ''
  );

  -- GoTrue exige una identidad de tipo 'email' para el login por contraseña.
  insert into auth.identities (provider_id, user_id, identity_data, provider,
                               last_sign_in_at, created_at, updated_at)
  values (uid, uid,
          jsonb_build_object('sub', uid::text, 'email', mail, 'email_verified', true),
          'email', now(), now(), now());

  -- El trigger ya creó el perfil como 'user' e inactivo; lo promovemos.
  update public.profiles
     set role = 'admin', is_active = true, must_change_password = true, full_name = nom
   where id = uid;
end $$;
