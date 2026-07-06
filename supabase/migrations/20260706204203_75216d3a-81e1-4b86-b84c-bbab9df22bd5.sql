REVOKE ALL ON FUNCTION public.cleanup_orphan_user_links(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_orphan_user_links(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_orphan_user_links(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_orphan_user_links(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, app_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, app_role) FROM anon;
REVOKE ALL ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, app_role) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, app_role) TO service_role;