-- ─────────────────────────────────────────────────────────────
-- 1) TERMINAIS: provisionamento automático + saúde
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.terminals
  ADD COLUMN IF NOT EXISTS number integer,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ativo',
  ADD COLUMN IF NOT EXISTS provisioned_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS health_status text NOT NULL DEFAULT 'desconhecido',
  ADD COLUMN IF NOT EXISTS health_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS health_detail jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  ALTER TABLE public.terminals
    ADD CONSTRAINT terminals_status_chk CHECK (status IN ('ativo','inativo','bloqueado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.terminals
    ADD CONSTRAINT terminals_health_chk
    CHECK (health_status IN ('ok','alerta','critico','offline','desconhecido'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS terminals_store_number_uk
  ON public.terminals (store_id, number) WHERE number IS NOT NULL;

-- Numera os terminais já existentes por ordem de criação.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY store_id ORDER BY created_at) AS rn
    FROM public.terminals WHERE number IS NULL
)
UPDATE public.terminals t SET number = r.rn FROM ranked r WHERE t.id = r.id;

-- ─────────────────────────────────────────────────────────────
-- 2) ALERTAS DE TERMINAL
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.terminal_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  terminal_key text,
  terminal_name text,
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'aviso' CHECK (severity IN ('info','aviso','critico')),
  title text NOT NULL,
  detail text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint text NOT NULL,
  occurrences integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS terminal_alerts_open_uk
  ON public.terminal_alerts (store_id, fingerprint) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS terminal_alerts_store_idx
  ON public.terminal_alerts (store_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS terminal_alerts_terminal_idx
  ON public.terminal_alerts (store_id, terminal_key);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.terminal_alerts TO authenticated;
GRANT ALL ON public.terminal_alerts TO service_role;
ALTER TABLE public.terminal_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Store members can view terminal alerts" ON public.terminal_alerts
  FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "PDV operators can create terminal alerts" ON public.terminal_alerts
  FOR INSERT TO authenticated WITH CHECK (public.can_operate_pdv(auth.uid(), store_id));
CREATE POLICY "PDV operators can update terminal alerts" ON public.terminal_alerts
  FOR UPDATE TO authenticated
  USING (public.can_operate_pdv(auth.uid(), store_id))
  WITH CHECK (public.can_operate_pdv(auth.uid(), store_id));
CREATE POLICY "Managers can delete terminal alerts" ON public.terminal_alerts
  FOR DELETE TO authenticated USING (public.can_manage_store(auth.uid(), store_id));

-- ─────────────────────────────────────────────────────────────
-- 3) FILA DE EMISSÃO FISCAL POR TERMINAL
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fiscal_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  sale_id uuid NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  terminal_key text,
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','processando','concluida','falha','cancelada')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 6,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  permanent boolean NOT NULL DEFAULT false,
  last_error text,
  last_channel text,
  locked_by text,
  locked_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fiscal_queue_active_sale_uk
  ON public.fiscal_queue (sale_id) WHERE status IN ('pendente','processando');
CREATE INDEX IF NOT EXISTS fiscal_queue_dispatch_idx
  ON public.fiscal_queue (store_id, status, next_attempt_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fiscal_queue TO authenticated;
GRANT ALL ON public.fiscal_queue TO service_role;
ALTER TABLE public.fiscal_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Store members can view fiscal queue" ON public.fiscal_queue
  FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "PDV operators can enqueue fiscal jobs" ON public.fiscal_queue
  FOR INSERT TO authenticated WITH CHECK (public.can_operate_pdv(auth.uid(), store_id));
CREATE POLICY "PDV operators can update fiscal jobs" ON public.fiscal_queue
  FOR UPDATE TO authenticated
  USING (public.can_operate_pdv(auth.uid(), store_id))
  WITH CHECK (public.can_operate_pdv(auth.uid(), store_id));
CREATE POLICY "Managers can delete fiscal jobs" ON public.fiscal_queue
  FOR DELETE TO authenticated USING (public.can_manage_store(auth.uid(), store_id));

DROP TRIGGER IF EXISTS touch_fiscal_queue ON public.fiscal_queue;
CREATE TRIGGER touch_fiscal_queue BEFORE UPDATE ON public.fiscal_queue
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- ─────────────────────────────────────────────────────────────
-- 4) CONFIG FISCAL: fallback entre motores
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.fiscal_configs
  ADD COLUMN IF NOT EXISTS fallback_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS fallback_order text[] NOT NULL DEFAULT ARRAY['agent_local','vps']::text[],
  ADD COLUMN IF NOT EXISTS vps_fallback_url text,
  ADD COLUMN IF NOT EXISTS circuit_state jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ─────────────────────────────────────────────────────────────
-- 5) RPCs
-- ─────────────────────────────────────────────────────────────

-- Provisionamento automático de terminal (número sequencial + upsert).
CREATE OR REPLACE FUNCTION public.provision_terminal(
  _store_id uuid,
  _terminal_key text,
  _name text DEFAULT NULL,
  _agent_id text DEFAULT NULL,
  _agent_version text DEFAULT NULL,
  _printer_name text DEFAULT NULL,
  _printer_source text DEFAULT NULL,
  _scale_port text DEFAULT NULL,
  _tef_provider text DEFAULT NULL,
  _user_agent text DEFAULT NULL
) RETURNS public.terminals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.terminals;
  v_number integer;
  v_name text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF _terminal_key IS NULL OR length(trim(_terminal_key)) < 6 THEN
    RAISE EXCEPTION 'Identificador de terminal inválido';
  END IF;
  IF NOT public.can_operate_pdv(auth.uid(), _store_id) THEN
    PERFORM public.log_rpc_attempt('provision_terminal', _store_id, false, 'sem permissão de PDV');
    RAISE EXCEPTION 'Sem permissão para registrar caixas nesta loja';
  END IF;

  SELECT * INTO v_row FROM public.terminals
   WHERE store_id = _store_id AND terminal_key = _terminal_key;

  IF NOT FOUND THEN
    SELECT COALESCE(MAX(number), 0) + 1 INTO v_number
      FROM public.terminals WHERE store_id = _store_id;
    v_name := COALESCE(NULLIF(trim(_name), ''), 'Caixa ' || lpad(v_number::text, 2, '0'));

    INSERT INTO public.terminals (
      store_id, terminal_key, name, number, provisioned_at,
      agent_id, agent_version, printer_name, printer_source,
      scale_port, tef_provider, user_agent, last_seen_at
    ) VALUES (
      _store_id, _terminal_key, v_name, v_number, now(),
      _agent_id, _agent_version, _printer_name, _printer_source,
      _scale_port, _tef_provider, left(COALESCE(_user_agent, ''), 300), now()
    )
    RETURNING * INTO v_row;

    PERFORM public.log_rpc_attempt('provision_terminal', _store_id, true,
      'caixa provisionado: ' || v_name);
    RETURN v_row;
  END IF;

  UPDATE public.terminals SET
    name = COALESCE(NULLIF(trim(_name), ''), name),
    agent_id = COALESCE(_agent_id, agent_id),
    agent_version = COALESCE(_agent_version, agent_version),
    printer_name = COALESCE(_printer_name, printer_name),
    printer_source = COALESCE(_printer_source, printer_source),
    scale_port = COALESCE(_scale_port, scale_port),
    tef_provider = COALESCE(_tef_provider, tef_provider),
    user_agent = COALESCE(left(_user_agent, 300), user_agent),
    number = COALESCE(number, (SELECT COALESCE(MAX(t2.number), 0) + 1
                                 FROM public.terminals t2 WHERE t2.store_id = _store_id)),
    last_seen_at = now(),
    updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

-- Registro de saúde do terminal (heartbeat com diagnóstico).
CREATE OR REPLACE FUNCTION public.record_terminal_health(
  _store_id uuid,
  _terminal_key text,
  _health_status text,
  _detail jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF NOT public.can_operate_pdv(auth.uid(), _store_id) THEN
    RAISE EXCEPTION 'Sem permissão para reportar saúde nesta loja';
  END IF;
  IF _health_status NOT IN ('ok','alerta','critico','offline','desconhecido') THEN
    RAISE EXCEPTION 'Estado de saúde inválido: %', _health_status;
  END IF;

  UPDATE public.terminals
     SET health_status = _health_status,
         health_detail = COALESCE(_detail, '{}'::jsonb),
         health_checked_at = now(),
         last_seen_at = now(),
         updated_at = now()
   WHERE store_id = _store_id AND terminal_key = _terminal_key;
END; $$;

-- Alerta deduplicado por fingerprint (abre novo ou incrementa o aberto).
CREATE OR REPLACE FUNCTION public.record_terminal_alert(
  _store_id uuid,
  _terminal_key text,
  _kind text,
  _severity text,
  _title text,
  _detail text DEFAULT NULL,
  _context jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fp text;
  v_id uuid;
  v_name text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF NOT public.can_operate_pdv(auth.uid(), _store_id) THEN
    RAISE EXCEPTION 'Sem permissão para registrar alertas nesta loja';
  END IF;
  IF _severity NOT IN ('info','aviso','critico') THEN
    RAISE EXCEPTION 'Gravidade inválida: %', _severity;
  END IF;

  v_fp := COALESCE(_terminal_key, 'loja') || ':' || _kind;
  SELECT name INTO v_name FROM public.terminals
   WHERE store_id = _store_id AND terminal_key = _terminal_key;

  INSERT INTO public.terminal_alerts (
    store_id, terminal_key, terminal_name, kind, severity, title, detail, context,
    fingerprint, created_by
  ) VALUES (
    _store_id, _terminal_key, v_name, _kind, _severity, _title, _detail,
    COALESCE(_context, '{}'::jsonb), v_fp, auth.uid()
  )
  ON CONFLICT (store_id, fingerprint) WHERE resolved_at IS NULL
  DO UPDATE SET
    occurrences = public.terminal_alerts.occurrences + 1,
    last_seen_at = now(),
    severity = EXCLUDED.severity,
    title = EXCLUDED.title,
    detail = EXCLUDED.detail,
    context = EXCLUDED.context,
    terminal_name = COALESCE(EXCLUDED.terminal_name, public.terminal_alerts.terminal_name)
  RETURNING id INTO v_id;

  RETURN v_id;
END; $$;

-- Fecha alertas abertos de um tipo (quando o problema se resolve sozinho).
CREATE OR REPLACE FUNCTION public.resolve_terminal_alerts(
  _store_id uuid,
  _terminal_key text,
  _kinds text[] DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF NOT public.has_store_access(auth.uid(), _store_id) THEN
    RAISE EXCEPTION 'Sem acesso a esta loja';
  END IF;

  UPDATE public.terminal_alerts
     SET resolved_at = now(), resolved_by = auth.uid()
   WHERE store_id = _store_id
     AND resolved_at IS NULL
     AND (_terminal_key IS NULL OR terminal_key = _terminal_key)
     AND (_kinds IS NULL OR kind = ANY(_kinds));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;

-- Enfileira uma venda para emissão fiscal (idempotente por venda ativa).
CREATE OR REPLACE FUNCTION public.enqueue_fiscal_job(
  _store_id uuid,
  _sale_id uuid,
  _terminal_key text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF NOT public.can_operate_pdv(auth.uid(), _store_id) THEN
    RAISE EXCEPTION 'Sem permissão para enfileirar notas nesta loja';
  END IF;

  SELECT id INTO v_id FROM public.fiscal_queue
   WHERE sale_id = _sale_id AND status IN ('pendente','processando');
  IF FOUND THEN RETURN v_id; END IF;

  INSERT INTO public.fiscal_queue (store_id, sale_id, terminal_key, created_by)
  VALUES (_store_id, _sale_id, _terminal_key, auth.uid())
  RETURNING id INTO v_id;

  RETURN v_id;
END; $$;

-- Reivindica jobs deste terminal (+ órfãos de caixas offline há 5 min).
CREATE OR REPLACE FUNCTION public.claim_fiscal_jobs(
  _store_id uuid,
  _terminal_key text,
  _limit integer DEFAULT 3
) RETURNS SETOF public.fiscal_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF NOT public.can_operate_pdv(auth.uid(), _store_id) THEN
    RAISE EXCEPTION 'Sem permissão para processar a fila fiscal';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT q.id
      FROM public.fiscal_queue q
      LEFT JOIN public.terminals t
        ON t.store_id = q.store_id AND t.terminal_key = q.terminal_key
     WHERE q.store_id = _store_id
       AND q.permanent = false
       AND q.attempts < q.max_attempts
       AND q.next_attempt_at <= now()
       AND (
         (q.status = 'pendente' AND (
            q.terminal_key IS NULL
            OR q.terminal_key = _terminal_key
            OR t.id IS NULL
            OR t.last_seen_at < now() - interval '5 minutes'
         ))
         OR (q.status = 'processando' AND q.locked_at < now() - interval '5 minutes')
       )
     ORDER BY (q.terminal_key = _terminal_key) DESC, q.created_at
     LIMIT GREATEST(COALESCE(_limit, 3), 1)
     FOR UPDATE OF q SKIP LOCKED
  )
  UPDATE public.fiscal_queue q
     SET status = 'processando',
         locked_by = _terminal_key,
         locked_at = now(),
         updated_at = now()
    FROM candidates c
   WHERE q.id = c.id
  RETURNING q.*;
END; $$;

-- Fecha um job da fila: sucesso, retry com backoff ou falha definitiva.
CREATE OR REPLACE FUNCTION public.complete_fiscal_job(
  _job_id uuid,
  _ok boolean,
  _error text DEFAULT NULL,
  _channel text DEFAULT NULL,
  _permanent boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.fiscal_queue;
  v_attempts integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;

  SELECT * INTO v_job FROM public.fiscal_queue WHERE id = _job_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT public.can_operate_pdv(auth.uid(), v_job.store_id) THEN
    RAISE EXCEPTION 'Sem permissão para atualizar a fila fiscal';
  END IF;

  v_attempts := v_job.attempts + 1;

  IF _ok THEN
    UPDATE public.fiscal_queue
       SET status = 'concluida', attempts = v_attempts, last_error = NULL,
           last_channel = _channel, locked_by = NULL, locked_at = NULL, updated_at = now()
     WHERE id = _job_id;
    RETURN;
  END IF;

  UPDATE public.fiscal_queue
     SET status = CASE
           WHEN _permanent OR v_attempts >= v_job.max_attempts THEN 'falha'
           ELSE 'pendente' END,
         attempts = v_attempts,
         permanent = _permanent OR v_attempts >= v_job.max_attempts,
         last_error = _error,
         last_channel = _channel,
         locked_by = NULL,
         locked_at = NULL,
         next_attempt_at = now() + make_interval(secs => LEAST(3600, 60 * power(4, LEAST(v_attempts - 1, 3))::int)),
         updated_at = now()
   WHERE id = _job_id;
END; $$;

-- Reabre um job travado em falha (botão "tentar de novo").
CREATE OR REPLACE FUNCTION public.retry_fiscal_job(_job_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.fiscal_queue;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  SELECT * INTO v_job FROM public.fiscal_queue WHERE id = _job_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT public.can_operate_pdv(auth.uid(), v_job.store_id) THEN
    RAISE EXCEPTION 'Sem permissão para reprocessar a fila fiscal';
  END IF;

  UPDATE public.fiscal_queue
     SET status = 'pendente', permanent = false, attempts = 0,
         next_attempt_at = now(), locked_by = NULL, locked_at = NULL, updated_at = now()
   WHERE id = _job_id;
END; $$;