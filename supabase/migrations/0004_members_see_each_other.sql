-- La herramienta es de un equipo de tres que comparte una única tabla: para
-- pintar el desplegable de Owner y firmar las notas, cualquier miembro activo
-- necesita ver el nombre de los demás. Solo se expone el perfil (nombre, correo
-- y rol); las escrituras sobre perfiles ajenos siguen yendo por Edge Function.
drop policy profiles_select_self_or_admin on public.profiles;
create policy profiles_select_members on public.profiles
  for select using (id = auth.uid() or private.is_member());
