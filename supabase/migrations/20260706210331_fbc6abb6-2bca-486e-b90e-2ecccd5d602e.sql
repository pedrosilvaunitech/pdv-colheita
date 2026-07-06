DROP TRIGGER IF EXISTS trg_store_after_insert ON public.stores;

CREATE OR REPLACE FUNCTION public.tg_store_bootstrap_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  ON CONFLICT (user_id, store_id, role) DO NOTHING;

  UPDATE public.profiles
     SET default_store_id = NEW.id,
         updated_at = now()
   WHERE id = NEW.created_by
     AND (
       default_store_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = default_store_id)
       OR NOT EXISTS (
         SELECT 1 FROM public.user_roles ur
          WHERE ur.user_id = NEW.created_by
            AND ur.store_id = default_store_id
       )
     );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_store_bootstrap_admin ON public.stores;
CREATE TRIGGER trg_store_bootstrap_admin
AFTER INSERT ON public.stores
FOR EACH ROW
EXECUTE FUNCTION public.tg_store_bootstrap_admin();