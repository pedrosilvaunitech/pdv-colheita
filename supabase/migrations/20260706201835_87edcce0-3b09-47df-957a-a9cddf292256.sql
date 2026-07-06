GRANT SELECT, INSERT, UPDATE, DELETE ON public.stores TO authenticated;
GRANT ALL ON public.stores TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

CREATE OR REPLACE FUNCTION public.tg_store_bootstrap_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.user_roles (user_id, store_id, role)
  VALUES (NEW.created_by, NEW.id, 'admin')
  ON CONFLICT DO NOTHING;

  UPDATE public.profiles
     SET default_store_id = COALESCE(default_store_id, NEW.id),
         updated_at = now()
   WHERE id = NEW.created_by;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.can_manage_store(_user_id uuid, _store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.user_roles
     WHERE user_id = _user_id
       AND store_id = _store_id
       AND role IN ('admin','gerente')
  );
$$;

DROP POLICY IF EXISTS "read roles of own stores" ON public.user_roles;
CREATE POLICY "read roles of manageable stores or own role"
ON public.user_roles
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  OR public.can_manage_store(auth.uid(), store_id)
);

UPDATE public.profiles p
   SET default_store_id = x.store_id,
       updated_at = now()
  FROM (
    SELECT DISTINCT ON (ur.user_id) ur.user_id, ur.store_id
      FROM public.user_roles ur
      JOIN public.stores s ON s.id = ur.store_id
     WHERE ur.role = 'admin'
     ORDER BY ur.user_id, s.created_at ASC
  ) x
 WHERE p.id = x.user_id
   AND p.default_store_id IS NULL;