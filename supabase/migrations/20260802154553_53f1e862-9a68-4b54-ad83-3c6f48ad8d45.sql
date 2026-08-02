CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE TABLE IF NOT EXISTS public.fiscal_purge_settings (
  store_id uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  purge_invoices boolean NOT NULL DEFAULT true,
  purge_queue boolean NOT NULL DEFAULT true,
  include_producao boolean NOT NULL DEFAULT false,
  homolog_retention_days integer NOT NULL DEFAULT 7 CHECK (homolog_retention_days BETWEEN 0 AND 3650),
  producao_retention_days integer NOT NULL DEFAULT 30 CHECK (producao_retention_days BETWEEN 1 AND 3650),
  queue_retention_days integer NOT NULL DEFAULT 3 CHECK (queue_retention_days BETWEEN 0 AND 3650),
  audit_retention_days integer NOT NULL DEFAULT 365 CHECK (audit_retention_days BETWEEN 30 AND 3650),
  last_run_at timestamptz,
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fiscal_purge_settings TO authenticated;
GRANT ALL ON public.fiscal_purge_settings TO service_role;

ALTER TABLE public.fiscal_purge_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Store members read purge settings"
  ON public.fiscal_purge_settings FOR SELECT TO authenticated
  USING (public.has_store_access(auth.uid(), store_id));

CREATE POLICY "Managers insert purge settings"
  ON public.fiscal_purge_settings FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_store(auth.uid(), store_id));

CREATE POLICY "Managers update purge settings"
  ON public.fiscal_purge_settings FOR UPDATE TO authenticated
  USING (public.can_manage_store(auth.uid(), store_id))
  WITH CHECK (public.can_manage_store(auth.uid(), store_id));

CREATE POLICY "Managers delete purge settings"
  ON public.fiscal_purge_settings FOR DELETE TO authenticated
  USING (public.can_manage_store(auth.uid(), store_id));

DROP TRIGGER IF EXISTS touch_fiscal_purge_settings ON public.fiscal_purge_settings;
CREATE TRIGGER touch_fiscal_purge_settings
  BEFORE UPDATE ON public.fiscal_purge_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- Prévia: quantos registros a retenção configurada removeria agora.
CREATE OR REPLACE FUNCTION public.preview_fiscal_retention(_store_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  s public.fiscal_purge_settings;
  v_homolog integer := 0;
  v_prod integer := 0;
  v_queue integer := 0;
  v_audit integer := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_store_access(auth.uid(), _store_id) THEN
    RAISE EXCEPTION 'Sem acesso a esta loja';
  END IF;

  SELECT * INTO s FROM public.fiscal_purge_settings WHERE store_id = _store_id;
  IF NOT FOUND THEN
    s.purge_invoices := true; s.purge_queue := true; s.include_producao := false;
    s.homolog_retention_days := 7; s.producao_retention_days := 30;
    s.queue_retention_days := 3; s.audit_retention_days := 365;
  END IF;

  IF s.purge_invoices THEN
    SELECT count(*) INTO v_homolog FROM public.invoices i
     WHERE i.store_id = _store_id
       AND i.environment::text = 'homologacao'
       AND i.created_at < now() - make_interval(days => s.homolog_retention_days);

    IF s.include_producao THEN
      SELECT count(*) INTO v_prod FROM public.invoices i
       WHERE i.store_id = _store_id
         AND i.environment::text = 'producao'
         AND i.status::text IN ('rascunho','rejeitada','processando')
         AND i.created_at < now() - make_interval(days => s.producao_retention_days);
    END IF;
  END IF;

  IF s.purge_queue THEN
    SELECT count(*) INTO v_queue FROM public.fiscal_queue q
     WHERE q.store_id = _store_id
       AND q.created_at < now() - make_interval(days => s.queue_retention_days)
       AND (q.status = 'falha' OR q.status IN ('pendente','processando'));
  END IF;

  SELECT count(*) INTO v_audit FROM public.rpc_audit_log a
   WHERE a.store_id = _store_id
     AND a.created_at < now() - make_interval(days => s.audit_retention_days);

  RETURN jsonb_build_object(
    'homologacao_invoices', v_homolog,
    'producao_invoices', v_prod,
    'queue_items', v_queue,
    'audit_rows', v_audit,
    'total', v_homolog + v_prod + v_queue
  );
END;
$$;

-- Motor interno da retenção (sem checagem de permissão: chamado pelos wrappers).
CREATE OR REPLACE FUNCTION public._apply_fiscal_retention(_store_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  s public.fiscal_purge_settings;
  v_homolog integer := 0;
  v_prod integer := 0;
  v_queue integer := 0;
  v_audit integer := 0;
  v_result jsonb;
BEGIN
  SELECT * INTO s FROM public.fiscal_purge_settings WHERE store_id = _store_id;
  IF NOT FOUND THEN
    INSERT INTO public.fiscal_purge_settings (store_id) VALUES (_store_id)
    ON CONFLICT (store_id) DO NOTHING;
    SELECT * INTO s FROM public.fiscal_purge_settings WHERE store_id = _store_id;
  END IF;

  IF s.purge_invoices THEN
    DELETE FROM public.invoices i
     WHERE i.store_id = _store_id
       AND i.environment::text = 'homologacao'
       AND i.created_at < now() - make_interval(days => s.homolog_retention_days);
    GET DIAGNOSTICS v_homolog = ROW_COUNT;

    IF s.include_producao THEN
      DELETE FROM public.invoices i
       WHERE i.store_id = _store_id
         AND i.environment::text = 'producao'
         AND i.status::text IN ('rascunho','rejeitada','processando')
         AND i.created_at < now() - make_interval(days => s.producao_retention_days);
      GET DIAGNOSTICS v_prod = ROW_COUNT;
    END IF;
  END IF;

  IF s.purge_queue THEN
    DELETE FROM public.fiscal_queue q
     WHERE q.store_id = _store_id
       AND q.created_at < now() - make_interval(days => s.queue_retention_days)
       AND (q.status = 'falha' OR q.status IN ('pendente','processando'));
    GET DIAGNOSTICS v_queue = ROW_COUNT;
  END IF;

  DELETE FROM public.rpc_audit_log a
   WHERE a.store_id = _store_id
     AND a.created_at < now() - make_interval(days => s.audit_retention_days);
  GET DIAGNOSTICS v_audit = ROW_COUNT;

  v_result := jsonb_build_object(
    'homologacao_invoices', v_homolog,
    'producao_invoices', v_prod,
    'queue_items', v_queue,
    'audit_rows', v_audit,
    'total', v_homolog + v_prod + v_queue,
    'ran_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')
  );

  UPDATE public.fiscal_purge_settings
     SET last_run_at = now(), last_result = v_result, updated_at = now()
   WHERE store_id = _store_id;

  INSERT INTO public.rpc_audit_log (user_id, function_name, store_id, allowed, detail)
  VALUES (auth.uid(), 'purge_fiscal_errors', _store_id, true,
          'retenção aplicada: ' || (v_homolog + v_prod)::text || ' nota(s), ' ||
          v_queue::text || ' item(ns) de fila, ' || v_audit::text || ' registro(s) de auditoria');

  RETURN v_result;
END;
$$;

-- Execução manual pela tela (exige gerente/admin da loja).
CREATE OR REPLACE FUNCTION public.apply_fiscal_retention(_store_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_store(auth.uid(), _store_id) THEN
    PERFORM public.log_rpc_attempt('apply_fiscal_retention', _store_id, false, 'sem permissão');
    RAISE EXCEPTION 'Sem permissão para aplicar retenção nesta loja';
  END IF;
  RETURN public._apply_fiscal_retention(_store_id);
END;
$$;

-- Rotina agendada (pg_cron): percorre lojas com limpeza automática ativa.
CREATE OR REPLACE FUNCTION public.cron_fiscal_retention()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  v_stores integer := 0;
  v_total integer := 0;
  v_res jsonb;
BEGIN
  FOR r IN SELECT store_id FROM public.fiscal_purge_settings WHERE enabled = true LOOP
    BEGIN
      v_res := public._apply_fiscal_retention(r.store_id);
      v_stores := v_stores + 1;
      v_total := v_total + COALESCE((v_res->>'total')::int, 0);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.rpc_audit_log (user_id, function_name, store_id, allowed, detail)
      VALUES (NULL, 'purge_fiscal_errors', r.store_id, false, 'retenção agendada falhou: ' || SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('stores', v_stores, 'deleted', v_total);
END;
$$;

REVOKE ALL ON FUNCTION public._apply_fiscal_retention(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.cron_fiscal_retention() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_fiscal_retention(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_fiscal_retention(uuid) TO authenticated;