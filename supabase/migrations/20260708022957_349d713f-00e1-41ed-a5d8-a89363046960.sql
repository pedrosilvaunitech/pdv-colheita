-- Retorna a loja onde o código existe (para qualquer loja do sistema),
-- para o frontend detectar "código pertence a outra loja" e mostrar mensagem clara.
CREATE OR REPLACE FUNCTION public.lookup_admin_code(_code text)
RETURNS TABLE(store_id uuid, store_name text, user_id uuid, full_name text, role app_role)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE cleaned TEXT := trim(_code);
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
       AND public.has_store_access(auth.uid(), c.store_id) -- só devolve lojas onde o operador logado tem vínculo
     ORDER BY CASE ur.role
        WHEN 'admin_dev' THEN 0 WHEN 'admin' THEN 1
        WHEN 'gerente' THEN 2 WHEN 'caixa' THEN 3
        WHEN 'estoquista' THEN 4 ELSE 5 END
     LIMIT 5;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_admin_code(text) TO authenticated;