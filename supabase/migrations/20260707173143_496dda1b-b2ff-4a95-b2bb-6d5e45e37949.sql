REVOKE EXECUTE ON FUNCTION public.cleanup_orphan_user_links(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, public.app_role) FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "cash_reg update" ON public.cash_registers;
CREATE POLICY "cash_reg update"
ON public.cash_registers
FOR UPDATE
TO authenticated
USING (private.can_operate_pdv(auth.uid(), store_id))
WITH CHECK (
  private.can_operate_pdv(auth.uid(), store_id)
  AND (closed_by IS NULL OR closed_by = auth.uid())
);