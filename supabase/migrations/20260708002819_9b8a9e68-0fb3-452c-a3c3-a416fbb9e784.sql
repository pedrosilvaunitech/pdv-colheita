-- Fix: verify_admin_code agora retorna qualquer role vinculado à loja.
-- A checagem de permissão específica (can_open_close_cash / can_sangria / can_all)
-- já é feita depois via user_store_permissions no cliente.
-- Isso permite que operadores caixa/estoquista com override de permissão autorizem ações.

CREATE OR REPLACE FUNCTION public.verify_admin_code(_store_id uuid, _code text)
 RETURNS TABLE(user_id uuid, full_name text, email text, role app_role)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  cleaned TEXT := trim(_code);
  master_hash TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;
  IF NOT public.has_store_access(auth.uid(), _store_id) THEN
    RAISE EXCEPTION 'Sem acesso a esta loja';
  END IF;

  -- 1) Senha mestra da loja autoriza qualquer ação
  SELECT master_password_hash INTO master_hash
    FROM public.stores WHERE id = _store_id;
  IF master_hash IS NOT NULL
     AND master_hash = encode(digest(cleaned, 'sha256'), 'hex') THEN
    RETURN QUERY
      SELECT NULL::uuid, 'Senha mestra'::text, NULL::text, 'admin'::app_role;
    RETURN;
  END IF;

  -- 2) Código de 5 dígitos: qualquer role vinculada à loja pode ser retornada.
  -- A validação da permissão específica (abrir caixa, sangria, etc) fica
  -- por conta de user_store_permissions no consumidor.
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
END;
$function$;