-- Exclusão controlada de notas: só gerentes/admins, nunca nota autorizada/cancelada em produção
CREATE POLICY "Managers can delete non-authorized invoices"
  ON public.invoices FOR DELETE TO authenticated
  USING (
    public.can_manage_store(auth.uid(), store_id)
    AND (
      environment = 'homologacao'
      OR status IN ('rascunho', 'rejeitada', 'processando')
    )
  );

CREATE OR REPLACE FUNCTION public.purge_fiscal_errors(
  _store_id uuid,
  _environment text DEFAULT NULL,
  _include_queue boolean DEFAULT true,
  _include_invoices boolean DEFAULT true,
  _invoice_ids uuid[] DEFAULT NULL,
  _queue_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_env text := lower(NULLIF(trim(COALESCE(_environment, '')), ''));
  v_invoices integer := 0;
  v_queue integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  IF _store_id IS NULL OR NOT public.can_manage_store(auth.uid(), _store_id) THEN
    PERFORM public.log_rpc_attempt('purge_fiscal_errors', _store_id, false, 'sem permissão');
    RAISE EXCEPTION 'Sem permissão para limpar registros fiscais desta loja';
  END IF;

  IF v_env IS NOT NULL AND v_env NOT IN ('homologacao', 'producao') THEN
    RAISE EXCEPTION 'Ambiente inválido: %', v_env;
  END IF;

  IF COALESCE(_include_invoices, true) THEN
    DELETE FROM public.invoices i
     WHERE i.store_id = _store_id
       AND (_invoice_ids IS NULL OR i.id = ANY(_invoice_ids))
       AND (v_env IS NULL OR i.environment::text = v_env)
       -- proteção fiscal: em produção nunca apaga nota autorizada ou cancelada
       AND (
         i.environment::text = 'homologacao'
         OR i.status::text IN ('rascunho', 'rejeitada', 'processando')
       );
    GET DIAGNOSTICS v_invoices = ROW_COUNT;
  END IF;

  IF COALESCE(_include_queue, true) THEN
    DELETE FROM public.fiscal_queue q
     WHERE q.store_id = _store_id
       AND (_queue_ids IS NULL OR q.id = ANY(_queue_ids))
       AND (
         _queue_ids IS NOT NULL
         OR q.status IN ('falha')
         OR (q.status IN ('pendente', 'processando') AND q.created_at < now() - interval '15 minutes')
       );
    GET DIAGNOSTICS v_queue = ROW_COUNT;
  END IF;

  PERFORM public.log_rpc_attempt('purge_fiscal_errors', _store_id, true,
    'ambiente ' || COALESCE(v_env, 'todos') || ': ' || v_invoices::text ||
    ' nota(s) e ' || v_queue::text || ' item(ns) de fila removidos');

  RETURN jsonb_build_object('invoices_deleted', v_invoices, 'queue_deleted', v_queue);
END;
$$;

REVOKE ALL ON FUNCTION public.purge_fiscal_errors(uuid, text, boolean, boolean, uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_fiscal_errors(uuid, text, boolean, boolean, uuid[], uuid[]) TO authenticated;