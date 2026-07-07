DO $$
DECLARE
  pol record;
  new_qual text;
  new_check text;
  sql_stmt text;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (COALESCE(qual, '') LIKE '%private.%'
            OR COALESCE(with_check, '') LIKE '%private.%')
  LOOP
    new_qual := CASE
      WHEN pol.qual IS NULL THEN NULL
      ELSE replace(pol.qual, 'private.', 'public.')
    END;

    new_check := CASE
      WHEN pol.with_check IS NULL THEN NULL
      ELSE replace(pol.with_check, 'private.', 'public.')
    END;

    sql_stmt := format('ALTER POLICY %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);

    IF new_qual IS NOT NULL THEN
      sql_stmt := sql_stmt || format(' USING (%s)', new_qual);
    END IF;

    IF new_check IS NOT NULL THEN
      sql_stmt := sql_stmt || format(' WITH CHECK (%s)', new_check);
    END IF;

    EXECUTE sql_stmt;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.can_manage_store(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_store_access(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_operate_pdv(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_store_permissions(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_store_permissions(uuid, uuid, boolean, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regenerate_admin_code(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_admin_code(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.store_has_master_password(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_store_master_password(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';