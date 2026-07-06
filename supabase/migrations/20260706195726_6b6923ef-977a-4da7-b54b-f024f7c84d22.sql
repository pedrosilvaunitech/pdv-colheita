
-- Fase 1: Caixa, movimentações e configurações de recibo/PDV

-- Extend products
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_weighable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cest TEXT,
  ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Extend customers
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS birthday DATE,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp TEXT;

-- Sale-level linkage improvements
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS cash_register_id UUID,
  ADD COLUMN IF NOT EXISTS document_type TEXT NOT NULL DEFAULT 'nao_fiscal' CHECK (document_type IN ('fiscal','nao_fiscal')),
  ADD COLUMN IF NOT EXISTS change_given NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Receipt / PDV settings per store
CREATE TABLE IF NOT EXISTS public.receipt_settings (
  store_id UUID PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  default_document TEXT NOT NULL DEFAULT 'nao_fiscal' CHECK (default_document IN ('fiscal','nao_fiscal')),
  paper_width INT NOT NULL DEFAULT 80 CHECK (paper_width IN (58,80)),
  header_text TEXT,
  footer_text TEXT DEFAULT 'Obrigado pela preferência!',
  logo_url TEXT,
  print_auto BOOLEAN NOT NULL DEFAULT true,
  ask_customer BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.receipt_settings TO authenticated;
GRANT ALL ON public.receipt_settings TO service_role;
ALTER TABLE public.receipt_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "receipt_settings read" ON public.receipt_settings FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "receipt_settings manage" ON public.receipt_settings FOR ALL TO authenticated USING (public.can_manage_store(auth.uid(), store_id)) WITH CHECK (public.can_manage_store(auth.uid(), store_id));
CREATE TRIGGER trg_receipt_settings_touch BEFORE UPDATE ON public.receipt_settings FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- Cash register sessions
CREATE TABLE IF NOT EXISTS public.cash_registers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  terminal TEXT NOT NULL DEFAULT 'PDV-01',
  opened_by UUID NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opening_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  closed_by UUID,
  closed_at TIMESTAMPTZ,
  closing_amount NUMERIC(14,2),
  expected_amount NUMERIC(14,2),
  difference NUMERIC(14,2),
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','fechado')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_open_per_store_terminal ON public.cash_registers (store_id, terminal) WHERE status = 'aberto';
CREATE INDEX IF NOT EXISTS idx_cash_registers_store ON public.cash_registers(store_id, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cash_registers TO authenticated;
GRANT ALL ON public.cash_registers TO service_role;
ALTER TABLE public.cash_registers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cash_reg read" ON public.cash_registers FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "cash_reg insert" ON public.cash_registers FOR INSERT TO authenticated WITH CHECK (public.can_operate_pdv(auth.uid(), store_id) AND opened_by = auth.uid());
CREATE POLICY "cash_reg update" ON public.cash_registers FOR UPDATE TO authenticated USING (public.can_operate_pdv(auth.uid(), store_id)) WITH CHECK (public.can_operate_pdv(auth.uid(), store_id));
CREATE TRIGGER trg_cash_registers_touch BEFORE UPDATE ON public.cash_registers FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- Cash movements (sangria, suprimento, reforço, retirada)
CREATE TABLE IF NOT EXISTS public.cash_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_register_id UUID NOT NULL REFERENCES public.cash_registers(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('sangria','suprimento','reforco','retirada','ajuste')),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  reason TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cash_mov_reg ON public.cash_movements(cash_register_id);
GRANT SELECT, INSERT ON public.cash_movements TO authenticated;
GRANT ALL ON public.cash_movements TO service_role;
ALTER TABLE public.cash_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cash_mov read" ON public.cash_movements FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "cash_mov insert" ON public.cash_movements FOR INSERT TO authenticated WITH CHECK (public.can_operate_pdv(auth.uid(), store_id) AND created_by = auth.uid());

-- FK for sales.cash_register_id (soft; allow null for legacy)
DO $$ BEGIN
  ALTER TABLE public.sales
    ADD CONSTRAINT sales_cash_register_fk FOREIGN KEY (cash_register_id) REFERENCES public.cash_registers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Helper: current open register for a store
CREATE OR REPLACE FUNCTION public.current_open_register(_store_id UUID)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT id FROM public.cash_registers WHERE store_id = _store_id AND status='aberto' ORDER BY opened_at DESC LIMIT 1;
$$;
