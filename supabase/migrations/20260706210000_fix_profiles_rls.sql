-- Allow users to see profiles of others who share a store with them
DROP POLICY IF EXISTS "own profile read" ON public.profiles;
CREATE POLICY "read profiles of shared stores" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = auth.uid() OR 
    EXISTS (
      SELECT 1 FROM public.user_roles my_roles
      JOIN public.user_roles other_roles ON my_roles.store_id = other_roles.store_id
      WHERE my_roles.user_id = auth.uid() AND other_roles.user_id = public.profiles.id
    )
  );
