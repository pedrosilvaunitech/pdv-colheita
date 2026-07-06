
-- Products extra columns
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS min_stock NUMERIC(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_stock NUMERIC(14,3),
  ADD COLUMN IF NOT EXISTS reorder_qty NUMERIC(14,3),
  ADD COLUMN IF NOT EXISTS lead_time_days INT NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS supplier_id UUID;

-- SUPPLIERS
CREATE TABLE IF NOT EXISTS public.suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cnpj TEXT, phone TEXT, email TEXT,
  address_line TEXT, city TEXT, state TEXT, notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suppliers_store_idx ON public.suppliers(store_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.suppliers TO authenticated;
GRANT ALL ON public.suppliers TO service_role;
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read suppliers" ON public.suppliers;
CREATE POLICY "read suppliers" ON public.suppliers FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
DROP POLICY IF EXISTS "insert suppliers" ON public.suppliers;
CREATE POLICY "insert suppliers" ON public.suppliers FOR INSERT TO authenticated WITH CHECK (public.can_manage_store(auth.uid(), store_id));
DROP POLICY IF EXISTS "update suppliers" ON public.suppliers;
CREATE POLICY "update suppliers" ON public.suppliers FOR UPDATE TO authenticated USING (public.can_manage_store(auth.uid(), store_id));
DROP POLICY IF EXISTS "delete suppliers" ON public.suppliers;
CREATE POLICY "delete suppliers" ON public.suppliers FOR DELETE TO authenticated USING (public.can_manage_store(auth.uid(), store_id));
DROP TRIGGER IF EXISTS trg_suppliers_updated ON public.suppliers;
CREATE TRIGGER trg_suppliers_updated BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_supplier_fk;
ALTER TABLE public.products ADD CONSTRAINT products_supplier_fk FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;

-- CUSTOMERS
CREATE TABLE IF NOT EXISTS public.customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  doc TEXT, doc_type TEXT CHECK (doc_type IN ('cpf','cnpj')),
  phone TEXT, email TEXT,
  address_line TEXT, city TEXT, state TEXT, zip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_store_idx ON public.customers(store_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO authenticated;
GRANT ALL ON public.customers TO service_role;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read customers" ON public.customers;
CREATE POLICY "read customers" ON public.customers FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
DROP POLICY IF EXISTS "insert customers" ON public.customers;
CREATE POLICY "insert customers" ON public.customers FOR INSERT TO authenticated WITH CHECK (public.has_store_access(auth.uid(), store_id));
DROP POLICY IF EXISTS "update customers" ON public.customers;
CREATE POLICY "update customers" ON public.customers FOR UPDATE TO authenticated USING (public.can_manage_store(auth.uid(), store_id));
DROP POLICY IF EXISTS "delete customers" ON public.customers;
CREATE POLICY "delete customers" ON public.customers FOR DELETE TO authenticated USING (public.can_manage_store(auth.uid(), store_id));
DROP TRIGGER IF EXISTS trg_customers_updated ON public.customers;
CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL;

-- PURCHASES
CREATE TABLE IF NOT EXISTS public.purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  doc_number TEXT, doc_series TEXT,
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','confirmada','cancelada')),
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes TEXT,
  received_at TIMESTAMPTZ,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchases_store_idx ON public.purchases(store_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchases TO authenticated;
GRANT ALL ON public.purchases TO service_role;
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read purchases" ON public.purchases;
CREATE POLICY "read purchases" ON public.purchases FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
DROP POLICY IF EXISTS "insert purchases" ON public.purchases;
CREATE POLICY "insert purchases" ON public.purchases FOR INSERT TO authenticated WITH CHECK (public.can_manage_store(auth.uid(), store_id) AND auth.uid() = created_by);
DROP POLICY IF EXISTS "update purchases" ON public.purchases;
CREATE POLICY "update purchases" ON public.purchases FOR UPDATE TO authenticated USING (public.can_manage_store(auth.uid(), store_id));
DROP POLICY IF EXISTS "delete purchases" ON public.purchases;
CREATE POLICY "delete purchases" ON public.purchases FOR DELETE TO authenticated USING (public.can_manage_store(auth.uid(), store_id));
DROP TRIGGER IF EXISTS trg_purchases_updated ON public.purchases;
CREATE TRIGGER trg_purchases_updated BEFORE UPDATE ON public.purchases FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES public.purchases(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_items_purchase_idx ON public.purchase_items(purchase_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_items TO authenticated;
GRANT ALL ON public.purchase_items TO service_role;
ALTER TABLE public.purchase_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read purchase items" ON public.purchase_items;
CREATE POLICY "read purchase items" ON public.purchase_items FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
DROP POLICY IF EXISTS "manage purchase items" ON public.purchase_items;
CREATE POLICY "manage purchase items" ON public.purchase_items FOR ALL TO authenticated
  USING (public.can_manage_store(auth.uid(), store_id))
  WITH CHECK (public.can_manage_store(auth.uid(), store_id));

CREATE OR REPLACE FUNCTION public.tg_purchase_confirm_stock()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE it RECORD;
BEGIN
  IF NEW.status = 'confirmada' AND (TG_OP = 'INSERT' OR OLD.status <> 'confirmada') THEN
    FOR it IN SELECT * FROM public.purchase_items WHERE purchase_id = NEW.id LOOP
      INSERT INTO public.stock_movements (store_id, product_id, type, quantity, unit_cost, reason, created_by)
      VALUES (NEW.store_id, it.product_id, 'entrada', it.quantity, it.unit_cost,
              COALESCE('NF ' || NEW.doc_number, 'Compra ' || NEW.id::text), NEW.created_by);
      UPDATE public.products SET price_cost = it.unit_cost WHERE id = it.product_id AND it.unit_cost > 0;
    END LOOP;
    NEW.received_at = COALESCE(NEW.received_at, now());
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_purchase_confirm ON public.purchases;
CREATE TRIGGER trg_purchase_confirm BEFORE INSERT OR UPDATE ON public.purchases
  FOR EACH ROW EXECUTE FUNCTION public.tg_purchase_confirm_stock();

-- Reorder view
CREATE OR REPLACE VIEW public.v_reorder
WITH (security_invoker = true) AS
WITH sales_30d AS (
  SELECT si.product_id, si.store_id,
         SUM(si.quantity) AS qty_30d,
         SUM(si.quantity) / 30.0 AS avg_daily
  FROM public.sale_items si
  JOIN public.sales s ON s.id = si.sale_id AND s.status = 'finalizada'
  WHERE s.finalized_at >= now() - INTERVAL '30 days'
  GROUP BY si.product_id, si.store_id
)
SELECT
  p.id AS product_id, p.store_id, p.name, p.barcode, p.sku, p.unit,
  p.min_stock, p.max_stock, p.reorder_qty, p.lead_time_days, p.supplier_id,
  COALESCE(ps.quantity, 0) AS current_stock,
  COALESCE(s30.qty_30d, 0) AS sold_30d,
  COALESCE(s30.avg_daily, 0) AS avg_daily_sales,
  CASE WHEN COALESCE(s30.avg_daily, 0) > 0
       THEN ROUND(COALESCE(ps.quantity, 0) / s30.avg_daily, 1)
       ELSE NULL END AS days_of_stock,
  CASE
    WHEN COALESCE(ps.quantity, 0) <= 0 THEN 'ruptura'
    WHEN COALESCE(ps.quantity, 0) <= p.min_stock THEN 'critico'
    WHEN COALESCE(s30.avg_daily, 0) > 0
         AND COALESCE(ps.quantity, 0) / s30.avg_daily <= p.lead_time_days
      THEN 'atencao'
    ELSE 'ok'
  END AS status,
  GREATEST(
    COALESCE(p.max_stock, p.min_stock * 3),
    CEIL(COALESCE(s30.avg_daily, 0) * (p.lead_time_days + 14))
  ) - COALESCE(ps.quantity, 0) AS suggested_qty
FROM public.products p
LEFT JOIN public.product_stocks ps ON ps.product_id = p.id AND ps.store_id = p.store_id
LEFT JOIN sales_30d s30 ON s30.product_id = p.id AND s30.store_id = p.store_id
WHERE p.active = true;

GRANT SELECT ON public.v_reorder TO authenticated;
