
CREATE TABLE public.comandas (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','fechada','cancelada')),
  opened_by UUID REFERENCES auth.users(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  sale_id UUID REFERENCES public.sales(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, number)
);
CREATE INDEX idx_comandas_store_status ON public.comandas(store_id, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.comandas TO authenticated;
GRANT ALL ON public.comandas TO service_role;
ALTER TABLE public.comandas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "comandas_read" ON public.comandas FOR SELECT TO authenticated
  USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "comandas_insert" ON public.comandas FOR INSERT TO authenticated
  WITH CHECK (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "comandas_update" ON public.comandas FOR UPDATE TO authenticated
  USING (public.has_store_access(auth.uid(), store_id))
  WITH CHECK (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "comandas_delete" ON public.comandas FOR DELETE TO authenticated
  USING (public.can_manage_store(auth.uid(), store_id));

CREATE TABLE public.comanda_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  comanda_id UUID NOT NULL REFERENCES public.comandas(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  barcode TEXT,
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  note TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_comanda_items_comanda ON public.comanda_items(comanda_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.comanda_items TO authenticated;
GRANT ALL ON public.comanda_items TO service_role;
ALTER TABLE public.comanda_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "comanda_items_read" ON public.comanda_items FOR SELECT TO authenticated
  USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "comanda_items_insert" ON public.comanda_items FOR INSERT TO authenticated
  WITH CHECK (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "comanda_items_update" ON public.comanda_items FOR UPDATE TO authenticated
  USING (public.has_store_access(auth.uid(), store_id))
  WITH CHECK (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "comanda_items_delete" ON public.comanda_items FOR DELETE TO authenticated
  USING (public.has_store_access(auth.uid(), store_id));

-- Numeração automática por loja
CREATE OR REPLACE FUNCTION public.tg_comanda_assign_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.number IS NULL OR NEW.number = 0 THEN
    SELECT COALESCE(MAX(number), 0) + 1 INTO NEW.number
      FROM public.comandas WHERE store_id = NEW.store_id;
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE public.comandas ALTER COLUMN number DROP NOT NULL;
CREATE TRIGGER trg_comanda_number
  BEFORE INSERT ON public.comandas
  FOR EACH ROW EXECUTE FUNCTION public.tg_comanda_assign_number();

CREATE TRIGGER trg_comandas_touch
  BEFORE UPDATE ON public.comandas
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
