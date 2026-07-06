CREATE OR REPLACE FUNCTION public.link_user_to_store_by_email(
  _manager_user_id uuid,
  _store_id uuid,
  _email text,
  _role app_role
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  target_user_id uuid;
BEGIN
  IF _manager_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuário gestor inválido';
  END IF;

  IF NOT public.can_manage_store(_manager_user_id, _store_id) THEN
    RAISE EXCEPTION 'Sem permissão para gerenciar esta loja';
  END IF;

  SELECT id
    INTO target_user_id
    FROM public.profiles
   WHERE lower(email) = lower(trim(_email))
   LIMIT 1;

  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não encontrado. Peça para ele criar conta primeiro.';
  END IF;

  INSERT INTO public.user_roles (user_id, store_id, role)
  VALUES (target_user_id, _store_id, _role)
  ON CONFLICT (user_id, store_id, role) DO NOTHING;

  UPDATE public.profiles
     SET default_store_id = COALESCE(default_store_id, _store_id),
         updated_at = now()
   WHERE id = target_user_id;

  RETURN target_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, app_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, app_role) FROM anon;
REVOKE ALL ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, app_role) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, app_role) TO service_role;