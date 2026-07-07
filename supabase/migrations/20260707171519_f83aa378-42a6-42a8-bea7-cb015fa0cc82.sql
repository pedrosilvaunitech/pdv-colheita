-- Restringir EXECUTE das funções SECURITY DEFINER
-- Regra: revogar de anon/public sempre; manter authenticated só onde o cliente chama via RPC.

REVOKE ALL ON FUNCTION public.has_role(uuid, uuid, public.app_role) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_operate_pdv(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.has_store_access(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.current_open_register(uuid) FROM PUBLIC, anon, authenticated;

-- Funções chamadas via .rpc() pelo cliente autenticado: manter authenticated
REVOKE ALL ON FUNCTION public.can_manage_store(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_store(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.cleanup_orphan_user_links(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cleanup_orphan_user_links(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, public.app_role) TO authenticated;

-- Triggers/handlers rodam via SECURITY DEFINER em contexto de trigger — revogar de todos
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_touch_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_apply_stock_movement() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_purchase_confirm_stock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_store_bootstrap_admin() FROM PUBLIC, anon, authenticated;