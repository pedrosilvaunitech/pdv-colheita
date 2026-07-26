ALTER TABLE public.drawer_events DROP CONSTRAINT IF EXISTS drawer_events_reason_check;
ALTER TABLE public.drawer_events ADD CONSTRAINT drawer_events_reason_check
  CHECK (reason = ANY (ARRAY['manual','venda','sangria','suprimento','troca','teste','cancelamento']));