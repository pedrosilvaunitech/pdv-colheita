CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) Tabela de códigos por (loja, usuário)
CREATE TABLE IF NOT EXISTS public.user_store_codes (
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
  admin_code text NOT NULL CHECK (admin_code ~ '^[0-9]{5}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, user_id),
  UNIQUE (store_id, admin_code)
);

GRANT SELECT ON public.user_store_codes TO authenticated;
GRANT ALL    ON public.user_store_codes TO service_role;

ALTER TABLE public.user_store_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own code or store manager reads codes" ON public.user_store_codes;
CREATE POLICY "own code or store manager reads codes"
  ON public.user_store_codes FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.can_manage_store(auth.uid(), store_id)
  );

-- 2) Coluna de senha mestra por loja
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS master_password_hash TEXT;

-- 3) Gerador de código único de 5 dígitos por loja
CREATE OR REPLACE FUNCTION public.generate_admin_code(_store_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  code TEXT;
  attempts INT := 0;
BEGIN
  LOOP
    code := lpad((floor(random() * 100000))::int::text, 5, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.user_store_codes
       WHERE store_id = _store_id AND admin_code = code
    );
    attempts := attempts + 1;
    IF attempts > 200 THEN
      RAISE EXCEPTION 'Não foi possível gerar código único';
    END IF;
  END LOOP;
  RETURN code;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_admin_code(uuid) FROM PUBLIC;

-- 4) Garante código ao vincular usuário à loja
CREATE OR REPLACE FUNCTION public.tg_user_roles_ensure_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_store_codes(store_id, user_id, admin_code)
  VALUES (NEW.store_id, NEW.user_id, public.generate_admin_code(NEW.store_id))
  ON CONFLICT (store_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_roles_ensure_code ON public.user_roles;
CREATE TRIGGER user_roles_ensure_code
  AFTER INSERT ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.tg_user_roles_ensure_code();

-- 5) Limpa o código quando o usuário perde todos os papéis naquela loja
CREATE OR REPLACE FUNCTION public.tg_user_roles_cleanup_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE store_id = OLD.store_id AND user_id = OLD.user_id
  ) THEN
    DELETE FROM public.user_store_codes
     WHERE store_id = OLD.store_id AND user_id = OLD.user_id;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS user_roles_cleanup_code ON public.user_roles;
CREATE TRIGGER user_roles_cleanup_code
  AFTER DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.tg_user_roles_cleanup_code();

-- 6) Backfill dos vínculos existentes
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT store_id, user_id FROM public.user_roles
  LOOP
    INSERT INTO public.user_store_codes(store_id, user_id, admin_code)
    VALUES (r.store_id, r.user_id, public.generate_admin_code(r.store_id))
    ON CONFLICT (store_id, user_id) DO NOTHING;
  END LOOP;
END;
$$;

-- 7) verify_admin_code aceita código de 5 dígitos OU senha mestra
CREATE OR REPLACE FUNCTION public.verify_admin_code(_store_id uuid, _code text)
RETURNS TABLE(user_id uuid, full_name text, email text, role app_role)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- 1) Senha mestra
  SELECT master_password_hash INTO master_hash
    FROM public.stores WHERE id = _store_id;
  IF master_hash IS NOT NULL
     AND master_hash = encode(digest(cleaned, 'sha256'), 'hex') THEN
    RETURN QUERY
      SELECT NULL::uuid, 'Senha mestra'::text, NULL::text, 'admin'::app_role;
    RETURN;
  END IF;

  -- 2) Código de 5 dígitos (apenas admin/gerente autoriza operações)
  RETURN QUERY
    SELECT ur.user_id, p.full_name, p.email, ur.role
      FROM public.user_store_codes c
      JOIN public.user_roles ur ON ur.store_id = c.store_id AND ur.user_id = c.user_id
      LEFT JOIN public.profiles p ON p.id = c.user_id
     WHERE c.store_id = _store_id
       AND c.admin_code = cleaned
       AND ur.role IN ('admin_dev','admin','gerente')
     ORDER BY CASE ur.role
       WHEN 'admin_dev' THEN 0
       WHEN 'admin'     THEN 1
       WHEN 'gerente'   THEN 2
       ELSE 3 END
     LIMIT 1;
END;
$$;

-- 8) Regenera código de um usuário na loja (admin/gerente ou o próprio)
CREATE OR REPLACE FUNCTION public.regenerate_admin_code(_store_id uuid, _user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE new_code TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;
  IF NOT public.can_manage_store(auth.uid(), _store_id) AND auth.uid() <> _user_id THEN
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
  RETURN new_code;
END;
$$;

REVOKE ALL ON FUNCTION public.regenerate_admin_code(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.regenerate_admin_code(uuid, uuid) TO authenticated;

-- 9) Definir/limpar senha mestra da loja (admin/gerente)
CREATE OR REPLACE FUNCTION public.set_store_master_password(_store_id uuid, _password text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;
  IF NOT public.can_manage_store(auth.uid(), _store_id) THEN
    RAISE EXCEPTION 'Sem permissão para definir senha mestra';
  END IF;

  IF _password IS NULL OR length(trim(_password)) = 0 THEN
    UPDATE public.stores SET master_password_hash = NULL WHERE id = _store_id;
    RETURN;
  END IF;

  IF length(trim(_password)) < 4 THEN
    RAISE EXCEPTION 'Senha mestra deve ter pelo menos 4 caracteres';
  END IF;

  UPDATE public.stores
     SET master_password_hash = encode(digest(trim(_password), 'sha256'), 'hex')
   WHERE id = _store_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_store_master_password(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_store_master_password(uuid, text) TO authenticated;

-- 10) Indica se a loja tem senha mestra definida (sem revelar o hash)
CREATE OR REPLACE FUNCTION public.store_has_master_password(_store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.stores
     WHERE id = _store_id AND master_password_hash IS NOT NULL
  );
$$;

REVOKE ALL ON FUNCTION public.store_has_master_password(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_has_master_password(uuid) TO authenticated;
