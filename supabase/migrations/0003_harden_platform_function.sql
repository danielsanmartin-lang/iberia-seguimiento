-- public.rls_auto_enable() viene de serie con el proyecto (event trigger que
-- activa RLS en cada CREATE TABLE de `public`). Es inofensiva —las event
-- trigger functions no se pueden invocar por RPC— pero salía en el advisor
-- como SECURITY DEFINER ejecutable por anon. Se le quita el EXECUTE público:
-- el event trigger la sigue ejecutando como propietario, sin depender de esto.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
