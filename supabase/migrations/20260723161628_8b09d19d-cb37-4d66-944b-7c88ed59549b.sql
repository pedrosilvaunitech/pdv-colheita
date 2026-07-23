-- 1) Motor de emissão direta na fiscal_configs
ALTER TABLE public.fiscal_configs
  ADD COLUMN IF NOT EXISTS direct_engine text NOT NULL DEFAULT 'agent_local'
    CHECK (direct_engine IN ('agent_local', 'vps')),
  ADD COLUMN IF NOT EXISTS vps_url text,
  ADD COLUMN IF NOT EXISTS vps_auth_secret_name text,
  ADD COLUMN IF NOT EXISTS homologacao_last_test_at timestamptz,
  ADD COLUMN IF NOT EXISTS homologacao_last_test_result jsonb,
  ADD COLUMN IF NOT EXISTS homologacao_history jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 2) RPC para reservar número de NFC-e de forma atômica (evita duplicidade)
CREATE OR REPLACE FUNCTION public.reserve_nfce_number(_store_id uuid)
RETURNS TABLE(series integer, number integer, environment text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_series integer;
  v_number integer;
  v_env text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;
  IF NOT public.can_operate_pdv(auth.uid(), _store_id) THEN
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

  RETURN QUERY SELECT v_series, v_number, v_env;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reserve_nfce_number(uuid) TO authenticated;

-- 3) RPC para gravar resultado da homologação (usada pelo cliente após retorno do agente)
CREATE OR REPLACE FUNCTION public.record_homologacao_test(_store_id uuid, _result jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_history jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;
  IF NOT public.can_manage_store(auth.uid(), _store_id) THEN
    RAISE EXCEPTION 'Sem permissão para gravar testes fiscais';
  END IF;

  SELECT homologacao_history INTO v_history
    FROM public.fiscal_configs WHERE store_id = _store_id;

  v_history := COALESCE(v_history, '[]'::jsonb);
  -- prepend + trim to last 5
  v_history := (
    SELECT jsonb_agg(x)
      FROM (
        SELECT x FROM jsonb_array_elements(jsonb_build_array(_result) || v_history) AS x
         LIMIT 5
      ) t
  );

  UPDATE public.fiscal_configs
     SET homologacao_last_test_at = now(),
         homologacao_last_test_result = _result,
         homologacao_history = COALESCE(v_history, '[]'::jsonb),
         updated_at = now()
   WHERE store_id = _store_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_homologacao_test(uuid, jsonb) TO authenticated;