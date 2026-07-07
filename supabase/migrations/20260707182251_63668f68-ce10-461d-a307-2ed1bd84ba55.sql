GRANT EXECUTE ON FUNCTION public.can_manage_store(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_store_access(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_operate_pdv(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) TO authenticated;