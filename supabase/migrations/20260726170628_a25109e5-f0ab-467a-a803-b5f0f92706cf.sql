CREATE TABLE public.rpc_audit_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID,
  function_name TEXT NOT NULL,
  store_id UUID,
  allowed BOOLEAN NOT NULL DEFAULT false,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.rpc_audit_log TO authenticated;
GRANT ALL ON public.rpc_audit_log TO service_role;

ALTER TABLE public.rpc_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rpc_audit_own_select" ON public.rpc_audit_log
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "rpc_audit_store_select" ON public.rpc_audit_log
  FOR SELECT TO authenticated
  USING (store_id IS NOT NULL AND public.can_manage_store(auth.uid(), store_id));

CREATE INDEX idx_rpc_audit_store_created ON public.rpc_audit_log (store_id, created_at DESC);
CREATE INDEX idx_rpc_audit_user_created ON public.rpc_audit_log (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.log_rpc_attempt(_function_name TEXT, _store_id UUID, _allowed BOOLEAN, _detail TEXT DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.rpc_audit_log (user_id, function_name, store_id, allowed, detail)
  VALUES (auth.uid(), _function_name, _store_id, COALESCE(_allowed, false), _detail);
$$;

REVOKE ALL ON FUNCTION public.log_rpc_attempt(TEXT, UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_rpc_attempt(TEXT, UUID, BOOLEAN, TEXT) TO service_role;

-- verify_admin_code: agora VOLATILE para registrar tentativas (inclusive código inválido)
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

  SELECT master_password_hash INTO master_hash
    FROM public.stores WHERE id = _store_id;

  IF master_hash IS NOT NULL
     AND master_hash = encode(extensions.digest(cleaned, 'sha256'), 'hex') THEN
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
  PERFORM public.log_rpc_attempt('verify_admin_code', _store_id, found_count > 0,
    CASE WHEN found_count > 0 THEN 'código válido' ELSE 'código inválido' END);
END;
$function$;

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
  PERFORM public.log_rpc_attempt('lookup_admin_code', NULL, found_count > 0,
    CASE WHEN found_count > 0 THEN 'código localizado' ELSE 'código inválido' END);
END;
$function$;

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
  IF NOT public.can_manage_store(auth.uid(), _store_id) THEN
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
  IF NOT public.can_manage_store(auth.uid(), _store_id) AND auth.uid() <> _user_id THEN
    PERFORM public.log_rpc_attempt('regenerate_admin_code', _store_id, false, 'sem permissão');
    RAISE EXCEPTION 'Sem permissão para regenerar código';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE store_id = _store_id AND user_id = _user_id
  ) THEN
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

CREATE OR REPLACE FUNCTION public.set_user_store_permissions(_store_id uuid, _user_id uuid, _can_all boolean, _can_sangria boolean, _can_open_close_cash boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;
  IF NOT public.can_manage_store(auth.uid(), _store_id) THEN
    PERFORM public.log_rpc_attempt('set_user_store_permissions', _store_id, false, 'sem permissão');
    RAISE EXCEPTION 'Sem permissão para editar permissões';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE store_id = _store_id AND user_id = _user_id
  ) THEN
    RAISE EXCEPTION 'Usuário não vinculado a esta loja';
  END IF;

  INSERT INTO public.user_store_codes (store_id, user_id, admin_code, can_all, can_sangria, can_open_close_cash)
  VALUES (_store_id, _user_id, public.generate_admin_code(_store_id),
          COALESCE(_can_all, false), COALESCE(_can_sangria, false), COALESCE(_can_open_close_cash, false))
  ON CONFLICT (store_id, user_id) DO UPDATE
    SET can_all = COALESCE(_can_all, false),
        can_sangria = COALESCE(_can_sangria, false),
        can_open_close_cash = COALESCE(_can_open_close_cash, false),
        updated_at = now();

  PERFORM public.log_rpc_attempt('set_user_store_permissions', _store_id, true, 'permissões de ' || _user_id::text);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reserve_nfce_number(_store_id uuid)
 RETURNS TABLE(series integer, number integer, environment text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_series integer;
  v_number integer;
  v_env text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;
  IF NOT public.can_operate_pdv(auth.uid(), _store_id) THEN
    PERFORM public.log_rpc_attempt('reserve_nfce_number', _store_id, false, 'sem permissão de PDV');
    RAISE EXCEPTION 'Sem permissão para emitir nota nesta loja';
  END IF;

  UPDATE public.fiscal_configs
     SET nfce_next_number = COALESCE(nfce_next_number, 1) + 1,
         updated_at = now()
   WHERE store_id = _store_id
   RETURNING COALESCE(nfce_series, 1),
             COALESCE(nfce_next_number, 1) - 1,
             environment
     INTO v_series, v_number, v_env;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Configuração fiscal ausente para esta loja';
  END IF;

  PERFORM public.log_rpc_attempt('reserve_nfce_number', _store_id, true,
    'série ' || v_series::text || ' nº ' || v_number::text || ' (' || COALESCE(v_env, '?') || ')');

  RETURN QUERY SELECT v_series, v_number, v_env;
END;
$function$;

REVOKE ALL ON FUNCTION public.verify_admin_code(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lookup_admin_code(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_store_master_password(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.regenerate_admin_code(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_user_store_permissions(uuid, uuid, boolean, boolean, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reserve_nfce_number(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.verify_admin_code(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lookup_admin_code(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_store_master_password(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.regenerate_admin_code(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_user_store_permissions(uuid, uuid, boolean, boolean, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_nfce_number(uuid) TO authenticated, service_role;