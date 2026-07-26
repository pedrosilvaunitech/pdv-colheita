DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION
  public.has_store_access(uuid, uuid),
  public.can_manage_store(uuid, uuid),
  public.can_operate_pdv(uuid, uuid),
  public.has_role(uuid, uuid, public.app_role),
  public.current_open_register(uuid),
  public.store_has_master_password(uuid),
  public.user_store_permissions(uuid, uuid),
  public.verify_admin_code(uuid, text),
  public.lookup_admin_code(text),
  public.regenerate_admin_code(uuid, uuid),
  public.set_user_store_permissions(uuid, uuid, boolean, boolean, boolean),
  public.set_store_master_password(uuid, text),
  public.link_user_to_store_by_email(uuid, uuid, text, public.app_role),
  public.cleanup_orphan_user_links(uuid),
  public.reserve_nfce_number(uuid),
  public.record_homologacao_test(uuid, jsonb)
TO authenticated;

DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE 'tg\_%'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
  END LOOP;
END $$;