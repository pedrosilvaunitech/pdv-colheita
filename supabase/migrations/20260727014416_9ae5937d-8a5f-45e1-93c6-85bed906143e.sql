-- 1) Tabela de contadores
CREATE TABLE IF NOT EXISTS public.rpc_rate_limits (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  function_name TEXT NOT NULL,
  store_id UUID,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS rpc_rate_limits_key
  ON public.rpc_rate_limits (user_id, function_name, COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS rpc_rate_limits_store_idx ON public.rpc_rate_limits (store_id, updated_at DESC);

GRANT SELECT ON public.rpc_rate_limits TO authenticated;
GRANT ALL ON public.rpc_rate_limits TO service_role;

ALTER TABLE public.rpc_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Usuário vê seus próprios limites"
  ON public.rpc_rate_limits FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Gestores veem limites da loja"
  ON public.rpc_rate_limits FOR SELECT TO authenticated
  USING (store_id IS NOT NULL AND public.can_manage_store(auth.uid(), store_id));

DROP TRIGGER IF EXISTS trg_rpc_rate_limits_touch ON public.rpc_rate_limits;
CREATE TRIGGER trg_rpc_rate_limits_touch
  BEFORE UPDATE ON public.rpc_rate_limits
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- 2) Helpers de rate limit
CREATE OR REPLACE FUNCTION public.enforce_rate_limit(
  _function_name TEXT,
  _store_id UUID,
  _max_attempts INTEGER,
  _window_secs INTEGER,
  _block_secs INTEGER
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.rpc_rate_limits%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_row
    FROM public.rpc_rate_limits
   WHERE user_id = auth.uid()
     AND function_name = _function_name
     AND COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(_store_id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Bloqueio ativo
  IF v_row.blocked_until IS NOT NULL AND v_row.blocked_until > now() THEN
    PERFORM public.log_rpc_attempt(_function_name, _store_id, false,
      'bloqueado por excesso de tentativas até ' || to_char(v_row.blocked_until, 'HH24:MI:SS'));
    RAISE EXCEPTION 'Muitas tentativas. Tente novamente em % segundos.',
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_row.blocked_until - now()))))::int;
  END IF;

  -- Janela expirada ou bloqueio vencido: zera o contador
  IF v_row.window_start < now() - make_interval(secs => _window_secs)
     OR (v_row.blocked_until IS NOT NULL AND v_row.blocked_until <= now()) THEN
    UPDATE public.rpc_rate_limits
       SET attempts = 0, window_start = now(), blocked_until = NULL
     WHERE id = v_row.id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.register_rate_limit_failure(
  _function_name TEXT,
  _store_id UUID,
  _max_attempts INTEGER,
  _window_secs INTEGER,
  _block_secs INTEGER
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_attempts INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.rpc_rate_limits (user_id, function_name, store_id, attempts, window_start)
  VALUES (auth.uid(), _function_name, _store_id, 1, now())
  ON CONFLICT (user_id, function_name, COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET
    attempts = CASE
      WHEN public.rpc_rate_limits.window_start < now() - make_interval(secs => _window_secs) THEN 1
      ELSE public.rpc_rate_limits.attempts + 1 END,
    window_start = CASE
      WHEN public.rpc_rate_limits.window_start < now() - make_interval(secs => _window_secs) THEN now()
      ELSE public.rpc_rate_limits.window_start END,
    updated_at = now()
  RETURNING attempts INTO v_attempts;

  IF v_attempts >= _max_attempts THEN
    UPDATE public.rpc_rate_limits
       SET blocked_until = now() + make_interval(secs => _block_secs)
     WHERE user_id = auth.uid()
       AND function_name = _function_name
       AND COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = COALESCE(_store_id, '00000000-0000-0000-0000-000000000000'::uuid);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_rate_limit(_function_name TEXT, _store_id UUID)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  DELETE FROM public.rpc_rate_limits
   WHERE user_id = auth.uid()
     AND function_name = _function_name
     AND COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(_store_id, '00000000-0000-0000-0000-000000000000'::uuid);
$$;

REVOKE ALL ON FUNCTION public.enforce_rate_limit(text, uuid, integer, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.register_rate_limit_failure(text, uuid, integer, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.clear_rate_limit(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enforce_rate_limit(text, uuid, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_rate_limit_failure(text, uuid, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_rate_limit(text, uuid) TO service_role;

-- 3) verify_admin_code com limite (8 falhas / 5 min -> bloqueio 10 min)
CREATE OR REPLACE FUNCTION public.verify_admin_code(_store_id uuid, _code text)
 RETURNS TABLE(user_id uuid, full_name text, email text, role app_role)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  cleaned TEXT := trim(_code);
  master_hash TEXT;
  found_count INT := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;
  IF NOT public.has_store_access(auth.uid(), _store_id) THEN
    PERFORM public.log_rpc_attempt('verify_admin_code', _store_id, false, 'sem acesso à loja');
    RAISE EXCEPTION 'Sem acesso a esta loja';
  END IF;

  PERFORM public.enforce_rate_limit('verify_admin_code', _store_id, 8, 300, 600);

  SELECT master_password_hash INTO master_hash
    FROM public.stores WHERE id = _store_id;

  IF master_hash IS NOT NULL
     AND master_hash = encode(extensions.digest(cleaned, 'sha256'), 'hex') THEN
    PERFORM public.clear_rate_limit('verify_admin_code', _store_id);
    PERFORM public.log_rpc_attempt('verify_admin_code', _store_id, true, 'senha mestra');
    RETURN QUERY
      SELECT NULL::uuid, 'Senha mestra'::text, NULL::text, 'admin'::public.app_role;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT ur.user_id, p.full_name, p.email, ur.role
      FROM public.user_store_codes c
      JOIN public.user_roles ur ON ur.store_id = c.store_id AND ur.user_id = c.user_id
      LEFT JOIN public.profiles p ON p.id = c.user_id
     WHERE c.store_id = _store_id
       AND c.admin_code = cleaned
     ORDER BY CASE ur.role
       WHEN 'admin_dev' THEN 0
       WHEN 'admin'     THEN 1
       WHEN 'gerente'   THEN 2
       WHEN 'caixa'     THEN 3
       WHEN 'estoquista' THEN 4
       ELSE 5 END
     LIMIT 1;

  GET DIAGNOSTICS found_count = ROW_COUNT;

  IF found_count > 0 THEN
    PERFORM public.clear_rate_limit('verify_admin_code', _store_id);
  ELSE
    PERFORM public.register_rate_limit_failure('verify_admin_code', _store_id, 8, 300, 600);
  END IF;

  PERFORM public.log_rpc_attempt('verify_admin_code', _store_id, found_count > 0,
    CASE WHEN found_count > 0 THEN 'código válido' ELSE 'código inválido' END);
END;
$function$;

-- 4) lookup_admin_code com limite (10 falhas / 5 min -> bloqueio 10 min)
CREATE OR REPLACE FUNCTION public.lookup_admin_code(_code text)
 RETURNS TABLE(store_id uuid, store_name text, user_id uuid, full_name text, role app_role)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  cleaned TEXT := trim(_code);
  found_count INT := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  PERFORM public.enforce_rate_limit('lookup_admin_code', NULL, 10, 300, 600);

  RETURN QUERY
    SELECT c.store_id,
           COALESCE(s.fantasy_name, s.name)::text AS store_name,
           c.user_id,
           p.full_name,
           ur.role
      FROM public.user_store_codes c
      JOIN public.stores s ON s.id = c.store_id
      JOIN public.user_roles ur ON ur.store_id = c.store_id AND ur.user_id = c.user_id
      LEFT JOIN public.profiles p ON p.id = c.user_id
     WHERE c.admin_code = cleaned
       AND public.has_store_access(auth.uid(), c.store_id)
     ORDER BY CASE ur.role
        WHEN 'admin_dev' THEN 0 WHEN 'admin' THEN 1
        WHEN 'gerente' THEN 2 WHEN 'caixa' THEN 3
        WHEN 'estoquista' THEN 4 ELSE 5 END
     LIMIT 5;

  GET DIAGNOSTICS found_count = ROW_COUNT;

  IF found_count > 0 THEN
    PERFORM public.clear_rate_limit('lookup_admin_code', NULL);
  ELSE
    PERFORM public.register_rate_limit_failure('lookup_admin_code', NULL, 10, 300, 600);
  END IF;

  PERFORM public.log_rpc_attempt('lookup_admin_code', NULL, found_count > 0,
    CASE WHEN found_count > 0 THEN 'código localizado' ELSE 'código inválido' END);
END;
$function$;

-- 5) regenerate_admin_code (10 / 10 min -> 15 min)
CREATE OR REPLACE FUNCTION public.regenerate_admin_code(_store_id uuid, _user_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE new_code TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  PERFORM public.enforce_rate_limit('regenerate_admin_code', _store_id, 10, 600, 900);

  IF NOT public.can_manage_store(auth.uid(), _store_id) AND auth.uid() <> _user_id THEN
    PERFORM public.register_rate_limit_failure('regenerate_admin_code', _store_id, 10, 600, 900);
    PERFORM public.log_rpc_attempt('regenerate_admin_code', _store_id, false, 'sem permissão');
    RAISE EXCEPTION 'Sem permissão para regenerar código';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE store_id = _store_id AND user_id = _user_id
  ) THEN
    PERFORM public.register_rate_limit_failure('regenerate_admin_code', _store_id, 10, 600, 900);
    RAISE EXCEPTION 'Usuário não vinculado a esta loja';
  END IF;

  new_code := public.generate_admin_code(_store_id);
  INSERT INTO public.user_store_codes(store_id, user_id, admin_code)
  VALUES (_store_id, _user_id, new_code)
  ON CONFLICT (store_id, user_id)
  DO UPDATE SET admin_code = EXCLUDED.admin_code, updated_at = now();
  PERFORM public.log_rpc_attempt('regenerate_admin_code', _store_id, true, 'código regenerado para ' || _user_id::text);
  RETURN new_code;
END;
$function$;

-- 6) set_store_master_password (5 / 10 min -> 15 min)
CREATE OR REPLACE FUNCTION public.set_store_master_password(_store_id uuid, _password text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  PERFORM public.enforce_rate_limit('set_store_master_password', _store_id, 5, 600, 900);

  IF NOT public.can_manage_store(auth.uid(), _store_id) THEN
    PERFORM public.register_rate_limit_failure('set_store_master_password', _store_id, 5, 600, 900);
    PERFORM public.log_rpc_attempt('set_store_master_password', _store_id, false, 'sem permissão');
    RAISE EXCEPTION 'Sem permissão para definir senha mestra';
  END IF;

  IF _password IS NULL OR length(trim(_password)) = 0 THEN
    UPDATE public.stores SET master_password_hash = NULL WHERE id = _store_id;
    PERFORM public.log_rpc_attempt('set_store_master_password', _store_id, true, 'senha mestra removida');
    RETURN;
  END IF;

  IF length(trim(_password)) < 4 THEN
    RAISE EXCEPTION 'Senha mestra deve ter pelo menos 4 caracteres';
  END IF;

  UPDATE public.stores
     SET master_password_hash = encode(extensions.digest(trim(_password), 'sha256'), 'hex')
   WHERE id = _store_id;
  PERFORM public.log_rpc_attempt('set_store_master_password', _store_id, true, 'senha mestra definida');
END;
$function$;
