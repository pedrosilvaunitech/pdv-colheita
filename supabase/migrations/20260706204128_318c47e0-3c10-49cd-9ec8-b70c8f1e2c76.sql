-- 1) Garantir acesso do Data API às tabelas usadas pelo app autenticado.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stores TO authenticated;
GRANT ALL ON public.stores TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fiscal_configs TO authenticated;
GRANT ALL ON public.fiscal_configs TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices TO authenticated;
GRANT ALL ON public.invoices TO service_role;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- 2) Funções de permissão passam a considerar admin_dev como gestor completo.
CREATE OR REPLACE FUNCTION public.can_operate_pdv(_user_id uuid, _store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND store_id = _store_id
      AND role IN ('admin_dev', 'admin', 'gerente', 'caixa')
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_store(_user_id uuid, _store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.user_roles
     WHERE user_id = _user_id
       AND store_id = _store_id
       AND role IN ('admin_dev', 'admin', 'gerente')
  );
$$;

CREATE OR REPLACE FUNCTION public.has_store_access(_user_id uuid, _store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND store_id = _store_id
  );
$$;

-- 3) Trigger idempotente: toda loja criada vincula o criador como admin_dev.
CREATE OR REPLACE FUNCTION public.tg_store_bootstrap_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, avatar_url, email)
  SELECT u.id,
         COALESCE(u.raw_user_meta_data->>'full_name', u.email),
         u.raw_user_meta_data->>'avatar_url',
         u.email
    FROM auth.users u
   WHERE u.id = NEW.created_by
  ON CONFLICT (id) DO UPDATE
    SET email = COALESCE(public.profiles.email, EXCLUDED.email),
        full_name = COALESCE(public.profiles.full_name, EXCLUDED.full_name),
        avatar_url = COALESCE(public.profiles.avatar_url, EXCLUDED.avatar_url),
        updated_at = now();

  INSERT INTO public.user_roles (user_id, store_id, role)
  VALUES (NEW.created_by, NEW.id, 'admin_dev')
  ON CONFLICT DO NOTHING;

  UPDATE public.profiles
     SET default_store_id = COALESCE(default_store_id, NEW.id),
         updated_at = now()
   WHERE id = NEW.created_by;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_store_bootstrap_admin ON public.stores;
CREATE TRIGGER trg_store_bootstrap_admin
AFTER INSERT ON public.stores
FOR EACH ROW
EXECUTE FUNCTION public.tg_store_bootstrap_admin();

-- 4) Corrigir dados já existentes: criadores de loja viram admin_dev e loja padrão é preenchida.
INSERT INTO public.user_roles (user_id, store_id, role)
SELECT s.created_by, s.id, 'admin_dev'::public.app_role
  FROM public.stores s
 WHERE s.created_by IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE public.profiles p
   SET default_store_id = COALESCE(p.default_store_id, first_store.store_id),
       updated_at = now()
  FROM (
    SELECT ur.user_id, min(ur.store_id::text)::uuid AS store_id
      FROM public.user_roles ur
     GROUP BY ur.user_id
  ) first_store
 WHERE p.id = first_store.user_id
   AND p.default_store_id IS NULL;

-- 5) Limpeza/auto-correção segura para ser chamada no login, usuários e rotinas internas.
CREATE OR REPLACE FUNCTION public.cleanup_orphan_user_links(_manager_user_id uuid DEFAULT auth.uid())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  removed_missing_store integer := 0;
  removed_missing_user integer := 0;
  fixed_defaults integer := 0;
  fixed_admin_links integer := 0;
  caller_can_manage boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = _manager_user_id
       AND role IN ('admin_dev', 'admin', 'gerente')
  ) INTO caller_can_manage;

  IF NOT caller_can_manage THEN
    RAISE EXCEPTION 'Sem permissão para auditar vínculos';
  END IF;

  DELETE FROM public.user_roles ur
   WHERE NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = ur.store_id);
  GET DIAGNOSTICS removed_missing_store = ROW_COUNT;

  DELETE FROM public.user_roles ur
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = ur.user_id);
  GET DIAGNOSTICS removed_missing_user = ROW_COUNT;

  UPDATE public.profiles p
     SET default_store_id = fallback.store_id,
         updated_at = now()
    FROM (
      SELECT ur.user_id, min(ur.store_id::text)::uuid AS store_id
        FROM public.user_roles ur
       GROUP BY ur.user_id
    ) fallback
   WHERE p.id = fallback.user_id
     AND (
       p.default_store_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p.default_store_id)
       OR NOT EXISTS (
         SELECT 1 FROM public.user_roles ur
          WHERE ur.user_id = p.id AND ur.store_id = p.default_store_id
       )
     );
  GET DIAGNOSTICS fixed_defaults = ROW_COUNT;

  INSERT INTO public.user_roles (user_id, store_id, role)
  SELECT s.created_by, s.id, 'admin_dev'::public.app_role
    FROM public.stores s
   WHERE s.created_by IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = s.created_by
          AND ur.store_id = s.id
          AND ur.role IN ('admin_dev', 'admin')
     )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS fixed_admin_links = ROW_COUNT;

  RETURN jsonb_build_object(
    'removed_missing_store', removed_missing_store,
    'removed_missing_user', removed_missing_user,
    'fixed_defaults', fixed_defaults,
    'fixed_admin_links', fixed_admin_links
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_orphan_user_links(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_orphan_user_links(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_orphan_user_links(uuid) TO service_role;

-- 6) A função de vínculo aceita admin_dev e continua protegida por can_manage_store.
CREATE OR REPLACE FUNCTION public.link_user_to_store_by_email(
  _manager_user_id uuid,
  _store_id uuid,
  _email text,
  _role app_role
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  target_user_id uuid;
BEGIN
  IF _manager_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuário gestor inválido';
  END IF;

  IF NOT public.can_manage_store(_manager_user_id, _store_id) THEN
    RAISE EXCEPTION 'Sem permissão para gerenciar esta loja';
  END IF;

  SELECT id
    INTO target_user_id
    FROM public.profiles
   WHERE lower(email) = lower(trim(_email))
   LIMIT 1;

  IF target_user_id IS NULL THEN
    SELECT id
      INTO target_user_id
      FROM auth.users
     WHERE lower(email) = lower(trim(_email))
     LIMIT 1;

    IF target_user_id IS NOT NULL THEN
      INSERT INTO public.profiles (id, full_name, avatar_url, email)
      SELECT u.id,
             COALESCE(u.raw_user_meta_data->>'full_name', u.email),
             u.raw_user_meta_data->>'avatar_url',
             u.email
        FROM auth.users u
       WHERE u.id = target_user_id
      ON CONFLICT (id) DO NOTHING;
    END IF;
  END IF;

  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não encontrado. Peça para ele criar conta primeiro.';
  END IF;

  INSERT INTO public.user_roles (user_id, store_id, role)
  VALUES (target_user_id, _store_id, _role)
  ON CONFLICT (user_id, store_id, role) DO NOTHING;

  UPDATE public.profiles
     SET default_store_id = COALESCE(default_store_id, _store_id),
         updated_at = now()
   WHERE id = target_user_id;

  RETURN target_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, app_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.link_user_to_store_by_email(uuid, uuid, text, app_role) TO service_role;