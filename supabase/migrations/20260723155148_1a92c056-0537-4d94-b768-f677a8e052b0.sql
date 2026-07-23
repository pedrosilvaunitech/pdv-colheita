DROP POLICY IF EXISTS "manage fiscal config" ON public.fiscal_configs;
DROP POLICY IF EXISTS "update fiscal config" ON public.fiscal_configs;

CREATE POLICY "insert fiscal config" ON public.fiscal_configs
  FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_store(auth.uid(), store_id));

CREATE POLICY "update fiscal config" ON public.fiscal_configs
  FOR UPDATE TO authenticated
  USING (public.can_manage_store(auth.uid(), store_id))
  WITH CHECK (public.can_manage_store(auth.uid(), store_id));

CREATE POLICY "delete fiscal config" ON public.fiscal_configs
  FOR DELETE TO authenticated
  USING (public.can_manage_store(auth.uid(), store_id));