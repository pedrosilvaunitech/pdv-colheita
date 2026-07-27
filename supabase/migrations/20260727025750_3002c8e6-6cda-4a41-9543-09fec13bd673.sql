-- 1) Política de exclusão: dono do log ou gestor da loja
CREATE POLICY "Owners and managers delete print logs" ON public.print_logs
  FOR DELETE TO authenticated
  USING (
    auth.uid() = user_id
    OR (store_id IS NOT NULL AND public.can_manage_store(auth.uid(), store_id))
  );

GRANT DELETE ON public.print_logs TO authenticated;

-- 2) Índice para consulta/limpeza por loja
CREATE INDEX IF NOT EXISTS print_logs_store_ts_idx ON public.print_logs (store_id, ts DESC);

-- 3) Rotina de retenção controlada
CREATE OR REPLACE FUNCTION public.purge_print_logs(_store_id uuid, _older_than_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_days integer := GREATEST(COALESCE(_older_than_days, 90), 7);
  v_removed integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  IF _store_id IS NULL OR NOT public.can_manage_store(auth.uid(), _store_id) THEN
    PERFORM public.log_rpc_attempt('purge_print_logs', _store_id, false, 'sem permissão');
    RAISE EXCEPTION 'Sem permissão para limpar logs de impressão desta loja';
  END IF;

  DELETE FROM public.print_logs
   WHERE store_id = _store_id
     AND ts < now() - make_interval(days => v_days);
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  PERFORM public.log_rpc_attempt('purge_print_logs', _store_id, true,
    v_removed::text || ' logs removidos (> ' || v_days::text || ' dias)');

  RETURN v_removed;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_print_logs(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_print_logs(uuid, integer) TO authenticated;