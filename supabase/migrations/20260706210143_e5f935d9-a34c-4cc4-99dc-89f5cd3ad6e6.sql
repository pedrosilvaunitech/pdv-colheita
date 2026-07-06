GRANT SELECT, INSERT, UPDATE, DELETE ON public.stores TO authenticated;
GRANT ALL ON public.stores TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

DROP POLICY IF EXISTS "delete stores if admin" ON public.stores;
CREATE POLICY "delete stores if admin or admin dev"
ON public.stores
FOR DELETE
TO authenticated
USING (
  public.has_role(auth.uid(), id, 'admin'::public.app_role)
  OR public.has_role(auth.uid(), id, 'admin_dev'::public.app_role)
);

DROP POLICY IF EXISTS "update stores if admin" ON public.stores;
CREATE POLICY "update stores if admin or admin dev"
ON public.stores
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), id, 'admin'::public.app_role)
  OR public.has_role(auth.uid(), id, 'admin_dev'::public.app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), id, 'admin'::public.app_role)
  OR public.has_role(auth.uid(), id, 'admin_dev'::public.app_role)
);

DROP POLICY IF EXISTS "admin manages roles" ON public.user_roles;
CREATE POLICY "admins and managers create roles"
ON public.user_roles
FOR INSERT
TO authenticated
WITH CHECK (public.can_manage_store(auth.uid(), store_id));

DROP POLICY IF EXISTS "admin updates roles" ON public.user_roles;
CREATE POLICY "admins and managers update roles"
ON public.user_roles
FOR UPDATE
TO authenticated
USING (public.can_manage_store(auth.uid(), store_id))
WITH CHECK (public.can_manage_store(auth.uid(), store_id));

DROP POLICY IF EXISTS "admin deletes roles" ON public.user_roles;
CREATE POLICY "admins and managers delete roles"
ON public.user_roles
FOR DELETE
TO authenticated
USING (public.can_manage_store(auth.uid(), store_id));

DROP TRIGGER IF EXISTS trg_store_bootstrap_admin ON public.stores;
CREATE TRIGGER trg_store_bootstrap_admin
AFTER INSERT ON public.stores
FOR EACH ROW
EXECUTE FUNCTION public.tg_store_bootstrap_admin();