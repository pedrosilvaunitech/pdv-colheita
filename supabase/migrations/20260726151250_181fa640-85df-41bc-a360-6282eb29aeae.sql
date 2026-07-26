CREATE TABLE IF NOT EXISTS public.drawer_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  sale_id UUID REFERENCES public.sales(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  terminal_id TEXT,
  reason TEXT NOT NULL DEFAULT 'manual' CHECK (reason IN ('manual','venda','sangria','suprimento','troca','teste')),
  automatic BOOLEAN NOT NULL DEFAULT false,
  channel TEXT,
  success BOOLEAN NOT NULL DEFAULT true,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drawer_events_store_created_idx ON public.drawer_events (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS drawer_events_sale_idx ON public.drawer_events (sale_id);

GRANT SELECT, INSERT ON public.drawer_events TO authenticated;
GRANT ALL ON public.drawer_events TO service_role;

ALTER TABLE public.drawer_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "drawer_events read" ON public.drawer_events
  FOR SELECT TO authenticated
  USING (public.has_store_access(auth.uid(), store_id));

CREATE POLICY "drawer_events insert" ON public.drawer_events
  FOR INSERT TO authenticated
  WITH CHECK (public.can_operate_pdv(auth.uid(), store_id) AND created_by = auth.uid());

ALTER TABLE public.receipt_settings
  ADD COLUMN IF NOT EXISTS drawer_auto BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS drawer_cash_only BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS drawer_pulse_pin SMALLINT NOT NULL DEFAULT 0 CHECK (drawer_pulse_pin IN (0,1));