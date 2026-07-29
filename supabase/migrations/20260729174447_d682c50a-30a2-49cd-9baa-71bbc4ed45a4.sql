CREATE TABLE public.terminals (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  terminal_key text NOT NULL,
  name text NOT NULL DEFAULT 'Caixa',
  agent_id text,
  agent_version text,
  printer_name text,
  printer_source text,
  scale_port text,
  tef_provider text,
  user_agent text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, terminal_key)
);

CREATE INDEX idx_terminals_store ON public.terminals(store_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.terminals TO authenticated;
GRANT ALL ON public.terminals TO service_role;

ALTER TABLE public.terminals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Store members can view terminals"
ON public.terminals FOR SELECT TO authenticated
USING (public.has_store_access(auth.uid(), store_id));

CREATE POLICY "PDV operators can register terminals"
ON public.terminals FOR INSERT TO authenticated
WITH CHECK (public.can_operate_pdv(auth.uid(), store_id));

CREATE POLICY "PDV operators can update terminals"
ON public.terminals FOR UPDATE TO authenticated
USING (public.can_operate_pdv(auth.uid(), store_id))
WITH CHECK (public.can_operate_pdv(auth.uid(), store_id));

CREATE POLICY "Managers can delete terminals"
ON public.terminals FOR DELETE TO authenticated
USING (public.can_manage_store(auth.uid(), store_id));

CREATE TRIGGER trg_terminals_touch
BEFORE UPDATE ON public.terminals
FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS terminal_key text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS terminal_key text;