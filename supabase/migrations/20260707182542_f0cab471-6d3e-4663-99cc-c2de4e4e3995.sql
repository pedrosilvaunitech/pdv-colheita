REVOKE EXECUTE ON FUNCTION public.regenerate_admin_code(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_store_master_password(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_user_store_permissions(uuid, uuid, boolean, boolean, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.store_has_master_password(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.user_store_permissions(uuid, uuid) FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION private.can_manage_store(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.has_store_access(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.has_role(uuid, uuid, public.app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.can_operate_pdv(uuid, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.regenerate_admin_code(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_store_master_password(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_store_permissions(uuid, uuid, boolean, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.store_has_master_password(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_store_permissions(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';