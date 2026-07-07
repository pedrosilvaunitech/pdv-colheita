GRANT EXECUTE ON FUNCTION public.has_store_access(uuid, uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_store(uuid, uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.can_operate_pdv(uuid, uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.current_open_register(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_orphan_user_links(uuid) TO authenticated;