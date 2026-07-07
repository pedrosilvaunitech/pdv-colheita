CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.has_store_access(_user_id uuid, _store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND store_id = _store_id
  );
$$;

CREATE OR REPLACE FUNCTION private.can_manage_store(_user_id uuid, _store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.user_roles
     WHERE user_id = _user_id
       AND store_id = _store_id
       AND role IN ('admin_dev', 'admin', 'gerente')
  );
$$;

CREATE OR REPLACE FUNCTION private.can_operate_pdv(_user_id uuid, _store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND store_id = _store_id
      AND role IN ('admin_dev', 'admin', 'gerente', 'caixa')
  );
$$;

CREATE OR REPLACE FUNCTION private.has_role(_user_id uuid, _store_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND store_id = _store_id AND role = _role
  );
$$;

GRANT EXECUTE ON FUNCTION private.has_store_access(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_manage_store(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_operate_pdv(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.has_role(uuid, uuid, public.app_role) TO authenticated;

DO $$
DECLARE
  p record;
  new_qual text;
  new_check text;
  stmt text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (
         qual ~ '(public\.)?(has_store_access|can_manage_store|can_operate_pdv|has_role)\('
         OR with_check ~ '(public\.)?(has_store_access|can_manage_store|can_operate_pdv|has_role)\('
       )
  LOOP
    new_qual := p.qual;
    new_check := p.with_check;

    IF new_qual IS NOT NULL THEN
      new_qual := regexp_replace(new_qual, '(public\.)?has_store_access\(', 'private.has_store_access(', 'g');
      new_qual := regexp_replace(new_qual, '(public\.)?can_manage_store\(', 'private.can_manage_store(', 'g');
      new_qual := regexp_replace(new_qual, '(public\.)?can_operate_pdv\(', 'private.can_operate_pdv(', 'g');
      new_qual := regexp_replace(new_qual, '(public\.)?has_role\(', 'private.has_role(', 'g');
    END IF;

    IF new_check IS NOT NULL THEN
      new_check := regexp_replace(new_check, '(public\.)?has_store_access\(', 'private.has_store_access(', 'g');
      new_check := regexp_replace(new_check, '(public\.)?can_manage_store\(', 'private.can_manage_store(', 'g');
      new_check := regexp_replace(new_check, '(public\.)?can_operate_pdv\(', 'private.can_operate_pdv(', 'g');
      new_check := regexp_replace(new_check, '(public\.)?has_role\(', 'private.has_role(', 'g');
    END IF;

    stmt := format('ALTER POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
    IF new_qual IS NOT NULL THEN
      stmt := stmt || ' USING (' || new_qual || ')';
    END IF;
    IF new_check IS NOT NULL THEN
      stmt := stmt || ' WITH CHECK (' || new_check || ')';
    END IF;
    EXECUTE stmt;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.link_user_to_store_by_email(_manager_user_id uuid, _store_id uuid, _email text, _role app_role)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  target_user_id uuid;
BEGIN
  IF _manager_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuário gestor inválido';
  END IF;

  IF NOT private.can_manage_store(_manager_user_id, _store_id) THEN
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

REVOKE EXECUTE ON FUNCTION public.has_store_access(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.can_operate_pdv(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.can_manage_store(uuid, uuid) FROM PUBLIC, anon, authenticated;