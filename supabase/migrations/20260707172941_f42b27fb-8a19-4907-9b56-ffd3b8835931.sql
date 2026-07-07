GRANT EXECUTE ON FUNCTION public.has_store_access(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_operate_pdv(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_store(uuid, uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.current_open_register(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_touch_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_apply_stock_movement() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_purchase_confirm_stock() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_store_bootstrap_admin() FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_sales_store_status_created_at ON public.sales(store_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_store_finalized_at ON public.sales(store_id, finalized_at DESC) WHERE status = 'finalizada';
CREATE INDEX IF NOT EXISTS idx_sale_items_store_product_sale ON public.sale_items(store_id, product_id, sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_payments_store_method ON public.sale_payments(store_id, method);
CREATE INDEX IF NOT EXISTS idx_cash_registers_store_opened_at ON public.cash_registers(store_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_movements_register_created_at ON public.cash_movements(cash_register_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_store_category_active ON public.products(store_id, category, active);
CREATE INDEX IF NOT EXISTS idx_product_stocks_store_product ON public.product_stocks(store_id, product_id);