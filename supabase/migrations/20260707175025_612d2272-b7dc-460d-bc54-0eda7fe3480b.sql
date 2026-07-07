REVOKE ALL ON FUNCTION public.verify_admin_code(uuid, text) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.verify_admin_code(_store_id uuid, _code text)
RETURNS TABLE (user_id uuid, full_name text, email text, role app_role)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  IF NOT public.has_store_access(auth.uid(), _store_id) THEN
    RAISE EXCEPTION 'Sem acesso a esta loja';
  END IF;

  RETURN QUERY
    SELECT ur.user_id, p.full_name, p.email, ur.role
      FROM public.user_roles ur
      LEFT JOIN public.profiles p ON p.id = ur.user_id
     WHERE ur.store_id = _store_id
       AND ur.role IN ('admin_dev','admin','gerente')
       AND (
         ur.user_id::text = lower(trim(_code))
         OR ur.user_id::text ILIKE (lower(trim(_code)) || '%')
       )
     LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_admin_code(uuid, text) TO authenticated;