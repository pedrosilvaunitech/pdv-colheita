CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.verify_admin_code(_store_id uuid, _code text)
RETURNS TABLE(user_id uuid, full_name text, email text, role public.app_role)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  cleaned TEXT := trim(_code);
  master_hash TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;
  IF NOT public.has_store_access(auth.uid(), _store_id) THEN
    RAISE EXCEPTION 'Sem acesso a esta loja';
  END IF;

  SELECT master_password_hash INTO master_hash
    FROM public.stores WHERE id = _store_id;

  IF master_hash IS NOT NULL
     AND master_hash = encode(extensions.digest(cleaned, 'sha256'), 'hex') THEN
    RETURN QUERY
      SELECT NULL::uuid, 'Senha mestra'::text, NULL::text, 'admin'::public.app_role;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT ur.user_id, p.full_name, p.email, ur.role
      FROM public.user_store_codes c
      JOIN public.user_roles ur ON ur.store_id = c.store_id AND ur.user_id = c.user_id
      LEFT JOIN public.profiles p ON p.id = c.user_id
     WHERE c.store_id = _store_id
       AND c.admin_code = cleaned
     ORDER BY CASE ur.role
       WHEN 'admin_dev' THEN 0
       WHEN 'admin'     THEN 1
       WHEN 'gerente'   THEN 2
       WHEN 'caixa'     THEN 3
       WHEN 'estoquista' THEN 4
       ELSE 5 END
     LIMIT 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.verify_admin_code(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_admin_code(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_store_master_password(_store_id uuid, _password text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;
  IF NOT public.can_manage_store(auth.uid(), _store_id) THEN
    RAISE EXCEPTION 'Sem permissão para definir senha mestra';
  END IF;

  IF _password IS NULL OR length(trim(_password)) = 0 THEN
    UPDATE public.stores SET master_password_hash = NULL WHERE id = _store_id;
    RETURN;
  END IF;

  IF length(trim(_password)) < 4 THEN
    RAISE EXCEPTION 'Senha mestra deve ter pelo menos 4 caracteres';
  END IF;

  UPDATE public.stores
     SET master_password_hash = encode(extensions.digest(trim(_password), 'sha256'), 'hex')
   WHERE id = _store_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_store_master_password(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_store_master_password(uuid, text) TO authenticated;