ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS fiscal_status TEXT NOT NULL DEFAULT 'nao_fiscal'
    CHECK (fiscal_status IN ('nao_fiscal','pendente','emitida','falha'));
CREATE INDEX IF NOT EXISTS idx_sales_fiscal_status ON public.sales(store_id, fiscal_status) WHERE fiscal_status = 'pendente';
UPDATE public.sales SET fiscal_status = 'pendente' WHERE document_type = 'fiscal' AND fiscal_status = 'nao_fiscal';