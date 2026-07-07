-- Add per-user-per-store permission flags
ALTER TABLE public.user_store_codes
  ADD COLUMN IF NOT EXISTS can_all BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_sangria BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_open_close_cash BOOLEAN NOT NULL DEFAULT false;

-- RPC: update permissions for a (store, user) pair
CREATE OR REPLACE FUNCTION public.set_user_store_permissions(
  _store_id UUID,
  _user_id UUID,
  _can_all BOOLEAN,
  _can_sangria BOOLEAN,
  _can_open_close_cash BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;
  IF NOT public.can_manage_store(auth.uid(), _store_id) THEN
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
END;
$$;

-- Helper: effective permissions considering role + overrides
CREATE OR REPLACE FUNCTION public.user_store_permissions(_user_id UUID, _store_id UUID)
RETURNS TABLE(can_all BOOLEAN, can_sangria BOOLEAN, can_open_close_cash BOOLEAN, role app_role)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r app_role;
  base_all BOOLEAN := false;
  base_sangria BOOLEAN := false;
  base_open BOOLEAN := false;
  ov_all BOOLEAN;
  ov_sangria BOOLEAN;
  ov_open BOOLEAN;
BEGIN
  SELECT ur.role INTO r
    FROM public.user_roles ur
   WHERE ur.user_id = _user_id AND ur.store_id = _store_id
   ORDER BY CASE ur.role
     WHEN 'admin_dev' THEN 0
     WHEN 'admin'     THEN 1
     WHEN 'gerente'   THEN 2
     WHEN 'caixa'     THEN 3
     WHEN 'estoquista' THEN 4
     ELSE 5 END
   LIMIT 1;

  IF r IS NULL THEN
    RETURN QUERY SELECT false, false, false, NULL::app_role;
    RETURN;
  END IF;

  IF r IN ('admin_dev', 'admin', 'gerente') THEN
    base_all := true; base_sangria := true; base_open := true;
  END IF;

  SELECT c.can_all, c.can_sangria, c.can_open_close_cash
    INTO ov_all, ov_sangria, ov_open
    FROM public.user_store_codes c
   WHERE c.store_id = _store_id AND c.user_id = _user_id;

  RETURN QUERY SELECT
    (base_all OR COALESCE(ov_all, false)),
    (base_sangria OR COALESCE(ov_sangria, false) OR COALESCE(ov_all, false)),
    (base_open OR COALESCE(ov_open, false) OR COALESCE(ov_all, false)),
    r;
END;
$$;
