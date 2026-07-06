ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email text;

CREATE INDEX IF NOT EXISTS idx_profiles_email_lower
  ON public.profiles (lower(email));

UPDATE public.profiles p
   SET email = u.email,
       updated_at = now()
  FROM auth.users u
 WHERE p.id = u.id
   AND p.email IS NULL;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, avatar_url, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    NEW.raw_user_meta_data->>'avatar_url',
    NEW.email
  )
  ON CONFLICT (id) DO UPDATE
    SET email = COALESCE(public.profiles.email, EXCLUDED.email),
        full_name = COALESCE(public.profiles.full_name, EXCLUDED.full_name),
        avatar_url = COALESCE(public.profiles.avatar_url, EXCLUDED.avatar_url),
        updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.link_user_to_store_by_email(
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
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Usuário não autenticado';
  END IF;

  IF NOT public.can_manage_store(auth.uid(), _store_id) THEN
    RAISE EXCEPTION 'Sem permissão para gerenciar esta loja';
  END IF;

  SELECT id
    INTO target_user_id
    FROM public.profiles
   WHERE lower(email) = lower(trim(_email))
   LIMIT 1;

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

GRANT EXECUTE ON FUNCTION public.link_user_to_store_by_email(uuid, text, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.link_user_to_store_by_email(uuid, text, app_role) TO service_role;