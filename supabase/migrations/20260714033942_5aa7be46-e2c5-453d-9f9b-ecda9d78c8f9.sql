
CREATE TABLE public.print_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  store_id UUID REFERENCES public.stores ON DELETE SET NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  printer TEXT,
  paper_width INT,
  sale_id TEXT,
  error TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.print_logs TO authenticated;
GRANT ALL ON public.print_logs TO service_role;
ALTER TABLE public.print_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users insert their own print logs" ON public.print_logs
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users read their own print logs" ON public.print_logs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE INDEX print_logs_user_ts_idx ON public.print_logs (user_id, ts DESC);
