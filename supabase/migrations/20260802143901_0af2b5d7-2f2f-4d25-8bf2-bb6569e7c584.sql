
ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS contact_name text,
  ADD COLUMN IF NOT EXISTS payment_day smallint,
  ADD COLUMN IF NOT EXISTS payment_term_days integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_condition text,
  ADD COLUMN IF NOT EXISTS payment_methods text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS pix_key text,
  ADD COLUMN IF NOT EXISTS pix_key_type text,
  ADD COLUMN IF NOT EXISTS lead_time_days integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.product_suppliers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  supplier_sku text,
  unit_cost numeric(14,4) NOT NULL DEFAULT 0,
  min_order_qty numeric(14,3) NOT NULL DEFAULT 0,
  lead_time_days integer NOT NULL DEFAULT 0,
  is_preferred boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS product_suppliers_store_idx ON public.product_suppliers(store_id);
CREATE INDEX IF NOT EXISTS product_suppliers_product_idx ON public.product_suppliers(product_id);
CREATE INDEX IF NOT EXISTS product_suppliers_supplier_idx ON public.product_suppliers(supplier_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_suppliers TO authenticated;
GRANT ALL ON public.product_suppliers TO service_role;

ALTER TABLE public.product_suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "product_suppliers_select" ON public.product_suppliers
  FOR SELECT TO authenticated
  USING (public.has_store_access(auth.uid(), store_id));

CREATE POLICY "product_suppliers_insert" ON public.product_suppliers
  FOR INSERT TO authenticated
  WITH CHECK (public.has_store_access(auth.uid(), store_id));

CREATE POLICY "product_suppliers_update" ON public.product_suppliers
  FOR UPDATE TO authenticated
  USING (public.has_store_access(auth.uid(), store_id))
  WITH CHECK (public.has_store_access(auth.uid(), store_id));

CREATE POLICY "product_suppliers_delete" ON public.product_suppliers
  FOR DELETE TO authenticated
  USING (public.has_store_access(auth.uid(), store_id));

CREATE TRIGGER product_suppliers_touch
  BEFORE UPDATE ON public.product_suppliers
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

INSERT INTO public.product_suppliers (store_id, product_id, supplier_id, unit_cost, lead_time_days, is_preferred)
SELECT p.store_id, p.id, p.supplier_id, COALESCE(p.price_cost, 0), COALESCE(p.lead_time_days, 0), true
  FROM public.products p
 WHERE p.supplier_id IS NOT NULL
ON CONFLICT (product_id, supplier_id) DO NOTHING;
