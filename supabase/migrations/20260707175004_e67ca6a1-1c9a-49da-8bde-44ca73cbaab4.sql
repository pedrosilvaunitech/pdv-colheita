CREATE OR REPLACE FUNCTION public.verify_admin_code(_store_id uuid, _code text)
RETURNS TABLE (user_id uuid, full_name text, email text, role app_role)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

GRANT EXECUTE ON FUNCTION public.verify_admin_code(uuid, text) TO authenticated;